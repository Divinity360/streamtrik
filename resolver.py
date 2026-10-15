"""Headless stream resolver — extracts raw m3u8 URL and proxies segments."""
import asyncio
import os
import re
import time
from urllib.parse import urljoin, urlparse, quote, parse_qs
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import async_playwright
import httpx

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"])

# session cache: embed_url -> (m3u8_url, cookies_dict, headers_dict, expires_at)
SESSIONS: dict = {}
SESSION_TTL = 180
_browser = None
_lock = asyncio.Lock()


async def get_browser():
    global _browser
    async with _lock:
        if _browser is None:
            pw = await async_playwright().start()
            _browser = await pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
        return _browser


MAX_SESSIONS = 30  # Hard cap — LRU-evict beyond this
_evict_lock = asyncio.Lock()


async def _close_ctx_safely(ctx):
    try:
        await ctx.close()
    except Exception:
        pass


async def _evict_expired_and_overflow():
    """Clean up expired sessions and keep below MAX_SESSIONS (LRU by expiry)."""
    async with _evict_lock:
        now = time.time()
        # Expired first
        expired = [k for k, v in list(SESSIONS.items()) if v[3] <= now]
        for k in expired:
            _, ctx, _, _ = SESSIONS.pop(k, (None, None, None, 0))
            if ctx:
                asyncio.create_task(_close_ctx_safely(ctx))
        # Then overflow — oldest first
        if len(SESSIONS) > MAX_SESSIONS:
            sorted_keys = sorted(SESSIONS.keys(), key=lambda k: SESSIONS[k][3])
            overflow = sorted_keys[:len(SESSIONS) - MAX_SESSIONS]
            for k in overflow:
                _, ctx, _, _ = SESSIONS.pop(k, (None, None, None, 0))
                if ctx:
                    asyncio.create_task(_close_ctx_safely(ctx))


# Hosts whose m3u8 URL is embedded as plain text in a downstream player page.
# We bypass Playwright entirely for these — faster, no ad scripts, no autoplay issues.
_DADDY_HOSTS = ("daddylive.app", "daddylive.sx", "daddylivehd.sx", "dlhd.sx", "dlhd.so")
_DADDY_PLAYER_TMPL = "https://daddyliveplayer.st/premiumtv/worldsportz4u.php?id={id}"
_DADDY_SRC_RE = re.compile(r'const\s+SRC\s*=\s*["\']([^"\']+\.m3u8[^"\']*)["\']')
# Fallback: match any https *.m3u8 URL in page HTML
_ANY_M3U8_RE = re.compile(r'https?://[^\s\'"<>]+?\.m3u8[^\s\'"<>]*')

# Reusable HTTP client for direct playlist/segment fetches (no browser needed)
_direct_client = httpx.AsyncClient(
    timeout=15.0, follow_redirects=True, http2=True,
    limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
)


def _is_daddylive(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    return any(host == h or host.endswith("." + h) for h in _DADDY_HOSTS)


def _extract_daddy_channel_id(url: str) -> str | None:
    """Pulls the numeric channel id from daddylive URLs like /player/embed.php?id=31."""
    try:
        p = urlparse(url)
        qs = parse_qs(p.query)
        cid = (qs.get("id") or qs.get("stream") or [None])[0]
        if cid and cid.isdigit():
            return cid
        # Also match /stream/stream-31.php or /live/31 patterns in path
        m = re.search(r'(?:stream-|/live/|/livetv/|/premium)(\d+)', p.path)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


async def _resolve_daddylive_fast(embed_url: str) -> dict | None:
    """HTTP-only resolver for daddylive.app embed URLs.

    Chain: daddylive.app/player/embed.php?id=N -> downstream player page
    (worldsportz4u.cfd / gomstream.xyz) -> iframe daddyliveplayer.st/premiumtv/*.php?id=N
    The final page contains `const SRC = "https://edge.*.sbs/premiumN/index.m3u8"`.
    """
    cid = _extract_daddy_channel_id(embed_url)
    if not cid:
        return None
    player_url = _DADDY_PLAYER_TMPL.format(id=cid)
    try:
        r = await _direct_client.get(player_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            "Referer": "https://worldsportz4u.cfd/",
            "Accept": "text/html,application/xhtml+xml",
        })
    except Exception:
        return None
    if r.status_code != 200:
        return None
    body = r.text
    m = _DADDY_SRC_RE.search(body) or _ANY_M3U8_RE.search(body)
    if not m:
        return None
    m3u8 = m.group(1) if m.lastindex else m.group(0)
    return {
        "m3u8": m3u8,
        "context": None,  # No Playwright context needed
        "headers": {"referer": "https://daddyliveplayer.st/", "origin": "https://daddyliveplayer.st"},
    }


