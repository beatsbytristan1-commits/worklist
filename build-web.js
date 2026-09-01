#!/usr/bin/env node
// Builds the static GitHub Pages version from the local app.
// The local public/index.html stays the single source of truth.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OWNER = process.env.WL_OWNER || 'beatsbytristan1-commits';
const DATA_REPO = process.env.WL_DATA_REPO || 'worklist-data';

let s = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const extra = fs
  .readFileSync(path.join(ROOT, 'web-extra.js'), 'utf8')
  .replace('__OWNER__', OWNER)
  .replace('__DATA_REPO__', DATA_REPO);

const applied = [];
function rep(old, neu, label) {
  if (!s.includes(old)) throw new Error('NOT FOUND: ' + label);
  if (s.split(old).length - 1 !== 1) throw new Error('MULTIPLE MATCHES: ' + label);
  s = s.replace(old, neu);
  applied.push(label);
}

/* ---- 1. setup overlay markup ---- */
rep(
  '<div class="modal" id="imp" hidden>',
  `<div class="modal" id="setup" hidden>
  <div class="sheetbox" style="max-width:520px">
    <div class="mh"><span style="font-size:20px">🔑</span><h3>Connect to your data</h3></div>
    <div class="mb">
      <p style="margin:0 0 14px;color:var(--muted);font-size:13.5px;line-height:1.6">
        Your lists live in the private GitHub repository
        <b>${OWNER}/${DATA_REPO}</b>. Paste a personal access token that can write to it
        and this device is set up for good.
      </p>
      <ol style="margin:0 0 16px;padding-left:20px;color:var(--muted);font-size:13px;line-height:1.9">
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank"
            rel="noopener" style="color:var(--accent2)">github.com/settings/personal-access-tokens</a></li>
        <li>Repository access → <b>Only select repositories</b> → <b>${DATA_REPO}</b></li>
        <li>Permissions → Repository permissions → <b>Contents: Read and write</b></li>
        <li>Generate, copy, and paste it below</li>
      </ol>
      <input id="setupTok" type="password" placeholder="github_pat_…" autocomplete="off"
        style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:10px;
        padding:11px 13px;font-size:13.5px;color:var(--text);outline:none">
      <p id="setupMsg" class="impmsg err" style="margin:10px 2px 0;min-height:18px"></p>
      <p style="margin:14px 2px 0;color:var(--faint);font-size:11.5px;line-height:1.6">
        The token is stored only in this browser and is sent straight to github.com — nowhere else.
      </p>
    </div>
    <div class="mf"><span class="sp"></span><button class="btn pri" id="setupGo">Connect</button></div>
  </div>
</div>

<div class="modal" id="imp" hidden>`,
  'setup overlay'
);

/* ---- 2. storage: read ---- */
rep(
  `  try{
    S=await (await fetch('/api/state',{cache:'no-store'})).json();
    lastUpdatedAt=S.updatedAt||0;
  }catch(e){ S={lists:[]}; }`,
  `  if(needsToken()){ showSetup(); return; }
  try{
    S=await ghGet();
    if(!S.lists.length && !S.groups) S=seedState();
    lastUpdatedAt=S.updatedAt||0;
  }catch(e){
    if(String(e.message||e)==='token rejected'){ ghToken=''; try{localStorage.removeItem('wl_token');}catch(_){}
      return showSetup('Your saved token no longer works. Paste a new one.'); }
    S={lists:[]};
  }`,
  'boot read'
);

/* ---- 3. storage: write ---- */
rep(
  `  try {
    const r=await fetch('/api/state',{method:'PUT',
      headers:{'Content-Type':'application/json','X-Client-Id':CLIENT_ID},body:JSON.stringify(S)});
    if(!r.ok) throw new Error('server gaf '+r.status);
    const j=await r.json(); if(j&&j.updatedAt) lastUpdatedAt=j.updatedAt;
    dirty=false; retries=0; markSaved(true);
  } catch(e){`,
  `  try {
    const ok=await ghPut(S);
    if(!ok){                       // another device committed first — take theirs, then re-apply ours
      const mine=clone(S);
      await ghGet();
      S=mine;
      if(!await ghPut(S)) throw new Error('conflict');
    }
    lastUpdatedAt=S.updatedAt;
    dirty=false; retries=0; markSaved(true);
  } catch(e){
    if(String(e.message||e)==='token rejected'){
      ghToken=''; try{localStorage.removeItem('wl_token');}catch(_){}
      markSaved(false); return showSetup('Your token stopped working. Paste a new one.');
    }`,
  'push write'
);

