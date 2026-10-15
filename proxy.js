const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 8765;

function fetchUrl(targetUrl, res, depth = 0) {
  const parsed = url.parse(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    },
    timeout: 20000,
  };

  const req = lib.request(opts, (upstream) => {
    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location && depth < 5) {
      const redirect = upstream.headers.location.startsWith('http')
        ? upstream.headers.location
        : `${parsed.protocol}//${parsed.host}${upstream.headers.location}`;
      return fetchUrl(redirect, res, depth + 1);
    }

    const contentType = upstream.headers['content-type'] || '';
    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
                   targetUrl.includes('.m3u8') || targetUrl.includes('playlist') || targetUrl.includes('index');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3U8) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      let body = '';
      upstream.on('data', chunk => body += chunk.toString());
      upstream.on('end', () => {
        // Rewrite segment URLs to go through proxy
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = body.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          // Absolute URL
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            return `http://localhost:${PORT}/proxy?url=${encodeURIComponent(trimmed)}`;
          }
          // Relative URL
          const abs = baseUrl + trimmed;
          return `http://localhost:${PORT}/proxy?url=${encodeURIComponent(abs)}`;
        }).join('\n');
        res.statusCode = 200;
        res.end(rewritten);
      });
    } else {
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
      res.statusCode = upstream.statusCode || 200;
      upstream.pipe(res);
    }
  });

  req.on('error', (err) => {
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 502;
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 504;
      res.end(JSON.stringify({ error: 'Timeout' }));
    }
  });

  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  // Health check
  if (parsed.pathname === '/') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('SportStream Proxy OK');
    return;
  }

  if (parsed.pathname === '/proxy') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      res.statusCode = 400;
      res.end('Missing ?url= parameter');
      return;
    }
    console.log(`[PROXY] ${decodeURIComponent(targetUrl).substring(0, 80)}`);
    fetchUrl(decodeURIComponent(targetUrl), res);
    return;
  }

  // Live API proxy — forwards to tvapp1 schedule API with CORS enabled
  if (parsed.pathname.startsWith('/api/')) {
    const upstreamPath = parsed.pathname.substring(4); // strip "/api"
    const upstreamUrl = 'https://api-backups.handleapi.win' + upstreamPath + (req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '');
    const parsedTarget = url.parse(upstreamUrl);
    const req3 = https.request({
      hostname: parsedTarget.hostname,
      port: 443,
      path: parsedTarget.path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (upstream) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.statusCode = upstream.statusCode || 200;
      upstream.pipe(res);
    });
    req3.on('error', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 502;
      res.end('{"error":"upstream failed"}');
    });
    req3.on('timeout', () => { req3.destroy(); res.setHeader('Access-Control-Allow-Origin','*'); res.statusCode=504; res.end('{"error":"timeout"}'); });
    req3.end();
    return;
  }

  // Pre-flight check — lightweight HEAD to see if the embed page is reachable
  if (parsed.pathname === '/check') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      res.statusCode = 400;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end('{"ok":false}');
      return;
    }
    const decoded = decodeURIComponent(targetUrl);
    const parsedTarget = url.parse(decoded);
    const lib = parsedTarget.protocol === 'https:' ? https : http;
    const req2 = lib.request({
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
      path: parsedTarget.path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-512' },
      timeout: 6000,
    }, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { if (body.length < 2048) body += chunk.toString(); });
      upstream.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        // Any 2xx/3xx means the embed is up (streams work even with ads)
        const alive = upstream.statusCode >= 200 && upstream.statusCode < 400;
        res.end(JSON.stringify({ ok: alive, status: upstream.statusCode, hasVideo: alive }));
      });
    });
    req2.on('error', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 200;
      res.end('{"ok":false,"reason":"network"}');
    });
    req2.on('timeout', () => {
      req2.destroy();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 200;
      res.end('{"ok":false,"reason":"timeout"}');
    });
    req2.end();
    return;
  }

  // ===== SEO: pre-rendered match pages for Googlebot + direct hits =====
  // Pattern: /match/{slug} — slug can be any URL-safe match id
  if (parsed.pathname && parsed.pathname.startsWith('/match/')) {
    const slug = parsed.pathname.substring(7).split('/')[0];
    return serveMatchPage(slug, parsed.query || {}, res);
  }

  // Dynamic sitemap — refreshed from tvapp1 API
  if (parsed.pathname === '/sitemap.xml') {
    return serveSitemap(res);
  }

  res.statusCode = 404;
  res.end('Not found');
});