async def resolve_session(embed_url: str, timeout: int = 20) -> dict:
    """Opens a persistent browser context — kept alive so m3u8 session cookies stay valid.

    For daddylive.app URLs (no TLS-fingerprinted CDN; m3u8 is in page HTML as plain text),
    uses an HTTP-only fast path — no Playwright, no ad script delays."""
    now = time.time()
    cached = SESSIONS.get(embed_url)
    if cached and cached[3] > now:
        return {"m3u8": cached[0], "context": cached[1], "headers": cached[2]}

    # Clean up before creating a new one
    await _evict_expired_and_overflow()

    # Close old context for this URL if present (leak fix)
    if cached:
        _, old_ctx, _, _ = cached
        if old_ctx:
            asyncio.create_task(_close_ctx_safely(old_ctx))
        SESSIONS.pop(embed_url, None)

    # Fast path: daddylive.app family — no browser needed
    if _is_daddylive(embed_url):
        res = await _resolve_daddylive_fast(embed_url)
        if res:
            SESSIONS[embed_url] = (res["m3u8"], None, res["headers"], now + SESSION_TTL)
            return res
        raise HTTPException(status_code=404, detail="daddylive m3u8 not found")

    browser = await get_browser()
    ctx = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 720},
    )
    page = await ctx.new_page()
    found = {"m3u8": None, "headers": {}}

    def on_request(req):
        u = req.url
        if ".m3u8" in u and not found["m3u8"]:
            found["m3u8"] = u
            found["headers"] = dict(req.headers)

    page.on("request", on_request)

    try:
        await page.goto(embed_url, wait_until="domcontentloaded", timeout=timeout * 1000)
        try:
            await page.evaluate("document.querySelectorAll('button,video,[class*=play]').forEach(b=>{try{b.click()}catch(e){}})")
        except Exception:
            pass
        for _ in range(timeout * 2):
            if found["m3u8"]:
                await asyncio.sleep(1.0)
                break
            await asyncio.sleep(0.5)
    except Exception:
        pass

    if not found["m3u8"]:
        await _close_ctx_safely(ctx)
        raise HTTPException(status_code=404, detail="m3u8 not found")

    SESSIONS[embed_url] = (found["m3u8"], ctx, found["headers"], now + SESSION_TTL)
    return {"m3u8": found["m3u8"], "context": ctx, "headers": found["headers"]}


@app.on_event("startup")
async def _start_evictor():
    async def loop():
        while True:
            try:
                await _evict_expired_and_overflow()
            except Exception:
                pass
            await asyncio.sleep(60)
    asyncio.create_task(loop())


