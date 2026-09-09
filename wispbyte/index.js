#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');

const VERSION = '2.0.1';
const PROVIDER = 'wispbyte';
const APP_DIR = __dirname;
const HOME_FILE = path.join(APP_DIR, 'index.html');
const STATE_DIR = process.env.WISPBYTE_STATE_DIR || path.join(os.homedir(), '.wispbyte-node');
const IDENTITY_FILE = path.join(STATE_DIR, 'identity.json');
const ENDPOINT_FILE = path.join(STATE_DIR, 'public-endpoint.json');
const PORT = validPort(process.env.PORT) || validPort(process.env.SERVER_PORT) || validPort(process.env.WISPBYTE_PORT);
const HOST = '0.0.0.0';
const REGISTRY_URL = clean(process.env.REGISTRY_URL || 'https://subscription-server-v2-production.up.railway.app').replace(/\/+$/, '');
const REGISTRY_TOKEN = clean(process.env.REGISTRY_TOKEN);
const HEARTBEAT_MS = Math.max(60_000, Number(process.env.HEARTBEAT_MS || 600000));
const ENDPOINT_OVERRIDE = clean(process.env.PUBLIC_ENDPOINT);
const TLS_CERT = clean(process.env.TLS_CERT || path.join(APP_DIR, 'tls.crt'));
const TLS_KEY = clean(process.env.TLS_KEY || path.join(APP_DIR, 'tls.key'));
const LOCAL_TLS = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);

function clean(v) { return String(v || '').trim(); }
function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}
function randomToken(bytes = 18) { return crypto.randomBytes(bytes).toString('base64url'); }
function safeJsonRead(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function atomicJsonWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function normalizeWsPath(v) {
  const s = clean(v).replace(/^\/+|\/+$/g, '');
  return '/' + (s || ('ws-' + randomToken(10)));
}
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(v));
}
function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

if (!PORT) {
  console.error('[fatal] no valid PORT/SERVER_PORT/WISPBYTE_PORT supplied');
  process.exit(1);
}

function loadIdentity() {
  const saved = safeJsonRead(IDENTITY_FILE);
  const envUuid = clean(process.env.UUID);
  const value = {
    uuid: isUuid(envUuid) ? envUuid : (isUuid(saved.uuid) ? saved.uuid : crypto.randomUUID()),
    wsPath: normalizeWsPath(process.env.WS_PATH || saved.wsPath),
    subToken: clean(process.env.SUB_TOKEN) || saved.subToken || randomToken(22),
    nodeId: clean(process.env.NODE_ID) || saved.nodeId || ('wispbyte-' + randomToken(12).toLowerCase()),
    nodeName: clean(process.env.NODE_NAME) || saved.nodeName || 'Wispbyte-01'
  };
  atomicJsonWrite(IDENTITY_FILE, value);
  return value;
}
const identity = loadIdentity();

function parseEndpointString(value) {
  if (!value) return null;
  try {
    const u = new URL(value.includes('://') ? value : ('http://' + value));
    const protocol = u.protocol === 'https:' ? 'https' : 'http';
    const port = validPort(u.port) || (protocol === 'https' ? 443 : 80);
    const host = u.hostname;
    if (!host) return null;
    return { protocol, host, port, source: 'override', learnedAt: new Date().toISOString() };
  } catch { return null; }
}
function endpointScore(ep) {
  if (!ep || !ep.host) return -1;
  let score = 0;
  if (ep.protocol === 'https') score += 100;
  if (!net.isIP(ep.host)) score += 40;
  if (ep.port === 443) score += 20;
  if (ep.host.endsWith('.wisp.uno') || ep.host.endsWith('.wispbyte.app')) score += 10;
  return score;
}
function loadEndpoint() {
  return parseEndpointString(ENDPOINT_OVERRIDE) || safeJsonRead(ENDPOINT_FILE);
}
let publicEndpoint = loadEndpoint();

let registerTimer = null;
let registered = false;
let registryLastStatus = null;
let registryLastError = '';
let registryLastAttemptAt = null;
let registryLastSuccessAt = null;

