const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');

// ─── Directory bootstrap ───

function ensureDirs() {
  // data/ for uploads, data/jobs/ for persistence
  // recursive:true = no error if already exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('  [store] Created data/');
  }
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    console.log('  [store] Created data/jobs/');
  }
}

// Run on first require
ensureDirs();

// ─── Startup recovery ───
// After crash/restart, jobs stuck as "running" have no
// worker behind them. Reset them to "stopped" so the
// user can re-run from the UI.

function recoverStaleJobs() {
  ensureDirs();

  const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  let recovered = 0;

  for (const f of files) {
    const fp = path.join(JOBS_DIR, f);
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));

      if (raw.status === 'running') {
        raw.status = 'stopped';
        raw.updatedAt = Date.now();
        raw.logs = raw.logs || [];
        raw.logs.push(
          `[${new Date().toISOString()}] Server restarted — job auto-stopped`
        );
        fs.writeFileSync(fp, JSON.stringify(raw));
        recovered++;
      }
    } catch { /* skip corrupt */ }
  }

  if (recovered) {
    console.log(`  [store] Recovered ${recovered} stale running job(s) → stopped`);
  }
  return recovered;
}

// ─── Debounced save ───

const savePending = new Map();

function saveJob(job) {
  if (savePending.has(job.id)) clearTimeout(savePending.get(job.id));

  savePending.set(
    job.id,
    setTimeout(() => {
      savePending.delete(job.id);
      _writeJob(job);
    }, 300)
  );
}

function saveJobNow(job) {
  if (savePending.has(job.id)) {
    clearTimeout(savePending.get(job.id));
    savePending.delete(job.id);
  }
  _writeJob(job);
}

function _writeJob(job) {
  ensureDirs();

  const data = {
    id:            job.id,
    name:          job.name,
    status:        job.status,
    createdAt:     job.createdAt,
    updatedAt:     Date.now(),
    totalRows:     job.totalRows,
    processedRows: job.processedRows,
    enrichedRows:  job.enrichedRows,
    errorRows:     job.errorRows,
    skippedRows:    job.skippedRows,
    verifiedEmails: job.verifiedEmails || 0,
    rows:           job.rows,
    logs:          (job.logs || []).slice(-500),
    fileName:      job.fileName,
  };

  const filePath = path.join(JOBS_DIR, `${job.id}.json`);
  const tmpPath  = filePath + '.tmp';

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.writeFileSync(filePath, JSON.stringify(data)); }
    catch { /* swallow */ }
  }
}

// ─── Load ───

function loadJob(jobId) {
  const fp = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return null; }
}

function loadAllJobs() {
  ensureDirs();
  const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  const jobs = [];

  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf-8'));
      jobs.push({
        id:            raw.id,
        name:          raw.name,
        status:        raw.status,
        createdAt:     raw.createdAt,
        totalRows:     raw.totalRows,
        processedRows: raw.processedRows,
        enrichedRows:  raw.enrichedRows,
        errorRows:      raw.errorRows,
        skippedRows:    raw.skippedRows,
        verifiedEmails: raw.verifiedEmails || 0,
        fileName:       raw.fileName,
      });
    } catch { /* skip corrupt */ }
  }

  return jobs;
}

// ─── Delete ───

function deleteJob(jobId) {
  const fp = path.join(JOBS_DIR, `${jobId}.json`);
  try { fs.unlinkSync(fp); } catch { /* ok */ }
}

// ─── Exports ───

module.exports = {
  ensureDirs,
  recoverStaleJobs,
  saveJob,
  saveJobNow,
  loadJob,
  loadAllJobs,
  deleteJob,
  DATA_DIR,
  JOBS_DIR,
};