async def fetch_via_browser(ctx, url: str, orig_headers: dict):
    """Fetches via page.evaluate(fetch()) — the ONLY proven working path for embed.st.
    Must run inside the embed.st document context (not navigate).
    If ctx is None (daddylive fast path), falls back to direct HTTP with the
    headers hinted by resolve_session (Referer: daddyliveplayer.st etc)."""
    if ctx is None:
        ref = (orig_headers or {}).get("referer") or (orig_headers or {}).get("Referer") or "https://daddyliveplayer.st/"
        origin = (orig_headers or {}).get("origin") or (orig_headers or {}).get("Origin") or "https://daddyliveplayer.st"
        try:
            r = await _direct_client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
                "Referer": ref,
                "Origin": origin,
                "Accept": "*/*",
            })
            body = r.content
            class _R:
                def __init__(self, status, headers, body):
                    self.status = status
                    self.headers = dict(headers) if headers else {}
                    self._body = body
                async def text(self): return self._body.decode('utf-8', errors='replace')
                async def body(self): return self._body
            return _R(r.status_code, r.headers, body)
        except Exception as e:
            class _E:
                status = 502
                headers = {}
                def __init__(self, msg): self._msg = msg
                async def text(self): return self._msg
                async def body(self): return self._msg.encode()
            return _E(str(e))
    pages = ctx.pages
    page = None
    for p in pages:
        if 'embed.st' in (p.url or ''):
            page = p
            break
    if not page:
        page = pages[0] if pages else await ctx.new_page()
    try:
        # Use arrayBuffer + chunked base64 to avoid stack overflow on big bodies
        # Try XHR first (looser CORS for simple requests), fallback to fetch
        result = await page.evaluate(
            """async (url) => {
                const toB64 = (bytes) => {
                    let binary = '';
                    const CHUNK = 32768;
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                    }
                    return btoa(binary);
                };
                // Try XHR with arraybuffer response
                try {
                    const xhrResult = await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.open('GET', url, true);
                        xhr.responseType = 'arraybuffer';
                        xhr.onload = () => resolve({
                            ok: true, via: 'xhr',
                            status: xhr.status,
                            headers: xhr.getAllResponseHeaders().split('\\r\\n').reduce((a,l)=>{const i=l.indexOf(':');if(i>0)a[l.substring(0,i).trim().toLowerCase()]=l.substring(i+1).trim();return a;},{}),
                            body_b64: toB64(new Uint8Array(xhr.response)),
                        });
                        xhr.onerror = () => resolve({ok:false, via:'xhr', error:'network'});
                        xhr.ontimeout = () => resolve({ok:false, via:'xhr', error:'timeout'});
                        xhr.timeout = 15000;
                        xhr.send();
                    });
                    if (xhrResult.ok && xhrResult.status >= 200 && xhrResult.status < 300) return xhrResult;
                } catch(e) {}
                // Fallback: fetch with no-cors (opaque — only useful if server does CORS)
                try {
                    const r = await fetch(url, {mode: 'cors', credentials: 'include'});
                    const buf = await r.arrayBuffer();
                    return {
                        ok: true, via: 'fetch',
                        status: r.status,
                        headers: Object.fromEntries(r.headers.entries()),
                        body_b64: toB64(new Uint8Array(buf)),
                    };
                } catch (e) {
                    return {ok: false, via: 'fetch', status: 0, error: String(e)};
                }
            }""",
            url,
        )

        class _R:
            def __init__(self, status, headers, body):
                self.status = status
                self.headers = headers or {}
                self._body = body
            async def text(self): return self._body.decode('utf-8', errors='replace')
            async def body(self): return self._body

        import base64
        if not result.get("ok"):
            return _R(502, {}, (result.get("error","")).encode())
        return _R(result["status"], result.get("headers", {}), base64.b64decode(result["body_b64"]))
    except Exception as e:
        class _E:
            status = 500
            headers = {}
            def __init__(self, msg): self._msg = msg
            async def text(self): return self._msg
            async def body(self): return self._msg.encode()
        return _E(str(e))


@app.get("/resolve")
async def resolve(url: str = Query(...)):
    try:
        res = await resolve_session(url)
        # Build proxied m3u8 URL that goes through this service
        proxied = f"/stream?embed={quote(url, safe='')}"
        return {"m3u8_proxy": proxied, "m3u8_direct": res["m3u8"]}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.head("/stream")
async def stream_m3u8_head(embed: str = Query(...)):
    return Response(status_code=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/vnd.apple.mpegurl",
    })


@app.get("/stream")
async def stream_m3u8(embed: str = Query(...)):
    try:
        res = await resolve_session(embed)
    except HTTPException as e:
        return Response(content=f"# resolve failed: {e.detail}", media_type="application/vnd.apple.mpegurl", status_code=e.status_code)

    r = await fetch_via_browser(res["context"], res["m3u8"], res["headers"])
    if r.status != 200:
        return Response(content=f"# upstream {r.status}", media_type="application/vnd.apple.mpegurl", status_code=502)

    body = await r.text()
    base = res["m3u8"].rsplit("/", 1)[0] + "/"
    out_lines = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            out_lines.append(line)
            continue
        absolute = s if s.startswith("http") else urljoin(base, s)
        out_lines.append(f"/seg?embed={quote(embed, safe='')}&url={quote(absolute, safe='')}")
    return Response(content="\n".join(out_lines), media_type="application/vnd.apple.mpegurl", headers={
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
    })


# Lightweight segment-fetching HTTP client (reused across requests)
_seg_client = httpx.AsyncClient(timeout=20.0, follow_redirects=True, http2=True, limits=httpx.Limits(max_connections=200, max_keepalive_connections=100))


def _is_playlist(url: str, ct: str = "") -> bool:
    """Only playlists need the browser context — media segments are URL-signed."""
    return url.endswith(".m3u8") or "mpegurl" in ct


