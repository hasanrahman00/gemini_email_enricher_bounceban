const { connectBrowser, newPage } = require('./browser');
const { searchGemini } = require('./gemini');
const {
  verifyEmail, verifySequential, isConfigured,
} = require('./bounceban');
const { saveJob, saveJobNow } = require('./jobStore');
const { shouldProcess } = require('./fileParser');
const { sleep, ts } = require('./utils');

// ─── State ───

const activeJobs = new Map();   // jobId → { stop }
const sseClients = new Map();   // jobId → Set<res>

// ─── SSE helpers ───

function addSse(jobId, res) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);
}

function removeSse(jobId, res) {
  sseClients.get(jobId)?.delete(res);
}

function emit(jobId, type, data) {
  const set = sseClients.get(jobId);
  if (!set?.size) return;
  const msg = JSON.stringify({ type, ...data });
  for (const res of set) {
    try { res.write(`data: ${msg}\n\n`); }
    catch { /* dead connection */ }
  }
}

// ─── Logger ───

function makeLog(job) {
  return (msg) => {
    const line = `[${ts()}] ${msg}`;
    if (!job.logs) job.logs = [];
    job.logs.push(line);
    if (job.logs.length > 600) job.logs = job.logs.slice(-500);
    emit(job.id, 'log', { message: line });
  };
}

// ─── Thread-safe queue ───

class RowQueue {
  constructor(indices) {
    this._items = [...indices];
    this._pos = 0;
  }
  next() {
    if (this._pos >= this._items.length) return null;
    return this._items[this._pos++];
  }
}

// ─── Single row processing ───

async function processRow(row, idx, page, log) {
  const name = `${row['First Name']} ${row['Last Name']}`.trim();
  log(`── Row ${idx}: ${name} ──`);

  const oldEmail  = (row['Email']  || '').trim();
  const oldStatus = (row['Status'] || '').toLowerCase().trim();
  const isCatchAll = oldStatus === 'catch_all' || oldStatus === 'catch-all';

  // Search Gemini
  const found = await searchGemini(row, page, log);

  if (!found.length) {
    log(`[Row ${idx}] No emails found from Gemini`);
    if (isCatchAll && isConfigured()) {
      log(`[Row ${idx}] Clearing catch-all: ${oldEmail}`);
      row['Email']  = '';
      row['Status'] = '';
    }
    return { enriched: false, verified: 0 };
  }

  // Verify via BounceBan
  log(`[Row ${idx}] Verifying ${found.length} email(s)…`);
  const vr = await verifySequential(found, log);

  if (vr.found) {
    log(`[Row ${idx}] ✓ Valid: ${vr.result.email}`);
    row['Email']  = vr.result.email;
    row['Status'] = 'valid';
    return { enriched: true, verified: vr.verified };
  }

  if (vr.allErrored) {
    log(`[Row ${idx}] ⚠ BounceBan errors — keeping existing data`);
    return { enriched: false, verified: 0 };
  }

  log(`[Row ${idx}] No valid email after verification`);
  if (isCatchAll || oldEmail) {
    log(`[Row ${idx}] Clearing: ${oldEmail} (${oldStatus})`);
    row['Email']  = '';
    row['Status'] = '';
  }
  return { enriched: false, verified: vr.verified };
}

// ─── Catch-all recheck pass ───

async function recheckCatchAlls(job, indices, ctrl, log) {
  const catchAlls = indices.filter((i) => {
    const s = (job.rows[i]['Status'] || '').toLowerCase().trim();
    return (s === 'catch_all' || s === 'catch-all')
      && job.rows[i]['Email'];
  });

  if (!catchAlls.length) return new Set();

  if (!isConfigured()) {
    log('⚠ BounceBan not configured — skipping catch-all recheck');
    return new Set();
  }

  log(`Rechecking ${catchAlls.length} catch-all email(s)…`);
  const upgraded = new Set();

  for (const idx of catchAlls) {
    if (ctrl.stop) break;

    const email = job.rows[idx]['Email'].trim();
    log(`[Row ${idx}] Recheck: ${email}`);

    try {
      const r = await verifyEmail(email);
      job.verifiedEmails = (job.verifiedEmails || 0) + 1;
      log(`[Row ${idx}] ${email} → ${r.status}`);
      if (r.status === 'valid') {
        job.rows[idx]['Status'] = 'valid';
        job.enrichedRows++;
        upgraded.add(idx);
      }
    } catch (err) {
      log(`[Row ${idx}] Recheck error: ${err.message}`);
    }
  }

  saveJob(job);
  emit(job.id, 'progress', stats(job));
  return upgraded;
}

// ─── Main processor ───

