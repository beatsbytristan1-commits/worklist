// Progress report for a single list — as HTML (print/PDF), CSV or plain text.
const LONG_DATE = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const qtyOf = (t) => (t.qty != null && t.qty > 1 ? t.qty : 1);

function stCount(t, i) {
  const q = qtyOf(t);
  if (t.sc && t.sc[i] != null) return Math.max(0, Math.min(q, t.sc[i]));
  return t.st && t.st[i] ? q : 0;
}

/** All the numbers for one list in one place. */
function summarize(list) {
  const stages = Array.isArray(list.stages) && list.stages.length > 1 ? list.stages : null;
  const tasks = list.tasks || [];
  const units = tasks.reduce((a, t) => a + qtyOf(t), 0);
  const doneRows = tasks.filter((t) => t.done).length;

  const perStage = (stages || []).map((name, i) => ({
    name,
    rows: tasks.filter((t) => stCount(t, i) >= qtyOf(t)).length,
    units: tasks.reduce((a, t) => a + stCount(t, i), 0),
  }));

  let pct;
  if (stages) {
    const total = units * stages.length;
    const done = tasks.reduce((a, t) => a + perStageTicks(t, stages.length), 0);
    pct = total ? Math.round((done / total) * 100) : 0;
  } else {
    pct = tasks.length ? Math.round((doneRows / tasks.length) * 100) : 0;
  }

  const started = tasks.filter((t) => !t.done && (stages ? perStageTicks(t, stages.length) > 0 : false));
  const notStarted = tasks.filter((t) => !t.done && !started.includes(t));

  return { stages, tasks, units, doneRows, perStage, pct, started, notStarted };
}

function perStageTicks(t, n) {
  let c = 0;
  for (let i = 0; i < n; i++) c += stCount(t, i);
  return c;
}

