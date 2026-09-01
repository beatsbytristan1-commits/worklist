#!/usr/bin/env node
// Worklist — zero-dependency checklist server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseXlsx, parseCsv } = require('./xlsx');
const report = require('./report');

const PORT = Number(process.env.PORT) || 4500;
// 0.0.0.0 = reachable from other devices on the same network
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const KEEP_SNAPSHOTS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function seedState() {
  const now = Date.now();
  return {
    version: 1,
    updatedAt: now,
    lists: [
      {
        id: 'l' + now,
        name: 'Today',
        emoji: '☀️',
        createdAt: now,
        tasks: [
          { id: 't' + (now + 1), text: 'Example: reply to email', done: false, star: false, due: '', note: '', createdAt: now, doneAt: 0 },
          { id: 't' + (now + 2), text: 'Example: count stock', done: false, star: true, due: '', note: '', createdAt: now, doneAt: 0 },
        ],
      },
    ],
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.lists)) return parsed;
  } catch (_) { /* fall through */ }
  const seeded = seedState();
  try { saveState(seeded); } catch (_) {}
  return seeded;
}

// On the first save of a day, keep the file as it looked right then,
// so you can always go back to the end of any previous day.
function dailySnapshot() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const now = new Date();
    const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const target = path.join(SNAP_DIR, `state-${stamp}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(DATA_FILE, target);

    const files = fs.readdirSync(SNAP_DIR)
      .filter((x) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(x))
      .sort();
    while (files.length > KEEP_SNAPSHOTS) {
      try { fs.unlinkSync(path.join(SNAP_DIR, files.shift())); } catch (_) {}
    }
  } catch (_) { /* a failed snapshot must never block saving */ }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dailySnapshot();
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch (_) {}
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --- live updates to other devices (SSE) ---
const clients = new Set();

function broadcast(payload) {
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of clients) {
    try { res.write(line); } catch (_) { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); }
  }
}, 25000).unref();

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify({ hello: true, updatedAt: loadState().updatedAt }) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Progress report for one list: /report?list=<id>[&format=csv|txt]
  if (url.pathname === '/report' && req.method === 'GET') {
    const state = loadState();
    const id = url.searchParams.get('list') || '';
    const list = state.lists.find((l) => l.id === id) || state.lists[0];
    if (!list) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('list not found');
    }
    const fmt = (url.searchParams.get('format') || 'html').toLowerCase();
    const safe = list.name.replace(/[^\w\d ·.-]+/g, '').trim().replace(/\s+/g, '-') || 'worklist';
    const day = new Date().toISOString().slice(0, 10);

    if (fmt === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safe}-${day}.csv"`,
      });
      return res.end(report.csv(list));
    }
    if (fmt === 'txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(report.text(list));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(report.html(list));
  }

  if (url.pathname === '/api/snapshots' && req.method === 'GET') {
    let list = [];
    try {
      list = fs.readdirSync(SNAP_DIR)
        .filter((x) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(x))
        .sort().reverse()
        .map((f) => {
          const st = fs.statSync(path.join(SNAP_DIR, f));
          let lists = 0, tasks = 0;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
            lists = (j.lists || []).length;
            tasks = (j.lists || []).reduce((a, l) => a + (l.tasks || []).length, 0);
          } catch (_) {}
          return { date: f.slice(6, 16), file: f, size: st.size, lists, tasks };
        });
    } catch (_) {}
    return sendJSON(res, 200, { snapshots: list });
  }

  if (url.pathname === '/api/restore' && req.method === 'POST') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { ok: false, error: 'invalid date' });
    const src = path.join(SNAP_DIR, `state-${date}.json`);
    if (!fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'no snapshot for that day' });
    try {
      const state = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (!state || !Array.isArray(state.lists)) throw new Error('snapshot could not be read');
      state.updatedAt = Date.now();
      saveState(state);
      broadcast({ updatedAt: state.updatedAt, from: 'restore' });
      return sendJSON(res, 200, { ok: true, date, lists: state.lists.length });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (url.pathname === '/api/net' && req.method === 'GET') {
    return sendJSON(res, 200, { urls: netUrls(), host: os.hostname() });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, loadState());
  }

  if (url.pathname === '/api/state' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 5e6) { req.destroy(); }
    });
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        if (!state || !Array.isArray(state.lists)) throw new Error('bad shape');
        state.updatedAt = Date.now();
        saveState(state);
        broadcast({ updatedAt: state.updatedAt, from: req.headers['x-client-id'] || '' });
        sendJSON(res, 200, { ok: true, updatedAt: state.updatedAt });
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  // Read Excel/CSV and return it as a grid — mapping happens in the UI
  if (url.pathname === '/api/parse-sheet' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20e6) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const name = String(req.headers['x-filename'] || '');
        const isCsv = /\.csv$/i.test(name) || (buf[0] !== 0x50 && buf[1] !== 0x4b);
        const out = isCsv ? parseCsv(buf.toString('utf8')) : parseXlsx(buf);
        sendJSON(res, 200, { ok: true, file: name, ...out });
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (url.pathname === '/api/export' && req.method === 'GET') {
    const state = loadState();
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Content-Disposition': 'attachment; filename="worklist-' + new Date().toISOString().slice(0, 10) + '.json"',
    });
    return res.end(JSON.stringify(state, null, 2));
  }

  serveStatic(req, res, url.pathname);
});

function netUrls() {
  const out = ['http://localhost:' + PORT];
  const host = os.hostname();
  if (host) out.push('http://' + host.replace(/\.$/, '') + ':' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push('http://' + ni.address + ':' + PORT);
    }
  }
  return [...new Set(out)];
}

server.listen(PORT, HOST, () => {
  console.log('\n  Worklist');
  netUrls().forEach((u) => console.log('   → ' + u));
  console.log('  data: ' + DATA_FILE + '\n');
});
