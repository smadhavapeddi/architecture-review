'use strict';

/**
 * Architecture reviewer
 * - Zero npm dependencies (Node 20+ built-ins only).
 * - Sign-in with a signed, HttpOnly session cookie.
 * - Keeps the model access key on the server and calls DigitalOcean Serverless Inference.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SYSTEM_PROMPT, REVIEW_SCHEMA, normalizeReview, extractJson } = require('./lib/review');

// ---------- Configuration ----------
const PORT = Number(process.env.PORT || 8080);
const APP_USER = process.env.APP_USER || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY || '';
const MODEL = process.env.MODEL || 'glm-5.3-flash';
const BASE_URL = (process.env.INFERENCE_BASE_URL || 'https://inference.do-ai.run/v1').replace(/\/+$/, '');

if (!APP_USER || !APP_PASSWORD) {
  console.error('APP_USER and APP_PASSWORD must be set. Refusing to start without sign-in configured.');
  process.exit(1);
}

let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set. Using a random one, so everyone is signed out on each restart.');
}
if (!MODEL_ACCESS_KEY) {
  console.warn('MODEL_ACCESS_KEY is not set. Sign-in works, but reviews will fail until it is added.');
}

const SESSION_COOKIE = 'ar_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 8000;
const MAX_IMAGE_DATAURL_CHARS = 9 * 1024 * 1024;
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

// ---------- Small helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');

function makeSession() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${hmac(exp)}`;
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function isAuthed(req) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = hmac(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, value, maxAgeSec) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  const h = req.headers;
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return String(h['do-connecting-ip'] || h['cf-connecting-ip'] || fwd || req.socket.remoteAddress || 'unknown');
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------- Rate limiting (in memory, single instance) ----------
const buckets = new Map();
function hit(key, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length;
}
function count(key, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, arr);
  return arr.length;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const fresh = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length) buckets.set(k, fresh);
    else buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 30;
const REVIEW_WINDOW = 10 * 60 * 1000;
const REVIEW_MAX_PER_IP = 12;
const REVIEW_MAX_GLOBAL_HOURLY = 150;

// ---------- Static files ----------
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, filePath, contentType, cache, extraHeaders = {}) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cache, ...extraHeaders });
    res.end(data);
  });
}

// Assets are revalidated on every load (ETag), so a new deploy is picked up immediately
// instead of leaving browsers with an old script that no longer matches the server.
function serveAsset(req, res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/assets\//, ''));
  const full = path.normalize(path.join(ASSETS_DIR, rel));
  if (!full.startsWith(ASSETS_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    serveFile(res, full, MIME[path.extname(full)] || 'application/octet-stream', 'no-cache', { ETag: etag });
  });
}

// ---------- Model call ----------
async function callInference(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 280 * 1000);
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MODEL_ACCESS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await r.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      /* leave null */
    }
    return { status: r.status, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

function messageText(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

// ---------- Model availability check (cached) ----------
let modelCache = { at: 0, ids: null };

function stateFromIds(ids) {
  if (!ids || !ids.length) return { state: 'unknown' };
  if (ids.includes(MODEL)) return { state: 'ok' };
  const hints = ids.filter((id) => /glm|kimi|vl|qwen|gemma|llama|deepseek/i.test(id)).slice(0, 8);
  return { state: 'missing', hints };
}

async function checkModel() {
  if (!MODEL_ACCESS_KEY) return { state: 'nokey' };
  if (modelCache.ids && Date.now() - modelCache.at < 10 * 60 * 1000) return stateFromIds(modelCache.ids);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${MODEL_ACCESS_KEY}` }, signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) return { state: 'badkey' };
    if (!r.ok) return { state: 'unknown' };
    const j = await r.json();
    const ids = (Array.isArray(j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean);
    modelCache = { at: Date.now(), ids };
    return stateFromIds(ids);
  } catch (_) {
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Review jobs ----------
// Reviews can take a minute or more. Running them as background jobs that the browser polls
// keeps every HTTP request short, so gateway timeouts cannot cut a review off.
const jobs = new Map();
const MAX_RUNNING_JOBS = 3;
const runningJobs = () => [...jobs.values()].filter((j) => j.status === 'running').length;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > 20 * 60 * 1000) jobs.delete(id);
}, 60 * 1000).unref();

function upstreamDetail(result) {
  const j = result.json;
  let m = j && (j.error && (j.error.message || j.error)) || (j && j.message) || result.raw || '';
  if (typeof m !== 'string') m = JSON.stringify(m);
  return m.replace(/\s+/g, ' ').trim().slice(0, 220);
}

const fail = (status, error, detail) => ({ ok: false, status, error, detail: detail || '' });

async function performReview({ description, image }) {
  const userText = description
    ? `Customer's description of the setup:\n${description}${image ? '\n\nA diagram is attached. Use it together with the description.' : ''}`
    : 'No written description was provided. Base the review on the attached diagram.';

  const userContent = image
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: image } },
      ]
    : userText;

  const base = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 9000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  };

  const started = Date.now();
  try {
    // First try strict structured output. Some models reject it, so fall back to prompt-only JSON.
    let result = await callInference({
      ...base,
      response_format: { type: 'json_schema', json_schema: { name: 'architecture_review', strict: true, schema: REVIEW_SCHEMA } },
    });
    let structured = true;
    if (result.status === 400 || result.status === 422) {
      structured = false;
      result = await callInference(base);
    }

    const choice = result.json && result.json.choices && result.json.choices[0];
    const finish = choice && choice.finish_reason;
    const usage = result.json && result.json.usage && result.json.usage.total_tokens;
    console.log(
      `review model=${MODEL} status=${result.status} structured=${structured} image=${Boolean(image)} finish=${finish || '-'} tokens=${usage || '-'} ms=${Date.now() - started}`
    );

    if (result.status === 401 || result.status === 403) {
      return fail(502, 'The model access key was rejected. Check MODEL_ACCESS_KEY.', upstreamDetail(result));
    }
    if (result.status === 404) {
      return fail(502, `Model "${MODEL}" was not found. Check the MODEL setting against GET /v1/models.`, upstreamDetail(result));
    }
    if (result.status === 429) {
      return fail(429, 'The model is rate limited right now. Try again in a minute.', upstreamDetail(result));
    }
    if (result.status < 200 || result.status >= 300) {
      console.error('inference error body:', String(result.raw).slice(0, 500));
      return fail(
        502,
        image
          ? 'The model rejected this request. If it does not accept images, set MODEL to a vision model, or describe the setup in text instead.'
          : 'The model could not process this request.',
        `HTTP ${result.status}: ${upstreamDetail(result)}`
      );
    }

    // Prefer the final answer. Some reasoning models put output in a separate field.
    const msg = (choice && choice.message) || {};
    let content = messageText(result.json);
    if (!content.trim()) content = String(msg.reasoning_content || msg.reasoning || '');
    const parsed = extractJson(content);
    if (!parsed) {
      console.error('unparseable model output (finish=%s, len=%d): %s', finish, content.length, content.slice(0, 300));
      if (finish === 'length') {
        return fail(502, 'The model ran out of output space before it finished. Try a simpler diagram or a shorter description.', 'finish_reason=length');
      }
      return fail(502, 'The model returned an answer in an unexpected format. Try again.', content ? `Started with: ${content.slice(0, 80).replace(/\s+/g, ' ')}` : 'Empty answer');
    }

    const review = normalizeReview(parsed);
    if (!review.findings.length && !review.summary) {
      return fail(502, 'The model returned an empty review. Add more detail and try again.');
    }
    return { ok: true, review, model: MODEL, tookMs: Date.now() - started };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return fail(504, 'The model took too long. Try a smaller diagram or a shorter description.');
    }
    console.error('review failed:', err && err.message);
    return fail(502, 'Could not reach the model. Try again in a moment.', String(err && err.message).slice(0, 160));
  }
}

