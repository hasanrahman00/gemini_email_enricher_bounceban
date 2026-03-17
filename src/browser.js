const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

let browser = null;
let context = null;

/** Read CDP port from env (lazy so dotenv is loaded first) */
function cdpPort() {
  return parseInt(process.env.CDP_PORT || '9226', 10);
}

function cdpUrl() {
  return `http://127.0.0.1:${cdpPort()}`;
}

// ─── Port check (cross-platform, no curl) ───

function isPortActive() {
  return new Promise((resolve) => {
    const req = http.get(
      `${cdpUrl()}/json/version`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data.length > 0));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Chrome launcher (Windows + Linux + Mac) ───

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'google-chrome';
}

async function launchChrome() {
  if (await isPortActive()) return;

  const chromePath = findChrome();
  const userDataDir = process.env.CHROME_USER_DATA_DIR || './chrome-data';

  const args = [
    `--remote-debugging-port=${cdpPort()}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  child.unref();
}

// ─── Wait for port ───

async function waitForPort(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isPortActive()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome CDP port ${cdpPort()} not reachable after ${maxMs}ms`);
}

// ─── Connect / reconnect ───

async function connectBrowser() {
  if (browser && browser.isConnected()) return browser;

  // Reset stale refs
  browser = null;
  context = null;

  await launchChrome();
  await waitForPort();

  browser = await chromium.connectOverCDP(cdpUrl());

  // Reuse existing context (keeps Gemini login session)
  const contexts = browser.contexts();
  context = contexts.length ? contexts[0] : await browser.newContext();

  return browser;
}

/** Open a new tab in the shared context */
async function newPage() {
  await connectBrowser();
  return context.newPage();
}

/** Check status (async version for routes) */
async function checkStatus() {
  return isPortActive();
}

async function closeBrowser() {
  try { if (browser?.isConnected()) await browser.close(); }
  catch { /* ok */ }
  browser = null;
  context = null;
}

module.exports = {
  connectBrowser,
  newPage,
  checkStatus,
  closeBrowser,
};
