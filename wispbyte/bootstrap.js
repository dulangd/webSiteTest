#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BOOTSTRAP_VERSION = '1.0.0';
const RAW_BASE = 'https://raw.githubusercontent.com/dulangd/webSiteTest/main/wispbyte';
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
  const indexUrl = `${RAW_BASE}/index.js`;
  const homeUrl = `${RAW_BASE}/index.html`;
  const indexSource = await fetchText(indexUrl);
  if (!indexSource.includes("const VERSION = '")) {
    throw new Error('downloaded index.js failed sanity check');
  }
  const indexChanged = atomicWriteIfChanged(INDEX_FILE, indexSource);

  try {
    const homeSource = await fetchText(homeUrl);
    atomicWriteIfChanged(HOME_FILE, homeSource);
  } catch (e) {
    console.warn(`[bootstrap] index.html refresh skipped: ${e.message}`);
  }

  console.log(`[bootstrap] v${BOOTSTRAP_VERSION} runtime ${indexChanged ? 'updated' : 'already current'}; git clone not used`);
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
    console.warn(`[bootstrap] runtime refresh failed; using last known-good index.js: ${e.message}`);
  }

  const child = spawn(process.execPath, [INDEX_FILE], {
    stdio: 'inherit',
    env: process.env
  });

  let forwardedSignal = null;
  const forward = signal => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    console.warn(`[bootstrap] received ${signal}; forwarding to node; uptime=${uptimeSec()}s`);
    try { child.kill(signal); } catch {}
  };

  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGHUP', () => forward('SIGHUP'));

  child.on('error', err => {
    console.error(`[bootstrap] child process error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    console.warn(`[bootstrap] node exited code=${code === null ? 'null' : code} signal=${signal || 'none'} uptime=${uptimeSec()}s`);
    if (signal) {
      process.exitCode = 0;
    } else {
      process.exitCode = Number.isInteger(code) ? code : 1;
    }
  });
}

main().catch(err => {
  console.error(`[bootstrap] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
