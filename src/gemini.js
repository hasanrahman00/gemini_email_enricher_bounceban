const GEMINI_URL = 'https://gemini.google.com/app';

function timeout() {
  return parseInt(process.env.GEMINI_RESPONSE_TIMEOUT_MS || '30000', 10);
}
function delay() {
  return parseInt(process.env.GEMINI_SEARCH_DELAY_MS || '2000', 10);
}

// ─── Query builder ───

function buildQuery(row) {
  const parts = [];
  if (row['First Name'])  parts.push(row['First Name']);
  if (row['Last Name'])   parts.push(row['Last Name']);
  if (row['Job Title'])   parts.push(row['Job Title']);
  if (row['Company Name'])parts.push(row['Company Name']);

  const doms = [row['Website'], row['Website_one'], row['Website_two']]
    .filter(Boolean);
  if (doms.length) parts.push(`domains: ${doms.join(', ')}`);

  if (row['Person LinkedIn Url']) {
    parts.push(`LinkedIn: ${row['Person LinkedIn Url']}`);
  }

  return (
    parts.join(' ') + ' ' +
    'best even you get public person email domain mailboxes. ' +
    'then only shared it with me concisely. Shared emails only ' +
    'do not need relevant context. If you don\'t comfort to valid ' +
    'one email then find at least two/three emails'
  );
}

// ─── Search Gemini ───

async function searchGemini(row, page, logFn) {
  const query = buildQuery(row);
  const name = `${row['First Name']} ${row['Last Name']}`.trim();
  logFn(`[Gemini] Searching: ${name}`);

  try {
    // Fresh chat every time
    await page.goto(GEMINI_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await page.waitForTimeout(delay());

    // ── Find & fill input ──
    await typeQuery(page, query, logFn);

    // ── Submit ──
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    logFn('[Gemini] Query sent, waiting…');

    // ── Wait for response ──
    await waitForResponse(page);

    // ── Extract response text ──
    const text = await extractResponse(page);
    logFn(`[Gemini] Response: ${text.length} chars`);

    const emails = extractEmails(text);
    logFn(`[Gemini] Found ${emails.length} email(s): ${emails.join(', ') || 'none'}`);
    return emails;
  } catch (err) {
    logFn(`[Gemini] Error: ${err.message}`);
    return [];
  }
}

// ─── Type into Gemini's input ───

async function typeQuery(page, query, logFn) {
  // Gemini uses contenteditable divs — cannot use .fill()
  const selectors = [
    '.ql-editor[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    'div.text-input-field [contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea',
  ];

  let found = false;
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 6000 });
      if (!el) continue;

      await el.click();
      await page.waitForTimeout(200);

      // Clear existing text via select-all + delete (works on contenteditable)
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.press(`${mod}+a`);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);

      // Type character by character
      await page.keyboard.type(query, { delay: 8 });
      found = true;
      break;
    } catch { /* try next selector */ }
  }

  if (!found) {
    logFn('[Gemini] No input found, typing blind');
    await page.keyboard.type(query, { delay: 8 });
  }
}

// ─── Wait for Gemini to finish responding ───

async function waitForResponse(page) {
  // Initial wait for response to start appearing
  await page.waitForTimeout(5000);

  // Poll for response completion
  const maxWait = timeout();
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const done = await page.evaluate(() => {
      // Check if any loading / typing indicator is still active
      const indicators = document.querySelectorAll(
        'mat-progress-bar, .loading-indicator, ' +
        '.response-loading, [data-loading="true"], ' +
        '.typing-indicator'
      );
      for (const el of indicators) {
        if (el.offsetParent !== null) return false;
      }

      // Check if send button is re-enabled (means response finished)
      const sendBtn = document.querySelector(
        'button[aria-label="Send message"], ' +
        'button.send-button, ' +
        '.input-area button[mat-icon-button]'
      );
      if (sendBtn && !sendBtn.disabled) return true;

      return true;
    });

    if (done) break;
    await page.waitForTimeout(1000);
  }

  // Final settle time for DOM to finish rendering
  await page.waitForTimeout(2000);
}

// ─── Extract response text from page ───

async function extractResponse(page) {
  return page.evaluate(() => {
    // Gemini response containers (try most specific first)
    const selectors = [
      'message-content .markdown-main-panel',
      'message-content',
      'model-response .markdown-main-panel',
      'model-response',
      '.response-container',
      '.model-response-text',
      '.conversation-container',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        const last = els[els.length - 1];
        const txt = last.innerText || last.textContent || '';
        if (txt.trim().length > 10) return txt;
      }
    }

    // Fallback: grab everything from main
    const main = document.querySelector('main') ||
                 document.querySelector('[role="main"]') ||
                 document.body;
    return main?.innerText || '';
  });
}

// ─── Email extraction ───

function extractEmails(text) {
  if (!text) return [];

  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const all = text.match(re) || [];

  // Dedupe, lowercase, filter noise, max 3
  const clean = [...new Set(all.map((e) => e.toLowerCase()))]
    .filter((e) => !e.endsWith('@gmail.com')    || true)  // keep all for now
    .filter((e) => !e.includes('example.com'))
    .filter((e) => !e.includes('email.com'))
    .filter((e) => e.length < 80);

  return clean.slice(0, 3);
}

module.exports = { searchGemini, buildQuery, extractEmails };
