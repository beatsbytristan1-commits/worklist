/* =======================================================================
   Web build extras — replaces the local Node server with GitHub storage.
   Injected into web/index.html by build-web.js.
   ======================================================================= */

const GH = {
  owner: '__OWNER__',
  repo: '__DATA_REPO__',
  path: 'state.json',
  branch: 'main',
};

let ghToken = '';
let ghSha = null;

try { ghToken = localStorage.getItem('wl_token') || ''; } catch (_) {}

const b64encode = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + ghToken,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
const ghUrl = () => `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}?ref=${GH.branch}`;

/** Read state.json from the private data repo. */
async function ghGet() {
  const r = await fetch(ghUrl() + '&t=' + Date.now(), { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) { ghSha = null; return { lists: [], groups: [], updatedAt: 0 }; }
  if (r.status === 401 || r.status === 403) throw new Error('token rejected');
  if (!r.ok) throw new Error('GitHub returned ' + r.status);
  const j = await r.json();
  ghSha = j.sha;
  const state = JSON.parse(b64decode(j.content));
  return state && Array.isArray(state.lists) ? state : { lists: [], groups: [], updatedAt: 0 };
}

/** Just the sha, to see whether another device wrote something. */
async function ghHead() {
  const r = await fetch(ghUrl() + '&t=' + Date.now(), { headers: ghHeaders(), cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  return j.sha;
}

/** Write state.json as a commit. Returns false on a conflict. */
async function ghPut(state, message) {
  state.updatedAt = Date.now();
  const body = {
    message: message || ('worklist: ' + new Date().toISOString().slice(0, 16).replace('T', ' ')),
    content: b64encode(JSON.stringify(state, null, 2)),
    branch: GH.branch,
  };
  if (ghSha) body.sha = ghSha;
  const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) return false;   // someone else wrote first
  if (r.status === 401 || r.status === 403) throw new Error('token rejected');
  if (!r.ok) throw new Error('GitHub returned ' + r.status);
  const j = await r.json();
  ghSha = j.content && j.content.sha;
  return true;
}

/* ---------- setup screen ---------- */
function needsToken() {
  return !ghToken;
}

function showSetup(msg) {
  const box = document.getElementById('setup');
  box.hidden = false;
  document.getElementById('setupMsg').textContent = msg || '';
  const inp = document.getElementById('setupTok');
  inp.value = '';
  inp.focus();
}

async function trySetup() {
  const inp = document.getElementById('setupTok');
  const v = inp.value.trim();
  if (!v) return;
  const btn = document.getElementById('setupGo');
  btn.disabled = true; btn.textContent = 'Checking…';
  ghToken = v;
  try {
    const state = await ghGet();
    try { localStorage.setItem('wl_token', v); } catch (_) {}
    document.getElementById('setup').hidden = true;
    S = state;
    if (!S.lists.length) S = seedState();
    afterLoad();
  } catch (e) {
    ghToken = '';
    document.getElementById('setupMsg').textContent =
      String(e.message || e) === 'token rejected'
        ? 'That token was refused. Check that it has Contents: Read and write on the data repository.'
        : 'Could not reach GitHub: ' + (e.message || e);
  }
  btn.disabled = false; btn.textContent = 'Connect';
}

function seedState() {
  const now = Date.now();
  return {
    version: 1, updatedAt: now,
    groups: [{ id: 'g0', name: 'Lists', collapsed: false }],
    lists: [{ id: 'l' + now, name: 'Today', emoji: '☀️', group: 'g0', kind: 'tasks', plan: 'today', createdAt: now, tasks: [] }],
  };
}

/* ---------- browser-side xlsx reader ---------- */
async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipWeb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid zip/xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      try { files.set(name, method === 0 ? raw : await inflateRaw(raw)); } catch (_) {}
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

async function parseSheetLocal(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dec = new TextDecoder();
  if (/\.csv$/i.test(file.name) || !(buf[0] === 0x50 && buf[1] === 0x4b)) {
    return { ok: true, ...parseCsvWeb(dec.decode(buf)) };
  }
  const files = await unzipWeb(buf);
  const txt = (k) => (files.has(k) ? dec.decode(files.get(k)) : '');
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const decode = (s) => String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);
  const textOf = (xml) => { let o = '', m; const re = /<t[^>]*>([\s\S]*?)<\/t>/g; while ((m = re.exec(xml))) o += decode(m[1]); return o; };

  const strings = [];
  { const xml = txt('xl/sharedStrings.xml'); const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(xml))) strings.push(textOf(m[1])); }

  const indents = [];
  { const xml = txt('xl/styles.xml'); const b = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (b) { const re = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g; let m;
      while ((m = re.exec(b[1]))) { const body = m[2] || m[1] || ''; const i = /\bindent="(\d+)"/.exec(body); indents.push(i ? +i[1] : 0); } } }

  const names = [];
  { const xml = txt('xl/workbook.xml'); const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g; let m;
    while ((m = re.exec(xml))) names.push(decode(m[1])); }

  const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return 0; let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  const paths = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]);
  if (!paths.length) throw new Error('no worksheet found');

  let best = { rows: [], levels: [], i: 0, filled: -1 };
  paths.forEach((path, idx) => {
    const xml = dec.decode(files.get(path));
    const rows = [], levels = [];
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rowRe.exec(xml))) {
      const rA = /\br="(\d+)"/.exec(rm[1]);
      const rIdx = rA ? +rA[1] - 1 : rows.length;
      const outline = +((/\boutlineLevel="(\d+)"/.exec(rm[1]) || [])[1] || 0);
      let firstIndent = -1;
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cellRe.exec(rm[2]))) {
        const attr = cm[1] || '', body = cm[2] || '';
        const ref = (/\br="([A-Z]+\d+)"/.exec(attr) || [])[1];
        const type = (/\bt="([^"]+)"/.exec(attr) || [])[1] || 'n';
        const ci = ref ? colIndex(ref) : cells.length;
        let val = '';
        if (type === 's') { const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]; val = v !== undefined ? (strings[+v] ?? '') : ''; }
        else if (type === 'inlineStr') val = textOf(body);
        else if (type === 'str' || type === 'e') val = decode((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '');
        else { const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]; val = v !== undefined ? decode(v) : '';
          if (/^-?\d+\.0+$/.test(val)) val = String(parseInt(val, 10)); }
        cells[ci] = String(val).trim();
        if (firstIndent < 0 && cells[ci]) {
          const sIdx = +((/\bs="(\d+)"/.exec(attr) || [])[1] || -1);
          firstIndent = sIdx >= 0 ? (indents[sIdx] || 0) : 0;
        }
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      rows[rIdx] = cells;
      levels[rIdx] = Math.max(outline, Math.max(0, firstIndent));
    }
    for (let i = 0; i < rows.length; i++) { if (!rows[i]) rows[i] = []; if (levels[i] === undefined) levels[i] = 0; }
    const filled = rows.filter((r) => r.some((c) => c !== '')).length;
    if (filled > best.filled) best = { rows, levels, i: idx, filled };
  });
  return { ok: true, sheet: names[best.i] || 'Sheet 1', sheets: names, rows: best.rows, levels: best.levels };
}