function learnEndpoint(req) {
  if (ENDPOINT_OVERRIDE) return;
  const xfProto = clean(String(req.headers['x-forwarded-proto'] || '').split(',')[0]).toLowerCase();
  const protocol = xfProto === 'https' ? 'https' : (req.socket.encrypted ? 'https' : 'http');
  const xfHost = clean(String(req.headers['x-forwarded-host'] || '').split(',')[0]);
  const rawHost = xfHost || clean(req.headers.host);
  if (!rawHost) return;
  let u;
  try { u = new URL(protocol + '://' + rawHost); } catch { return; }
  const host = u.hostname;
  if (!host || host === 'localhost' || host === '127.0.0.1') return;
  const xfPort = validPort(String(req.headers['x-forwarded-port'] || '').split(',')[0]);
  const port = xfPort || validPort(u.port) || (protocol === 'https' ? 443 : PORT);
  const candidate = { protocol, host, port, source: 'request', learnedAt: new Date().toISOString() };
  if (!publicEndpoint || endpointScore(candidate) >= endpointScore(publicEndpoint)) {
    const changed = !publicEndpoint || candidate.protocol !== publicEndpoint.protocol || candidate.host !== publicEndpoint.host || candidate.port !== publicEndpoint.port;
    publicEndpoint = candidate;
    atomicJsonWrite(ENDPOINT_FILE, candidate);
    if (changed) {
      console.log(`[endpoint] learned ${candidate.protocol}://${candidate.host}:${candidate.port}`);
      scheduleRegistration(1200);
    }
  }
}

function currentEndpoint(req) {
  learnEndpoint(req);
  if (publicEndpoint && publicEndpoint.host) return publicEndpoint;
  const hostHeader = clean(req?.headers?.host);
  if (hostHeader) {
    try {
      const p = req.socket.encrypted ? 'https' : 'http';
      const u = new URL(p + '://' + hostHeader);
      return { protocol: p, host: u.hostname, port: validPort(u.port) || (p === 'https' ? 443 : PORT), source: 'request' };
    } catch {}
  }
  return null;
}

function nodeUri(ep) {
  if (!ep) return null;
  const secure = ep.protocol === 'https';
  const qp = new URLSearchParams({ encryption: 'none', security: secure ? 'tls' : 'none', type: 'ws', host: ep.host, path: identity.wsPath });
  if (secure) {
    qp.set('sni', ep.host);
    qp.set('alpn', 'http/1.1');
  }
  return `vless://${identity.uuid}@${formatHost(ep.host)}:${ep.port}?${qp.toString()}#${encodeURIComponent(identity.nodeName)}`;
}
function formatHost(host) { return net.isIP(host) === 6 ? `[${host}]` : host; }
function baseUrl(ep) { return `${ep.protocol}://${formatHost(ep.host)}${((ep.protocol === 'https' && ep.port === 443) || (ep.protocol === 'http' && ep.port === 80)) ? '' : ':' + ep.port}`; }

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  });
  res.end(body);
}
function notFound(res) { send(res, 404, 'Not found\n'); }
function authorizedToken(v) { return constantTimeEqual(v, identity.subToken); }