/* ---- 4. polling instead of SSE ---- */
rep(
  `async function pullRemote(){
  if(dirty) return;                       // our own edit takes priority
  try{
    const r=await fetch('/api/state',{cache:'no-store'});
    const remote=await r.json();
    if(!remote||!Array.isArray(remote.lists)) return;
    if(remote.updatedAt===lastUpdatedAt) return;`,
  `async function pullRemote(){
  if(dirty||!ghToken) return;             // our own edit takes priority
  try{
    const sha=await ghHead();
    if(!sha||sha===ghSha) return;
    const remote=await ghGet();
    if(!remote||!Array.isArray(remote.lists)) return;
    if(remote.updatedAt===lastUpdatedAt) return;`,
  'pullRemote'
);

rep(
  `function connectLive(){
  try{ if(es) es.close(); }catch(_){}
  es=new EventSource('/api/events');
  es.onmessage=e=>{
    let d={}; try{ d=JSON.parse(e.data); }catch(_){ return; }
    if(d.from===CLIENT_ID) return;        // ignore our own echo
    if(d.hello){ if(!lastUpdatedAt) lastUpdatedAt=d.updatedAt; return; }
    pullRemote();
  };
  es.onerror=()=>{ /* EventSource reconnects itself; polling is the fallback */ };
}
setInterval(()=>{ if(!document.hidden) pullRemote(); }, 15000);`,
  `function connectLive(){ /* no server to stream from — polling below does the job */ }
setInterval(()=>{ if(!document.hidden) pullRemote(); }, 20000);`,
  'connectLive'
);

/* ---- 5. import parses in the browser ---- */
rep(
  `    const buf=await file.arrayBuffer();
    const r=await fetch('/api/parse-sheet',{method:'POST',
      headers:{'Content-Type':'application/octet-stream','X-Filename':file.name},body:buf});
    const j=await r.json();`,
  `    const j=await parseSheetLocal(file);`,
  'import parse'
);

/* ---- 6. reports built in the browser ---- */
rep(
  `  if(dirty) await push();                 // make sure the server has your latest state first
  const base='/report?list='+encodeURIComponent(l.id);`,
  `  if(dirty) await push();
  const stamp=new Date().toISOString().slice(0,10);
  const safe=(l.name.replace(/[^\\w\\d .-]+/g,'').trim().replace(/\\s+/g,'-')||'worklist');`,
  'report base'
);

rep(
  `  item('🖨','Open report','clean overview — ⌘P for PDF',()=>{ window.open(base,'_blank'); closePop(); });
  item('📄','Download CSV','for Excel or Smartsheet',()=>{ window.location=base+'&format=csv'; closePop(); });
  item('📋','Copy as text','to paste into an email',async()=>{
    try{
      const txt=await (await fetch(base+'&format=txt')).text();
      await navigator.clipboard.writeText(txt);
      toast('Summary copied — ready to paste');
    }catch(_){ toast('Copying failed'); }
    closePop();
  });`,
  `  item('🖨','Open report','clean overview — ⌘P for PDF',()=>{
    const w=window.open('','_blank');
    if(w){ w.document.write(reportHtml(l)); w.document.close(); }
    else downloadBlob(safe+'-'+stamp+'.html','text/html',reportHtml(l));
    closePop();
  });
  item('📄','Download CSV','for Excel or Smartsheet',()=>{
    downloadBlob(safe+'-'+stamp+'.csv','text/csv;charset=utf-8',reportCsv(l)); closePop();
  });
  item('📋','Copy as text','to paste into an email',async()=>{
    try{ await navigator.clipboard.writeText(reportText(l)); toast('Summary copied — ready to paste'); }
    catch(_){ toast('Copying failed'); }
    closePop();
  });`,
  'report actions'
);

