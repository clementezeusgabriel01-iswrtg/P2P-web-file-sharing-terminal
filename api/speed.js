/**
 * api/speed.js
 * -----------------------------------------------------------------------
 * Vercel Serverless Function backing the "Speed test" tab.
 *
 * This measures the link between the browser and THIS server — not the
 * WebRTC peer-to-peer link the Transfer tab uses. It's an ordinary
 * client-server HTTPS throughput check (ping / download / upload), same
 * idea as any browser-based speed test.
 *
 * Picked by method + query:
 *   - GET  /api/speed              -> ping: a near-empty response for
 *                                     round-trip timing.
 *   - GET  /api/speed?dl=1&n=BYTES -> download: BYTES (clamped to
 *                                     MAX_CHUNK_BYTES) of random data in
 *                                     one buffered response.
 *   - POST /api/speed              -> upload: reports how many bytes of
 *                                     body it received.
 *
 * Both download and upload are deliberately kept under Vercel's ~4.5 MB
 * buffered request/response ceiling per call, rather than trying to
 * stream past it — the client instead fires many of these small, bounded
 * requests back to back (in parallel) for a few seconds and sums the
 * bytes, the same multi-connection approach real speed tests use. This
 * keeps the endpoint correct on whatever runtime mode is handling the
 * function, with nothing relying on possibly-unsupported long-lived
 * streaming.
 *
 * Same best-effort, single-instance, in-memory rate limiter pattern as
 * api/chat.js — resets on cold start, only protects one warm instance,
 * but enough of a speed bump against a scripted loop.
 * -----------------------------------------------------------------------
 */

const { parse } = require('url');
const crypto = require('crypto');

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;   // 4 MiB — safely under the 4.5 MB platform cap
const MIN_CHUNK_BYTES = 16 * 1024;         // floor so a bad "n" can't make a near-empty request
const RATE_LIMIT_WINDOW_MS = 3 * 60 * 1000;
// A single run on a very fast connection is itself over a thousand small
// requests per phase (short-lived chunks round-tripping as fast as the
// link allows — measured ~2,500 requests/run at a 12ms RTT in testing),
// and the person should be able to click "Start test" more than once
// without tripping this. It's here to catch a scripted loop hammering the
// endpoint long-term, not to cap a couple of real test runs back to back.
const RATE_LIMIT_MAX = 8000;
const rateBuckets = new Map();             // ip -> number[] (request timestamps), best-effort only

// Generated once per cold start and sliced per request — reusing the same
// random bytes across requests costs nothing for a throughput test (every
// byte still has to physically cross the wire) and avoids paying
// crypto.randomBytes() on every single call.
const pool = crypto.randomBytes(MAX_CHUNK_BYTES);

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

function handleDownload(req, res, query) {
  const requested = Number.parseInt(query.n, 10);
  const size = Number.isFinite(requested)
    ? Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, requested))
    : MAX_CHUNK_BYTES;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(pool.subarray(0, size));
}

function handleUpload(req, res) {
  const body = req.body;
  let bytes = 0;
  if (Buffer.isBuffer(body)) bytes = body.length;
  else if (typeof body === 'string') bytes = Buffer.byteLength(body);
  else if (body && typeof body === 'object') {
    try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { bytes = 0; }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ bytes });
}

module.exports = async function handler(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' });
  }

  if (req.method === 'GET') {
    const { query } = parse(req.url, true);
    if (query.dl !== undefined) return handleDownload(req, res, query);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ t: Date.now() });
  }

  if (req.method === 'POST') {
    return handleUpload(req, res);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};
