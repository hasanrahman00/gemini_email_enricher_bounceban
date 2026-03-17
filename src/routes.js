const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { v4: uuid } = require('uuid');
const { parseFile } = require('./fileParser');
const { saveJobNow, loadJob, loadAllJobs, deleteJob } = require('./jobStore');
const { rowsToCsv, rowsToXlsx } = require('./utils');
const { checkStatus } = require('./browser');
const {
  processJob, stopJob, isRunning,
  addSse, removeSse,
} = require('./processor');

const router = express.Router();

// ── Upload config ──

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(__dirname, '..', 'data')),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── List jobs (lightweight, no rows) ──

router.get('/jobs', (req, res) => {
  const jobs = loadAllJobs().map((j) => ({
    ...j,
    running: isRunning(j.id),
    toEnrich: j.totalRows - (j.skippedRows || 0),
  }));
  jobs.sort((a, b) => b.createdAt - a.createdAt);
  res.json(jobs);
});

// ── Upload + create job ──

router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rows = parseFile(req.file.path);
    const job = {
      id:            uuid(),
      name:          req.body.name || req.file.originalname,
      status:        'queued',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      totalRows:     rows.length,
      processedRows: 0,
      enrichedRows:  0,
      errorRows:     0,
      skippedRows:   0,
      rows,
      logs: [`[${new Date().toISOString()}] Job created: ${req.file.originalname}`],
      fileName: req.file.originalname,
    };

    saveJobNow(job);
    res.json({ id: job.id, name: job.name, totalRows: job.totalRows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Start / Resume job ──

router.post('/jobs/:id/start', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job)              return res.status(404).json({ error: 'Not found' });
  if (isRunning(job.id)) return res.status(400).json({ error: 'Already running' });

  // processJob handles both fresh start and resume internally
  // (checks job.status to decide whether to reset counters)
  processJob(job).catch((e) => console.error('Job error:', e));
  res.json({ status: 'started' });
});

// ── Stop job ──

router.post('/jobs/:id/stop', async (req, res) => {
  const id = req.params.id;

  if (!isRunning(id)) {
    return res.json({ status: 'not_running' });
  }

  // Signal stop
  stopJob(id);

  // Wait up to 5s for job to actually stop
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isRunning(id)) {
      return res.json({ status: 'stopped' });
    }
  }

  // Still running (worker mid-Gemini), but stop is signaled
  res.json({ status: 'stopping' });
});

// ── Delete job ──

router.delete('/jobs/:id', (req, res) => {
  if (isRunning(req.params.id)) stopJob(req.params.id);
  deleteJob(req.params.id);
  res.json({ status: 'deleted' });
});

// ── Single job detail ──

router.get('/jobs/:id', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ ...job, rows: undefined, running: isRunning(job.id) });
});

// ── Logs ──

router.get('/jobs/:id/logs', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job.logs || []);
});

// ── Download ──

router.get('/jobs/:id/download', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const fmt  = req.query.format || 'csv';
  const safe = (job.name || 'export').replace(/[^a-zA-Z0-9_\-.]/g, '_');

  if (fmt === 'xlsx') {
    const buf = rowsToXlsx(job.rows);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
    return res.send(buf);
  }

  const csv = rowsToCsv(job.rows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
  res.send(csv);
});

// ── SSE events (with heartbeat) ──

router.get('/jobs/:id/events', (req, res) => {
  const jobId = req.params.id;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  addSse(jobId, res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSse(jobId, res);
  });
});

// ── Browser status ──

router.get('/browser-status', async (req, res) => {
  const active = await checkStatus();
  res.json({ active });
});

module.exports = router;