/* ---------------- HTML ---------------- */
function html(list, meta = {}) {
  const s = summarize(list);
  const now = new Date();
  const stamp = now.toLocaleDateString('en-GB', LONG_DATE);
  const title = `${list.name} — progress`;

  const head = s.stages
    ? s.stages.map((n) => `<th class="num">${esc(n)}</th>`).join('')
    : '<th class="num">Status</th>';

  const rows = s.tasks
    .map((t) => {
      const q = qtyOf(t);
      const cells = s.stages
        ? s.stages
            .map((_, i) => {
              const c = stCount(t, i);
              const full = c >= q;
              const label = q > 1 ? `${c}/${q}` : full ? '✓' : '—';
              return `<td class="num ${full ? 'ok' : c > 0 ? 'part' : 'no'}">${label}</td>`;
            })
            .join('')
        : `<td class="num ${t.done ? 'ok' : 'no'}">${t.done ? '✓' : '—'}</td>`;
      return `<tr class="${t.done ? 'done' : ''}">
        <td class="qty">${t.qty != null && t.qty !== '' ? esc(t.qty) + '×' : ''}</td>
        <td class="name">${esc(t.text)}</td>
        ${cells}
        <td class="note">${esc(t.note || '')}</td>
      </tr>`;
    })
    .join('');

  const stats = s.perStage
    .map(
      (p) => `<div class="stat">
        <div class="lbl">${esc(p.name)}</div>
        <div class="val">${p.rows}<span>/${s.tasks.length}</span></div>
        <div class="sub">${p.units} of ${s.units} units</div>
      </div>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--ink:#12161f;--soft:#5d6577;--line:#e3e7ee;--ok:#0f9d6b;--part:#c2820a;--accent:#3f6fe0}
  *{box-sizing:border-box}
  body{margin:0;background:#f4f6fa;color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .page{max-width:900px;margin:0 auto;padding:34px 30px 60px}
  .bar-top{display:flex;align-items:flex-start;gap:16px;margin-bottom:6px}
  h1{font-size:24px;margin:0;letter-spacing:-.4px}
  .sub{color:var(--soft);font-size:13px;margin-top:3px}
  .sp{flex:1}
  .pct{text-align:right}
  .pct b{font-size:34px;letter-spacing:-1.2px;line-height:1}
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
  th{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--soft);text-align:left;
    padding:10px 12px;background:#fafbfd;border-bottom:1px solid var(--line);font-weight:700}
  td{padding:9px 12px;border-bottom:1px solid #f0f3f8;vertical-align:top}
  tr:last-child td{border-bottom:0}
  .qty{width:44px;text-align:right;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700;font-size:12.5px}
  .name{font-weight:600}
  .note{color:var(--soft);font-size:12.5px;max-width:230px}
  th.num,td.num{width:78px;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;font-size:12.5px}
  td.ok{color:var(--ok)}
  td.part{color:var(--part)}
  td.no{color:#b6bdca}
  tr.done .name{color:var(--soft)}
  .foot{margin-top:22px;color:var(--soft);font-size:11.5px;display:flex;gap:10px;align-items:center}
  .print{position:fixed;right:22px;bottom:22px;background:var(--ink);color:#fff;border:0;border-radius:11px;
    padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.2)}
  .print:hover{background:#000}
  @media print{
    body{background:#fff}
    .page{padding:0;max-width:none}
    .print{display:none}
    table,.stat{break-inside:auto}
    tr{break-inside:avoid}
  }
</style></head><body>
<div class="page">
  <div class="bar-top">
    <div>
      <h1>${esc(list.name)}</h1>
      <div class="sub">${esc(meta.subtitle || 'Staging progress')} · updated ${esc(stamp)}</div>
    </div>
    <div class="sp"></div>
    <div class="pct"><b>${s.pct}%</b><span>${s.doneRows} of ${s.tasks.length} complete</span></div>
  </div>
  <div class="track"><i style="width:${s.pct}%"></i></div>
  ${stats ? `<div class="stats">${stats}</div>` : ''}
  <table>
    <thead><tr><th></th><th>Item</th>${head}<th>Notes</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" style="color:#8a92a3">No rows.</td></tr>'}</tbody>
  </table>
  <div class="foot">${s.units} units in total${list.source ? ' · source: ' + esc(list.source) : ''}</div>
</div>
<button class="print" onclick="window.print()">Save as PDF / print</button>
</body></html>`;
}

/* ---------------- CSV ---------------- */
function csv(list) {
  const s = summarize(list);
  const cell = (v) => {
    const t = String(v ?? '');
    return /[",;\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const head = ['Item', 'Quantity'];
  if (s.stages) s.stages.forEach((n) => head.push(n, n + ' %'));
  else head.push('Done');
  head.push('Complete', 'Notes');

  const lines = [head.map(cell).join(',')];
  s.tasks.forEach((t) => {
    const q = qtyOf(t);
    const row = [t.text, t.qty != null && t.qty !== '' ? t.qty : ''];
    if (s.stages) {
      s.stages.forEach((_, i) => {
        const c = stCount(t, i);
        row.push(c, Math.round((c / q) * 100) + '%');
      });
    } else row.push(t.done ? 'yes' : 'no');
    row.push(t.done ? 'yes' : 'no', t.note || '');
    lines.push(row.map(cell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* ---------------- plain text ---------------- */
function text(list) {
  const s = summarize(list);
  const stamp = new Date().toLocaleDateString('en-GB', LONG_DATE);
  const out = [];
  out.push(`${list.name.toUpperCase()} — ${s.pct}% complete`);
  out.push(`Updated: ${stamp}`);
  out.push('');
  if (s.perStage.length) {
    s.perStage.forEach((p) =>
      out.push(`${p.name}: ${p.rows} of ${s.tasks.length} rows · ${p.units}/${s.units} units`)
    );
    out.push('');
  }

  const line = (t, mark) => {
    const q = t.qty != null && t.qty !== '' ? `${t.qty}× ` : '';
    let extra = '';
    if (s.stages && !t.done) {
      const parts = s.stages
        .map((n, i) => `${n.toLowerCase()} ${stCount(t, i)}/${qtyOf(t)}`)
        .join(', ');
      extra = `  (${parts})`;
    }
    return `  ${mark} ${q}${t.text}${extra}`;
  };

  const done = s.tasks.filter((t) => t.done);
  if (done.length) { out.push(`DONE (${done.length})`); done.forEach((t) => out.push(line(t, '[x]'))); out.push(''); }
  if (s.started.length) { out.push(`IN PROGRESS (${s.started.length})`); s.started.forEach((t) => out.push(line(t, '[~]'))); out.push(''); }
  if (s.notStarted.length) { out.push(`NOT STARTED (${s.notStarted.length})`); s.notStarted.forEach((t) => out.push(line(t, '[ ]'))); out.push(''); }

  out.push(`Total: ${s.tasks.length} rows · ${s.units} units`);
  return out.join('\n');
}

module.exports = { html, csv, text, summarize };
