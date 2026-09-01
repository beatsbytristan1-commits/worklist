// Minimal .xlsx reader — no dependencies.
// An xlsx is a zip full of XML; we unpack it with zlib and pull a grid out of it.
const zlib = require('zlib');

/* ---------- zip ---------- */
function unzip(buf) {
  const files = new Map();
  // End of central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid zip/xlsx file');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      try {
        files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
      } catch (_) { /* skip unreadable entries */ }
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

/* ---------- xml helpers ---------- */
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);
}
function textOf(xml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += decode(m[1]);
  return out;
}

function sharedStrings(files) {
  const f = files.get('xl/sharedStrings.xml');
  if (!f) return [];
  const xml = f.toString('utf8');
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

const colIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/* ---------- sheets ---------- */
// indent per cell style: styles.xml -> cellXfs -> <xf><alignment indent="n"/></xf>
function styleIndents(files) {
  const f = files.get('xl/styles.xml');
  if (!f) return [];
  const xml = f.toString('utf8');
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!block) return [];
  const out = [];
  const re = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const body = m[2] || m[1] || '';
    const ind = /\bindent="(\d+)"/.exec(body);
    out.push(ind ? +ind[1] : 0);
  }
  return out;
}

function sheetNames(files) {
  const wb = files.get('xl/workbook.xml');
  if (!wb) return [];
  const xml = wb.toString('utf8');
  const out = [];
  const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml))) out.push(decode(m[1]));
  return out;
}

function readSheet(files, path, strings, indents) {
  const f = files.get(path);
  if (!f) return { rows: [], levels: [] };
  const xml = f.toString('utf8');
  const rows = [];
  const levels = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = /\br="(\d+)"/.exec(rm[1]);
    const rIdx = rAttr ? +rAttr[1] - 1 : rows.length;
    const outline = +((/\boutlineLevel="(\d+)"/.exec(rm[1]) || [])[1] || 0);
    let firstIndent = -1;
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const attr = cm[1] || '';
      const body = cm[2] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(attr) || [])[1];
      const type = (/\bt="([^"]+)"/.exec(attr) || [])[1] || 'n';
      const ci = ref ? colIndex(ref) : cells.length;
      let val = '';
      if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v !== undefined ? (strings[+v] ?? '') : '';
      } else if (type === 'inlineStr') {
        val = textOf(body);
      } else if (type === 'str' || type === 'e') {
        val = decode((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '');
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v !== undefined ? decode(v) : '';
        // 994.0 -> 994
        if (/^-?\d+\.0+$/.test(val)) val = String(parseInt(val, 10));
      }
      cells[ci] = String(val).trim();
      if (firstIndent < 0 && cells[ci]) {
        const sIdx = +((/\bs="(\d+)"/.exec(attr) || [])[1] || -1);
        firstIndent = sIdx >= 0 && indents ? (indents[sIdx] || 0) : 0;
      }
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[rIdx] = cells;
    levels[rIdx] = Math.max(outline, Math.max(0, firstIndent));
  }
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]) rows[i] = [];
    if (levels[i] === undefined) levels[i] = 0;
  }
  return { rows, levels };
}

/** Reads an xlsx buffer and returns { sheet, sheets, rows, levels }. */
function parseXlsx(buf) {
  const files = unzip(buf);
  const strings = sharedStrings(files);
  const names = sheetNames(files);
  const indents = styleIndents(files);
  const paths = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
  if (!paths.length) throw new Error('no worksheet found');

  // take the worksheet with the most filled rows
  let best = { rows: [], levels: [], i: 0 };
  paths.forEach((p, i) => {
    const { rows, levels } = readSheet(files, p, strings, indents);
    const filled = rows.filter((r) => r.some((c) => c !== '')).length;
    if (filled > best.rows.filter((r) => r.some((c) => c !== '')).length) best = { rows, levels, i };
  });

  return { sheet: names[best.i] || 'Blad 1', sheets: names, rows: best.rows, levels: best.levels };
}

/* ---------- csv ---------- */
function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const delim = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return { sheet: 'CSV', sheets: ['CSV'], rows, levels: rows.map(() => 0) };
}

module.exports = { parseXlsx, parseCsv };
