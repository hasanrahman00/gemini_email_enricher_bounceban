const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');

const REQUIRED = [
  'Company Name', 'Website', 'First Name', 'Last Name',
  'Job Title', 'Person LinkedIn Url', 'Email', 'Status',
];

const OPTIONAL = ['Website_one', 'Website_two'];
const ALL_HEADERS = [...REQUIRED, ...OPTIONAL];

// ─── Public API ───

function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv')                    return parseCsv(filePath);
  if (ext === '.xlsx' || ext === '.xls') return parseXlsx(filePath);
  throw new Error(`Unsupported file: ${ext}`);
}

function shouldProcess(row) {
  const s = (row.Status || '').toLowerCase().trim();
  return s !== 'valid';
}

// ─── Internals ───

function parseCsv(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  // Strip UTF-8 BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return normalizeRows(records);
}

function parseXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const records = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return normalizeRows(records);
}

function normalizeRows(records) {
  if (!records.length) throw new Error('File is empty');

  // Flexible header matching (trim + case-insensitive lookup)
  const rawHeaders = Object.keys(records[0]);
  const headerMap = {};
  for (const rh of rawHeaders) {
    const trimmed = rh.trim();
    headerMap[trimmed.toLowerCase()] = trimmed;
  }

  const missing = REQUIRED.filter(
    (h) => !headerMap[h.toLowerCase()]
  );
  if (missing.length) {
    throw new Error(`Missing required headers: ${missing.join(', ')}`);
  }

  return records.map((row, idx) => {
    const out = { _idx: idx };
    for (const h of ALL_HEADERS) {
      // Find actual key in row (case-insensitive)
      const actualKey = headerMap[h.toLowerCase()] || h;
      out[h] = (row[actualKey] ?? '').toString().trim();
    }
    return out;
  });
}

module.exports = {
  parseFile,
  shouldProcess,
  REQUIRED_HEADERS: REQUIRED,
  OPTIONAL_HEADERS: OPTIONAL,
  ALL_HEADERS,
};
