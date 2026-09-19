// RFC 4180 CSV parsing/serialization.

export function parseCSV(text) {
  const s = String(text).replace(/^﻿/, '');
  const delim = sniff(s);
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// Semicolon-delimited files are common where the decimal separator is a comma.
function sniff(s) {
  const first = s.slice(0, s.search(/\r?\n|$/));
  const count = ch => first.split(ch).length - 1;
  return count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ',';
}

// Text cells that start with = + - @ (or tab/CR) are executed as formulas by
// Excel/Sheets. Prefix them with ' so an exported file can never run code.
export function csvCell(v, isText) {
  if (v == null) return '';
  let s = String(v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(header, rows) {
  const lines = [header.map(h => csvCell(h, true)).join(',')];
  for (const r of rows) lines.push(r.map(([v, isText]) => csvCell(v, isText)).join(','));
  return '﻿' + lines.join('\r\n');
}
