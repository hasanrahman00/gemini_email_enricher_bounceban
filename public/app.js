/* ═══════════════════════════════════════════
   Gemini Email Scraper — Frontend v1.2
   ═══════════════════════════════════════════ */

const $ = (s) => document.querySelector(s);

// ── DOM refs ──
const dropZone    = $('#dropZone');
const fileInput   = $('#fileInput');
const uploadReady = $('#uploadReady');
const fileNameEl  = $('#fileName');
const clearFile   = $('#clearFile');
const jobName     = $('#jobName');
const runBtn      = $('#runBtn');
const jobsList    = $('#jobsList');
const jobsEmpty   = $('#jobsEmpty');
const cdpDot      = $('#cdpDot');
const cdpLabel    = $('#cdpLabel');
const logModal    = $('#logModal');
const logTitle    = $('#logTitle');
const logOutput   = $('#logOutput');
const logClose    = $('#logClose');
const logClear    = $('#logClear');
const refreshBtn  = $('#refreshBtn');

// ── State ──
let file  = null;
let sse   = {};
let cache = {};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  loadJobs();
  checkCdp();
  setInterval(checkCdp, 12000);
});


/* ═══════════════════════════════════════════
   UPLOAD
   ═══════════════════════════════════════════ */

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) pickFile(fileInput.files[0]);
});

clearFile.addEventListener('click', resetUpload);

function pickFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    toast('Please upload a CSV or XLSX file');
    return;
  }
  file = f;
  fileNameEl.textContent = f.name;
  uploadReady.classList.remove('hidden');
  dropZone.classList.add('hidden');
}

function resetUpload() {
  file = null;
  fileInput.value = '';
  jobName.value = '';
  uploadReady.classList.add('hidden');
  dropZone.classList.remove('hidden');
}


/* ═══════════════════════════════════════════
   RUN
   ═══════════════════════════════════════════ */

runBtn.addEventListener('click', async () => {
  if (!file) return;
  runBtn.disabled = true;
  const origHTML = runBtn.innerHTML;
  runBtn.textContent = 'Uploading…';

  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', jobName.value || file.name);

    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);

    await fetch(`/api/jobs/${d.id}/start`, { method: 'POST' });
    resetUpload();
    loadJobs();
    openSSE(d.id);
  } catch (err) {
    toast(err.message);
  } finally {
    runBtn.disabled = false;
    runBtn.innerHTML = origHTML;
  }
});


/* ═══════════════════════════════════════════
   JOBS LIST
   ═══════════════════════════════════════════ */

refreshBtn.addEventListener('click', loadJobs);

async function loadJobs() {
  try {
    const r = await fetch('/api/jobs');
    const jobs = await r.json();

    for (const j of jobs) cache[j.id] = j;
    render(jobs);

    for (const j of jobs) {
      if (j.running || j.status === 'running') openSSE(j.id);
    }
  } catch { /* silent */ }
}

function render(jobs) {
  if (!jobs.length) {
    const cards = jobsList.querySelectorAll('.jcard');
    cards.forEach((c) => c.remove());
    jobsEmpty.classList.remove('hidden');
    return;
  }

  jobsEmpty.classList.add('hidden');

  const existing = new Map();
  jobsList.querySelectorAll('.jcard').forEach((el) => {
    existing.set(el.dataset.id, el);
  });

  const jobIds = new Set(jobs.map((j) => j.id));
  for (const [id, el] of existing) {
    if (!jobIds.has(id)) el.remove();
  }

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const ex = existing.get(j.id);

    if (ex) {
      updateCard(ex, j);
    } else {
      const div = document.createElement('div');
      div.innerHTML = cardHTML(j);
      const card = div.firstElementChild;
      bindCard(card);

      const ref = jobsList.children[i + 1];
      if (ref) jobsList.insertBefore(card, ref);
      else jobsList.appendChild(card);
    }
  }
}


/* ═══════════════════════════════════════════
   CARD HTML — visible labeled buttons
   ═══════════════════════════════════════════ */

