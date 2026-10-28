/* SIGI · Should I Get It?  Front end.
   Sign-in and saved lists: Supabase (config comes from /api/config).
   "Ask Claude to compare": POST /api/compare on our own server. */
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = d => { try { return new Date(d+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); } catch(e){ return d; } };
const ago = iso => { const s=(Date.now()-new Date(iso))/1000; return s<90?'just now':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago'; };
const SRC = {cpsc:'CPSC', fda:'FDA food', seat:'NHTSA seat'};
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v==null ? d : JSON.parse(v); } catch(e){ return d; } };
const lsSet = (k, v) => { try { v==null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
let DATA = null, IDX = null, IDF = {}, CONFIG = {}, sb = null;
const vcache = {};
let tt;
function toast(msg){ let t=$('.toast'); if(!t){t=document.createElement('div');t.className='toast';t.setAttribute('role','status');document.body.appendChild(t);} t.textContent=msg; t.hidden=false; clearTimeout(tt); tt=setTimeout(()=>t.hidden=true,2600); }

/* ================= theme ================= */
function applyTheme(t){
  if (t==='light'||t==='dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $$('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSet===(t||'system')));
}
applyTheme(lsGet('sigi-theme', 'system'));
$$('[data-theme-set]').forEach(b => b.addEventListener('click', () => { lsSet('sigi-theme', b.dataset.themeSet); applyTheme(b.dataset.themeSet); }));

/* ================= auth ================= */
let ME = null; // {mode:'user'|'guest', id, email, name}
function nameFromEmail(e){ const n = (e||'').split('@')[0].replace(/[._-]+/g,' ').trim(); return n ? n[0].toUpperCase()+n.slice(1) : 'You'; }
async function enterAs(session){
  ME = session
    ? {mode:'user', id:session.user.id, email:session.user.email, name: session.user.user_metadata?.full_name || nameFromEmail(session.user.email)}
    : {mode:'guest', name:'Guest'};
  if (!session) lsSet('sigi-guest-mode', true);
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#hello').innerHTML = 'Hi,<b></b>'; $('#hello b').textContent = ME.name.split(' ')[0];
  $('#me-name').textContent = ME.mode==='user' ? ME.name : 'Guest';
  $('#me-mode').textContent = ME.mode==='user' ? `${ME.email} · list syncs across devices` : 'Guest · list saved on this device only. Sign out, then sign in to sync it.';
  $('#me-av').src = 'img/logo-mark.png';
  const h = (location.hash||'').slice(1); show(['check','mine','latest','account'].includes(h) ? h : 'check');
  await initStore();
}
function showAuth(){
  ME = null; items = []; checks = []; statusCache = [];
  $('#app').hidden = true; $('#auth').hidden = false; window.scrollTo(0,0);
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!sb){ toast('Sign-in isn’t set up on this server yet.'); return; }
  const email = $('#email').value.trim(); if (!email) return;
  $('#login-btn').disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
  $('#login-btn').disabled = false;
  if (error){ toast(error.message || 'Couldn’t send the link. Try again.'); return; }
  $('#sent').hidden = false;
  $('#sent').textContent = `Check ${email} for a sign-in link. Open it on this device to finish signing in.`;
});
$('#guest').addEventListener('click', () => enterAs(null));
$('#signout').addEventListener('click', async () => {
  lsSet('sigi-guest-mode', null);
  if (ME?.mode==='user' && sb) await sb.auth.signOut().catch(()=>{});
  showAuth();
});

