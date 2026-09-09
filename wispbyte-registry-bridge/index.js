'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const REGISTRY_URL = String(process.env.REGISTRY_URL || 'https://subscription-server-v2-production.up.railway.app').replace(/\/+$/, '');
const REGISTRY_TOKEN = String(process.env.REGISTRY_TOKEN || '').trim();
const ALLOWED_NODE_ID = String(process.env.ALLOWED_NODE_ID || 'wispbyte-rbigccnsjeqso9ch').trim();
const ALLOWED_ENDPOINT = String(process.env.ALLOWED_ENDPOINT || 'https://1st.wispbyte.app').replace(/\/+$/, '');

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validVlessUri(uri) {
  try {
    const u = new URL(uri);
    const allowed = new URL(ALLOWED_ENDPOINT);
    return u.protocol === 'vless:' &&
      u.hostname === allowed.hostname &&
      Number(u.port || 443) === 443 &&
      u.searchParams.get('security') === 'tls' &&
      u.searchParams.get('type') === 'ws' &&
      u.searchParams.get('host') === allowed.hostname &&
      u.searchParams.get('sni') === allowed.hostname &&
      String(u.searchParams.get('path') || '').startsWith('/');
  } catch {
    return false;
  }
}

async function verifyNode(body) {
  if (body.provider !== 'wispbyte') throw new Error('provider rejected');
  if (body.node_id !== ALLOWED_NODE_ID) throw new Error('node_id rejected');
  if (String(body.endpoint || '').replace(/\/+$/, '') !== ALLOWED_ENDPOINT) throw new Error('endpoint rejected');
  if (!body.proof || typeof body.proof !== 'string' || body.proof.length < 32) throw new Error('proof rejected');
  if (!validVlessUri(String(body.uri || ''))) throw new Error('uri rejected');

  const r = await fetch(ALLOWED_ENDPOINT + '/health', {
    headers: { 'user-agent': 'container-test-wispbyte-bridge/1.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('node health HTTP ' + r.status);
  const h = await r.json();
  if (h?.ok !== true || h?.provider !== 'wispbyte' || h?.node_id !== ALLOWED_NODE_ID) throw new Error('node health identity mismatch');
  if (!h?.registry_proof_sha256 || h.registry_proof_sha256 !== sha256(body.proof)) throw new Error('proof mismatch');
}

async function forwardRegistration(body) {
  if (!REGISTRY_TOKEN) throw new Error('bridge REGISTRY_TOKEN missing');
  const r = await fetch(REGISTRY_URL + '/api/v1/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + REGISTRY_TOKEN,
      'user-agent': 'container-test-wispbyte-bridge/1.0'
    },
    body: JSON.stringify({
      kind: 'proxy',
      node_id: body.node_id,
      name: body.name || 'Wispbyte-01',
      provider: 'wispbyte',
      uri: body.uri,
      priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 80
    }),
    signal: AbortSignal.timeout(10000)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error('registry HTTP ' + r.status + ': ' + String(text).slice(0, 200));
  return { status: r.status, data };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'wispbyte-registry-bridge',
        version: '1.0.0',
        registry_configured: !!REGISTRY_TOKEN,
        allowed_node_id: ALLOWED_NODE_ID,
        allowed_endpoint: ALLOWED_ENDPOINT
      });
    }
    if (u.pathname === '/register' && req.method === 'POST') {
      const body = await readJson(req);
      await verifyNode(body);
      const out = await forwardRegistration(body);
      return json(res, 200, { ok: true, registry_status: out.status, registry: out.data });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[bridge]', e?.message || e);
    return json(res, 400, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ready] wispbyte-registry-bridge v1.0.0 on :${PORT}`);
  console.log(`[ready] registry_configured=${REGISTRY_TOKEN ? 'yes' : 'no'}`);
  console.log(`[ready] allowed_node_id=${ALLOWED_NODE_ID}`);
  console.log(`[ready] allowed_endpoint=${ALLOWED_ENDPOINT}`);
});
