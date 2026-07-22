// The HTTPS interception layer for the offline cache: records mapgenie's page bundle on
// the way past, and (later) serves it back with mapgenie unreachable.
//
// WHY protocol.handle AND NOT A REDIRECT. Both webviews omit `partition`, so they share
// session.defaultSession — one registration covers both windows. More importantly, it
// does not change the ORIGIN. MapLibre CORS-fetches glyph PBFs and sprite JSON, and the
// SPA calls /api/v1/... as same-origin XHR; redirecting either to a custom scheme breaks
// them, with failure modes (blank labels, silent 401s) that are miserable to diagnose.
// Serving the recorded bytes under the real https origin sidesteps all of it.
//
// THE RISK, AND WHY IT IS CONTAINED. protocol.handle registers per SCHEME, not per host,
// so while this is on, one JS function sits in the path of every HTTPS request the app
// makes. The containment that matters most is also the cheapest: in 'passthrough' the
// handler is NOT REGISTERED AT ALL, so the blast radius when the feature is idle is
// exactly zero. Beyond that, a hostname allowlist is the first statement in the handler.
//
// THREE HAZARDS THAT ARE SILENT IF YOU GET THEM WRONG (all handled below):
//   1. Cookies. protocol.handle does NOT give the handler the request's Cookie header.
//      mapgenie's found-set is behind a login cookie and marks are authenticated writes,
//      so forwarding must go through ses.fetch (which owns the session's cookie jar)
//      with credentials:'include' — NOT net.fetch, which does not.
//   2. Request bodies need duplex:'half'. Without it every POST/PUT throws, which breaks
//      precisely the found-mark writes that must keep working online.
//   3. content-encoding. ses.fetch hands back a DECOMPRESSED body. Store that and replay
//      it still labelled `content-encoding: gzip` and Chromium tries to gunzip plaintext.
//      This is the most likely "it should work but the page is blank" bug in the feature.
//      The header is stripped and content-length recomputed.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { session } = require('electron');

// The only hostnames verifiable from the repo. Everything else passes straight through.
// Record mode logs whatever other hosts the page actually touches (see hostStats) so they
// can be promoted DELIBERATELY rather than guessed at.
const CACHE_HOSTS = new Set(['mapgenie.io', 'www.mapgenie.io', 'tiles.mapgenie.io', 'cdn.mapgenie.io']);

// Tiles are owned by tileCache.js and live in the tiles/{z}/{y}/{x} tree. Recording them
// into http/ as well would duplicate ~940MB.
const TILE_HOST = 'tiles.mapgenie.io';

// Checked BEFORE the allowlist. The found-mark write path must always reach the network
// when we're online; a recorded copy of it would be both useless and a correctness trap.
const NEVER_CACHE = [/\/api\/v1\/user\/locations/];

// Connection-level or credential-bearing headers that must not survive into a replay.
// content-encoding and content-length are dropped because the stored body is decoded.
const STRIP_HEADERS = new Set([
  'content-encoding', 'content-length', 'set-cookie', 'date',
  'strict-transport-security', 'alt-svc', 'report-to', 'nel',
  'transfer-encoding', 'connection',
]);

let mode = 'passthrough';         // 'passthrough' | 'record' | 'replay'
let cacheDir = null;              // where record writes / replay reads
let registered = false;
let inFlight = 0;                 // for quiescing before a directory swap
let offlineHint = false;          // replay: fail fast on a miss instead of stalling
let activeSession = null;         // the session the handler is bound to (forward() uses it)
let registeredSession = null;     // which session currently has our https handler
const hostStats = new Map();
let missLog = null;               // replay: collects cache misses when strict

function keyFor(method, url) {
  return crypto.createHash('sha1').update(`${method} ${url}`).digest('hex');
}