const requestHandler = (req, res) => {
  learnEndpoint(req);
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return notFound(res); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  const bodyless = req.method === 'HEAD';

  if (url.pathname === '/health') {
    const ep = currentEndpoint(req);
    const payload = {
      ok: true,
      service: 'wispbyte-node',
      version: VERSION,
      provider: PROVIDER,
      node_id: identity.nodeId,
      endpoint_ready: !!ep,
      endpoint: ep ? `${ep.protocol}://${ep.host}:${ep.port}` : null,
      local_tls: LOCAL_TLS,
      registry: {
        configured: !!REGISTRY_TOKEN,
        url: REGISTRY_URL,
        registered,
        last_status: registryLastStatus,
        last_error: registryLastError || null,
        last_attempt_at: registryLastAttemptAt,
        last_success_at: registryLastSuccessAt
      }
    };
    return send(res, 200, bodyless ? '' : JSON.stringify(payload), 'application/json; charset=utf-8');
  }

  const p = url.pathname.split('/').filter(Boolean);
  let action = null;
  let token = null;
  if (p.length === 2 && ['sub','sub64','node'].includes(p[1])) { token = p[0]; action = p[1]; }
  if (p.length === 2 && p[0] === 'sub') { token = p[1]; action = 'sub64'; }
  if (action) {
    if (!authorizedToken(token)) return notFound(res);
    const ep = currentEndpoint(req);
    if (!ep) return send(res, 503, 'Public endpoint not learned yet\n');
    const uri = nodeUri(ep);
    if (action === 'sub') return send(res, 200, bodyless ? '' : uri + '\n');
    if (action === 'sub64') return send(res, 200, bodyless ? '' : Buffer.from(uri + '\n').toString('base64'));
    const payload = {
      version: 2,
      provider: PROVIDER,
      node_id: identity.nodeId,
      name: identity.nodeName,
      endpoint: ep,
      ws_path: identity.wsPath,
      uri,
      individual_subscription: baseUrl(ep) + '/' + identity.subToken + '/sub',
      individual_subscription_base64: baseUrl(ep) + '/' + identity.subToken + '/sub64'
    };
    return send(res, 200, bodyless ? '' : JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');
  }

  if (url.pathname === '/') {
    let html = '<!doctype html><meta charset="utf-8"><title>Green Horizon</title><h1>Green Horizon</h1>';
    try { html = fs.readFileSync(HOME_FILE, 'utf8'); } catch {}
    return send(res, 200, bodyless ? '' : html, 'text/html; charset=utf-8');
  }
  return notFound(res);
};

const server = LOCAL_TLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' }, requestHandler)
  : http.createServer(requestHandler);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

function wsAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
function wsFrame(payload, opcode = 2) {
  payload = Buffer.from(payload);
  const n = payload.length;
  let h;
  if (n < 126) { h = Buffer.alloc(2); h[0] = 0x80 | opcode; h[1] = n; }
  else if (n <= 0xffff) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, payload]);
}
function createWsParser(onFrame, onClose) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(8 * 1024 * 1024)) return onClose(); len = Number(big); off = 10; }
      if (!masked) return onClose();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); off += 4;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (opcode === 8) return onClose();
      onFrame(opcode, payload);
    }
  };
}

