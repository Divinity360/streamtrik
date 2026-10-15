# StreamTrik

Free HD live sports streaming aggregator with ad-free playback via headless Chromium m3u8 resolver.

## Stack
- Frontend: static HTML + HLS.js
- Backend: nginx + proxy.js (CORS + API proxy + SEO SSR) + Python resolver (Playwright)
- CDN: Cloudflare (edge-cached segments)
- Deploy: PM2 + Docker

## Files
- `index.html` — main SPA
- `proxy.js` — Node proxy for /api, /match SSR pages, /sitemap.xml
- `resolver.py` — Python Playwright service: extracts m3u8 from embed.st, proxies through /stream /seg
- `nginx-streamtrik.conf` — nginx vhost
- `deploy.sh` — tar + scp + remote install
- `robots.txt`, `llms.txt` — AI-friendly SEO