function parseCsvWeb(text) {
  const t = text.replace(/^﻿/, '');
  const first = t.split('\n')[0];
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return { sheet: 'CSV', sheets: ['CSV'], rows, levels: rows.map(() => 0) };
}

/* ---------- reports, generated in the browser ---------- */
function reportData(l, opts) {
  const o = { qty: true, steps: true, notes: true, openOnly: false, ...(opts || {}) };
  const full = stagesOf(l);
  const stages = o.steps ? full : null;
  const all = l.tasks || [];
  const tasks = o.openOnly ? all.filter((t) => !t.done) : all;
  const units = all.reduce((a, t) => a + qtyOf(t), 0);
  const doneRows = all.filter((t) => t.done).length;
  const perStage = (stages || []).map((name, i) => ({
    name,
    rows: all.filter((t) => stCount(t, i) >= qtyOf(t)).length,
    units: all.reduce((a, t) => a + stCount(t, i), 0),
  }));
  const p = pct(l);
  const started = tasks.filter((t) => !t.done && full && stTicks(t, full.length) > 0);
  const notStarted = tasks.filter((t) => !t.done && !started.includes(t));
  return { stages, tasks, all, units, doneRows, perStage, pct: p, started, notStarted, opts: o };
}

function reportHtml(l, opts) {
  const s = reportData(l, opts);
  const o = s.opts;
  const stamp = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const head = s.stages ? s.stages.map((n) => `<th class="num">${esc(n)}</th>`).join('') : '<th class="num">Status</th>';
  const cols = (o.qty ? 1 : 0) + 1 + (s.stages ? s.stages.length : 1) + (o.notes ? 1 : 0);
  const rows = s.tasks.map((t) => {
    const q = qtyOf(t);
    const cells = s.stages
      ? s.stages.map((_, i) => { const c = stCount(t, i), full = c >= q;
          return `<td class="num ${full ? 'ok' : c > 0 ? 'part' : 'no'}">${c}/${q}</td>`; }).join('')
      : `<td class="num ${t.done ? 'ok' : 'no'}">${t.done ? '✓' : '—'}</td>`;
    return `<tr class="${t.done ? 'done' : ''}">${o.qty ? `<td class="qty">${t.qty != null && t.qty !== '' ? esc(t.qty) + '×' : ''}</td>` : ''}
      <td class="name">${esc(t.text)}</td>${cells}${o.notes ? `<td class="note">${esc(t.note || '')}</td>` : ''}</tr>`;
  }).join('');
  const stats = s.perStage.map((p2) => `<div class="stat"><div class="lbl">${esc(p2.name)}</div>
      <div class="val">${p2.rows}<span>/${s.tasks.length}</span></div>
      <div class="sub">${p2.units} of ${s.units} units</div></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(l.name)} — progress</title>
<style>
:root{--ink:#12161f;--soft:#5d6577;--line:#e3e7ee;--ok:#0f9d6b;--part:#c2820a;--accent:#3f6fe0}
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:var(--ink);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
.page{max-width:900px;margin:0 auto;padding:34px 30px 60px}
.bar-top{display:flex;align-items:flex-start;gap:16px;margin-bottom:6px}
h1{font-size:24px;margin:0;letter-spacing:-.4px}.sub{color:var(--soft);font-size:13px;margin-top:3px}
.sp{flex:1}.pct{text-align:right}.pct b{font-size:34px;letter-spacing:-1.2px;line-height:1}
.pct span{display:block;font-size:12px;color:var(--soft)}
.track{height:10px;border-radius:99px;background:#e6eaf1;overflow:hidden;margin:16px 0 22px}
.track i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--ok))}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.stat{flex:1;min-width:150px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.stat .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--soft);font-weight:700}
.stat .val{font-size:24px;font-weight:700;letter-spacing:-.6px;margin-top:2px}
.stat .val span{font-size:14px;color:var(--soft);font-weight:600}
.stat .sub{font-size:11.5px;color:var(--soft);margin:0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
th{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--soft);text-align:left;padding:10px 12px;
background:#fafbfd;border-bottom:1px solid var(--line);font-weight:700}
td{padding:9px 12px;border-bottom:1px solid #f0f3f8;vertical-align:top}tr:last-child td{border-bottom:0}
.qty{width:44px;text-align:right;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700;font-size:12.5px}
.name{font-weight:600}.note{color:var(--soft);font-size:12.5px;max-width:230px}
th.num,td.num{width:78px;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;font-size:12.5px}
td.ok{color:var(--ok)}td.part{color:var(--part)}td.no{color:#b6bdca}tr.done .name{color:var(--soft)}
.foot{margin-top:22px;color:var(--soft);font-size:11.5px}
.print{position:fixed;right:22px;bottom:22px;background:var(--ink);color:#fff;border:0;border-radius:11px;
padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.2)}
@media print{body{background:#fff}.page{padding:0;max-width:none}.print{display:none}tr{break-inside:avoid}}
</style></head><body><div class="page">
<div class="bar-top"><div><h1>${esc(l.name)}</h1>
<div class="sub">Staging progress · updated ${esc(stamp)}</div></div><div class="sp"></div>
<div class="pct"><b>${s.pct}%</b><span>${s.doneRows} of ${s.all.length} complete</span></div></div>
<div class="track"><i style="width:${s.pct}%"></i></div>
${stats ? `<div class="stats">${stats}</div>` : ''}
<table><thead><tr>${o.qty ? '<th></th>' : ''}<th>Item</th>${head}${o.notes ? '<th>Notes</th>' : ''}</tr></thead>
<tbody>${rows || `<tr><td colspan="${cols}">No rows.</td></tr>`}</tbody></table>
<div class="foot">${s.units} units in total${o.openOnly ? ` · showing only the ${s.tasks.length} rows still open` : ''}</div></div>
<button class="print" onclick="window.print()">Save as PDF / print</button></body></html>`;
}

function reportCsv(l, opts) {
  const s = reportData(l, opts);
  const o = s.opts;
  const cell = (v) => { const t = String(v ?? ''); return /[",;\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const head = ['Item'];
  if (o.qty) head.push('Quantity');
  if (s.stages) s.stages.forEach((n) => head.push(n, n + ' %')); else head.push('Done');
  head.push('Complete');
  if (o.notes) head.push('Notes');
  const lines = [head.map(cell).join(',')];
  s.tasks.forEach((t) => {
    const q = qtyOf(t);
    const row = [t.text];
    if (o.qty) row.push(t.qty != null && t.qty !== '' ? t.qty : '');
    if (s.stages) s.stages.forEach((_, i) => { const c = stCount(t, i); row.push(c, Math.round((c / q) * 100) + '%'); });
    else row.push(t.done ? 'yes' : 'no');
    row.push(t.done ? 'yes' : 'no');
    if (o.notes) row.push(t.note || '');
    lines.push(row.map(cell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function reportText(l, opts) {
  const s = reportData(l, opts);
  const o = s.opts;
  const stamp = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const out = [`${l.name.toUpperCase()} — ${s.pct}% complete`, `Updated: ${stamp}`, ''];
  if (s.perStage.length) {
    s.perStage.forEach((p2) => out.push(`${p2.name}: ${p2.rows} of ${s.tasks.length} rows · ${p2.units}/${s.units} units`));
    out.push('');
  }
  const line = (t, mark) => {
    const q = o.qty && t.qty != null && t.qty !== '' ? `${t.qty}× ` : '';
    const extra = s.stages && !t.done
      ? `  (${s.stages.map((n, i) => `${n.toLowerCase()} ${stCount(t, i)}/${qtyOf(t)}`).join(', ')})` : '';
    const note = o.notes && t.note ? `  — ${t.note}` : '';
    return `  ${mark} ${q}${t.text}${extra}${note}`;
  };
  const done = s.tasks.filter((t) => t.done);
  if (done.length) { out.push(`DONE (${done.length})`); done.forEach((t) => out.push(line(t, '[x]'))); out.push(''); }
  if (s.started.length) { out.push(`IN PROGRESS (${s.started.length})`); s.started.forEach((t) => out.push(line(t, '[~]'))); out.push(''); }
  if (s.notStarted.length) { out.push(`NOT STARTED (${s.notStarted.length})`); s.notStarted.forEach((t) => out.push(line(t, '[ ]'))); out.push(''); }
  out.push(`Total: ${s.all.length} rows · ${s.units} units`);
  return out.join('\n');
}

function downloadBlob(name, type, data) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}