server.on('upgrade', (req, socket, head) => {
  learnEndpoint(req);
  let pathname = '';
  try { pathname = new URL(req.url, 'http://local').pathname; } catch {}
  if (pathname !== identity.wsPath || clean(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
  }
  const key = clean(req.headers['sec-websocket-key']);
  if (!key) { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');

  let remote = null;
  let initialized = false;
  const close = () => { try { remote?.destroy(); } catch {} try { socket.destroy(); } catch {} };
  const parser = createWsParser((opcode, payload) => {
    if (opcode === 9) { try { socket.write(wsFrame(payload, 10)); } catch {} return; }
    if (opcode !== 2) return;
    if (!initialized) {
      initialized = true;
      const reqInfo = parseVless(payload);
      if (!reqInfo) return close();
      remote = net.connect({ host: reqInfo.address, port: reqInfo.port, timeout: 10000 });
      remote.once('connect', () => {
        socket.write(wsFrame(Buffer.from([0, 0])));
        if (reqInfo.payload.length) remote.write(reqInfo.payload);
      });
      remote.on('data', d => { if (!socket.destroyed) socket.write(wsFrame(d)); });
      remote.on('timeout', close); remote.on('error', close); remote.on('close', close);
    } else if (remote && !remote.destroyed) remote.write(payload);
  }, close);
  if (head?.length) parser(head);
  socket.on('data', parser); socket.on('error', close); socket.on('close', () => { try { remote?.destroy(); } catch {} });
});

function parseVless(buf) {
  if (buf.length < 24 || buf[0] !== 0) return null;
  const id = [buf.subarray(1,5),buf.subarray(5,7),buf.subarray(7,9),buf.subarray(9,11),buf.subarray(11,17)].map(x=>x.toString('hex')).join('-');
  if (!constantTimeEqual(id.toLowerCase(), identity.uuid.toLowerCase())) return null;
  let p = 17; const optLen = buf[p++]; p += optLen;
  if (buf.length < p + 4 || buf[p++] !== 1) return null;
  const port = buf.readUInt16BE(p); p += 2; const atyp = buf[p++]; let address;
  if (atyp === 1) { if (buf.length < p + 4) return null; address = [...buf.subarray(p,p+4)].join('.'); p += 4; }
  else if (atyp === 2) { if (buf.length < p + 1) return null; const n = buf[p++]; if (buf.length < p+n) return null; address = buf.subarray(p,p+n).toString(); p += n; }
  else if (atyp === 3) { if (buf.length < p + 16) return null; const a=[]; for(let i=0;i<8;i++) a.push(buf.readUInt16BE(p+i*2).toString(16)); address=a.join(':'); p+=16; }
  else return null;
  return { address, port, payload: buf.subarray(p) };
}

function requestJson(urlString, method, body, token, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlString); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request({ protocol:u.protocol, hostname:u.hostname, port:u.port || undefined, path:u.pathname + u.search, method, headers:{'content-type':'application/json','content-length':data.length,'authorization':'Bearer '+token,'user-agent':'container-test-wispbyte/2.0.1'}, timeout }, res => {
      let out=''; res.setEncoding('utf8'); res.on('data',d=>out+=d); res.on('end',()=>resolve({status:res.statusCode, body:out}));
    });
    req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',reject); req.end(data);
  });
}
function scheduleRegistration(delay = 0) {
  if (!REGISTRY_TOKEN) {
    registryLastError = 'REGISTRY_TOKEN missing in process environment';
    return;
  }
  if (!publicEndpoint?.host) {
    registryLastError = 'public endpoint not ready';
    return;
  }
  clearTimeout(registerTimer);
  registerTimer = setTimeout(() => registerNode().catch(e => {
    registryLastError = e.message;
    console.warn('[registry] register failed:', e.message);
  }), delay);
}
async function registerNode() {
  if (!REGISTRY_TOKEN || !publicEndpoint?.host) return false;
  registryLastAttemptAt = new Date().toISOString();
  registryLastError = '';
  console.log(`[registry] register attempt node_id=${identity.nodeId} url=${REGISTRY_URL}`);
  const uri = nodeUri(publicEndpoint);
  const r = await requestJson(REGISTRY_URL + '/api/v1/register', 'POST', { kind:'proxy', node_id:identity.nodeId, name:identity.nodeName, provider:PROVIDER, uri, priority:80 }, REGISTRY_TOKEN);
  registryLastStatus = r.status;
  registered = r.status >= 200 && r.status < 300;
  if (!registered) {
    registryLastError = 'HTTP ' + r.status;
    throw new Error(registryLastError);
  }
  registryLastSuccessAt = new Date().toISOString();
  console.log(`[registry] registered node_id=${identity.nodeId}`);
  return true;
}
async function heartbeat() {
  if (!REGISTRY_TOKEN || !publicEndpoint?.host) return;
  try {
    const r = await requestJson(REGISTRY_URL + '/api/v1/heartbeat', 'POST', { node_id: identity.nodeId, status:'online' }, REGISTRY_TOKEN);
    registryLastStatus = r.status;
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    registryLastError = '';
    if (!registered) await registerNode();
  } catch (e) {
    registered = false;
    registryLastError = e.message;
    console.warn('[registry] heartbeat failed; re-registering');
    try { await registerNode(); } catch (e2) { registryLastError = e2.message; console.warn('[registry] re-register failed:', e2.message); }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[ready] wispbyte-node v${VERSION} listening on ${HOST}:${PORT} (${LOCAL_TLS ? 'https/wss' : 'http/ws'})`);
  console.log(`[ready] persistent state: ${STATE_DIR}`);
  console.log(`[ready] node_id=${identity.nodeId}`);
  console.log('[ready] secrets are intentionally not printed');
  console.log(`[registry] configured=${REGISTRY_TOKEN ? 'yes' : 'no'} url=${REGISTRY_URL}`);
  if (publicEndpoint?.host) {
    console.log(`[ready] public endpoint ${publicEndpoint.protocol}://${publicEndpoint.host}:${publicEndpoint.port}`);
    scheduleRegistration(1500);
  } else {
    console.log('[ready] waiting for first public request to learn endpoint before Registry registration');
  }
  setInterval(heartbeat, HEARTBEAT_MS).unref();
});