/* ---- 7. device button becomes account/settings ---- */
rep(
  `$('#netBtn').onclick=async e=>{`,
  `$('#netBtn').onclick=async e=>{
  e.stopPropagation(); closePop();
  const pop=document.createElement('div'); pop.className='pop'; pop.style.minWidth='250px';
  pop.onclick=ev=>ev.stopPropagation();
  pop.innerHTML='<div class="hd">This device</div>'
    + '<div class="hd" style="text-transform:none;letter-spacing:0;font-size:11.5px;line-height:1.6;color:var(--faint)">'
    + 'Saving to <b style="color:var(--muted)">${OWNER}/${DATA_REPO}</b>. Open this same link on any device '
    + 'and paste a token there to see the same lists.</div>';
  const b1=document.createElement('button');
  b1.innerHTML='<span class="em">📥</span><span>Download a backup<br><span style="font-size:11px;color:var(--faint)">everything as one JSON file</span></span>';
  b1.onclick=()=>{ downloadBlob('worklist-'+new Date().toISOString().slice(0,10)+'.json',
    'application/json', JSON.stringify(S,null,2)); closePop(); };
  const b2=document.createElement('button');
  b2.innerHTML='<span class="em">🕓</span><span>History on GitHub<br><span style="font-size:11px;color:var(--faint)">every change is a commit</span></span>';
  b2.onclick=()=>{ window.open('https://github.com/${OWNER}/${DATA_REPO}/commits/main/state.json','_blank'); closePop(); };
  const b3=document.createElement('button');
  b3.innerHTML='<span class="em">🔑</span><span>Replace token<br><span style="font-size:11px;color:var(--faint)">sign this device out</span></span>';
  b3.onclick=()=>{ closePop(); ghToken=''; try{localStorage.removeItem('wl_token');}catch(_){} showSetup(); };
  pop.append(b1,b2,b3);
  document.body.appendChild(pop);
  const r=e.currentTarget.getBoundingClientRect();
  pop.style.left=Math.max(10,r.left)+'px';
  pop.style.top=Math.max(10,r.top-10-pop.offsetHeight)+'px';
  return;
};

const _oldNet=async e=>{`,
  'device popover'
);

/* ---- 8. boot split so setup can finish it ---- */
rep(
  `  if(!S.lists) S.lists=[];
  let changed=false;
  if(!Array.isArray(S.groups)||!S.groups.length){
    const hasCheck=S.lists.some(l=>l.kind==='checklist');
    S.groups=[{id:'g0',name:'Lists',collapsed:false}];
    if(hasCheck) S.groups.push({id:'gstage',name:'Store staging',collapsed:false});
    S.lists.forEach(l=>{ if(!l.group) l.group=(hasCheck&&l.kind==='checklist')?'gstage':'g0'; });
    changed=true;
  }
  S.lists.forEach(l=>{
    if(l.plan===undefined){
      const n=(l.name||'').toLowerCase();
      l.plan = /vandaag|today|daily|dagelijks/.test(n) ? 'today'
             : /deze week|this week|weekly|wekelijks/.test(n) ? 'week' : 'none';
      changed=true;
    }
  });
  if(changed) save();
  lastSnap=clone(S);
  render(); paintClock(); markSaved(true); refreshUndo();
  connectLive();
})();`,
  `  afterLoad();
})();

// Runs both on a normal load and right after the token screen.
function afterLoad(){
  if(!S.lists) S.lists=[];
  let changed=false;
  if(!Array.isArray(S.groups)||!S.groups.length){
    const hasCheck=S.lists.some(l=>l.kind==='checklist');
    S.groups=[{id:'g0',name:'Lists',collapsed:false}];
    if(hasCheck) S.groups.push({id:'gstage',name:'Store staging',collapsed:false});
    S.lists.forEach(l=>{ if(!l.group) l.group=(hasCheck&&l.kind==='checklist')?'gstage':'g0'; });
    changed=true;
  }
  S.lists.forEach(l=>{
    if(l.plan===undefined){
      const n=(l.name||'').toLowerCase();
      l.plan = /today|daily/.test(n) ? 'today' : /this week|weekly/.test(n) ? 'week' : 'none';
      changed=true;
    }
  });
  lastSnap=clone(S);
  render(); paintClock(); markSaved(true); refreshUndo();
  if(changed) commit();
}

document.getElementById('setupGo').onclick=trySetup;
document.getElementById('setupTok').onkeydown=e=>{ if(e.key==='Enter') trySetup(); };`,
  'boot split'
);

/* ---- 9. inject the extras before the boot block ---- */
rep('/* ---------- boot ---------- */', extra + '\n\n/* ---------- boot ---------- */', 'inject extras');

/* ---- 10. drop the now-dead local-network popover ---- */
{
  const start = s.indexOf('const _oldNet=async e=>{');
  const end = s.indexOf("}catch(_){ pop.innerHTML='<div class=\"hd\">Could not fetch the address</div>'; }\n};", start);
  if (start < 0 || end < 0) throw new Error('NOT FOUND: dead net popover');
  const tail = s.indexOf('};', end) + 2;
  s = s.slice(0, start) + s.slice(tail);
  applied.push('remove dead popover');
}

const out = path.join(ROOT, 'web');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), s);
for (const f of ['icon.png', 'icon-192.png', 'icon-512.png', 'manifest.json']) {
  const src = path.join(ROOT, 'public', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log('built web/index.html  (' + (fs.statSync(path.join(out, 'index.html')).size / 1024).toFixed(1) + ' kB)');
console.log('patches applied: ' + applied.length);
applied.forEach((a) => console.log('  ✓ ' + a));
