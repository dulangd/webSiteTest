#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BOOTSTRAP_VERSION = '1.0.3';
const KNOWN_GOOD_COMMIT = 'db64a771057b33749c7285054416d5cb33581492';
const RAW_BASE = `https://raw.githubusercontent.com/dulangd/webSiteTest/${KNOWN_GOOD_COMMIT}/wispbyte`;
const DIR = __dirname;
const INDEX_FILE = path.join(DIR, 'index.js');
const HOME_FILE = path.join(DIR, 'index.html');
const startedAt = Date.now();

function uptimeSec() {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': `container-test-wispbyte-bootstrap/${BOOTSTRAP_VERSION}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function atomicWriteIfChanged(file, content) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

function replaceOnce(source, label, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`runtime patch marker missing: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`runtime patch marker duplicated: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchRuntime(source) {
  let out = source;
  if (!out.includes("const VERSION = '2.0.2';")) throw new Error('known-good runtime sanity check failed: expected v2.0.2');

  out = replaceOnce(out, 'version', "const VERSION = '2.0.2';", "const VERSION = '2.0.4';");
  out = replaceOnce(
    out,
    'endpoint-stability',
    'if (!publicEndpoint || endpointScore(candidate) >= endpointScore(publicEndpoint)) {',
    'if (!publicEndpoint || endpointScore(candidate) > endpointScore(publicEndpoint)) {'
  );
  out = replaceOnce(
    out,
    'registration-promise',
    'let registerTimer = null;\nlet registered = false;',
    'let registerTimer = null;\nlet registerPromise = null;\nlet registered = false;'
  );
  out = replaceOnce(
    out,
    'registration-wrapper',
    'async function registerNode() {\n  if (!publicEndpoint?.host) return false;',
    `async function registerNode() {\n  if (registerPromise) return registerPromise;\n  registerPromise = registerNodeOnce().finally(() => { registerPromise = null; });\n  return registerPromise;\n}\nasync function registerNodeOnce() {\n  if (!publicEndpoint?.host) return false;\n  const lastOk = Date.parse(registryLastSuccessAt || '');\n  if (registered && Number.isFinite(lastOk) && Date.now() - lastOk < 60000) return true;`
  );
  out = out.replace('    console.log(`[registry] bearer register attempt node_id=${identity.nodeId} url=${REGISTRY_URL}`);\n', '');
  out = out.replace('    console.log(`[registry] public-proof register attempt node_id=${identity.nodeId} url=${REGISTRY_URL}`);\n', '');
  out = replaceOnce(
    out,
    'success-log',
    '  registryLastSuccessAt = new Date().toISOString();\n  console.log(`[registry] registered node_id=${identity.nodeId} mode=${REGISTRY_TOKEN ? \'bearer-token\' : \'public-proof\'}`);',
    `  const firstSuccess = !registryLastSuccessAt;\n  registryLastSuccessAt = new Date().toISOString();\n  if (firstSuccess) console.log(\`[registry] connected node_id=\${identity.nodeId} mode=\${REGISTRY_TOKEN ? 'bearer-token' : 'public-proof'}\`);`
  );

  if (!out.includes("const VERSION = '2.0.4';") || !out.includes('registerPromise')) {
    throw new Error('runtime patch validation failed');
  }
  return out;
}

async function refreshRuntime() {
  const rawIndex = await fetchText(`${RAW_BASE}/index.js`);
  const indexSource = patchRuntime(rawIndex);
  const indexChanged = atomicWriteIfChanged(INDEX_FILE, indexSource);

  try {
    const homeSource = await fetchText(`${RAW_BASE}/index.html`);
    atomicWriteIfChanged(HOME_FILE, homeSource);
  } catch (e) {
    console.warn(`[bootstrap] index.html refresh skipped: ${e.message}`);
  }

  console.log(`[bootstrap] v${BOOTSTRAP_VERSION} runtime ${indexChanged ? 'updated' : 'already current'}; effective=v2.0.4`);
}

function installLifecycleDiagnostics() {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      console.warn(`[lifecycle] received ${signal}; uptime=${uptimeSec()}s rss=${memMb}MB`);
      process.removeAllListeners(signal);
      try { process.kill(process.pid, signal); } catch { process.exit(0); }
    });
  }

  process.on('uncaughtExceptionMonitor', err => {
    console.error(`[lifecycle] uncaught exception: ${err.stack || err.message}`);
  });

  process.on('unhandledRejection', reason => {
    console.error(`[lifecycle] unhandled rejection: ${reason?.stack || reason}`);
  });

  process.on('exit', code => {
    console.warn(`[lifecycle] process exit code=${code} uptime=${uptimeSec()}s`);
  });
}

async function main() {
  console.log(`[bootstrap] starting v${BOOTSTRAP_VERSION}`);
  try {
    await refreshRuntime();
  } catch (e) {
    if (!fs.existsSync(INDEX_FILE)) {
      console.error(`[bootstrap] fatal: runtime refresh failed and no local index.js exists: ${e.message}`);
      process.exit(1);
      return;
    }
    console.warn(`[bootstrap] runtime refresh failed; using local index.js: ${e.message}`);
  }

  installLifecycleDiagnostics();
  require(INDEX_FILE);
}

main().catch(err => {
  console.error(`[bootstrap] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