async function processJob(job) {
  const ctrl = { stop: false };
  activeJobs.set(job.id, ctrl);

  const log = makeLog(job);
  const isResume = job.status === 'stopped' || job.status === 'error';

  if (isResume) {
    log(`Job resumed: ${job.name} (continuing from where it left off)`);
  } else {
    log(`Job started: ${job.name} (${job.totalRows} rows)`);
  }

  if (!isConfigured()) {
    log('⚠ WARNING: BOUNCEBAN_API_KEY not configured');
    log('⚠ Emails found but NOT verified — existing data protected');
  }

  job.status = 'running';

  // On fresh start, reset counters. On resume, keep them.
  if (!isResume) {
    job.processedRows  = 0;
    job.enrichedRows   = 0;
    job.errorRows      = 0;
    job.skippedRows    = 0;
    job.verifiedEmails = 0;
  }
  if (!job.verifiedEmails) job.verifiedEmails = 0;

  saveJob(job);
  emit(job.id, 'status', { status: 'running' });

  try {
    log('Connecting to Chrome CDP…');
    await connectBrowser();
    log('Browser connected');

    // Identify rows to process (shouldProcess checks Status !== valid)
    // This naturally handles resume: rows already set to "valid" are skipped
    const toProcess = [];
    let skipCount = 0;

    for (let i = 0; i < job.rows.length; i++) {
      if (shouldProcess(job.rows[i])) {
        toProcess.push(i);
      } else {
        skipCount++;
      }
    }

    // Update skipped count from current scan
    job.skippedRows = skipCount;

    if (isResume) {
      log(`Resuming — ${toProcess.length} rows remaining, ${skipCount} already done/skipped`);
    } else {
      log(`To process: ${toProcess.length} | Skipping: ${skipCount}`);
    }

    emit(job.id, 'progress', stats(job));

    // Pass 1: recheck catch-alls
    const upgraded = await recheckCatchAlls(job, toProcess, ctrl, log);
    const remaining = toProcess.filter((i) => !upgraded.has(i));

    if (!remaining.length) {
      log('No rows left to process');
      job.status = 'completed';
      log('Job completed');
      saveJobNow(job);
      emit(job.id, 'status', { status: job.status });
      emit(job.id, 'progress', stats(job));
      activeJobs.delete(job.id);
      return;
    }

    // Pass 2: parallel Gemini windows
    const winCount = Math.min(
      parseInt(process.env.GEMINI_PARALLEL_WINDOWS || '5', 10),
      remaining.length
    );
    log(`Opening ${winCount} parallel window(s)…`);

    const pages = [];
    for (let i = 0; i < winCount; i++) {
      try {
        pages.push(await newPage());
        log(`Window ${i + 1} ready`);
      } catch (err) {
        log(`Window ${i + 1} failed: ${err.message}`);
      }
    }

    if (!pages.length) throw new Error('No browser windows available');

    const queue = new RowQueue(remaining);
    const searchDelay = parseInt(
      process.env.GEMINI_SEARCH_DELAY_MS || '2000', 10
    );

    const workers = pages.map(async (page) => {
      let rowIdx;
      while ((rowIdx = queue.next()) !== null && !ctrl.stop) {
        try {
          const res = await processRow(
            job.rows[rowIdx], rowIdx, page, log
          );
          job.processedRows++;
          job.verifiedEmails += res.verified || 0;
          if (res.enriched) job.enrichedRows++;
        } catch (err) {
          job.processedRows++;
          job.errorRows++;
          log(`[Row ${rowIdx}] ERROR: ${err.message}`);
        }

        saveJob(job);
        emit(job.id, 'progress', stats(job));
        await sleep(searchDelay);
      }

      try { await page.close(); } catch { /* ok */ }
    });

    await Promise.all(workers);

    job.status = ctrl.stop ? 'stopped' : 'completed';
    log(ctrl.stop ? 'Job stopped by user' : 'Job completed');
  } catch (err) {
    job.status = 'error';
    log(`Job error: ${err.message}`);
  }

  saveJobNow(job);
  emit(job.id, 'status', { status: job.status });
  emit(job.id, 'progress', stats(job));
  activeJobs.delete(job.id);
}

// ─── Controls ───

function stopJob(id) {
  const c = activeJobs.get(id);
  if (c) c.stop = true;
}

function isRunning(id) {
  return activeJobs.has(id);
}

function stats(job) {
  return {
    totalRows:      job.totalRows,
    processedRows:  job.processedRows,
    enrichedRows:   job.enrichedRows,
    errorRows:      job.errorRows,
    skippedRows:    job.skippedRows,
    verifiedEmails: job.verifiedEmails || 0,
    toEnrich:       job.totalRows - (job.skippedRows || 0),
  };
}

module.exports = {
  processJob,
  stopJob,
  isRunning,
  addSse,
  removeSse,
  emit,
};