// ===== Match page rendering =====
let MATCH_CACHE = { data: [], expires: 0 };
async function getMatches() {
  const now = Date.now();
  if (MATCH_CACHE.data.length && MATCH_CACHE.expires > now) return MATCH_CACHE.data;
  return new Promise((resolve) => {
    https.get('https://api-backups.handleapi.win/matches/today', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (r) => {
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          MATCH_CACHE = { data, expires: now + 300000 }; // 5min cache
          resolve(data);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([])).on('timeout', () => resolve([]));
  });
}

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

async function serveMatchPage(slug, query, res) {
  const matches = await getMatches();
  const match = matches.find((m) => m.id === slug || slugify(m.title) === slug || slugify(m.title).includes(slug));
  const now = Date.now();

  if (!match) {
    // Still serve a page (SEO fallback) — may be past event or typo
    const title = decodeURIComponent(slug.replace(/-/g, ' ')).replace(/\b\w/g, (c) => c.toUpperCase());
    return sendMatchHTML(res, {
      title: title + ' Live Stream Free HD',
      description: `Watch ${title} live stream free in HD on StreamTrik. Multiple server options, no signup required.`,
      slug, team_a: '', team_b: '', competition: 'Live Sport', poster: '', startTime: 0, isLive: false,
    });
  }

  const [team_a, team_b] = (match.title || '').split(/\s+vs\.?\s+/i);
  const poster = match.poster ? ('https://streamed.pk' + match.poster) : '';
  const startTime = match.date || 0;
  const isLive = startTime > 0 && startTime < now + 900000 && startTime > now - 3 * 3600000;
  sendMatchHTML(res, {
    title: match.title,
    description: `Watch ${match.title} live stream free in HD on StreamTrik. Multiple server options, no signup required.`,
    slug: match.id || slug,
    team_a: team_a || '',
    team_b: team_b || '',
    competition: match.category || 'Live Sport',
    poster,
    startTime,
    isLive,
    sport: match.category || 'football',
  });
}

function sendMatchHTML(res, m) {
  const canonical = `https://streamtrik.com/match/${m.slug}`;
  // Dual schema (foot24.st pattern) — SportsEvent + WebPage linked via mainEntity
  const eventSchema = {
    '@context': 'https://schema.org',
    '@id': canonical + '#event',
    '@type': 'SportsEvent',
    name: m.title,
    description: m.description,
    url: canonical,
    image: m.poster || 'https://streamtrik.com/og-cover.png',
    sport: m.sport || 'Football',
    isAccessibleForFree: true,
    eventStatus: m.isLive ? 'https://schema.org/EventScheduled' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    startDate: m.startTime ? new Date(m.startTime).toISOString() : undefined,
    endDate: m.startTime ? new Date(m.startTime + 2.5 * 3600000).toISOString() : undefined,
    location: { '@type': 'VirtualLocation', url: canonical },
    organizer: { '@type': 'Organization', name: 'StreamTrik', url: 'https://streamtrik.com/' },
    performer: m.team_a && m.team_b ? [
      { '@type': 'SportsTeam', name: m.team_a },
      { '@type': 'SportsTeam', name: m.team_b },
    ] : undefined,
  };
  const pageSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${m.title} Live Stream Free HD`,
    description: m.description,
    url: canonical,
    isPartOf: { '@id': 'https://streamtrik.com/#website' },
    mainEntity: { '@id': canonical + '#event' },
  };
  const schemaStr = JSON.stringify(eventSchema).replace(/</g, '\\u003c') + '</script>\n<script type="application/ld+json">' + JSON.stringify(pageSchema).replace(/</g, '\\u003c');
  const kw = [m.team_a, m.team_b, m.competition, 'live stream', 'free hd', 'watch online', '2026', 'streamtrik'].filter(Boolean).join(', ');
  const liveTxt = m.isLive ? 'LIVE NOW' : (m.startTime ? ('Starts ' + new Date(m.startTime).toUTCString()) : 'Scheduled');
  const bgCss = m.poster ? `background:#000 url('${m.poster}') center/cover no-repeat` : 'background:#0a0a0c';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)} Live Stream Free HD · StreamTrik</title>
<meta name="description" content="${esc(m.description)}">
<meta name="keywords" content="${esc(kw)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="google-site-verification" content="wXAQ_Q19wteuIgOkV_ueVeB7X2oSsOYfRCNEAUA0eF4">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.ico">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(m.title)} Live Stream Free">
<meta property="og:description" content="${esc(m.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${m.poster || 'https://streamtrik.com/og-cover.png'}">
<meta property="og:site_name" content="StreamTrik">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(m.title)} Live Stream Free">
<meta name="twitter:description" content="${esc(m.description)}">
<meta name="twitter:image" content="${m.poster || 'https://streamtrik.com/og-cover.png'}">
<script type="application/ld+json">${schemaStr}</script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;${bgCss}}
  body::before{content:"";position:fixed;inset:0;background:linear-gradient(180deg,rgba(10,10,12,.6),rgba(10,10,12,.95));z-index:0}
  main{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:40px 24px;min-height:100vh;display:flex;flex-direction:column;justify-content:center}
  .brand{display:inline-block;background:#f43f5e;color:#fff;padding:6px 14px;border-radius:20px;font-size:.75rem;font-weight:800;letter-spacing:1.5px;margin-bottom:24px;align-self:flex-start}
  h1{font-size:clamp(2rem,5vw,3.5rem);font-weight:900;line-height:1.1;letter-spacing:-1px;margin-bottom:16px}
  .live{display:inline-flex;align-items:center;gap:8px;background:#f43f5e;padding:6px 14px;border-radius:4px;font-size:.75rem;font-weight:800;letter-spacing:1.5px;margin-bottom:20px}
  .live::before{content:"";width:6px;height:6px;background:#fff;border-radius:50%;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .meta{color:rgba(255,255,255,.65);font-size:.95rem;margin-bottom:28px}
  .cta{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#000;padding:16px 32px;border-radius:32px;font-size:1.05rem;font-weight:800;text-decoration:none;transition:transform .2s;align-self:flex-start}
  .cta:hover{transform:scale(1.05)}
  .about{margin-top:48px;padding:28px;background:rgba(255,255,255,.06);border-radius:16px;border:1px solid rgba(255,255,255,.1);line-height:1.7;color:rgba(255,255,255,.85)}
  .about h2{font-size:1.3rem;margin-bottom:14px;color:#fff}
  footer{margin-top:40px;color:rgba(255,255,255,.4);font-size:.8rem;text-align:center}
</style>
</head>
<body>
<main>
  <span class="brand">⚡ STREAMTRIK</span>
  <span class="live">● ${liveTxt}</span>
  <h1>${esc(m.title)} Live Stream</h1>
  <div class="meta">${esc(m.competition)} · Free HD · Multiple server options</div>
  <a class="cta" href="/?match=${encodeURIComponent(m.slug)}" id="watch">▶ Watch ${esc(m.title)} Live Now</a>
  <section class="about">
    <h2>Watch ${esc(m.title)} Free in HD</h2>
    <p>Looking for a free live stream of ${esc(m.title)}? StreamTrik gives you multiple HD server options for ${esc(m.team_a || m.title)}${m.team_b ? ' vs ' + esc(m.team_b) : ''}, no signup required. Our streams are updated in real-time with no buffering and no popup ads.</p>
    <p style="margin-top:12px">${esc(m.competition)} coverage is backed by multiple fallback servers so you never miss a moment of the action. Just click watch and the match starts instantly.</p>
    <p style="margin-top:12px"><strong>What's included:</strong> HD video, multiple language commentary options (English, Spanish, German, Italian), automatic quality adjustment, mobile-friendly player.</p>
    <p style="margin-top:12px"><strong>How to watch:</strong> Simply click the "Watch Now" button above. The stream loads instantly in the StreamTrik player. If one server lags, switch to another with one click.</p>
  </section>
  <footer>StreamTrik · Free Live Sports Streaming · ${new Date().getFullYear()}</footer>
</main>
<script>
  // Users land here → auto-redirect to full app with match pre-selected
  // Googlebot and other crawlers see the full HTML content first
  var ua = (navigator.userAgent || '').toLowerCase();
  var isBot = /bot|crawler|spider|slurp|googlebot|bingbot|duckduckbot|baiduspider|yandex|facebookexternalhit|twitterbot/.test(ua);
  if (!isBot) {
    setTimeout(function() { window.location.replace('/?match=${encodeURIComponent(m.slug)}'); }, 500);
  }
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.end(html);
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function serveSitemap(res) {
  const matches = await getMatches();
  const now = new Date().toISOString();
  const urls = [
    { loc: 'https://streamtrik.com/', changefreq: 'hourly', priority: 1.0 },
    { loc: 'https://streamtrik.com/channels/sky-sports-main-event', changefreq: 'daily', priority: 0.8 },
    { loc: 'https://streamtrik.com/channels/tnt-sports-1', changefreq: 'daily', priority: 0.8 },
    { loc: 'https://streamtrik.com/channels/nfl-network', changefreq: 'daily', priority: 0.8 },
    { loc: 'https://streamtrik.com/channels/nba-tv', changefreq: 'daily', priority: 0.8 },
    { loc: 'https://streamtrik.com/channels/espn', changefreq: 'daily', priority: 0.8 },
    { loc: 'https://streamtrik.com/leagues/premier-league', changefreq: 'daily', priority: 0.9 },
    { loc: 'https://streamtrik.com/leagues/champions-league', changefreq: 'daily', priority: 0.9 },
    { loc: 'https://streamtrik.com/leagues/nfl', changefreq: 'daily', priority: 0.9 },
    { loc: 'https://streamtrik.com/leagues/nba', changefreq: 'daily', priority: 0.9 },
  ];
  for (const m of matches.slice(0, 500)) {
    if (!m.id) continue;
    const image = (m.teams && m.teams.home && m.teams.home.badge) ? ('https://streamed.pk/api/images/badge/' + m.teams.home.badge + '.webp') : null;
    urls.push({ loc: `https://streamtrik.com/match/${encodeURIComponent(m.id)}`, lastmod: now, changefreq: 'hourly', priority: 0.95, image });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority>${u.image ? `<image:image><image:loc>${u.image}</image:loc></image:image>` : ''}</url>`).join('\n')}
</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.end(xml);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅  SportStream Proxy running at http://localhost:${PORT}`);
  console.log(`   Routes stream requests through CORS-enabled proxy`);
  console.log(`   Keep this terminal open while streaming\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the existing process and retry.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
