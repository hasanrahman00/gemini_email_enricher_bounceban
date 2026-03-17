const { stringify } = require('csv-stringify/sync');
const XLSX = require('xlsx');
const { ALL_HEADERS } = require('./fileParser');

function rowsToCsv(rows) {
  const data = rows.map((r) => {
    const o = {};
    for (const h of ALL_HEADERS) o[h] = r[h] || '';
    return o;
  });
  return stringify(data, { header: true });
}

function rowsToXlsx(rows) {
  const data = rows.map((r) => {
    const o = {};
    for (const h of ALL_HEADERS) o[h] = r[h] || '';
    return o;
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { rowsToCsv, rowsToXlsx, sleep, ts };
