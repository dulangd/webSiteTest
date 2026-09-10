#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BOOTSTRAP_VERSION = '1.0.2';
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

async function refreshRuntime() {
  const indexSource = await fetchText(`${RAW_BASE}/index.js`);
  if (!indexSource.includes("const VERSION = '2.0.2';")) {
    throw new Error('known-good runtime sanity check failed: expected v2.0.2');
  }
  const indexChanged = atomicWriteIfChanged(INDEX_FILE, indexSource);

  try {
    const homeSource = await fetchText(`${RAW_BASE}/index.html`);
    atomicWriteIfChanged(HOME_FILE, homeSource);
  } catch (e) {
    console.warn(`[bootstrap] index.html refresh skipped: ${e.message}`);
  }

  console.log(`[bootstrap] v${BOOTSTRAP_VERSION} rollback runtime ${indexChanged ? 'restored' : 'already current'}; pinned=v2.0.2 commit=${KNOWN_GOOD_COMMIT.slice(0, 8)}`);
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
  console.log(`[bootstrap] starting v${BOOTSTRAP_VERSION} in rollback mode`);
  try {
    await refreshRuntime();
  } catch (e) {
    if (!fs.existsSync(INDEX_FILE)) {
      console.error(`[bootstrap] fatal: rollback runtime refresh failed and no local index.js exists: ${e.message}`);
      process.exit(1);
      return;
    }
    console.warn(`[bootstrap] rollback runtime refresh failed; using local index.js: ${e.message}`);
  }

  installLifecycleDiagnostics();
  require(INDEX_FILE);
}

main().catch(err => {
  console.error(`[bootstrap] fatal: ${err.stack || err.message}`);
  process.exit(1);
});