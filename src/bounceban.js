// BounceBan API — correct endpoint & auth
// Docs: https://bounceban.com/public/doc/api.html#tag/Single-verification
const BASE = 'https://api.bounceban.com/v1/verify/single';

// 408 = verification still processing; retry up to 5 times (free retries)
const MAX_RETRIES = 5;
const RETRY_DELAY = 10000; // 10s between retries

/** Lazy key read so dotenv is loaded before first call */
function apiKey() {
  const k = process.env.BOUNCEBAN_API_KEY || '';
  if (!k || k === 'your_bounceban_api_key_here') {
    throw new Error('BOUNCEBAN_API_KEY not configured');
  }
  return k;
}

/** Quick check if key is usable (no throw) */
function isConfigured() {
  const k = process.env.BOUNCEBAN_API_KEY || '';
  return !!(k && k !== 'your_bounceban_api_key_here');
}

// ─── Map BounceBan result → our status field ───

function mapStatus(raw) {
  const r = (raw || '').toLowerCase().trim();
  // BounceBan returns: deliverable, undeliverable, accept-all, unknown, etc.
  if (r === 'deliverable' || r === 'valid')       return 'valid';
  if (r === 'undeliverable' || r === 'invalid')    return 'invalid';
  if (r === 'accept-all' || r === 'accept_all'
      || r === 'catchall' || r === 'catch-all'
      || r === 'catch_all' || r === 'risky')       return 'catch_all';
  if (r === 'unknown')                             return 'unknown';
  if (r === 'disposable')                          return 'disposable';
  return r || 'unknown';
}

// ─── Single verify (with 408 retry) ───

async function verifyEmail(email) {
  if (!email) return { email, status: 'invalid', sub_status: 'empty' };

  const key = apiKey();
  const url = `${BASE}?email=${encodeURIComponent(email)}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000); // 90s (API can take 80s)

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': key,
        },
        signal: ac.signal,
      });
      clearTimeout(timer);

      // 408 = verification still processing → retry (free, no extra credit)
      if (res.status === 408) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
          continue;
        }
        return { email, status: 'unknown', sub_status: 'timeout' };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
      }

      const data = await res.json();

      // BounceBan response: { result, email, domain, accept_all, ... }
      return {
        email,
        status:     mapStatus(data.result || data.status),
        sub_status: (data.sub_status || data.message || '').toLowerCase(),
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
          continue;
        }
        throw new Error(`Timeout verifying ${email} after ${MAX_RETRIES + 1} attempts`);
      }
      throw err;
    }
  }

  return { email, status: 'unknown', sub_status: 'max_retries' };
}

// ─── Sequential verify (stop on first valid) ───
//
// Returns: { found, result, allErrored, verified }
//   found=true  → result contains the valid email
//   found=false, allErrored=false → actually verified, none valid (safe to clear)
//   found=false, allErrored=true  → all API calls errored (DO NOT clear data)
//   verified    → number of emails actually sent to BounceBan API

async function verifySequential(emails, logFn) {
  let errorCount = 0;
  let verifiedCount = 0;

  for (const email of emails) {
    logFn(`[BounceBan] Verifying: ${email}`);
    try {
      const r = await verifyEmail(email);
      verifiedCount++;
      logFn(`[BounceBan] ${email} → ${r.status}`);
      if (r.status === 'valid') {
        return { found: true, result: r, allErrored: false, verified: verifiedCount };
      }
    } catch (err) {
      errorCount++;
      logFn(`[BounceBan] Error ${email}: ${err.message}`);
    }
  }

  const allErrored = errorCount > 0 && verifiedCount === 0;
  return { found: false, result: null, allErrored, verified: verifiedCount };
}

// ─── Batch verify (chunked parallelism) ───

async function verifyBatch(emails, maxPar) {
  const limit = maxPar ||
    parseInt(process.env.BOUNCEBAN_MAX_PARALLEL || '100', 10);
  const results = [];

  for (let i = 0; i < emails.length; i += limit) {
    const chunk = emails.slice(i, i + limit);
    const batch = await Promise.all(
      chunk.map((e) =>
        verifyEmail(e).catch((err) => ({
          email: e, status: 'error', sub_status: err.message,
        }))
      )
    );
    results.push(...batch);
  }
  return results;
}

module.exports = {
  verifyEmail,
  verifySequential,
  verifyBatch,
  isConfigured,
};