function cardHTML(j) {
  const toEnrich = j.toEnrich ?? (j.totalRows - (j.skippedRows || 0));
  const pct = j.totalRows
    ? Math.round(((j.processedRows || 0) + (j.skippedRows || 0)) / j.totalRows * 100)
    : 0;
  const done = j.status === 'completed';

  return `
  <div class="jcard" data-id="${j.id}" data-st="${j.status}">
    <div class="jcard__row1">
      <span class="jcard__name">${esc(j.name)}</span>
      <span class="badge ${j.status}">${j.status}</span>
    </div>
    <div class="jcard__counters">
      <div class="counter">
        <span class="counter__val" data-f="toEnrich">${toEnrich}</span>
        <span class="counter__label">To Enrich</span>
      </div>
      <div class="counter counter--accent">
        <span class="counter__val" data-f="enr">${j.enrichedRows || 0}</span>
        <span class="counter__label">Enriched</span>
      </div>
      <div class="counter counter--verified">
        <span class="counter__val" data-f="vrf">${j.verifiedEmails || 0}</span>
        <span class="counter__label">Verified</span>
      </div>
      <div class="counter counter--proc">
        <span class="counter__val" data-f="proc">${j.processedRows || 0}</span>
        <span class="counter__label">Processed</span>
      </div>
      <div class="counter counter--err">
        <span class="counter__val" data-f="err">${j.errorRows || 0}</span>
        <span class="counter__label">Errors</span>
      </div>
    </div>
    <div class="jcard__stats">
      <div class="st">Total <b>${j.totalRows}</b></div>
      <div class="st">Skipped <b data-f="skip">${j.skippedRows || 0}</b></div>
    </div>
    <div class="jcard__prog">
      <div class="jcard__bar${done ? ' ok' : ''}" style="width:${pct}%"></div>
    </div>
    <div class="jcard__btns">
      ${btnsHTML(j)}
    </div>
  </div>`;
}

function btnsHTML(j) {
  const run = j.status === 'running' || j.running;
  const stopped = j.status === 'stopped';
  const parts = [];

  // Stop (only when running)
  if (run) {
    parts.push(aBtn('stop', 'Stop', 'stop',
      '<rect x="5" y="5" width="14" height="14" rx="2"/>'));
  }

  // Start / Resume / Re-run
  if (j.status === 'queued') {
    parts.push(aBtn('start', 'Start', 'run',
      '<polygon points="6 3 20 12 6 21"/>'));
  }

  if (!run && j.status !== 'queued') {
    const label = stopped ? 'Resume' : 'Re-run';
    parts.push(aBtn('rerun', label, 'rerun',
      '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-12.36L1 10"/>'));
  }

  // Download
  parts.push(aBtn('dl-csv', 'CSV', 'dl',
    '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'));

  parts.push(aBtn('dl-xlsx', 'XLSX', 'dl',
    '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'));

  // Logs
  parts.push(aBtn('logs', 'Logs', '',
    '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +
    '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'));

  // Delete
  parts.push(aBtn('delete', 'Delete', 'del',
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>'));

  return parts.join('');
}

function aBtn(action, label, variant, pathsInner) {
  const cls = variant ? `abtn abtn--${variant}` : 'abtn';
  return `<button class="${cls}" data-act="${action}">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      ${pathsInner}
    </svg>
    ${label}
  </button>`;
}


/* ═══════════════════════════════════════════
   CARD UPDATE (in-place, no rebuild)
   ═══════════════════════════════════════════ */

function updateCard(card, j) {
  // Badge
  const badge = card.querySelector('.badge');
  if (badge) {
    badge.className = `badge ${j.status}`;
    badge.textContent = j.status;
  }

  // Counters + stats
  const f = (key) => card.querySelector(`[data-f="${key}"]`);
  const te  = f('toEnrich');
  const p   = f('proc');
  const e   = f('enr');
  const vrf = f('vrf');
  const er  = f('err');
  const sk  = f('skip');

  const toEnrich = j.toEnrich ?? (j.totalRows - (j.skippedRows || 0));
  if (te) te.textContent = toEnrich;
  if (p)  p.textContent  = j.processedRows || 0;
  if (er) er.textContent = j.errorRows     || 0;
  if (sk) sk.textContent = j.skippedRows   || 0;

  // Animate enriched counter on change
  if (e) {
    const newVal = j.enrichedRows || 0;
    if (e.textContent !== String(newVal)) {
      e.textContent = newVal;
      e.classList.remove('pop');
      void e.offsetWidth;
      e.classList.add('pop');
    }
  }

  // Animate verified counter on change
  if (vrf) {
    const newVal = j.verifiedEmails || 0;
    if (vrf.textContent !== String(newVal)) {
      vrf.textContent = newVal;
      vrf.classList.remove('pop');
      void vrf.offsetWidth;
      vrf.classList.add('pop');
    }
  }

  // Progress
  const bar = card.querySelector('.jcard__bar');
  if (bar) {
    const total = j.totalRows || 1;
    const done  = (j.processedRows || 0) + (j.skippedRows || 0);
    bar.style.width = Math.round(done / total * 100) + '%';
    if (j.status === 'completed') bar.classList.add('ok');
    else bar.classList.remove('ok');
  }

  // Buttons: rebuild only when status actually changes
  if (card.dataset.st !== j.status) {
    card.dataset.st = j.status;
    const btns = card.querySelector('.jcard__btns');
    if (btns) {
      btns.innerHTML = btnsHTML(j);
      bindBtns(btns);
    }
  }
}

function bindCard(card) {
  bindBtns(card.querySelector('.jcard__btns'));
}

function bindBtns(container) {
  if (!container) return;
  container.querySelectorAll('.abtn').forEach((b) =>
    b.addEventListener('click', onAction)
  );
}


/* ═══════════════════════════════════════════
   ACTIONS
   ═══════════════════════════════════════════ */

async function onAction(e) {
  const btn  = e.currentTarget;
  const card = btn.closest('.jcard');
  const id   = card.dataset.id;
  const act  = btn.dataset.act;

  switch (act) {
    case 'start':
    case 'rerun':
      btn.disabled = true;
      btn.textContent = act === 'rerun' ? 'Resuming…' : 'Starting…';
      await fetch(`/api/jobs/${id}/start`, { method: 'POST' });
      openSSE(id);
      loadJobs();
      break;

    case 'stop':
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
      // Poll until actually stopped
      pollUntilStopped(id);
      break;

    case 'delete':
      if (!confirm('Delete this job permanently?')) return;
      closeSSE(id);
      await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
      delete cache[id];
      card.remove();
      if (!jobsList.querySelector('.jcard')) {
        jobsEmpty.classList.remove('hidden');
      }
      break;

    case 'dl-csv':
      window.open(`/api/jobs/${id}/download?format=csv`, '_blank');
      break;

    case 'dl-xlsx':
      window.open(`/api/jobs/${id}/download?format=xlsx`, '_blank');
      break;

    case 'logs':
      openLogs(id);
      break;
  }
}

/** Poll until job is no longer running */
async function pollUntilStopped(id) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`/api/jobs/${id}`);
      const j = await r.json();
      if (j.status !== 'running') {
        cache[id] = j;
        loadJobs();
        return;
      }
    } catch { /* retry */ }
  }
  // Fallback: just reload
  loadJobs();
}