async function handleReview(req, res) {
  const ip = clientIp(req);
  if (count(`review:${ip}`, REVIEW_WINDOW) >= REVIEW_MAX_PER_IP || count('review:all', 60 * 60 * 1000) >= REVIEW_MAX_GLOBAL_HOURLY) {
    return sendJson(res, 429, { error: 'Too many reviews in a short time. Wait a few minutes and try again.' }, { 'Retry-After': '300' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.status === 413 ? 'The diagram is too large. Use an image under 8 MB.' : 'Invalid request.' });
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const image = typeof body.image === 'string' ? body.image : '';

  if (!description && !image) {
    return sendJson(res, 400, { error: 'Upload a diagram or describe the setup first.' });
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return sendJson(res, 400, { error: `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.` });
  }
  if (image && (image.length > MAX_IMAGE_DATAURL_CHARS || !IMAGE_RE.test(image))) {
    return sendJson(res, 400, { error: 'The diagram must be a PNG, JPEG, WebP, or GIF image under 8 MB.' });
  }
  if (!MODEL_ACCESS_KEY) {
    return sendJson(res, 503, { error: 'The model access key is not configured on the server.' });
  }
  if (runningJobs() >= MAX_RUNNING_JOBS) {
    return sendJson(res, 429, { error: 'The reviewer is busy with other reviews. Try again in a minute.' }, { 'Retry-After': '60' });
  }

  hit(`review:${ip}`, REVIEW_WINDOW);
  hit('review:all', 60 * 60 * 1000);

  const id = crypto.randomBytes(16).toString('hex');
  const job = { id, status: 'running', createdAt: Date.now(), result: null };
  jobs.set(id, job);
  performReview({ description, image })
    .then((r) => {
      job.result = r;
      job.status = r.ok ? 'done' : 'error';
    })
    .catch((e) => {
      console.error('job crashed:', e && e.stack);
      job.result = fail(500, 'Something went wrong while reviewing. Try again.');
      job.status = 'error';
    });

  return sendJson(res, 202, { jobId: id });
}

function handleReviewStatus(res, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: 'This review expired. Run it again.' });
  if (job.status === 'running') return sendJson(res, 200, { status: 'running', elapsedMs: Date.now() - job.createdAt });
  if (job.status === 'done') {
    const { review, model, tookMs } = job.result;
    return sendJson(res, 200, { status: 'done', review, model, tookMs });
  }
  return sendJson(res, 200, { status: 'error', error: job.result.error, detail: job.result.detail || '' });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (count(`login:${ip}`, LOGIN_WINDOW) >= LOGIN_MAX_PER_IP || count('login:all', LOGIN_WINDOW) >= LOGIN_MAX_GLOBAL) {
    return sendJson(res, 429, { error: 'Too many failed attempts. Wait 15 minutes and try again.' }, { 'Retry-After': '900' });
  }
  let body;
  try {
    body = await readJson(req, 10 * 1024);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid request.' });
  }
  const userOk = safeEqual(String(body.username || ''), APP_USER);
  const passOk = safeEqual(String(body.password || ''), APP_PASSWORD);
  if (userOk && passOk) {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeSession(), SESSION_TTL_MS / 1000) });
  }
  hit(`login:${ip}`, LOGIN_WINDOW);
  hit('login:all', LOGIN_WINDOW);
  return sendJson(res, 401, { error: 'Incorrect user ID or password.' });
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }

    if (pathname.startsWith('/assets/') && method === 'GET') return serveAsset(req, res, pathname);

    if (pathname === '/login' && method === 'GET') {
      if (isAuthed(req)) return redirect(res, '/');
      return serveFile(res, path.join(PUBLIC_DIR, 'login.html'), 'text/html; charset=utf-8', 'no-store');
    }
    if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res);
    if (pathname === '/api/logout' && method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    // Everything below requires sign-in.
    if (!isAuthed(req)) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Your session has ended. Sign in again.' });
      return redirect(res, '/login');
    }

    if (pathname === '/' && method === 'GET') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', 'no-store');
    }
    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(res, 200, { model: MODEL, keyConfigured: Boolean(MODEL_ACCESS_KEY), check: await checkModel() });
    }
    if (pathname === '/api/review' && method === 'POST') return handleReview(req, res);
    if (method === 'GET' && pathname.startsWith('/api/review/')) {
      const id = pathname.slice('/api/review/'.length);
      if (!/^[a-f0-9]{32}$/.test(id)) return sendJson(res, 404, { error: 'Not found.' });
      return handleReviewStatus(res, id);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error('unhandled:', err && err.stack);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
    else res.end();
  }
});

server.requestTimeout = 180 * 1000;
server.headersTimeout = 30 * 1000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Architecture reviewer listening on :${PORT} (model: ${MODEL})`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