function pathsFor(dir, host, key) {
  const base = path.join(dir, 'http', host, key);
  return { body: `${base}.bin`, meta: `${base}.json` };
}

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// Headers safe to carry from the intercepted request onto the forwarded one.
//
// FORWARDING THE REQUEST'S HEADERS WHOLESALE BREAKS EVERY REQUEST. Measured: with
// `headers: request.headers` the very first navigation dies with net::ERR_FAILED after
// ~25ms; with these four it loads normally (80 requests, no errors). The incoming
// Request carries browser-managed headers — Host, Origin, the Sec-Fetch-* set, an
// Accept-Encoding describing an encoding we are about to strip — and Chromium's net
// stack refuses to re-send them on a synthetic request. Cookies are NOT among these on
// purpose: protocol.handle never shows them to us, and credentials:'include' makes
// ses.fetch attach them from the session's own jar.
const FORWARD_HEADERS = ['accept', 'accept-language', 'referer', 'content-type'];

// Forward to the real network on WHICHEVER session the handler is bound to. ses.fetch
// (not net.fetch) so that session's cookie jar and proxy apply; bypassCustomProtocolHandlers
// so we don't recurse into ourselves.
function forward(request) {
  const ses = activeSession || session.defaultSession;
  const headers = {};
  for (const k of FORWARD_HEADERS) {
    const v = request.headers.get(k);
    if (v) headers[k] = v;
  }
  const init = {
    method: request.method,
    headers,
    credentials: 'include',
    bypassCustomProtocolHandlers: true,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body;
    init.duplex = 'half';        // hazard 2 — without this every POST/PUT throws
  }
  return ses.fetch(request.url, init);
}

function noteHost(host) {
  hostStats.set(host, (hostStats.get(host) || 0) + 1);
}