/* ================= matching ================= */
const STOP = new Set('the and for with of a an in on to by from inc llc co ltd recalls recall due risk recalled sold about this that are is be or as at its it brand model'.split(' '));
function toks(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(w => w.length>1 && !STOP.has(w)); }
function buildIndex(){
  const df = {};
  IDX = DATA.products.map(r => {
    const title = r.title.replace(/\b(recalled )?due to\b.*$/i,'').replace(/;.*$/,'');
    const set = new Set(toks([title,r.products,r.model,r.type].join(' ')));
    const b = toks(r.src==='seat' ? r.products : title).filter(w=>!['child','seat'].includes(w));
    const brand = new Set([...b.slice(0,3), toks(r.products)[0]].filter(Boolean));
    set.forEach(w => df[w]=(df[w]||0)+1);
    return {r, set, words:[...set], brand};
  });
  for (const w in df) IDF[w] = Math.log(1 + IDX.length/df[w]);
}
function search(q, n=6){
  const digits = q.replace(/\D/g,'');
  if (/^\d{8,14}$/.test(q.trim().replace(/\s/g,''))) {
    const bare = digits.replace(/^0+/,'');
    const hits = IDX.filter(x => (x.r.upc||[]).some(u => u.replace(/\D/g,'').replace(/^0+/,'') === bare));
    return {upc:digits, hits: hits.map(x => ({r:x.r, cov:1, n:1, branded:true})), strong:[]};
  }
  const qt = [...new Set(toks(q))];
  if (!qt.length) return {hits:[], strong:[], qt};
  const wq = w => IDF[w] || Math.log(1+IDX.length);
  const total = qt.reduce((a,w)=>a+wq(w),0);
  const out = [];
  for (const x of IDX){
    let s=0, n=0;
    for (const w of qt){
      if (x.set.has(w)) { s+=wq(w); n++; continue; }
      if (w.length>=4 && x.words.some(v => v.startsWith(w) || (v.length>=5 && w.startsWith(v)))) { s+=wq(w)*0.7; n++; }
    }
    if (n) out.push({r:x.r, cov:s/total, n, branded: qt.some(w => x.brand.has(w))});
  }
  out.sort((a,b)=> b.cov-a.cov || (b.r.date>a.r.date?1:-1));
  const top = out[0]?.cov || 0;
  return {hits: out.filter(h => h.cov >= Math.max(0.45, top*0.6)).slice(0,n), strong: out.filter(h=>h.cov>=0.8), qt};
}
function verdictFor(res){
  const top = res.hits[0], qtLen = (res.qt||[]).length;
  if (res.upc) return top ? 'skip' : 'none';
  if (!top) return 'get';
  if (top.cov < 0.5 || top.n < Math.min(2, qtLen)) return 'get';
  if (top.cov >= 0.8 && top.branded && res.strong.filter(h=>h.branded).length < 3) return 'skip';
  return 'check';
}
function bars(c){ const k = c>=.8?4:c>=.65?3:c>=.5?2:1; return '<span class="strength" title="Match strength">'+[1,2,3,4].map(i=>`<i class="${i<=k?'on':''}"></i>`).join('')+'</span>'; }