/* ═══════════════════════════════════════════
   SSE
   ═══════════════════════════════════════════ */

function openSSE(id) {
  if (sse[id]) return;

  const es = new EventSource(`/api/jobs/${id}/events`);
  sse[id] = es;

  es.onmessage = (e) => {
    try { handleSSE(id, JSON.parse(e.data)); }
    catch { /* skip */ }
  };

  es.onerror = () => {
    closeSSE(id);
    setTimeout(() => {
      if (cache[id]?.status === 'running') openSSE(id);
    }, 3000);
  };
}

function closeSSE(id) {
  if (sse[id]) { sse[id].close(); delete sse[id]; }
}

function handleSSE(id, msg) {
  const card = jobsList.querySelector(`.jcard[data-id="${id}"]`);

  if (msg.type === 'progress' && card) {
    const c = cache[id] || {};
    Object.assign(c, msg);
    cache[id] = c;
    updateCard(card, { ...c, status: c.status || 'running', running: true });
  }

  if (msg.type === 'status') {
    const c = cache[id] || {};
    c.status = msg.status;
    c.running = msg.status === 'running';
    cache[id] = c;
    if (msg.status !== 'running') closeSSE(id);
    loadJobs();
  }

  if (msg.type === 'log') {
    if (logModal.dataset.jid === id && !logModal.classList.contains('hidden')) {
      logOutput.textContent += msg.message + '\n';
      logOutput.scrollTop = logOutput.scrollHeight;
    }
  }
}


/* ═══════════════════════════════════════════
   LOG MODAL
   ═══════════════════════════════════════════ */

async function openLogs(id) {
  logModal.dataset.jid = id;
  logTitle.textContent = `Logs — ${cache[id]?.name || id.slice(0, 8)}`;
  logOutput.textContent = 'Loading…';
  logModal.classList.remove('hidden');

  try {
    const r = await fetch(`/api/jobs/${id}/logs`);
    const logs = await r.json();
    logOutput.textContent = logs.join('\n') + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
  } catch {
    logOutput.textContent = 'Failed to load logs.';
  }
}

logClose.addEventListener('click', closeLogs);
logClear.addEventListener('click', () => { logOutput.textContent = ''; });

logModal.addEventListener('click', (e) => {
  if (e.target === logModal) closeLogs();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !logModal.classList.contains('hidden')) closeLogs();
});

function closeLogs() {
  logModal.classList.add('hidden');
  logModal.dataset.jid = '';
}


/* ═══════════════════════════════════════════
   CDP STATUS
   ═══════════════════════════════════════════ */

async function checkCdp() {
  try {
    const r = await fetch('/api/browser-status');
    const d = await r.json();
    cdpDot.className = 'dot ' + (d.active ? 'on' : 'off');
    cdpLabel.textContent = d.active ? 'CDP Connected' : 'CDP Offline';
  } catch {
    cdpDot.className = 'dot off';
    cdpLabel.textContent = 'CDP Offline';
  }
}


/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}