async function record(request, url) {
  const res = await forward(request);

  // Store 2xx/3xx from the cacheable hosts, minus tiles (tileCache owns those).
  //
  // A set-cookie response is NOT excluded, though it looks like it should be. mapgenie's
  // main document sets laravel_session, so excluding those skipped THE PAGE ITSELF —
  // verify came back with exactly one miss, the embed HTML, which is also where the SPA
  // inlines its bootstrapped store (the POI data has no separate GeoJSON URL to fetch).
  // Storing it is safe because filterHeaders drops set-cookie from what we persist: we
  // keep the public HTML body, never the credential.
  const cacheable = res.status >= 200 && res.status < 400 && url.hostname !== TILE_HOST;
  if (!cacheable) return res;

  // The body stream is single-use, so buffer it and hand back a fresh Response built
  // from the same bytes — the guest must see exactly what it would have seen.
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = filterHeaders(res.headers);

  try {
    const key = keyFor(request.method, request.url);
    const p = pathsFor(cacheDir, url.hostname, key);
    await fsp.mkdir(path.dirname(p.body), { recursive: true });
    await fsp.writeFile(p.body, buf);
    await fsp.writeFile(p.meta, JSON.stringify({
      url: request.url,
      method: request.method,
      status: res.status,
      mime: res.headers.get('content-type') || '',
      headers,
      bodyBytes: buf.length,
      fetchedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* a failed write must never break the page load */ }

  return new Response(buf, { status: res.status, headers });
}

async function serveFromCache(request, url) {
  // Tiles come from the tile tree, not http/. A zero-byte file is the negative cache
  // (mapgenie 403s absent tiles), so it replays as the 403 the guest already tolerates.
  if (url.hostname === TILE_HOST) {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(url.pathname);
    if (m) {
      const p = path.join(cacheDir, 'tiles', m[1], m[2], `${m[3]}.jpg`);
      try {
        const buf = await fsp.readFile(p);
        if (buf.length === 0) return new Response('', { status: 403 });
        return new Response(buf, { headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' } });
      } catch { return null; }
    }
    return null;
  }

  const key = keyFor(request.method, request.url);
  const p = pathsFor(cacheDir, url.hostname, key);
  try {
    const meta = JSON.parse(await fsp.readFile(p.meta, 'utf-8'));
    const buf = await fsp.readFile(p.body);
    return new Response(buf, { status: meta.status, headers: meta.headers });
  } catch {
    return null;
  }
}

const DEBUG = !!process.env.DD2_MIRROR_DEBUG;

async function handler(request) {
  inFlight++;
  if (DEBUG) console.log(`[mirror>] ${mode} ${request.method} ${request.url.slice(0, 110)}`);
  try {
    let url;
    try { url = new URL(request.url); } catch { return forward(request); }

    if (!CACHE_HOSTS.has(url.hostname)) return forward(request);
    noteHost(url.hostname);
    if (NEVER_CACHE.some((re) => re.test(url.pathname))) {
      // The found-mark write path. Online it must reach the server (real persistence).
      // OFFLINE, forwarding it hangs for the full connect timeout and the mark UI stalls;
      // instead answer a synthetic 200 so mapgenie's optimistic update sticks and feels
      // instant. The mark is still saved locally by the found-set mirror. Caveat (the
      // "no write-back" design): a mark made offline never reaches your mapgenie account,
      // so the server set overwrites it once you're back online.
      if (mode === 'replay' && offlineHint) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      return forward(request);
    }

    if (mode === 'record') {
      const r = await record(request, url);
      if (DEBUG) console.log(`[mirror<] ${r.status} ${r.headers.get('content-type') || ''} ${request.url.slice(0, 80)}`);
      return r;
    }

    if (mode === 'replay') {
      const hit = await serveFromCache(request, url);
      if (hit) return hit;
      if (missLog) missLog.push(request.url);
      // Offline, letting a miss attempt the network stalls MapLibre and the SPA for the
      // full DNS/connect timeout. Failing fast is what makes offline feel instant.
      if (offlineHint) return new Response('offline cache miss', { status: 504 });
      return forward(request);
    }

    return forward(request);
  } catch (err) {
    // Loud on purpose: a swallowed error here presents as a blank map with no clue why.
    console.log(`[mirror] ${mode} FAILED ${request.method} ${request.url} — ${err.message}`);
    return new Response(`mirror error: ${err.message}`, { status: 502 });
  } finally {
    inFlight--;
  }
}

// `opts.session` chooses which session's HTTPS traffic to intercept. The offline-SERVING
// feature (switcher) uses the default session — the one the real webviews run on. CAPTURE
// and VERIFY pass a dedicated, throwaway session instead, so building a cache never
// registers a handler on, reloads, or otherwise disturbs the live map. The two never run
// at once (capture happens during a build, which the user does while online), so one
// active handler at a time is enough.
function setMode(next, opts = {}) {
  if (opts.dir) cacheDir = opts.dir;
  if (opts.offline != null) offlineHint = opts.offline;
  const wantSession = opts.session || session.defaultSession;

  // A session change while registered (shouldn't happen in practice) must move the
  // handler, so unregister from wherever it currently lives first.
  if (registeredSession && registeredSession !== wantSession) {
    try { registeredSession.protocol.unhandle('https'); } catch { /* already gone */ }
    registeredSession = null;
    registered = false;
  }

  if (next === mode && (next === 'passthrough' || registeredSession === wantSession)) {
    activeSession = wantSession;
    return;
  }
  mode = next;
  activeSession = wantSession;

  if (mode === 'passthrough') {
    // The containment that matters: with the feature idle, nothing is in the path.
    if (registered && registeredSession) {
      try { registeredSession.protocol.unhandle('https'); } catch { /* already gone */ }
    }
    registered = false;
    registeredSession = null;
    return;
  }
  if (!registered) {
    wantSession.protocol.handle('https', handler);
    registered = true;
    registeredSession = wantSession;
  }
}

function getMode() { return mode; }
function getHostStats() { return Object.fromEntries(hostStats); }
function resetHostStats() { hostStats.clear(); }

function startMissLog() { missLog = []; }
function stopMissLog() { const m = missLog || []; missLog = null; return m; }

// Wait for in-flight handler calls to finish before a directory rename — an open file
// inside the directory makes the rename fail with EBUSY.
async function quiesce(timeoutMs = 3000) {
  const t0 = Date.now();
  while (inFlight > 0 && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return inFlight === 0;
}

module.exports = {
  CACHE_HOSTS, TILE_HOST,
  setMode, getMode, getHostStats, resetHostStats,
  startMissLog, stopMissLog, quiesce,
};