/* ================= check: products ================= */
function recallCard(r, extra=''){
  return `<article class="rc">
    <div class="meta"><span class="pill">${SRC[r.src]}</span><span>${fmtDate(r.date)}</span>${r.units?`<span>${esc(r.units)} units</span>`:''}${extra}</div>
    <div class="t">${esc(r.title)}</div>
    ${r.hazard?`<div class="d"><b>Hazard:</b> ${esc(r.hazard)}</div>`:''}
    ${r.model?`<div class="d"><b>${r.src==='fda'?'Lot / codes':'Models'}:</b> ${esc(r.model)}</div>`:''}
    ${r.remedy?`<div class="d"><b>What to do:</b> ${esc(r.remedy)}</div>`:''}
    ${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener">Official notice ↗</a>`:''}
  </article>`;
}
const VERD = { get:['GET IT','get'], check:['CHECK IT','check'], skip:['SKIP IT','skip'], none:['NO MATCH','get'] };
function tagHTML(v, why, actions=''){
  const [w,c] = VERD[v];
  return `<div class="tag ${c}"><div class="word">${w}</div><div class="why">${why}</div>${actions?`<div class="row">${actions}</div>`:''}</div>`;
}
let lastQuery = '', lastHits = [];
function runCheck(q, {log=true}={}){
  q = q.trim(); if (!q || !DATA) return;
  lastQuery = q;
  const res = search(q); lastHits = res.hits;
  const v = verdictFor(res);
  let why;
  if (res.upc) why = res.hits.length ? `Barcode ${esc(res.upc)} appears on a recall notice.` : `Barcode ${esc(res.upc)} isn't on any recall notice. Most notices don't list barcodes, so also search by brand and model.`;
  else if (v==='skip') why = `A recall closely matches “${esc(q)}”. Compare the model numbers below before you buy.`;
  else if (v==='check'){
    const top = res.hits[0], brandHit = res.strong.filter(h=>h.branded).length;
    if (brandHit >= 3) why = `${brandHit} different recalls match “${esc(q)}”. Find the model number on yours and compare it below.`;
    else if (top.cov >= 0.8 && !top.branded) why = `${res.strong.length} recall${res.strong.length>1?'s':''} cover this kind of product, but your search doesn't name a recalled brand. Add the brand, or check if yours is one below.`;
    else why = `Some recalls partly match “${esc(q)}”. They may be a different model, so look closely.`;
  }
  else why = `No recalls in the last two years match “${esc(q)}”. That covers CPSC products, FDA Class I food and NHTSA child seats.`;
  const actions = [
    res.hits.length && CONFIG.compareEnabled ? `<button class="btn small" id="ask">Ask Claude to compare</button>` : '',
    `<button class="btn small ghost" id="watch-prod">I own this, watch it</button>`,
    `<button class="btn small ghost" id="share">Share verdict</button>`].join('');
  let html = tagHTML(v, why, actions) + `<div id="ai"></div>`;
  if (res.hits.length){
    html += `<h3>${v==='get'?'Loosely related, probably not yours':res.hits.length===1?'Matching recall':'Closest recalls'}</h3>`;
    html += res.hits.map(h => recallCard(h.r, bars(h.cov))).join('');
  }
  $('#result').innerHTML = html;
  $('#ask')?.addEventListener('click', askClaude);
  $('#watch-prod').addEventListener('click', () => addItem({kind:'product', label:q, q}));
  $('#share').addEventListener('click', () => share(`SIGI says ${VERD[v][0]} for “${q}”. ${res.hits[0]?'Closest recall: '+res.hits[0].r.title+' '+res.hits[0].r.url:'No matching recalls found.'}`));
  if (log) logCheck({kind:'product', label:q, q, verdict:v});
}
async function share(text){
  if (navigator.share){ try { await navigator.share({title:'SIGI', text}); return; } catch(e){ if (e?.name==='AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch(e){ toast('Couldn’t copy. Long-press the text to copy it.'); }
}

/* Claude double-check, through our server */
async function askClaude(){
  const box = $('#ai'), btn = $('#ask');
  if (ME?.mode!=='user'){ box.innerHTML = `<div class="ai">Sign in to use Ask Claude. It's free for you, and signing in stops strangers from using up the app's AI credit.</div>`; return; }
  btn.disabled = true;
  box.innerHTML = `<div class="ai"><span><span class="spinner"></span> Claude is comparing model details…</span></div>`;
  const cands = lastHits.map(h => ({id:h.r.id, title:h.r.title, products:h.r.products, models_or_lots:h.r.model, type:h.r.type, date:h.r.date}));
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch('/api/compare', { method:'POST', headers:{'content-type':'application/json', authorization:'Bearer '+(session?.access_token||'')}, body: JSON.stringify({query:lastQuery, candidates:cands}) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'Claude couldn’t finish that check.');
    const v = ['skip','check','get'].includes(out?.verdict) ? out.verdict : 'check';
    const fit = Object.fromEntries((out?.matches||[]).map(m => [m.id, m]));
    const label = {same:'Same product', maybe:'Maybe', different:'Different'};
    box.innerHTML = `<div class="ai"><b>Claude's read: ${VERD[v][0]}</b><span>${esc(out?.summary||'')}</span>
      ${lastHits.map(h => fit[h.r.id] ? `<span class="hint"><span class="pill ${fit[h.r.id].fit==='same'?'hot':fit[h.r.id].fit==='maybe'?'warn':'ok'}">${label[fit[h.r.id].fit]||'?'}</span> ${esc(h.r.title.slice(0,70))}${h.r.title.length>70?'…':''}: ${esc(fit[h.r.id].reason||'')}</span>`:'').join('')}
      <span class="hint">Claude compared only the notices above. Confirm on the official notice.</span></div>`;
  } catch(e){
    box.innerHTML = `<div class="ai">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
}

/* barcode from photo */
let zxingLoad = null;
const loadZXing = () => window.ZXing ? Promise.resolve() : (zxingLoad ||= new Promise((ok, bad) => { const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'; s.onload=ok; s.onerror=bad; document.head.appendChild(s); }));
$('#scan').addEventListener('click', () => $('#barcode-file').click());
$('#barcode-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value=''; if (!f) return;
  toast('Reading barcode…');
  try {
    await loadZXing();
    const url = URL.createObjectURL(f);
    const r = await new ZXing.BrowserMultiFormatReader().decodeFromImageUrl(url);
    URL.revokeObjectURL(url);
    $('#q').value = r.getText(); runCheck(r.getText());
  } catch(err){ toast('No barcode found. Try a closer, sharper photo.'); }
});

/* ================= check: vehicles ================= */
const titleCase = s => s.replace(/\b([A-Z])([A-Z]+)\b/g,(m,a,b)=>a+b.toLowerCase());
function opt(sel, list, ph){ sel.innerHTML = `<option value="">${ph}</option>` + list.map(x=>`<option>${esc(x)}</option>`).join(''); }
$('#mk').addEventListener('change', () => {
  const m = $('#mk').value; $('#yr').disabled = true; opt($('#yr'),[], 'Year');
  if (!m){ $('#md').disabled = true; return; }
  opt($('#md'), Object.keys(DATA.makes[m].m).sort(), 'Model'); $('#md').disabled = false;
});
$('#md').addEventListener('change', () => {
  const m=$('#mk').value, md=$('#md').value; if(!md) return;
  opt($('#yr'), DATA.makes[m].m[md].slice().sort().reverse(), 'Year'); $('#yr').disabled=false;
});
$('#yr').addEventListener('change', () => { if ($('#yr').value) runCar($('#mk').value, $('#md').value, $('#yr').value); });
function pickCar(mk, md, yr){
  setMode('car'); $('#mk').value=mk; $('#mk').dispatchEvent(new Event('change'));
  $('#md').value=md; $('#md').dispatchEvent(new Event('change')); $('#yr').value=yr;
}
function loadMake(mk){
  const f = DATA.makes[mk]?.f; if (!f) return Promise.resolve(null);
  return vcache[f] ||= fetch(`data/v/${f}.json`).then(r=>{ if(!r.ok) throw 0; return r.json(); }).catch(()=>{ delete vcache[f]; return null; });
}
async function carRecalls(mk, md, yr){
  const d = await loadMake(mk); if (!d) return [];
  return (d.models?.[md]?.[yr] || []).map(id => ({id, ...d.campaigns[id]})).sort((a,b)=> a.d<b.d?1:-1);
}
function campCard(c){
  return `<article class="rc"><div class="meta"><span class="pill">NHTSA ${esc(c.id)}</span><span>${fmtDate(c.d)}</span>${c.n?'<span class="pill hot">Do not drive</span>':''}${c.o?'<span class="pill warn">Park outside</span>':''}</div>
    <div class="t">${esc(c.c)}</div><div class="d">${esc(c.s)}</div>
    ${c.q?`<div class="d"><b>Risk:</b> ${esc(c.q)}</div>`:''}${c.r?`<div class="d"><b>Fix:</b> ${esc(c.r)}</div>`:''}
    <a href="https://www.nhtsa.gov/recalls?nhtsaId=${esc(c.id)}" target="_blank" rel="noopener">NHTSA notice ↗</a></article>`;
}
async function runCar(mk, md, yr, {log=true}={}){
  $('#result').innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  const list = await carRecalls(mk, md, yr);
  const label = titleCase(`${yr} ${mk} ${md}`);
  const severe = list.filter(c=>c.n||c.o).length;
  const recent = list.filter(c=> c.d >= `${new Date().getFullYear()-1}-01-01`).length;
  const v = severe ? 'skip' : list.length ? 'check' : 'get';
  const why = !list.length ? `No safety recalls on file for the ${esc(label)}.`
    : `${list.length} recall${list.length>1?'s':''} on the ${esc(label)}${severe?`, including ${severe} with a do-not-drive or park-outside warning`:''}${recent?`. ${recent} issued since last January`:''}. Ask the seller for proof each one was fixed, or run the VIN.`;
  const actions = `<a class="btn small" href="https://www.nhtsa.gov/recalls" target="_blank" rel="noopener">Check the exact VIN ↗</a><button class="btn small ghost" id="watch-car">I own this, watch it</button>`;
  $('#result').innerHTML = tagHTML(v, why, actions) + (list.length?`<h3>Recalls, newest first</h3>`:'') + list.map(campCard).join('');
  $('#watch-car').addEventListener('click', () => addItem({kind:'car', label, make:mk, model:md, year:yr}));
  if (log) logCheck({kind:'car', label, make:mk, model:md, year:yr, verdict:v});
}

/* ================= storage: Supabase when signed in, this browser for guests ================= */
let items = [], checks = [], store = null;
const ITEM_COLS = 'id,kind,label,q,make,model,year,added';
const CHECK_COLS = 'id,kind,label,q,make,model,year,verdict,at';
function guestData(){ return lsGet('sigi-guest', {items:[], checks:[]}); }
async function initStore(){
  store = null;
  if (ME.mode==='user' && sb){
    const reload = async () => {
      const [a, b] = await Promise.all([
        sb.from('watch_items').select(ITEM_COLS).order('created_at', {ascending:false}),
        sb.from('checks').select(CHECK_COLS).order('at', {ascending:false}).limit(30)]);
      if (a.error || b.error){ toast('Couldn’t load your saved list. Check your connection.'); return; }
      items = a.data; checks = b.data; renderMine(); renderAccount();
    };
    store = {
      reload,
      add: async it => { const t = it.list==='history' ? 'checks' : 'watch_items'; const {list, ...row} = it; const { error } = await sb.from(t).insert(row); if (error) throw error; await reload(); },
      del: async (id, list) => { const { error } = await sb.from(list==='history'?'checks':'watch_items').delete().eq('id', id); if (error) throw error; await reload(); },
      clearChecks: async () => { await sb.from('checks').delete().eq('user_id', ME.id); await reload(); },
    };
    // move a guest list on this device into the account
    const g = guestData();
    if (g.items.length || g.checks.length){
      for (const it of g.items) await sb.from('watch_items').insert({kind:it.kind,label:it.label,q:it.q,make:it.make,model:it.model,year:it.year,added:it.added}).then(()=>{});
      lsSet('sigi-guest', null); toast('Moved your guest list into your account');
    }
    await reload();
    return;
  }
  const g = guestData(); items = g.items; checks = g.checks;
  const save = () => lsSet('sigi-guest', {items, checks});
  store = {
    reload: async () => {},
    add: async it => { (it.list==='history'?checks:items).unshift(it); save(); renderMine(); renderAccount(); },
    del: async id => { items = items.filter(x=>x.id!==id); checks = checks.filter(x=>x.id!==id); save(); renderMine(); renderAccount(); },
    clearChecks: async () => { checks = []; save(); renderAccount(); },
  };
  renderMine(); renderAccount();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) store?.reload(); });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'g'+Date.now().toString(36)+Math.random().toString(36).slice(2));
async function addItem(it){
  if (!store){ toast('Still loading. Try again in a second.'); return; }
  if (items.some(x => x.label.toLowerCase()===it.label.toLowerCase())) { toast('Already in My stuff'); return; }
  Object.assign(it, {added:new Date().toISOString().slice(0,10)});
  if (ME.mode!=='user') it.id = newId();
  try { await store.add(it); toast('Added to My stuff'); } catch(e){ toast('Couldn’t save that. Try again.'); }
}
async function logCheck(h){
  if (!store) return;
  h.list = 'history';
  if (ME.mode==='user'){ sb.from('checks').delete().eq('label', h.label).then(() => store.add(h)).catch(()=>{}); return; }
  checks = checks.filter(x => x.label.toLowerCase()!==h.label.toLowerCase()).slice(0,29);
  Object.assign(h, {id:newId(), at:new Date().toISOString()});
  store.add(h);
}

/* ================= my stuff ================= */
let statusCache = [], renderSeq = 0;
async function itemStatus(it){
  if (it.kind==='car'){
    const list = await carRecalls(it.make, it.model, it.year);
    const fresh = list.filter(c=>c.d>=it.added).length;
    return {v: list.some(c=>c.n||c.o)?'skip':list.length?'check':'get',
      text: list.length ? `${list.length} recall${list.length>1?'s':''}${fresh?` · ${fresh} new since added`:''}` : 'No recalls on file'};
  }
  const res = search(it.q || it.label, 4); let v = verdictFor(res); if (v==='none') v='get';
  const fresh = v!=='get' ? res.hits.filter(h=>h.r.date>=it.added && h.cov>=.5).length : 0;
  return {v, text: (v==='skip'?'Recall matches':v==='check'?'Possible recall, check the model':'No recalls found') + (fresh?` · ${fresh} new since added`:'')};
}
async function renderMine(){
  const el = $('#mine-list');
  if (!DATA) return;
  const seq = ++renderSeq;
  if (!items.length){ el.innerHTML = `<div class="empty">Nothing here yet. Add your kids' car seat, your car, the space heater. Anything you'd want to hear about.</div>`; $('#badge').hidden=true; statusCache=[]; renderAccount(); return; }
  const snapshot = items.slice();
  const st = await Promise.all(snapshot.map(itemStatus));
  if (seq !== renderSeq) return;
  statusCache = st;
  const alerts = st.filter(s=>s.v!=='get').length;
  el.innerHTML = snapshot.map((it,i) => `
    <div class="item" tabindex="0" data-i="${i}"><span class="dot ${st[i].v}"></span>
      <div style="min-width:0"><div class="n">${esc(it.label)}</div><div class="s">${it.kind==='car'?'Vehicle · ':''}${esc(st[i].text)}</div></div>
      <button class="x" data-del="${esc(it.id)}" aria-label="Remove ${esc(it.label)}">×</button></div>`).join('');
  $('#badge').textContent = alerts; $('#badge').hidden = !alerts;
  el.querySelectorAll('.item').forEach(row => {
    const open = () => openEntry(snapshot[+row.dataset.i]);
    row.addEventListener('click', e => { if (!e.target.closest('[data-del]')) open(); });
    row.addEventListener('keydown', e => { if (e.key==='Enter' && !e.target.closest('[data-del]')) open(); });
  });
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => store.del(b.dataset.del).catch(()=>toast('Couldn’t remove that. Try again.'))));
  renderAccount();
}
function openEntry(it){
  show('check');
  if (it.kind==='car'){ pickCar(it.make, it.model, it.year); runCar(it.make, it.model, it.year, {log:false}); }
  else { setMode('prod'); $('#q').value = it.q || it.label; runCheck(it.q || it.label, {log:false}); }
}
$('#addform').addEventListener('submit', e => { e.preventDefault(); const v=$('#addq').value.trim(); if(!v) return; addItem({kind:'product', label:v, q:v}); $('#addq').value=''; });

/* ================= latest ================= */
const FILTERS = [
  ['All', ()=>true],
  ['Kids & baby', r => r.src==='seat' || /toy|infant|child|nursery|baby|crib|stroller|teeth|kid/i.test(r.type+' '+r.title)],
  ['Food', r => r.src==='fda'],
  ['Home & kitchen', r => /appliance|kitchen|furniture|heater|home|household|dresser|cook|lamp|light/i.test(r.type+' '+r.title)],
  ['Batteries & fire', r => /fire|burn|battery|batteries|shock|electrocution/i.test(r.hazard+' '+r.title)],
  ['Outdoor & sports', r => /bike|bicycle|helmet|outdoor|sport|scooter|ebike|e-bike|recreation|camp|fitness/i.test(r.type+' '+r.title)],
];
let fIdx = 0, shown = 25;
function renderFilters(){
  $('#filters').innerHTML = FILTERS.map((f,i)=>`<button class="chip" aria-pressed="${i===fIdx}" data-f="${i}">${f[0]}</button>`).join('');
  $('#filters').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { fIdx=+b.dataset.f; shown=25; renderFilters(); renderLatest(); }));
}
function renderLatest(){
  const list = DATA.products.filter(FILTERS[fIdx][1]);
  $('#latest').innerHTML = list.slice(0,shown).map(r=>recallCard(r)).join('') || '<div class="empty">No recalls in this group.</div>';
  $('#more').hidden = list.length <= shown;
}
$('#more').addEventListener('click', () => { shown += 25; renderLatest(); });

/* ================= account ================= */
function renderAccount(){
  if (!ME) return;
  $('#st-watch').textContent = items.length;
  const flagged = statusCache.filter(s=>s.v!=='get').length;
  $('#st-flag').textContent = flagged; $('#st-flag-box').classList.toggle('alert', flagged>0);
  $('#st-checks').textContent = checks.length;
  const el = $('#history');
  if (!checks.length){ el.innerHTML = `<div><span class="hint">Your checks will show up here.</span></div>`; return; }
  el.innerHTML = '';
  checks.slice(0,8).forEach(h => {
    const b = document.createElement('button'); b.className='hist';
    b.innerHTML = `<span class="l"><span class="dot ${(VERD[h.verdict]||VERD.get)[1]}"></span><span></span></span><span class="w"></span>`;
    b.querySelector('.l span:last-child').textContent = h.label;
    b.querySelector('.w').textContent = ago(h.at);
    b.addEventListener('click', () => openEntry(h));
    el.appendChild(b);
  });
}
$('#clear-hist').addEventListener('click', async () => {
  if (!checks.length) return;
  try { await store.clearChecks(); toast('Recent checks cleared'); } catch(e){ toast('Couldn’t clear them. Try again.'); }
});

/* ================= tabs ================= */
function show(p){
  $$('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.p===p));
  ['check','mine','latest','account'].forEach(x => $('#p-'+x).hidden = x!==p);
  $('#main').scrollTop = 0;
  try { history.replaceState(null,'','#'+p); } catch(e){}
}
$$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.p)));
function setMode(m){
  $('#mode-prod').setAttribute('aria-pressed', m==='prod'); $('#mode-car').setAttribute('aria-pressed', m==='car');
  $('#prod-form').hidden = m!=='prod'; $('#car-form').hidden = m!=='car'; $('#result').innerHTML='';
}
$('#mode-prod').addEventListener('click', ()=>setMode('prod'));
$('#mode-car').addEventListener('click', ()=>setMode('car'));
$('#qform').addEventListener('submit', e => { e.preventDefault(); runCheck($('#q').value); });

const EX = ['Graco Milestone','Govee space heater','baby walker','e-bike','2021 Honda Accord'];
$('#examples').innerHTML = '<span class="hint" style="align-self:center">Try:</span>' + EX.map(x=>`<button class="chip" type="button">${x}</button>`).join('');
$('#examples').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
  const t=b.textContent;
  if (t==='2021 Honda Accord'){ pickCar('HONDA','ACCORD','2021'); runCar('HONDA','ACCORD','2021'); return; }
  $('#q').value=t; runCheck(t);
}));

/* ================= boot ================= */
async function boot(){
  try { CONFIG = await (await fetch('/api/config')).json(); } catch(e){ CONFIG = {}; }
  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && window.supabase){
    sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  } else {
    $('#login-form').hidden = true; $('.or').hidden = true;
    $('#auth-fine').textContent = 'Sign-in isn’t set up on this server yet, so lists stay on this device.';
  }
  try {
    DATA = await (await fetch('data/data.json')).json();
  } catch(e){ $('#auth-fine').textContent = 'Couldn’t load the recall list. Reload to try again.'; return; }
  buildIndex();
  opt($('#mk'), Object.keys(DATA.makes).sort(), 'Make');
  const nCars = Object.keys(DATA.makes).length;
  $('#proof').innerHTML = `<div><b>${DATA.products.filter(r=>r.src==='cpsc').length.toLocaleString()}</b>product recalls</div><div><b>${DATA.products.filter(r=>r.src!=='cpsc').length.toLocaleString()}</b>food &amp; seat</div><div><b>${nCars}</b>vehicle makes</div>`;
  $('#d-asof').textContent = fmtDate(DATA.asOf);
  $('#d-prod').textContent = DATA.products.length.toLocaleString() + ' since ' + fmtDate(DATA.products[DATA.products.length-1].date);
  $('#d-makes').textContent = nCars + ' makes · 2012–' + (new Date(DATA.asOf).getFullYear()+1);
  renderFilters(); renderLatest();
  $('#q').value='Govee space heater'; runCheck('Govee space heater', {log:false});

  if (sb){
    const { data: { session } } = await sb.auth.getSession();
    if (session) await enterAs(session);
    else if (lsGet('sigi-guest-mode', false)) await enterAs(null);
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt==='SIGNED_IN' && s && ME?.id !== s.user.id) { lsSet('sigi-guest-mode', null); enterAs(s); }
      if (evt==='SIGNED_OUT' && ME?.mode==='user') showAuth();
    });
  } else if (lsGet('sigi-guest-mode', false)) await enterAs(null);
}
boot();
})();