async def _fetch_segment_direct(url: str) -> httpx.Response:
    """Direct HTTP fetch — much faster than page.evaluate for media segments."""
    return await _seg_client.get(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        "Referer": "https://embed.st/",
        "Origin": "https://embed.st",
        "Accept": "*/*",
    })


def _segment_media_type(url: str, upstream_ct: str) -> str:
    """Force correct Content-Type for HLS segments.
    TikTok CDN disguises video segments as image/webp — HLS.js chokes on that."""
    low = url.lower()
    if ".m3u8" in low or "mpegurl" in upstream_ct:
        return "application/vnd.apple.mpegurl"
    if ".ts" in low or ".tiktokcdn.com" in low or "tplv-tiktokx-origin" in low:
        return "video/mp2t"
    if ".m4s" in low or ".mp4" in low:
        return "video/mp4"
    if ".aac" in low:
        return "audio/aac"
    if ".key" in low:
        return "application/octet-stream"
    return upstream_ct or "application/octet-stream"


@app.head("/seg")
async def stream_segment_head(embed: str = Query(...), url: str = Query(...)):
    # HLS.js and video player sometimes send HEAD to probe. Respond cheaply.
    return Response(
        status_code=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Type": _segment_media_type(url, ""),
            "Accept-Ranges": "bytes",
        },
    )


def _ref_origin_for(embed: str) -> tuple[str, str]:
    """Pick the correct Referer/Origin for upstream segment fetches based on the embed source."""
    if _is_daddylive(embed):
        return "https://daddyliveplayer.st/", "https://daddyliveplayer.st"
    return "https://embed.st/", "https://embed.st"


@app.get("/seg")
async def stream_segment(embed: str = Query(...), url: str = Query(...)):
    seg_ref, seg_origin = _ref_origin_for(embed)
    # Fast path: segments on signed CDNs (tiktokcdn.com, etc.) don't need browser context
    if not url.endswith(".m3u8"):
        try:
            # TRUE streaming — don't buffer in memory
            req = _seg_client.build_request("GET", url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
                "Referer": seg_ref,
                "Origin": seg_origin,
                "Accept": "*/*",
            })
            upstream = await _seg_client.send(req, stream=True)
            if upstream.status_code == 200:
                async def passthrough():
                    try:
                        async for chunk in upstream.aiter_bytes(chunk_size=64 * 1024):
                            yield chunk
                    finally:
                        await upstream.aclose()
                upstream_ct = upstream.headers.get("content-type", "")
                return StreamingResponse(
                    passthrough(),
                    media_type=_segment_media_type(url, upstream_ct),
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        # CF edge cache 10min (tiktokcdn segments valid for ~4h);
                        # Browser cache 60s so revisits don't re-fetch
                        "Cache-Control": "public, max-age=60, s-maxage=600",
                        "Accept-Ranges": "bytes",
                    },
                )
            else:
                await upstream.aclose()
        except Exception:
            pass

    # Slow path (sub-playlists): must go through browser context
    try:
        res = await resolve_session(embed)
    except HTTPException as e:
        return Response(status_code=e.status_code)

    r = await fetch_via_browser(res["context"], url, res["headers"])
    if r.status != 200:
        return Response(status_code=r.status)

    ct = r.headers.get("content-type", "application/octet-stream")
    if _is_playlist(url, ct):
        text = await r.text()
        base = url.rsplit("/", 1)[0] + "/"
        out = []
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                out.append(line)
                continue
            absolute = s if s.startswith("http") else urljoin(base, s)
            out.append(f"/seg?embed={quote(embed, safe='')}&url={quote(absolute, safe='')}")
        return Response(content="\n".join(out), media_type="application/vnd.apple.mpegurl", headers={
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        })

    body = await r.body()
    return Response(content=body, media_type=ct, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/debug")
async def debug(url: str = Query(...)):
    try:
        res = await resolve_session(url)
        # Also test fetching the m3u8
        r = await fetch_via_browser(res["context"], res["m3u8"], res["headers"])
        body_preview = (await r.text())[:300]
        return {"m3u8": res["m3u8"], "headers": res["headers"], "fetch_status": r.status, "body_preview": body_preview}
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/health")
async def health():
    return {"ok": True, "sessions": len(SESSIONS)}


@app.get("/")
async def root():
    return {"service": "stream-resolver", "endpoints": ["/resolve", "/stream", "/seg", "/debug", "/health"]}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7788))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
