#!/usr/bin/env node
/**
 * StreamTrik auto-indexer
 *
 * Pulls today's match list, builds canonical URLs, submits them to:
 *   - IndexNow (Bing + Yandex + Seznam + Naver) — instant, no auth
 *   - Google Indexing API — if GOOGLE_SERVICE_ACCOUNT_JSON is set
 *
 * Run via cron every 15 min, or ad-hoc after deploys.
 *
 * Env vars (store in ~/.streamtrik-env, source it before running):
 *   INDEXNOW_KEY=<32-char-hex>
 *   GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json (optional, skipped if missing)
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const SITE = 'https://streamtrik.com';
const INDEXNOW_KEY = process.env.INDEXNOW_KEY;
const GOOGLE_SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const DAILY_LIMIT_PATH = '/tmp/streamtrik-indexer-count.json';

if (!INDEXNOW_KEY) {
  console.error('[indexer] INDEXNOW_KEY env var not set');
  process.exit(1);
}

// ---------- fetch helper ----------
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'StreamTrik-Indexer/1.0' }, timeout: 15000 }, (r) => {
      let b = '';
      r.on('data', (c) => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function postJSON(host, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 15000,
    }, (r) => {
      let b = '';
      r.on('data', (c) => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------- IndexNow ----------
async function pushIndexNow(urls) {
  if (!urls.length) return;
  // IndexNow allows up to 10k URLs per request to one domain
  const payload = {
    host: 'streamtrik.com',
    key: INDEXNOW_KEY,
    keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  };
  const res = await postJSON('api.indexnow.org', '/indexnow', payload);
  console.log(`[IndexNow] ${urls.length} URLs → HTTP ${res.status}`);
  if (res.status >= 400) console.log(`  body: ${res.body.substring(0, 300)}`);
}

// ---------- Google Indexing API ----------
async function getGoogleAccessToken(sa) {
  // Build + sign a JWT (RS256) and exchange it for an access_token
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) throw new Error('Google auth failed: ' + res.body);
  return parsed.access_token;
}

async function pushGoogleIndexing(urls, sa) {
  if (!urls.length || !sa) return;
  // Google Indexing API — URL_UPDATED notifications
  // Daily quota: 200 URLs per project (standard)
  const token = await getGoogleAccessToken(sa);
  let ok = 0, fail = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const countFile = DAILY_LIMIT_PATH;
  let used = 0;
  try {
    const c = JSON.parse(fs.readFileSync(countFile, 'utf8'));
    if (c.date === todayStr) used = c.count;
  } catch (e) {}
  const budget = Math.max(0, 180 - used); // leave headroom
  if (budget === 0) {
    console.log(`[Google] Daily quota reached (${used}/200), skipping`);
    return;
  }
  const toPush = urls.slice(0, budget);
  console.log(`[Google] Pushing ${toPush.length} URLs (budget ${budget}/day)`);

  for (const url of toPush) {
    try {
      const r = await postJSON('indexing.googleapis.com', '/v3/urlNotifications:publish', {
        url, type: 'URL_UPDATED',
      }, { Authorization: `Bearer ${token}` });
      if (r.status === 200) ok++;
      else { fail++; if (fail <= 3) console.log(`  fail ${r.status}: ${r.body.substring(0, 200)}`); }
    } catch (e) { fail++; }
  }
  fs.writeFileSync(countFile, JSON.stringify({ date: todayStr, count: used + toPush.length }));
  console.log(`[Google] done — ${ok} ok, ${fail} fail`);
}

// ---------- URL discovery ----------
async function discoverUrls() {
  const matches = await fetchJSON(`${SITE}/api/matches/today`);
  const urls = [`${SITE}/`];
  for (const m of matches) {
    if (!m.id) continue;
    urls.push(`${SITE}/match/${encodeURIComponent(m.id)}`);
  }
  return urls;
}

// ---------- main ----------
(async () => {
  console.log('[indexer] start', new Date().toISOString());
  let urls = [];
  try {
    urls = await discoverUrls();
    console.log(`[indexer] discovered ${urls.length} URLs`);
  } catch (e) {
    console.error('[indexer] discover failed:', e.message);
    process.exit(1);
  }

  await pushIndexNow(urls).catch((e) => console.error('[IndexNow] error:', e.message));

  if (GOOGLE_SA_PATH && fs.existsSync(GOOGLE_SA_PATH)) {
    try {
      const sa = JSON.parse(fs.readFileSync(GOOGLE_SA_PATH, 'utf8'));
      await pushGoogleIndexing(urls, sa);
    } catch (e) {
      console.error('[Google] error:', e.message);
    }
  } else {
    console.log('[Google] skipped (set GOOGLE_SERVICE_ACCOUNT_JSON)');
  }

  console.log('[indexer] done');
})();
