// Planning Dashboard webview script.
// Loaded via <script src> (not interpolated through a TypeScript template
// literal). A TS template turns '\n' into a real newline inside JS strings
// and Chromium then fails document.write with "Invalid or unexpected token".
(function () {
"use strict";
try {
const vscode = acquireVsCodeApi();
const LANES = {
  task: ['inbox','today','in_progress','done','deferred','outdated'],
  idea: ['capture','refine','accepted','parked','done'],
  plan: ['plan','prototype','implement','validate','done','parked'],
  thought: ['new','kept','converted','archived'],
};
const TYPE_COLOR = {idea:'#d7ba7d',plan:'#4ec9b0',task:'#569cd6',project:'#c586c0',catalog_entry:'#c586c0',domain:'#808080',daily_plan:'#dcdcaa',insight:'#4fc1ff',reflection:'#9cdcfe',knowledge:'#ce9178',session:'#608b4e',thought:'#e2c08d'};
const LANE_COLOR = {inbox:'#888',today:'#569cd6',in_progress:'#dcdcaa',done:'#4ec9b0',deferred:'#a08',outdated:'#d16969',capture:'#d7ba7d',refine:'#dcdcaa',accepted:'#4ec9b0',parked:'#888',plan:'#569cd6',prototype:'#c586c0',implement:'#dcdcaa',validate:'#4fc1ff',new:'#d7ba7d',kept:'#4ec9b0',converted:'#569cd6',archived:'#666'};
let S = null, view='board', laneSet='task';
let renderError=null;
let SESS=null, sessFilter='today', sessSearch='', sessHost='all', sessUnlinked=false, sessHideAuto=true, sessOpenUuid=null, sessExplain={};
let sessPoll=null, fleetChatOpen=false, fleetChatBusy=false, fleetPendingActions=[];
document.body.dataset.view = view;
let loadStatus={phase:'idle',detail:'waiting for host',startedAt:Date.now(),queueDepth:0};
const _st=(vscode.getState&&vscode.getState())||{};
let groupBy = _st.groupBy || 'status';
let customLanes = _st.customLanes || [];
let doneWindow = _st.doneWindow || 'week'; // hide done items older than: yesterday|week|month|all
let sortBy = _st.sortBy || 'priority';
function saveState(){ try{ vscode.setState({groupBy, customLanes, doneWindow, sortBy}); }catch(e){} }
const BOARD_TYPES=['task','idea','plan','thought'];
const $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let searchTerm='', maxLane=null;
let calFrom=null, calTo=null, calMode='month', calAnchor=null;
let boardDateField='updated', boardDateVal='', overdueOnly=false, staleOnly=false;
const CLOSING=new Set(['done','deferred','outdated','parked','archived']);
const CLOSED_STATUS=new Set(['done','outdated','parked','archived','converted']);
function blockedSet(){ return new Set(((S&&S.blocked)||[]).map(b=>b.id)); }
function addDays(d,n){ const x=new Date(d+'T00:00:00Z'); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); }

window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='snapshot'){S=m.data; window.__paintTried=false; render();}
  else if(m.type==='loadStatus'){ applyLoadStatus(m.data); }
  else if(m.type==='detail'){renderDrawer(m.data);}
  else if(m.type==='setView'){view=m.view;syncSeg();render();}
  else if(m.type==='laneAdded'){ if(groupBy!=='lane'){groupBy='lane';const gb=$('#groupBy');if(gb)gb.value='lane';} if(m.name&&!customLanes.includes(m.name))customLanes.push(m.name); saveState(); renderBoard(); }
  else if(m.type==='openItem'){ view='board'; syncSeg(); render(); if(m.id)openDetail(m.id); }
  else if(m.type==='syncStatus'){ renderSyncPill(m.data); }
  else if(m.type==='sessions'){ SESS=m.data||[]; if(view==='sessions')renderSessions(); }
  else if(m.type==='sessionExplain'||m.type==='sessionAsk'||m.type==='sessionExplainStatus'){ applySessionExplain(m); }
  else if(m.type==='fleetChat'||m.type==='fleetChatApplied'){ onFleetChatHost(m); }
});

// ── store-sync status pill + activity reporting ──────────────────────────────
let syncState=null;
function agoStr(t){ if(!t)return 'never'; const s=Math.round((Date.now()-t)/1000);
  return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'; }
function renderSyncPill(s){ if(s)syncState=s; s=syncState; const p=$('#syncPill'); if(!p||!s)return;
  const cls=s.status==='syncing'?'syncing':(s.status==='conflict'||s.status==='error'||s.status==='offline'||s.status==='push-failed')?'warn':'ok';
  p.className='syncpill '+cls+(s.active?' active':'');
  const icon=s.status==='syncing'?'⟳':(cls==='warn'?'⚠':'☁');
  p.textContent=icon+' '+(s.status==='syncing'?'syncing…':agoStr(s.lastSyncAt))+(s.active?' ⚡':'');
  p.title='Store sync — '+s.status+(s.detail?': '+s.detail:'')+
    '\nLast: '+(s.lastSyncAt?new Date(s.lastSyncAt).toLocaleTimeString():'never')+
    (s.lastChanged&&s.lastChanged.length?'\nUpdated: '+s.lastChanged.join(', '):'')+
    (s.active?'\n⚡ active — polling aggressively':'')+'\nClick to sync now.'; }
setInterval(()=>{ if(syncState&&syncState.status!=='syncing')renderSyncPill(); },15000); // keep "Xs ago" fresh
$('#syncPill')&&$('#syncPill').addEventListener('click',()=>vscode.postMessage({type:'syncNow'}));
// report activity (keyboard/click/scroll) so the host arms aggressive polling; throttled
let lastActivity=0;
function reportActivity(){ const now=Date.now(); if(now-lastActivity>10000){ lastActivity=now; vscode.postMessage({type:'activity'}); } }
['click','keydown','wheel'].forEach(ev=>document.addEventListener(ev,reportActivity,{passive:true}));

// top bar
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;view=b.dataset.view;syncSeg();render();});
$('#laneSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;laneSet=b.dataset.lane;syncSeg();renderBoard();});
$('#calModeSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;calMode=b.dataset.cm;syncSeg();renderCalendar();});
$('#refreshBtn').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
$('#captureBtn').addEventListener('click',()=>openCreateDrawer({}));
$('#syncBtn').addEventListener('click',()=>vscode.postMessage({type:'action',action:'runSync'}));
function applySearch(){const q=searchTerm.toLowerCase();
  document.querySelectorAll('#board .card, #inbox .socialcard, #projects .pcard, #autonomous .card, #social .socialcard').forEach(c=>{
    c.style.display=(!q||(c.textContent||'').toLowerCase().includes(q))?'':'none';
  });}
function applyBoardCmd(cmd){
  if(!cmd)return;
  const VIEWS=['board','inbox','autonomous','projects','sessions','social','calendar','graph','canvas'];
  if(cmd.view && VIEWS.indexOf(cmd.view)>=0) view=cmd.view;
  if(cmd.lane && BOARD_TYPES.indexOf(cmd.lane)>=0) laneSet=cmd.lane;
  if(typeof cmd.search==='string'){
    searchTerm=cmd.search;
    const s=$('#search');
    if(s){ s.value=cmd.search; s.style.display=cmd.search?'inline-block':'none'; }
  }
  syncSeg();
  render();
  applySearch();
  if(cmd.item) openDetail(cmd.item);
}
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key==='f'){e.preventDefault();const s=$('#search');s.style.display='inline-block';s.focus();s.select();}
  if(e.key==='Escape'){const s=$('#search');
    if(document.activeElement===s){searchTerm='';s.value='';s.style.display='none';applySearch();}
    else if(!$('#drawer').classList.contains('hidden')){closeDrawer();}
    else if(maxLane){maxLane=null;renderBoard();}
    else if(searchTerm){searchTerm='';s.value='';s.style.display='none';applySearch();}}
});
$('#search').addEventListener('input',e=>{searchTerm=e.target.value;applySearch();});
(function(){const gb=$('#groupBy'); if(gb){gb.value=groupBy; gb.addEventListener('change',()=>{groupBy=gb.value;saveState();renderBoard();});}
  const sb=$('#sortBy'); if(sb){sb.value=sortBy; sb.addEventListener('change',()=>{sortBy=sb.value;saveState();renderBoard();});}
  const al=$('#addLaneBtn'); if(al)al.addEventListener('click',()=>vscode.postMessage({type:'action',action:'addLane'}));})();
$('#backdrop').addEventListener('click',closeDrawer);
function syncSeg(){
  // Drive CSS for board-only chrome + narrow-pane prioritization of view tabs.
  try{ document.body.dataset.view = view; }catch(e){}
  document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  document.querySelectorAll('#laneSeg button').forEach(b=>b.classList.toggle('on',b.dataset.lane===laneSet));
  document.querySelectorAll('#calModeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.cm===calMode));
  // Board/calendar chrome visibility is primarily CSS (body[data-view]); keep
  // inline display in sync for older hosts / no-CSS-fallback.
  $('#laneSeg').style.display = view==='board'?'inline-flex':'none';
  $('#calModeSeg').style.display = view==='calendar'?'inline-flex':'none';
  const boardOnly = ['#groupBy','#sortBy','#addLaneBtn'];
  boardOnly.forEach(sel=>{ const n=$(sel); if(n) n.style.display = view==='board'?'':'none'; });
  $('#board').classList.toggle('hidden',view!=='board');
  $('#inbox').classList.toggle('hidden',view!=='inbox');
  $('#autonomous').classList.toggle('hidden',view!=='autonomous');
  $('#projects').classList.toggle('hidden',view!=='projects');
  $('#sessions').classList.toggle('hidden',view!=='sessions');
  $('#social').classList.toggle('hidden',view!=='social');
  $('#calendar').classList.toggle('hidden',view!=='calendar');
  $('#graph').classList.toggle('hidden',view!=='graph');
  $('#gfilters').classList.toggle('hidden',view!=='graph');
  $('#canvas').classList.toggle('hidden',view!=='canvas');
}
function applyLoadStatus(s){
  if(s){
    // Merge host status; do not let a later "ready" pump wipe a webview render crash.
    const keep=renderError;
    loadStatus=Object.assign({}, loadStatus, s);
    if(keep) renderError=keep;
  }
  paintLoadOverlay();
}
function loadElapsed(){
  const t=loadStatus&&loadStatus.startedAt?Math.round((Date.now()-loadStatus.startedAt)/1000):0;
  if(t<1)return 'just now';
  if(t<60)return t+'s';
  return Math.floor(t/60)+'m '+(t%60)+'s';
}
function boardPainted(){
  if(view==='board') return !!document.querySelector('#board .lanes .col');
  return true;
}
function paintLoadOverlay(){
  const ov=$('#loadOverlay'); if(!ov)return;
  const phase=loadStatus&&loadStatus.phase||'idle';
  const hasSnap=!!(S && (S.objects||S.counts));
  const painted=hasSnap && boardPainted();
  const err=!!renderError || phase==='error' || (loadStatus&&loadStatus.error && !hasSnap);
  const busy=phase==='export'||phase==='parse'||(phase==='idle'&&!hasSnap)||(hasSnap&&!painted&&!renderError);
  // Never hide the overlay just because export JSON arrived — the board can
  // still be a 0-height #main or render() can have thrown, then a host
  // "ready" pump used to cover the crash with a blank pane.
  if(painted && !renderError && (phase==='ready'||phase==='idle'||phase==='export') && !loadStatus.error){ ov.classList.add('hidden'); ov.classList.remove('err'); return; }
  // Snapshot is here but lanes never appeared: retry paint once, then stop spinning.
  if(hasSnap && !painted && !renderError && view==='board' && !window.__paintTried){
    window.__paintTried=true;
    try { renderBoard(); if(boardPainted()){ ov.classList.add('hidden'); return; } }
    catch(e){ renderError=String(e&&e.message||e); }
  }
  const stuck=hasSnap && !painted && !renderError;
  ov.classList.remove('hidden');
  ov.classList.toggle('err', !!err && !busy || (stuck && window.__paintTried));
  const title=$('#loadTitle'), det=$('#loadDetail'), tm=$('#loadTime'), retry=$('#loadRetry'), spin=$('#loadSpin');
  if(title) title.textContent = renderError ? 'Dashboard render failed' : (err&&!busy ? 'Planning store failed to load' : (phase==='parse'?'Parsing snapshot…':phase==='export'?'Exporting planning store…':(stuck?'Painting board…':'Loading planning store')));
  if(det){
    const bits=[];
    if(renderError) bits.push(renderError);
    if(loadStatus.detail) bits.push(loadStatus.detail);
    if(loadStatus.queueDepth>1) bits.push('kp CLI queue depth '+loadStatus.queueDepth);
    if(loadStatus.error) bits.push(loadStatus.error);
    if(stuck) bits.push((S.objects||[]).length+' objects received — waiting for lanes to paint');
    det.textContent=bits.filter(Boolean).join('\n');
  }
  if(tm) tm.textContent = (busy?'elapsed ':'')+loadElapsed()+(loadStatus.objectCount!=null?' · '+loadStatus.objectCount+' objects':'');
  if(retry) retry.style.display = (err&&!busy) || (stuck && window.__paintTried) ? 'inline-block':'none';
  if(spin) spin.style.display = busy && !(stuck && window.__paintTried) ? 'block':'none';
}
setInterval(()=>{ const ov=$('#loadOverlay'); if(ov && !ov.classList.contains('hidden')) paintLoadOverlay(); },1000);
$('#loadRetry')&&$('#loadRetry').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));

function render(){
  syncSeg();
  if(!S){
    $('#counts').textContent = 'loading…';
    paintLoadOverlay();
    return;
  }
  try {
    $('#counts').textContent = Object.entries(S.counts||{}).map(([k,v])=>k+':'+v).join('  ');
    renderOverduePill();
    renderInboxPill();
    if(view==='board')renderBoard(); else if(view==='inbox')renderInbox(); else if(view==='autonomous')renderAutonomous(); else if(view==='projects')renderProjects(); else if(view==='sessions')renderSessions(); else if(view==='social')renderSocial(); else if(view==='calendar')renderCalendar(); else if(view==='graph')requestAnimationFrame(renderGraph); else renderCanvas();
    applySearch();
    renderError=null;
  } catch (e) {
    renderError = (e && e.stack) ? e.stack : String(e&&e.message||e);
  }
  paintLoadOverlay();
}
render(); // paint overlay + chrome immediately, even with no snapshot yet
$('#overduePill')&&$('#overduePill').addEventListener('click',()=>{
  overdueOnly=!overdueOnly;
  if(overdueOnly){ view='board'; if(groupBy==='type'){} else if(laneSet!=='task')laneSet='task'; }
  syncSeg(); render();
});
$('#inboxPill')&&$('#inboxPill').addEventListener('click',()=>{ view=(view==='inbox')?'board':'inbox'; syncSeg(); render(); });

// closing statuses prompt for a resolution note (host shows the InputBox; Esc aborts)
function postStatus(id,status){ if(CLOSING.has(status))openResModal(id,status); else vscode.postMessage({type:'setStatus',id:id,status:status}); }
// Multi-line resolution note modal for closing moves (nicer than a one-line input).
let resCtx=null;
function openResModal(id,status){
  resCtx={id:id,status:status};
  const o=(S&&S.objects||[]).find(x=>x.id===id);
  $('#resTitle').textContent=(o&&(o.title||o.id))||id;
  $('#resSub').textContent='Moving to “'+status+'” — add a resolution note (optional).';
  const ta=$('#resNote'); ta.value='';
  $('#resmodal').classList.remove('hidden');
  setTimeout(()=>ta.focus(),40);
}
function closeResModal(apply,withNote){
  const m=$('#resmodal'); if(m.classList.contains('hidden'))return;
  const ctx=resCtx; m.classList.add('hidden'); resCtx=null;
  if(!ctx)return;
  if(apply)vscode.postMessage({type:'setStatusApply',id:ctx.id,status:ctx.status,note:withNote?$('#resNote').value.trim():''});
  else vscode.postMessage({type:'refresh'}); // cancel → snap the board back
}
$('#resSave').addEventListener('click',()=>closeResModal(true,true));
$('#resSkip').addEventListener('click',()=>closeResModal(true,false));
$('#resCancel').addEventListener('click',()=>closeResModal(false));
$('#resX').addEventListener('click',()=>closeResModal(false));
$('#resNote').addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();closeResModal(true,true);} if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeResModal(false);} });
function laneFieldAndList(objs){
  if(groupBy==='status') return {field:'status', lanes:(LANES[laneSet]||[...new Set(objs.map(o=>o.status||'inbox'))])};
  if(groupBy==='type') return {field:'type', lanes:BOARD_TYPES.slice()};
  const vals=new Set(objs.map(o=>o[groupBy]||'(none)')); customLanes.forEach(l=>vals.add(l)); const lanes=[...vals]; if(!lanes.includes('(none)'))lanes.push('(none)');
  return {field:groupBy, lanes};
}
function renderBoard(){
  const bl=blockedSet();
  let objs = groupBy==='type' ? (S.objects||[]).filter(o=>BOARD_TYPES.indexOf(o.type)>=0) : (S.objects||[]).filter(o=>o.type===laneSet);
  const {field, lanes} = laneFieldAndList(objs);
  const board=$('#board'); board.innerHTML='';
  // date filter bar (worked-on / due) — full-width row above the lanes
  const fb=el('div','boardfilter');
  const odCount=overdueList().length;
  fb.innerHTML='<span style="opacity:.6">filter by</span>'+
    '<select id="bfField"><option value="updated"'+(boardDateField==='updated'?' selected':'')+'>worked on (updated)</option><option value="due"'+(boardDateField==='due'?' selected':'')+'>due</option></select>'+
    '<input type="date" id="bfDate" value="'+esc(boardDateVal||'')+'">'+
    '<button class="ghost" id="bfToday">today</button>'+
    (boardDateVal?'<button class="ghost" id="bfClear">clear ✕</button>':'')+
    '<button class="ghost'+(overdueOnly?' on':'')+'" id="bfOverdue" title="Show only past-due, not-completed tasks">⚠ Overdue'+(odCount?' ('+odCount+')':'')+'</button>'+
    '<button class="ghost'+(staleOnly?' on':'')+'" id="bfStale" title="Open items untouched for 21+ days">🕸 Stale</button>'+
    '<span style="opacity:.6" id="bfN"></span>';
  board.appendChild(fb);
  fb.querySelector('#bfField').addEventListener('change',e=>{boardDateField=e.target.value;renderBoard();});
  fb.querySelector('#bfDate').addEventListener('change',e=>{boardDateVal=e.target.value;renderBoard();});
  fb.querySelector('#bfToday').addEventListener('click',()=>{boardDateVal=todayStr();renderBoard();});
  if(fb.querySelector('#bfClear'))fb.querySelector('#bfClear').addEventListener('click',()=>{boardDateVal='';renderBoard();});
  fb.querySelector('#bfOverdue').addEventListener('click',()=>{overdueOnly=!overdueOnly;renderOverduePill();renderBoard();});
  fb.querySelector('#bfStale').addEventListener('click',()=>{staleOnly=!staleOnly;renderBoard();});
  if(boardDateVal)objs=objs.filter(o=>String(o[boardDateField]||'').slice(0,10)===boardDateVal);
  if(overdueOnly)objs=objs.filter(isOverdue);
  if(staleOnly)objs=objs.filter(isStale);
  if(fb.querySelector('#bfN'))fb.querySelector('#bfN').textContent=overdueOnly?(objs.length+' overdue'):staleOnly?(objs.length+' stale'):(boardDateVal?(objs.length+' '+laneSet+'(s) '+boardDateField+' '+boardDateVal):'');
  const lanesWrap=el('div','lanes');board.appendChild(lanesWrap);
  const shown=(maxLane&&lanes.includes(maxLane))?[maxLane]:lanes;
  shown.forEach(lane=>{
    let rows=objs.filter(o=>String(o[field]||'(none)')===String(lane));
    const CMP={
      priority:(a,b)=>String(a.priority||'p9').localeCompare(String(b.priority||'p9')),
      due:(a,b)=>String(a.due||'9999').localeCompare(String(b.due||'9999')),
      updated:(a,b)=>String(b.updated||'').localeCompare(String(a.updated||'')),
      title:(a,b)=>String(a.title||a.id).localeCompare(String(b.title||b.id)),
      project:(a,b)=>String(a.project||'~').localeCompare(String(b.project||'~')),
      domain:(a,b)=>String(a.domain||'~').localeCompare(String(b.domain||'~')),
      type:(a,b)=>String(a.type).localeCompare(String(b.type)),
    };
    rows.sort(CMP[sortBy]||CMP.priority); // unset values sort last (except updated: newest first)
    const isDone = field==='status' && lane==='done';
    let hidDone=0;
    if(isDone && doneWindow!=='all'){
      const days={yesterday:1,week:7,month:30}[doneWindow]||7;
      const cut=addDays(todayStr(),-days);
      const before=rows.length;
      rows=rows.filter(o=>String(o.updated||'').slice(0,10)>=cut);
      hidDone=before-rows.length;
    }
    const isMax=maxLane===lane;
    const col=el('div','col'+(isMax?' max':'')); col.dataset.lane=lane;
    const h=el('h3',null,'<span class="dot" style="background:'+(LANE_COLOR[lane]||TYPE_COLOR[lane]||'#888')+'"></span>'+esc(lane)+(isMax?' <span style="opacity:.5;font-weight:400;text-transform:none">(double-click or Esc to restore)</span>':'')+'<span class="cnt">'+rows.length+(hidDone?' <span style="opacity:.55" title="'+hidDone+' older done hidden">+'+hidDone+' older</span>':'')+'</span>');
    col.title='double-click to '+(isMax?'restore':'maximize as a list');
    col.addEventListener('dblclick',ev=>{ if(ev.target.closest('.card')||ev.target.tagName==='SELECT')return; maxLane=isMax?null:lane; renderBoard(); });
    if(isDone){
      const sel=el('select','donewin');
      ['yesterday','week','month','all'].forEach(w=>{const op=el('option',null,w);op.value=w;if(w===doneWindow)op.selected=true;sel.appendChild(op);});
      sel.title='show items done (updated) within… — older ones are hidden';
      sel.addEventListener('click',ev=>ev.stopPropagation());
      sel.addEventListener('change',()=>{doneWindow=sel.value;saveState();renderBoard();});
      h.insertBefore(sel,h.querySelector('.cnt'));
    }
    col.appendChild(h);
    const cards=el('div','cards');
    rows.forEach(o=>{
      const card=el('div','card'+(bl.has(o.id)?' blocked':'')+(isMax?' compact':'')); card.draggable=true; card.dataset.id=o.id;
      const isThought=o.type==='thought';
      card.innerHTML='<div class="cact">'+(isThought?'<button data-act="toIdea" title="Convert → idea">→💡</button><button data-act="toTask" title="Convert → task">→☑</button>':'')+'<button data-act="edit" title="Edit">✎</button><button data-act="clone" title="Clone">⧉</button><button data-act="recat" title="Recategorize / move">⇄</button><button data-act="del" title="Delete">✕</button></div>'+
        '<div class="ct">'+esc(o.title||o.id)+'</div><div class="cm"><span class="badge">'+o.type+'</span>'+(o.priority?'<span class="prio '+esc(o.priority)+'">'+esc(o.priority)+'</span>':'')+(o.due?'<span class="due'+(o.due<todayStr()&&o.status!=='done'&&o.status!=='outdated'?' late':'')+'">⏰ '+esc(o.due)+'</span>':'')+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.lane?'<span>⋔ '+esc(o.lane)+'</span>':'')+(o.project?'<span>· '+esc(o.project.split('/').pop())+'</span>':'')+(isThought&&o.context?'<span title="where this was captured">◔ '+esc(o.context)+'</span>':'')+(isThought&&(o.surfaced_on||o.created)?'<span>'+esc(o.surfaced_on||o.created)+'</span>':'')+'</div>';
      card.addEventListener('click',ev=>{ if(ev.target.closest('[data-act]'))return; openDetail(o.id); });
      card.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();const a=b.dataset.act;vscode.postMessage({type:'action',action:a==='edit'?'editItem':a==='recat'?'recategorize':a==='clone'?'cloneItem':a==='toIdea'?'convertToIdea':a==='toTask'?'convertToTask':'deleteItem',id:o.id});}));
      card.addEventListener('dragstart',ev=>{ev.dataTransfer.setData('text/plain',o.id);card.classList.add('dragging');});
      card.addEventListener('dragend',()=>card.classList.remove('dragging'));
      // drop a card ON another card => adopt its priority (drag-to-sort within a lane);
      // across lanes it also takes the target lane's status
      card.addEventListener('dragover',ev=>{ev.preventDefault();ev.stopPropagation();card.classList.add('dropover');});
      card.addEventListener('dragleave',()=>card.classList.remove('dropover'));
      card.addEventListener('drop',ev=>{ev.preventDefault();ev.stopPropagation();card.classList.remove('dropover');
        const id=ev.dataTransfer.getData('text/plain'); if(!id||id===o.id)return;
        const src=(S.objects||[]).find(x=>x.id===id);
        if(field==='status'&&src&&String(src.status||'')!==String(lane))postStatus(id,lane);
        vscode.postMessage({type:'setPriority',id:id,priority:o.priority||'-'});});
      cards.appendChild(card);
    });
    col.appendChild(cards);
    col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',ev=>{ev.preventDefault();col.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(!id)return;
      if(field==='status')postStatus(id,lane);
      else if(field==='type')vscode.postMessage({type:'action',action:'setType',id:id,toType:lane});
      else vscode.postMessage({type:'action',action:'setField',id:id,field:field,value:lane==='(none)'?'':lane});});
    lanesWrap.appendChild(col);
  });
}

// ── project-centric view: each KP project with its open work + linked sessions ──
const expandedProjects=new Set();
function parseLinked(o){try{const v=typeof o.linked_sessions==='string'?JSON.parse(o.linked_sessions):(o.linked_sessions||[]);return Array.isArray(v)?v:[];}catch(e){return [];}}
function renderProjects(){
  const el2=$('#projects'); el2.innerHTML='';
  const wrap=el('div','pgrid'); el2.appendChild(wrap);
  const items=(S.objects||[]).filter(o=>BOARD_TYPES.indexOf(o.type)>=0);
  const projects=(S.objects||[]).filter(o=>o.type==='project').sort((a,b)=>String(a.title||a.id).localeCompare(String(b.title||b.id)));
  const buckets=projects.map(p=>({p,rows:items.filter(o=>o.project===p.id)}));
  buckets.push({p:{id:'(none)',title:'(no project)',type:'project'},rows:items.filter(o=>!o.project)});
  buckets.forEach(({p,rows})=>{
    if(p.id==='(none)'&&!rows.length)return;
    const open=rows.filter(o=>!CLOSING.has(String(o.status||'')));
    const closed=rows.length-open.length;
    const key=p.id, expanded=expandedProjects.has(key);
    const card=el('div','pcard');
    const byType={}; rows.forEach(o=>{byType[o.type]=(byType[o.type]||0)+1;});
    const counts=Object.entries(byType).map(([k,v])=>v+' '+k+(v>1?'s':'')).join(' · ');
    const h=el('h3',null,esc(p.title||p.id.split('/').pop())+'<span class="pn">'+open.length+' open'+(closed?' · '+closed+' closed':'')+(counts?' · '+counts:'')+'</span>');
    h.title=p.id==='(none)'?'items without a project':'open '+esc(p.id)+' — double-click card to '+(expanded?'collapse':'expand');
    if(p.id!=='(none)')h.addEventListener('click',()=>openDetail(p.id));
    card.appendChild(h);
    card.addEventListener('dblclick',ev=>{if(ev.target.closest('.pitem')||ev.target.closest('.psess'))return;expanded?expandedProjects.delete(key):expandedProjects.add(key);renderProjects();});
    const STATUS_ORDER=['in_progress','today','inbox','capture','refine','accepted','plan','prototype','implement','validate','new','kept'];
    const sorted=open.slice().sort((a,b)=>{const ai=STATUS_ORDER.indexOf(String(a.status)),bi=STATUS_ORDER.indexOf(String(b.status));return (ai<0?99:ai)-(bi<0?99:bi)||String(a.priority||'p9').localeCompare(String(b.priority||'p9'));});
    const show=expanded?sorted:sorted.slice(0,10);
    show.forEach(o=>{
      const it=el('div','pitem');
      it.innerHTML='<span class="dot" style="background:'+(TYPE_COLOR[o.type]||'#888')+'"></span><span class="st">'+esc(o.status||'')+(o.priority?' '+esc(o.priority):'')+'</span><span class="pt">'+esc(o.title||o.id)+'</span>';
      it.addEventListener('click',()=>openDetail(o.id));
      card.appendChild(it);
    });
    if(!expanded&&sorted.length>show.length){const m=el('div','pmore','…+'+(sorted.length-show.length)+' more — click to expand');m.addEventListener('click',()=>{expandedProjects.add(key);renderProjects();});card.appendChild(m);}
    if(expanded&&closed){const m=el('div','pmore',closed+' closed item(s) shown on the board (done lane)');card.appendChild(m);}
    const sess=new Set(parseLinked(p)); rows.forEach(o=>parseLinked(o).forEach(u=>sess.add(u)));
    if(sess.size){
      const ts=el('div','psess'); ts.appendChild(el('div','lbl','linked sessions ('+sess.size+')'));
      [...sess].slice(0,expanded?15:5).forEach(u=>{
        const it=el('div','pitem'); it.innerHTML='<span class="st">▸ session</span><span class="pt">'+esc(String(u).slice(0,18))+'…</span>';
        it.title='open chat — '+esc(u);
        it.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openSession',uuid:u}));
        ts.appendChild(it);
      });
      card.appendChild(ts);
    }
    wrap.appendChild(card);
  });
  if(!wrap.children.length)wrap.appendChild(el('div',null,'<span style="opacity:.6">No projects yet — create type:project objects in the store, or assign items a Project in the drawer.</span>'));
}
// ── inbox: triage queue of freshly-captured items (task=inbox, idea=capture, thought=new) ──
function inboxItems(){
  const rows=(S&&S.objects||[]).filter(o=>(o.type==='task'&&o.status==='inbox')||(o.type==='idea'&&o.status==='capture')||(o.type==='thought'&&o.status==='new'));
  return rows.sort((a,b)=>String((b.surfaced_on||b.created||'')).localeCompare(String(a.surfaced_on||a.created||'')));
}
function renderInbox(){
  const el2=$('#inbox'); el2.innerHTML='';
  const rows=inboxItems();
  const bar=el('div',null,'<div style="font-size:13px;font-weight:600">📥 Inbox — '+rows.length+' to triage</div><div style="opacity:.65;font-size:12px;margin:2px 0 12px">Freshly-captured items awaiting a decision. Click to open · convert thoughts→ideas→tasks · set due/priority · park noise.</div>');
  el2.appendChild(bar);
  if(!rows.length){ el2.appendChild(el('div',null,'<div style="opacity:.55;padding:14px 2px">Inbox zero ✓</div>')); return; }
  const list=el('div','sociallist');
  rows.forEach(o=>{
    const c=el('div','socialcard');
    let tg=o.tags; if(typeof tg==='string'){try{tg=JSON.parse(tg);}catch(e){tg=[];}}
    const auto=(Array.isArray(tg)&&tg.includes('autogenerated'))?'<span class="badge" title="created by the autonomous ideation">🤖 auto</span>':'';
    let ls=o.linked_sessions; if(typeof ls==='string'){try{ls=JSON.parse(ls);}catch(e){ls=[];}}
    const sess=(Array.isArray(ls)&&ls[0])?'<span class="badge" title="source session">▸ '+esc(String(ls[0]).slice(0,8))+'…</span>':'';
    const agent=o.agent?'<span class="badge" title="agent/model">'+esc(o.agent)+(o.model?' · '+esc(o.model):'')+'</span>':'';
    const prov=(o.context?'<span class="badge" title="captured under">◔ '+esc(o.context)+'</span>':'')+((o.surfaced_on||o.created)?'<span>'+esc(o.surfaced_on||o.created)+'</span>':'');
    c.innerHTML='<div class="sh"><span class="ct">'+esc(o.title||o.id)+'</span><span class="cm"><span class="badge">'+o.type+'</span>'+auto+agent+sess+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+prov+'</span></div>';
    const acts=el('div','sacts');
    const open=el('button','ghost mini','Open'); open.addEventListener('click',()=>openDetail(o.id));
    acts.appendChild(open);
    if(o.type==='thought'){ const i=el('button','ghost mini','→ idea'); i.addEventListener('click',()=>vscode.postMessage({type:'action',action:'convertToIdea',id:o.id})); const t=el('button','ghost mini','→ task'); t.addEventListener('click',()=>vscode.postMessage({type:'action',action:'convertToTask',id:o.id})); acts.appendChild(i); acts.appendChild(t); }
    if(o.type==='idea'){ const t=el('button','ghost mini','→ task'); t.addEventListener('click',()=>vscode.postMessage({type:'action',action:'moveToTask',id:o.id})); acts.appendChild(t); }
    const park=el('button','ghost mini',o.type==='task'?'Defer':'Park'); park.addEventListener('click',()=>postStatus(o.id,o.type==='task'?'deferred':'parked')); acts.appendChild(park);
    c.appendChild(acts);
    c.addEventListener('click',ev=>{ if(ev.target.closest('button'))return; openDetail(o.id); });
    list.appendChild(c);
  });
  el2.appendChild(list);
}
// ── autonomous: the night ideate→build orchestration (schedule / usage / reports / auto-ideas) ──
function autoIdeas(){ return (S&&S.objects||[]).filter(o=>{let t=o.tags; if(typeof t==='string'){try{t=JSON.parse(t);}catch(e){t=[];}} return Array.isArray(t)&&t.includes('autogenerated');}); }
function fmtDT(s){ if(!s)return '—'; try{const d=new Date(s);return d.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(e){return s;} }
function specLinkHtml(spec){ return spec?'<span class="lnk speclnk" data-spec="'+esc(spec)+'" title="open the spec">📄 '+esc(spec)+'</span>':''; }
function wireSpecLinks(root){ root.querySelectorAll('.speclnk').forEach(s=>s.addEventListener('click',ev=>{ev.stopPropagation();vscode.postMessage({type:'action',action:'openSpec',spec:s.getAttribute('data-spec')});})); }
// idea id → spec path, from the current window + history (each records created ids)
function ideaSpecMap(a){
  const m={};
  if(!a)return m;
  const add=(ids,spec)=>{ (ids||[]).forEach(id=>{ if(spec&&!m[id])m[id]=spec; }); };
  if(a.current_window&&a.current_window.ideate)add(a.current_window.ideate.created,a.current_window.ideate.spec);
  (a.history||[]).forEach(h=>add(h.created,h.spec));
  return m;
}
function renderAutonomous(){
  const el2=$('#autonomous'); el2.innerHTML='';
  const a=S&&S.autonomous;
  const hd=el('div',null,'<div style="display:flex;align-items:center;gap:10px"><div style="font-size:14px;font-weight:700;flex:1">🤖 Autonomous builder</div></div><div style="opacity:.65;font-size:12px;margin:2px 0 14px">Overnight ideate→spec→implement, aligned to 5-hour Claude windows. Ideas land in the Inbox tagged <b>autogenerated</b>.</div>');
  // enable/disable — flips <store>/autonomous/STOP (git-synced, honored by the orchestrator)
  const on=!a||a.enabled!==false;
  const tog=el('button','ghost mini',on?'⏸ Disable':'▶ Enable');
  tog.title=on?'pause the autonomous builder (creates planning/autonomous/STOP)':'resume the autonomous builder';
  tog.style.cssText=on?'border-color:#d16969;color:#d16969':'border-color:#4ec9b0;color:#4ec9b0';
  tog.addEventListener('click',()=>vscode.postMessage({type:'action',action:'autoToggle',on:!on}));
  hd.querySelector('div').appendChild(tog);
  if(a&&a.enabled===false)hd.insertAdjacentHTML('beforeend','<div style="color:#d16969;font-size:12px;margin:-8px 0 12px">⏸ paused — no new windows will start until re-enabled</div>');
  el2.appendChild(hd);
  if(!a){ el2.appendChild(el('div',null,'<div style="opacity:.6;padding:14px 2px">No autonomous run yet. The night orchestrator writes its plan here after its first window (planning/autonomous/plan.json).</div>')); }
  else {
    // 2) ACTUAL usage (from headless "claude /usage") + config; projected as fallback
    const cw=a.current_window;
    const act=a.actual;
    const usage=el('div','autorow');
    const resetStr=act&&act.session_resets?new Date(act.session_resets).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):null;
    const agoMin=act&&act.measured_at?Math.max(0,Math.round((Date.now()-new Date(act.measured_at).getTime())/60000)):null;
    usage.innerHTML=(act
        ?'<div class="autostat"><span class="l">Window usage (actual)</span><span class="v">'+esc(String(act.session_pct))+'%'+(resetStr?' · resets '+esc(resetStr):'')+'</span></div>'+
         '<div class="autostat"><span class="l">Week</span><span class="v">'+esc(String(act.week_pct==null?'—':act.week_pct))+'%'+(act.fable_week_pct!=null?' · fable '+esc(String(act.fable_week_pct))+'%':'')+(agoMin!=null?' · measured '+agoMin+'m ago':'')+'</span></div>'
        :'<div class="autostat"><span class="l">Projected usage / window</span><span class="v">'+esc(String(a.projected_usage_pct||0))+'%</span></div>')+
      '<div class="autostat"><span class="l">Window</span><span class="v">'+esc(String(a.window_hours||5))+'h · implement '+esc(String(a.implement_lead_hours||1))+'h before close'+(a.usage_max_pct?' · gate ≥'+esc(String(a.usage_max_pct))+'%':'')+'</span></div>'+
      '<div class="autostat"><span class="l">Targets</span><span class="v">'+esc((a.targets||[]).join(', '))+'</span></div>';
    el2.appendChild(usage);
    // 1) planned session orchestrations + times
    const sched=el('div','autosec'); sched.appendChild(el('h4',null,'Planned sessions'));
    const meter=el('div','usagebar'); const fill=el('div','usagefill');
    const pct=act?act.session_pct:(a.projected_usage_pct||0);
    fill.style.width=Math.min(100,pct)+'%';
    if(a.usage_max_pct&&pct>=a.usage_max_pct)fill.style.background='#d16969';
    meter.title=(act?'actual':'projected')+' '+pct+'% of the 5h window';
    meter.appendChild(fill); sched.appendChild(meter);
    if(cw){
      const id=cw.ideate||{}, im=cw.implement||{};
      sched.appendChild(el('div','autoline','<span class="ph ide">ideate</span> window '+fmtDT(cw.start)+' → '+fmtDT(cw.end)+' · <b>'+esc(id.status||'')+'</b>'+(id.created_count?' · '+id.created_count+' ideas':'')+(id.spec?' · '+specLinkHtml(id.spec):'')));
      sched.appendChild(el('div','autoline','<span class="ph imp">implement</span> scheduled '+fmtDT(im.scheduled)+' · <b>'+esc(im.status||'planned')+'</b>'+(im.ran?' · ran '+fmtDT(im.ran):'')));
    }
    if(a.next_window)sched.appendChild(el('div','autoline','<span class="ph nxt">next</span> ideate at '+fmtDT(a.next_window.start)));
    el2.appendChild(sched);
    // 3) reports from implementation sessions
    const reps=[]; if(cw&&cw.implement&&cw.implement.report)reps.push({when:cw.implement.ran||cw.start,report:cw.implement.report,spec:cw.ideate&&cw.ideate.spec});
    (a.history||[]).slice().reverse().forEach(h=>{ if(h.report)reps.push({when:h.window_start,report:h.report,spec:h.spec,status:h.implement_status}); });
    const rs=el('div','autosec'); rs.appendChild(el('h4',null,'Implementation reports ('+reps.length+')'));
    if(!reps.length)rs.appendChild(el('div',null,'<div style="opacity:.55;font-size:12px">No reports yet.</div>'));
    reps.forEach(r=>{ const row=el('div','autoline'); row.innerHTML='<span class="ph rep">report</span> '+fmtDT(r.when)+' · <span class="lnk">'+esc(r.report)+'</span>'+(r.spec?' · '+specLinkHtml(r.spec):'')+(r.status?' · '+esc(r.status):''); row.querySelector('.lnk').addEventListener('click',()=>vscode.postMessage({type:'open',kbPath:r.report})); rs.appendChild(row); });
    el2.appendChild(rs);
    // window history: every past ideation session + its planned/actual implementation
    const hist=(a.history||[]).slice().reverse();
    const hs=el('div','autosec'); hs.appendChild(el('h4',null,'Window history ('+hist.length+')'));
    if(!hist.length)hs.appendChild(el('div',null,'<div style="opacity:.55;font-size:12px">No completed windows yet.</div>'));
    hist.forEach(h=>{
      const card=el('div','socialcard');
      const ideaChips=(h.created||[]).map(id=>{const o=(S.objects||[]).find(x=>x.id===id);return '<span class="badge histidea" data-id="'+esc(id)+'" style="cursor:pointer" title="open">'+esc((o&&o.title)||id.split('/').pop())+'</span>';}).join(' ');
      card.innerHTML='<div class="sh"><span class="ct">'+fmtDT(h.window_start)+(h.window_end?' → '+fmtDT(h.window_end):'')+'</span>'+
        '<span class="cm"><span class="badge">'+esc(h.implement_status||'?')+'</span>'+(h.spec?specLinkHtml(h.spec):'')+'</span></div>'+
        (h.ideate_summary?'<div style="font-size:12px;opacity:.8;margin-top:3px">💡 '+esc(h.ideate_summary)+'</div>':'')+
        (h.implement_summary?'<div style="font-size:12px;opacity:.8;margin-top:2px">🔨 '+esc(h.implement_summary)+'</div>':'')+
        (ideaChips?'<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">'+ideaChips+'</div>':'')+
        (h.report?'<div style="margin-top:4px"><span class="lnk histrep" data-r="'+esc(h.report)+'">📋 '+esc(h.report)+'</span></div>':'');
      card.querySelectorAll('.histidea').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();openDetail(b.getAttribute('data-id'));}));
      const rl=card.querySelector('.histrep'); if(rl)rl.addEventListener('click',ev=>{ev.stopPropagation();vscode.postMessage({type:'open',kbPath:rl.getAttribute('data-r')});});
      hs.appendChild(card);
    });
    el2.appendChild(hs);
    // configuration & schedule — the explicit config the orchestrator runs on
    if(a.config){
      const cs=el('div','autosec');
      const det=document.createElement('details');
      det.innerHTML='<summary style="cursor:pointer;font-size:13px;font-weight:600;margin-bottom:6px">⚙ Configuration & schedule</summary>';
      const c=a.config;
      const rowsHtml=[
        ['window',c.window_hours+'h · implement '+c.implement_lead_hours+'h before close'],
        ['caps','ideate '+c.ideate_cap_min+'m · implement '+c.implement_cap_min+'m'],
        ['usage gate','skip phase at ≥'+c.usage_max_pct+'% session usage'],
        ['active band',c.active_band+(c.active_band==='0000-0000'?' (24/7)':'')],
        ['ideate','claude · effort '+esc(c.ideate&&c.ideate.effort||'high')],
        ['implement','claude · model '+esc(c.implement&&c.implement.model||'fable')+' · effort '+esc(c.implement&&c.implement.effort||'medium')],
        ['grok',esc(c.grok_cmd||'auto')],
        ['targets',esc((c.targets||[]).join(', '))],
        ['branch',esc(c.work_branch||'')],
      ].map(r=>'<div class="autoline"><span style="opacity:.6;display:inline-block;min-width:100px">'+r[0]+'</span>'+r[1]+'</div>').join('');
      const schedHtml=(a.schedule||[]).map(s=>'<div class="autoline" style="opacity:.75">· '+esc(s)+'</div>').join('');
      det.insertAdjacentHTML('beforeend',rowsHtml+'<div style="margin-top:8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6">How it is scheduled</div>'+schedHtml+
        '<div style="margin-top:8px"><span class="lnk" id="openAutoCfg">✎ edit config.json</span> <span style="opacity:.55;font-size:11px">(env vars NIGHT_* override; git-synced to both laptops)</span></div>');
      cs.appendChild(det); el2.appendChild(cs);
      const oc=det.querySelector('#openAutoCfg'); if(oc)oc.addEventListener('click',()=>vscode.postMessage({type:'open',path:c.path}));
    }
  }
  // 4) ideas/tasks created during ideation (autogenerated) — always show what exists,
  //    each with a link to the spec its window produced (review/correct from here)
  const ideas=autoIdeas(); const sm=ideaSpecMap(a);
  const is=el('div','autosec'); is.appendChild(el('h4',null,'Autogenerated ideas ('+ideas.length+')'));
  if(!ideas.length)is.appendChild(el('div',null,'<div style="opacity:.55;font-size:12px">None yet — the ideation phase creates these.</div>'));
  const list=el('div','sociallist');
  ideas.forEach(o=>{ const c=el('div','socialcard'); const spec=sm[o.id];
    let ls=o.linked_sessions; if(typeof ls==='string'){try{ls=JSON.parse(ls);}catch(e){ls=[];}}
    const sess=(Array.isArray(ls)&&ls[0])?'<span class="badge" title="source session" style="cursor:pointer" data-sess="'+esc(ls[0])+'">▸ session '+esc(String(ls[0]).slice(0,8))+'…</span>':'';
    const agent=o.agent?'<span class="badge" title="ideation agent">'+esc(o.agent)+(o.model?' · '+esc(o.model):'')+(o.effort?' · '+esc(o.effort):'')+'</span>':'';
    c.innerHTML='<div class="sh"><span class="ct">'+esc(o.title||o.id)+'</span><span class="cm"><span class="badge">'+o.type+'</span>'+agent+sess+(o.status?'<span>'+esc(o.status)+'</span>':'')+(o.surfaced_on||o.created?'<span>'+esc(o.surfaced_on||o.created)+'</span>':'')+'</span></div>'+(spec?'<div style="margin-top:4px">'+specLinkHtml(spec)+'</div>':'');
    c.addEventListener('click',ev=>{
      const b=ev.target.closest('[data-sess]');
      if(b){ vscode.postMessage({type:'action',action:'openSession',uuid:b.getAttribute('data-sess')}); return; }
      openDetail(o.id);
    });
    list.appendChild(c); });
  is.appendChild(list); el2.appendChild(is);
  wireSpecLinks(el2);
}
// ── fleet board: laptops × compact rows + view-scoped agent chat ──
function dayStart(offset){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+(offset||0)); return d.getTime(); }
function sessWhen(s){ return s.lastActivity||s.startedAt||s.mtime||0; }
function sessIsAuto(s){ return !!s.automated || (s.labels||[]).some(l=>/^tag:automated$/i.test(l)||/^automated$/i.test(l)); }
function sessInWindow(s){
  const t=sessWhen(s);
  if(sessFilter==='all')return true;
  if(sessFilter==='live')return s.status==='live-local'||s.status==='active-remote';
  if(sessFilter==='today')return t>=dayStart(0);
  if(sessFilter==='yesterday')return t>=dayStart(-1)&&t<dayStart(0);
  if(sessFilter==='week')return t>=dayStart(-6);
  return true;
}
function titleForId(id){ const o=(S&&S.objects||[]).find(x=>x.id===id); return o?(o.title||o.id):id; }
function sessionLinks(s){
  const out=new Set((s.planningRefs||[]));
  (S&&S.objects||[]).forEach(o=>{ let ls=o.linked_sessions; if(typeof ls==='string'){try{ls=JSON.parse(ls);}catch(e){ls=[];}} if(Array.isArray(ls)&&ls.includes(s.uuid))out.add(o.id); });
  return [...out];
}
function visibleFleetRows(){
  if(!SESS)return [];
  const q=sessSearch.toLowerCase();
  return SESS.filter(sessInWindow)
    .filter(s=>sessHost==='all'||s.host===sessHost)
    .filter(s=>!sessUnlinked||(!s.linked && sessionLinks(s).length===0))
    .filter(s=>!sessHideAuto||!sessIsAuto(s))
    .filter(s=>!q||((s.title||'')+' '+(s.project||'')+' '+(s.agent||'')+' '+(s.host||'')+' '+(s.intent||'')+' '+(s.firstUserMsg||'')).toLowerCase().includes(q))
    .sort((a,b)=>sessWhen(b)-sessWhen(a));
}
function fmtWhen(t){ if(!t)return ''; const d=new Date(t); const today=dayStart(0);
  const hm=d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  if(t>=today)return hm; if(t>=dayStart(-1))return 'yst';
  return d.toLocaleDateString([], {month:'short',day:'numeric'}); }
function statusDot(st){ return '<span class="pulse '+(st==='active-remote'?'remote':st==='open'?'open':st==='ended'?'ended':'')+'" title="'+esc(st||'')+'"></span>'; }
function applySessionExplain(m){
  if(!m||!m.uuid)return;
  sessExplain[m.uuid]=m;
  if(sessOpenUuid===m.uuid && view==='sessions') renderSessions();
}
function armSessPoll(){
  if(sessPoll)return;
  sessPoll=setInterval(()=>{ if(view==='sessions') vscode.postMessage({type:'requestSessions'}); }, 8000);
}
function fleetAct(label, title, fn){
  const b=el('button','ghost mini',label); b.title=title; b.addEventListener('click',ev=>{ev.stopPropagation(); fn();}); return b;
}
function renderFleetRow(s){
  const live=s.status==='live-local'||s.status==='active-remote';
  const auto=sessIsAuto(s);
  const row=el('div','fleet-row'+(live?' live':'')+(auto?' auto':'')+(sessOpenUuid===s.uuid?' on':''));
  const src=s.source==='grok'?'G':s.source==='git'?'S':s.source==='codex'?'X':'C';
  const links=sessionLinks(s);
  row.innerHTML=statusDot(s.status)+
    '<span class="when">'+esc(fmtWhen(sessWhen(s)))+'</span>'+
    '<span class="ttl" title="'+esc(s.title||s.uuid)+'">'+esc(s.title||s.uuid)+'</span>'+
    '<span class="meta">'+
      '<span class="badge">'+src+'</span>'+
      (s.intent?'<span class="badge">'+esc(s.intent)+'</span>':'')+
      (s.project?'<span>'+esc(s.project)+'</span>':'')+
      (auto?'<span class="badge auto">auto</span>':'')+
      (links.length?'<span title="linked">↔'+links.length+'</span>':'')+
    '</span>';
  const acts=el('div','acts');
  acts.appendChild(fleetAct('Open','view conversation',()=>vscode.postMessage({type:'action',action:'openSession',uuid:s.uuid,title:s.title})));
  acts.appendChild(fleetAct('Resume ▸','resume in Code Build',()=>vscode.postMessage({type:'action',action:'resumeSession',uuid:s.uuid,cwd:s.projectPath,source:s.source,title:s.title})));
  acts.appendChild(fleetAct('Explain','derive intent',()=>{ sessOpenUuid=s.uuid; renderSessions(); vscode.postMessage({type:'action',action:'explainSession',uuid:s.uuid}); }));
  acts.appendChild(fleetAct('Link','link to a planning item',()=>vscode.postMessage({type:'action',action:'linkSessionToTask',uuid:s.uuid})));
  acts.appendChild(fleetAct('→ task','capture a task',()=>vscode.postMessage({type:'action',action:'captureFromSession',uuid:s.uuid,asType:'task',title:s.title||s.firstUserMsg||'from session'})));
  acts.appendChild(fleetAct('→ idea','capture an idea',()=>vscode.postMessage({type:'action',action:'captureFromSession',uuid:s.uuid,asType:'idea',title:s.title||s.firstUserMsg||'from session'})));
  if(links.length) acts.appendChild(fleetAct('→ plan','open linked item',()=>openDetail(links[0])));
  row.appendChild(acts);
  row.addEventListener('click',ev=>{ if(ev.target.closest('button'))return; sessOpenUuid=sessOpenUuid===s.uuid?null:s.uuid; renderSessions(); });
  return row;
}
function renderExplainDrawer(s){
  const box=el('div','sessdrawer');
  const ex=sessExplain[s.uuid]||{};
  const label=ex.label;
  box.innerHTML='<div style="font-weight:600;margin-bottom:6px">'+esc(s.title||s.uuid)+'</div>'+
    '<div style="opacity:.65;font-size:12px;margin-bottom:8px">'+esc(s.host||'')+' · '+esc(s.status||'')+' · '+esc((s.firstUserMsg||'').slice(0,180))+'</div>';
  if(ex.status==='running') box.appendChild(el('div',null,'<div style="opacity:.7">Deriving intent…</div>'));
  if(ex.error) box.appendChild(el('div',null,'<div style="color:#e6a4a4">'+esc(ex.error)+'</div>'));
  if(label){
    box.appendChild(el('div',null,'<div><b>'+esc(label.topic||'')+'</b> · '+esc(label.intent||'')+'</div><div style="opacity:.8;margin:4px 0">'+esc(label.summary||'')+'</div><div style="opacity:.65;font-size:11px">'+(label.tags||[]).map(t=>esc(t)).join(' · ')+'</div>'));
    const apply=el('button','ghost mini','Apply labels');
    apply.addEventListener('click',()=>vscode.postMessage({type:'action',action:'applySessionLabel',uuid:s.uuid,intent:label.intent,topic:label.topic,tags:label.tags,summary:label.summary}));
    box.appendChild(apply);
    (label.suggestedLinks||[]).forEach(id=>{
      const b=el('button','ghost mini','link '+id); b.addEventListener('click',()=>openDetail(id)); box.appendChild(b);
    });
  }
  if(ex.answer) box.appendChild(el('div','ans',esc(ex.answer)));
  const ta=document.createElement('textarea'); ta.placeholder='Ask about this session…';
  const ask=el('button','ghost mini','Ask');
  ask.addEventListener('click',()=>{ const q=ta.value.trim(); if(!q)return; vscode.postMessage({type:'action',action:'askSession',uuid:s.uuid,question:q}); });
  box.appendChild(ta); box.appendChild(ask);
  return box;
}
const FLEET_CHIPS=[
  ['Tag automated','Identify every automated / cron / night-loop session in this view and tag them automated. Do not tag interactive coding.'],
  ['Missing tasks','For unlinked interactive sessions, propose a short task title (and project if obvious). Skip automated.'],
  ['Link projects','Match sessions to an existing open task/idea/project and emit link actions.'],
  ['What did I do?','Summarize the real work in this view in 8 bullets. Ignore automated jobs.'],
];
function fleetChatHint(){
  const n=visibleFleetRows().length;
  const autoN=(SESS||[]).filter(sessInWindow).filter(sessIsAuto).length;
  return n+' session'+(n===1?'':'s')+' · '+sessFilter+(sessHost!=='all'?' · '+sessHost:'')+(sessHideAuto?' · auto hidden ('+autoN+')':'');
}
function sendFleetChat(q){
  q=(q||'').trim(); if(!q||fleetChatBusy)return;
  fleetChatBusy=true; fleetChatOpen=true;
  const log=$('#fcLog'); if(log){ const m=el('div','fc-msg user'); m.textContent=q; log.appendChild(m); log.scrollTop=log.scrollHeight; }
  const sug=$('#fcSuggest'); if(sug)sug.innerHTML='';
  vscode.postMessage({
    type:'action', action:'fleetChat', question:q,
    filter:{ window:sessFilter, host:sessHost, unlinked:sessUnlinked, hideAutomated:sessHideAuto, search:sessSearch },
    uuids: visibleFleetRows().map(s=>s.uuid),
  });
  syncFleetChatChrome();
}
function onFleetChatHost(m){
  fleetChatOpen=true;
  if(m.type==='fleetChatApplied'){
    fleetChatBusy=false;
    const log=$('#fcLog');
    if(log && m.results){
      const ok=(m.results||[]).filter(r=>r.ok).length;
      const bot=el('div','fc-msg bot'); bot.innerHTML='<div class="md">Applied '+ok+'/'+(m.results.length)+' action(s).<br>'+(m.results||[]).map(r=>(r.ok?'✓ ':'✗ ')+esc(r.label)+(r.detail?' — '+esc(String(r.detail).slice(0,80)):'')).join('<br>')+'</div>';
      log.appendChild(bot); log.scrollTop=log.scrollHeight;
    }
    const done=new Set((m.results||[]).filter(r=>r.ok).map(r=>r.label));
    fleetPendingActions=fleetPendingActions.filter(a=>!done.has(a.label||a.kind));
    renderFleetSuggestions();
    syncFleetChatChrome();
    return;
  }
  if(m.running){ fleetChatBusy=true; syncFleetChatChrome(); return; }
  fleetChatBusy=false;
  const log=$('#fcLog');
  if(log){
    const bot=el('div','fc-msg bot');
    if(m.error) bot.innerHTML='<div class="md" style="color:#e6a4a4">'+esc(m.error)+'</div>';
    else bot.innerHTML='<div class="md">'+esc(m.answer||'')+'</div>';
    log.appendChild(bot); log.scrollTop=log.scrollHeight;
  }
  fleetPendingActions=m.actions||[];
  renderFleetSuggestions();
  syncFleetChatChrome();
}
function renderFleetSuggestions(){
  const sug=$('#fcSuggest'); if(!sug)return;
  sug.innerHTML='';
  if(!fleetPendingActions.length)return;
  const bar=el('div','sacts');
  const all=el('button','ghost mini','Apply all ('+fleetPendingActions.length+')');
  all.addEventListener('click',()=>vscode.postMessage({type:'action',action:'applyFleetActions',actions:fleetPendingActions}));
  const clr=el('button','ghost mini','Dismiss'); clr.addEventListener('click',()=>{fleetPendingActions=[];renderFleetSuggestions();});
  bar.appendChild(all); bar.appendChild(clr); sug.appendChild(bar);
  fleetPendingActions.forEach((a,i)=>{
    const row=el('div','fc-act');
    row.innerHTML='<span class="lab">'+esc(a.label||a.kind)+'</span>';
    const one=el('button','ghost mini','Apply');
    one.addEventListener('click',()=>vscode.postMessage({type:'action',action:'applyFleetActions',actions:[a]}));
    const drop=el('button','ghost mini','✕');
    drop.addEventListener('click',()=>{fleetPendingActions=fleetPendingActions.filter((_,j)=>j!==i);renderFleetSuggestions();});
    row.appendChild(one); row.appendChild(drop); sug.appendChild(row);
  });
}
function syncFleetChatChrome(){
  const chat=$('#fleetChat'); if(!chat)return;
  chat.classList.toggle('open', fleetChatOpen);
  const hint=$('#fcHint'); if(hint) hint.textContent=fleetChatBusy?'thinking…':fleetChatHint();
  const send=$('#fcSend'); if(send) send.disabled=fleetChatBusy;
}
function ensureFleetChat(root){
  let chat=root.querySelector('#fleetChat');
  if(chat){ syncFleetChatChrome(); return chat; }
  chat=el('div'); chat.id='fleetChat';
  chat.innerHTML='<div class="fc-bar" id="fcBar"><span id="fcChevron">▸</span> <strong>Ask this view</strong><span class="hint" id="fcHint"></span></div>'+
    '<div class="fc-body"><div class="fc-chips" id="fcChips"></div><div class="fc-log" id="fcLog"></div><div class="fc-suggest" id="fcSuggest"></div>'+
    '<div class="fc-input"><textarea id="fcQ" placeholder="Ask about these sessions… e.g. tag automated, invent missing tasks"></textarea><button class="ghost" id="fcSend">Ask</button></div></div>';
  root.appendChild(chat);
  chat.querySelector('#fcBar').addEventListener('click',()=>{ fleetChatOpen=!fleetChatOpen; chat.querySelector('#fcChevron').textContent=fleetChatOpen?'▾':'▸'; syncFleetChatChrome(); });
  const chips=chat.querySelector('#fcChips');
  FLEET_CHIPS.forEach(([lab,q])=>{
    const b=el('button','fc-chip',lab); b.addEventListener('click',()=>sendFleetChat(q)); chips.appendChild(b);
  });
  chat.querySelector('#fcSend').addEventListener('click',()=>{ const ta=chat.querySelector('#fcQ'); sendFleetChat(ta.value); ta.value=''; });
  chat.querySelector('#fcQ').addEventListener('keydown',e=>{ if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); const ta=e.target; sendFleetChat(ta.value); ta.value=''; }});
  syncFleetChatChrome();
  return chat;
}
function renderSessions(){
  armSessPoll();
  const el2=$('#sessions');
  el2.classList.add('fleet-shell');
  if(SESS===null){
    el2.innerHTML='<div style="opacity:.6;padding:16px">Loading sessions…</div>';
    vscode.postMessage({type:'requestSessions'});
    return;
  }
  const chat=el2.querySelector('#fleetChat');
  [...el2.children].forEach(n=>{ if(n.id!=='fleetChat') n.remove(); });
  const bar=el('div','sessbar');
  const seg=el('div','seg');
  [['live','Live'],['today','Today'],['yesterday','Yest'],['week','Week'],['all','All']].forEach(([k,lbl])=>{
    const b=el('button',sessFilter===k?'on':null,lbl); b.addEventListener('click',()=>{sessFilter=k;renderSessions();}); seg.appendChild(b);
  });
  bar.appendChild(seg);
  const hosts=['all',...new Set(SESS.map(s=>s.host).filter(Boolean))].sort();
  const hostSel=document.createElement('select'); hostSel.title='Filter by laptop';
  hosts.forEach(h=>{ const o=document.createElement('option'); o.value=h; o.textContent=h==='all'?'all laptops':h; if(h===sessHost)o.selected=true; hostSel.appendChild(o); });
  hostSel.addEventListener('change',()=>{sessHost=hostSel.value;renderSessions();});
  bar.appendChild(hostSel);
  const autoN=SESS.filter(sessInWindow).filter(sessIsAuto).length;
  const hide=el('button',sessHideAuto?'on':null, sessHideAuto?('Hide auto · '+autoN):('Show auto · '+autoN));
  hide.title='Filter out cron / night-loop / fleet automation'; hide.addEventListener('click',()=>{sessHideAuto=!sessHideAuto;renderSessions();}); bar.appendChild(hide);
  const unl=el('button',sessUnlinked?'on':null,'Unlinked'); unl.title='sessions with no planning link'; unl.addEventListener('click',()=>{sessUnlinked=!sessUnlinked;renderSessions();}); bar.appendChild(unl);
  const srch=el('input'); srch.placeholder='Filter…'; srch.value=sessSearch; srch.className='sesssearch';
  srch.addEventListener('input',e=>{sessSearch=e.target.value;renderSessions();});
  bar.appendChild(srch);
  const ask=el('button','ghost mini','Ask ▾'); ask.title='reason over this view'; ask.addEventListener('click',()=>{fleetChatOpen=true;ensureFleetChat(el2);syncFleetChatChrome(); const ta=$('#fcQ'); if(ta)ta.focus();}); bar.appendChild(ask);
  const reload=el('button','ghost mini','⟳'); reload.title='reload + sync'; reload.addEventListener('click',()=>{SESS=null;vscode.postMessage({type:'syncNow'});vscode.postMessage({type:'requestSessions'});renderSessions();}); bar.appendChild(reload);
  el2.insertBefore(bar, chat||null);
  const rows=visibleFleetRows();
  const liveN=rows.filter(s=>s.status==='live-local'||s.status==='active-remote').length;
  const hiddenAuto=sessHideAuto?autoN:0;
  const cnt=el('div','sesscount', rows.length+' shown · '+liveN+' live'+(hiddenAuto?' · '+hiddenAuto+' automated hidden':'')+' · hover a row for actions');
  el2.insertBefore(cnt, chat||null);
  const board=el('div'); board.id='fleetBoard';
  if(!rows.length){
    board.appendChild(el('div',null,'<div style="opacity:.55;padding:18px 8px">Nothing in this view. Turn off <b>Hide auto</b> or widen the window. ⟳ pulls other laptops.</div>'));
  } else {
    const byHost=new Map();
    rows.forEach(s=>{ const h=s.host||'unknown'; if(!byHost.has(h))byHost.set(h,[]); byHost.get(h).push(s); });
    [...byHost.entries()].sort((a,b)=>{
      const la=a[1].filter(x=>x.status==='live-local'||x.status==='active-remote').length;
      const lb=b[1].filter(x=>x.status==='live-local'||x.status==='active-remote').length;
      return lb-la||a[0].localeCompare(b[0]);
    }).forEach(([host,list])=>{
      const col=el('div','fleetcol');
      const live=list.filter(x=>x.status==='live-local'||x.status==='active-remote').length;
      col.appendChild(el('div','fleethost',statusDot(live?'live-local':'ended')+' '+esc(host)+' <span style="opacity:.55;font-weight:500">'+list.length+(live?' · '+live+' live':'')+'</span>'));
      list.slice(0,120).forEach(s=>{
        col.appendChild(renderFleetRow(s));
        if(sessOpenUuid===s.uuid) col.appendChild(renderExplainDrawer(s));
      });
      board.appendChild(col);
    });
  }
  el2.insertBefore(board, chat||null);
  ensureFleetChat(el2);
}
// ── social: ideas/tasks flagged (lane==='social') to polish into a post ──
const SOCIAL_LANE='social';
function isSocial(o){ return String(o.lane||'')===SOCIAL_LANE; }
function renderSocial(){
  const el2=$('#social'); el2.innerHTML='';
  const rows=(S.objects||[]).filter(o=>(o.type==='idea'||o.type==='task'||o.type==='thought')&&isSocial(o));
  const bar=el('div',null,'<div style="font-size:13px;font-weight:600;margin-bottom:2px">✨ Polish → social media post</div><div style="opacity:.65;font-size:12px;margin-bottom:12px">Ideas / tasks / thoughts flagged for social. Flag any item from its drawer ("Mark for social"), or drag a card here. "Polish in Code Build" drafts a post from the item.</div>');
  el2.appendChild(bar);
  const drop=el('div','socialdrop'); drop.textContent='＋ drop a card here to flag it for social';
  drop.addEventListener('dragover',ev=>{ev.preventDefault();drop.classList.add('over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',ev=>{ev.preventDefault();drop.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(id)vscode.postMessage({type:'action',action:'toggleSocial',id:id,on:true});});
  el2.appendChild(drop);
  if(!rows.length){ el2.appendChild(el('div',null,'<div style="opacity:.55;padding:14px 2px">Nothing flagged yet.</div>')); return; }
  const list=el('div','sociallist');
  rows.forEach(o=>{
    const c=el('div','socialcard');
    c.innerHTML='<div class="sh"><span class="ct">'+esc(o.title||o.id)+'</span><span class="cm"><span class="badge">'+o.type+'</span>'+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.status?'<span>'+esc(o.status)+'</span>':'')+'</span></div>';
    const acts=el('div','sacts');
    const polish=el('button','ghost mini','✨ Polish in Code Build'); polish.addEventListener('click',()=>vscode.postMessage({type:'action',action:'polishSocial',id:o.id}));
    const open=el('button','ghost mini','Open'); open.addEventListener('click',()=>openDetail(o.id));
    const unflag=el('button','ghost mini','Unflag'); unflag.addEventListener('click',()=>vscode.postMessage({type:'action',action:'toggleSocial',id:o.id,on:false}));
    acts.appendChild(polish); acts.appendChild(open); acts.appendChild(unflag);
    c.appendChild(acts); list.appendChild(c);
  });
  el2.appendChild(list);
}
function todayStr(){return (S&&S.board&&S.board.date)||new Date().toISOString().slice(0,10);}
// A task is overdue when its due date is before today and it isn't done/outdated.
function isOverdue(o){ return o.type==='task' && o.due && String(o.due).slice(0,10)<todayStr() && o.status!=='done' && o.status!=='outdated'; }
// Open item untouched for 21+ days (last = updated, else created).
function isStale(o){ if(CLOSED_STATUS.has(String(o.status||'')))return false; const last=String(o.updated||o.created||''); if(!last)return false; return last<addDays(todayStr(),-21); }
function overdueList(){ return (S&&S.objects||[]).filter(isOverdue); }
function renderOverduePill(){
  const p=$('#overduePill'); if(!p)return; const n=overdueList().length;
  if(!n){ p.style.display='none'; return; }
  p.style.display='inline-flex'; p.textContent='⚠ '+n+' overdue'; p.classList.toggle('on',overdueOnly);
}
function renderInboxPill(){
  const p=$('#inboxPill'); if(!p)return; const n=inboxItems().length;
  if(!n){ p.style.display='none'; return; }
  p.style.display='inline-flex'; p.textContent='📥 '+n; p.classList.toggle('on',view==='inbox');
}
function weekStart(d){ const x=new Date(d+'T00:00:00Z'); return addDays(d,-((x.getUTCDay()+6)%7)); }
function dueByDay(){const m={};(S.objects||[]).filter(o=>o.type==='task'&&o.due).forEach(o=>{(m[o.due]??=[]).push(o);});
  for(const k in m)m[k].sort((a,b)=>((a.priority||'p9')).localeCompare(b.priority||'p9'));return m;}
function calDrop(elm,day){
  elm.addEventListener('dragover',ev=>{ev.preventDefault();ev.dataTransfer.dropEffect='move';elm.classList.add('over');});
  elm.addEventListener('dragleave',()=>elm.classList.remove('over'));
  elm.addEventListener('drop',ev=>{ev.preventDefault();elm.classList.remove('over');
    const id=ev.dataTransfer.getData('text/plain');
    if(id)vscode.postMessage({type:'setDue',id:id,due:day});});
}
function dueItem(o,cls){
  const now=todayStr();const closed=o.status==='done'||o.status==='outdated';
  const it=el('div',cls+(o.due<now&&!closed?' late':''));
  it.textContent=(o.priority?o.priority+' · ':'')+(o.title||o.id);
  it.draggable=true;
  it.addEventListener('dragstart',ev=>{ev.stopPropagation();ev.dataTransfer.setData('text/plain',o.id);ev.dataTransfer.effectAllowed='move';});
  it.addEventListener('click',ev=>{ev.stopPropagation();openDetail(o.id);});
  return it;
}
function renderCalendar(){
  const now=todayStr();
  if(!calAnchor)calAnchor=now;
  const cal=$('#calendar'); cal.innerHTML='';
  const by=dueByDay();
  if(calMode==='list'){ renderCalList(cal,by,now); return; }
  const bar=el('div','calbar');
  const title=calMode==='month'?new Date(calAnchor+'T00:00:00Z').toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'}):'Week of '+weekStart(calAnchor);
  bar.innerHTML='<button class="ghost" id="cPrev">‹</button><span class="title">'+esc(title)+'</span><button class="ghost" id="cNext">›</button><button class="ghost" id="cToday">Today</button>';
  cal.appendChild(bar);
  bar.querySelector('#cToday').addEventListener('click',()=>{calAnchor=now;renderCalendar();});
  if(calMode==='month'){
    bar.querySelector('#cPrev').addEventListener('click',()=>{const d=new Date(calAnchor+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1,1);calAnchor=d.toISOString().slice(0,10);renderCalendar();});
    bar.querySelector('#cNext').addEventListener('click',()=>{const d=new Date(calAnchor+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1,1);calAnchor=d.toISOString().slice(0,10);renderCalendar();});
    const gridStart=weekStart(calAnchor.slice(0,8)+'01');
    const grid=el('div','mgrid');
    ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d=>grid.appendChild(el('div','dow',d)));
    for(let i=0;i<42;i++){
      const d=addDays(gridStart,i);
      const cell=el('div','mcell'+(d.slice(0,7)!==calAnchor.slice(0,7)?' dim':'')+(d===now?' today':''));
      cell.appendChild(el('div','d','<span>'+Number(d.slice(8))+'</span>'));
      const due=by[d]||[];
      due.slice(0,3).forEach(o=>cell.appendChild(dueItem(o,'mi')));
      if(due.length>3)cell.appendChild(el('div','mi','+'+(due.length-3)+' more…'));
      cell.addEventListener('click',ev=>{ if(ev.target.closest('.mi'))return; openCreateDrawer({due:d}); });
      cell.querySelector('.d').addEventListener('click',ev=>{ev.stopPropagation();calMode='list';calFrom=d;calTo=d;renderCalendar();});
      cell.querySelector('.d').style.cursor='pointer';cell.querySelector('.d').title='open day list';
      calDrop(cell,d);
      grid.appendChild(cell);
    }
    cal.appendChild(grid);
  }else{
    const days=calMode==='workweek'?5:7;
    bar.querySelector('#cPrev').addEventListener('click',()=>{calAnchor=addDays(calAnchor,-7);renderCalendar();});
    bar.querySelector('#cNext').addEventListener('click',()=>{calAnchor=addDays(calAnchor,7);renderCalendar();});
    const start=weekStart(calAnchor);
    const grid=el('div','wgrid');grid.style.gridTemplateColumns='repeat('+days+',1fr)';
    for(let i=0;i<days;i++){
      const d=addDays(start,i);
      const col=el('div','wcol'+(d===now?' today':''));
      const label=new Date(d+'T00:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
      const h=el('h4',null,'<span>'+esc(label)+'</span><span>›</span>');
      h.addEventListener('click',()=>{calMode='list';calFrom=d;calTo=d;renderCalendar();});
      col.appendChild(h);
      (by[d]||[]).forEach(o=>col.appendChild(dueItem(o,'witem')));
      col.addEventListener('click',ev=>{ if(ev.target.closest('.witem')||ev.target.closest('h4'))return; openCreateDrawer({due:d}); });
      col.style.cursor='pointer';col.title='click empty space to add a task due this day';
      calDrop(col,d);
      grid.appendChild(col);
    }
    cal.appendChild(grid);
  }
}
function renderCalList(cal,by,now){
  if(!calFrom){calFrom=now;}
  if(!calTo){calTo=addDays(now,14);}
  const bar=el('div','calbar');
  bar.innerHTML='<label>from <input type="date" id="calFrom" value="'+calFrom+'"></label> <label>to <input type="date" id="calTo" value="'+calTo+'"></label> <button id="calAll" class="ghost">All dated</button> <button id="calOverdue" class="ghost">+ Overdue</button>';
  cal.appendChild(bar);
  const inWin=Object.keys(by).filter(d=>d>=calFrom&&d<=calTo).sort();
  if(!inWin.length)cal.appendChild(el('div','calempty','(no tasks due between '+calFrom+' and '+calTo+')'));
  inWin.forEach(day=>{
    const dayEl=el('div','calday');
    const mark=day<now?' ⚠':day===now?' ← today':'';
    dayEl.appendChild(el('h3',null,esc(day)+mark));
    by[day].forEach(o=>{const done=o.status==='done'||o.status==='outdated';
      const row=el('div','calrow'+(done?' done':'')+(o.due<now&&!done?' late':''));
      row.innerHTML='<span class="dot" style="background:'+(LANE_COLOR[o.status]||'#888')+'"></span>'+(o.priority?'<span class="prio '+esc(o.priority)+'">'+esc(o.priority)+'</span>':'')+'<span class="ct">'+esc(o.title||o.id)+'</span><span class="cm">'+esc(o.status||'')+(o.domain?' · '+esc(o.domain):'')+'</span>';
      row.addEventListener('click',()=>openDetail(o.id));
      dayEl.appendChild(row);});
    cal.appendChild(dayEl);
  });
  bar.querySelector('#calFrom').addEventListener('change',e=>{calFrom=e.target.value;renderCalendar();});
  bar.querySelector('#calTo').addEventListener('change',e=>{calTo=e.target.value;renderCalendar();});
  bar.querySelector('#calAll').addEventListener('click',()=>{calFrom='0000-01-01';calTo='9999-12-31';renderCalendar();});
  bar.querySelector('#calOverdue').addEventListener('click',()=>{calFrom='0000-01-01';calTo=todayStr();renderCalendar();});
}

// force-directed graph
let gFilter={nodes:new Set(),edges:new Set()};
let gT={x:0,y:0,k:1};
function renderFilters(){
  const panel=$('#gfilters'); if(!panel)return;
  const types=[...new Set(((S&&S.graph&&S.graph.nodes)||[]).map(n=>n.type))].sort();
  const kinds=[...new Set(((S&&S.graph&&S.graph.edges)||[]).map(e=>e.kind))].sort();
  const btn=(label,active,color,attr,val)=>'<button class="gf-btn'+(active?'':' off')+'" '+attr+'="'+esc(val)+'">'+(color?'<span class="gf-dot" style="background:'+color+'"></span>':'')+esc(label)+'</button>';
  panel.innerHTML='<div class="gf-row"><span class="gf-lab">Nodes</span>'+types.map(t=>btn(t,!gFilter.nodes.has(t),TYPE_COLOR[t]||'#888','data-nt',t)).join('')+'</div>'+
    '<div class="gf-row"><span class="gf-lab">Edges</span>'+kinds.map(k=>btn(k,!gFilter.edges.has(k),'','data-ek',k)).join('')+'<button class="gf-btn gf-fit" id="gfFit">⊡ fit</button></div>';
  panel.querySelectorAll('[data-nt]').forEach(b=>b.addEventListener('click',()=>{const t=b.getAttribute('data-nt');gFilter.nodes.has(t)?gFilter.nodes.delete(t):gFilter.nodes.add(t);renderGraph();}));
  panel.querySelectorAll('[data-ek]').forEach(b=>b.addEventListener('click',()=>{const k=b.getAttribute('data-ek');gFilter.edges.has(k)?gFilter.edges.delete(k):gFilter.edges.add(k);renderGraph();}));
  const fit=$('#gfFit'); if(fit)fit.addEventListener('click',()=>renderGraph());
}
function renderGraph(){
  const svg=$('#graph'); const r=svg.getBoundingClientRect();
  const W=(r.width||window.innerWidth||900), H=(r.height||(window.innerHeight-100)||600);
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  renderFilters();
  const allNodes=((S&&S.graph&&S.graph.nodes)||[]).filter(n=>!gFilter.nodes.has(n.type));
  const present=new Set(allNodes.map(n=>n.id));
  const edges=((S&&S.graph&&S.graph.edges)||[]).filter(e=>!gFilter.edges.has(e.kind)&&present.has(e.from)&&present.has(e.to));
  if(!allNodes.length){ svg.innerHTML='<text x="20" y="40" fill="currentColor" opacity="0.6">No nodes (all hidden, or no data).</text>'; return; }
  // lay out around the origin, then auto-fit the bounding box to the viewport
  const N=allNodes.length, R0=Math.max(160,Math.sqrt(N)*80);
  const nodes=allNodes.map((n,i)=>{const a=i/N*6.283;return {...n,x:Math.cos(a)*R0*(0.55+0.45*((i*0.37)%1)),y:Math.sin(a)*R0*(0.55+0.45*((i*0.61)%1)),vx:0,vy:0};});
  const idx={}; nodes.forEach(n=>idx[n.id]=n);
  const E=edges.filter(e=>idx[e.from]&&idx[e.to]);
  for(let it=0;it<340;it++){
    for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
      const p=nodes[a],q=nodes[b];let dx=p.x-q.x,dy=p.y-q.y;let d=Math.sqrt(dx*dx+dy*dy)||0.5;let f=Math.min(9000/(d*d),45);p.vx+=dx/d*f;p.vy+=dy/d*f;q.vx-=dx/d*f;q.vy-=dy/d*f;}
    E.forEach(e=>{const p=idx[e.from],q=idx[e.to];let dx=q.x-p.x,dy=q.y-p.y;let d=Math.sqrt(dx*dx+dy*dy)||1;let f=(d-72)*0.05;p.vx+=dx/d*f;p.vy+=dy/d*f;q.vx-=dx/d*f;q.vy-=dy/d*f;});
    nodes.forEach(n=>{n.vx+=(-n.x)*0.013;n.vy+=(-n.y)*0.013;n.x+=Math.max(-18,Math.min(18,n.vx));n.y+=Math.max(-18,Math.min(18,n.vy));n.vx*=0.8;n.vy*=0.8;});
  }
  let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
  nodes.forEach(n=>{mnx=Math.min(mnx,n.x);mny=Math.min(mny,n.y);mxx=Math.max(mxx,n.x);mxy=Math.max(mxy,n.y);});
  const bw=Math.max(1,mxx-mnx),bh=Math.max(1,mxy-mny),pad=120;
  gT.k=Math.max(0.3,Math.min((W-pad)/bw,(H-pad)/bh,2.4)); gT.x=W/2-(mnx+bw/2)*gT.k; gT.y=H/2-(mny+bh/2)*gT.k;
  const k=gT.k, fs=(12/k).toFixed(1);
  const ns='http://www.w3.org/2000/svg';
  svg.innerHTML='';
  const g=document.createElementNS(ns,'g'); g.setAttribute('id','gz'); svg.appendChild(g);
  E.forEach(e=>{const p=idx[e.from],q=idx[e.to];const l=document.createElementNS(ns,'line');l.setAttribute('x1',p.x);l.setAttribute('y1',p.y);l.setAttribute('x2',q.x);l.setAttribute('y2',q.y);l.setAttribute('vector-effect','non-scaling-stroke');if(e.kind==='blocked_by'&&e.status!=='resolved')l.setAttribute('class','blocked');g.appendChild(l);});
  nodes.forEach(nd=>{const grp=document.createElementNS(ns,'g');
    const c=document.createElementNS(ns,'circle');c.setAttribute('cx',nd.x);c.setAttribute('cy',nd.y);c.setAttribute('r',((nd.blocked?9:7)/k).toFixed(1));c.setAttribute('fill',nd.blocked?'#e51400':(TYPE_COLOR[nd.type]||'#888'));
    c.addEventListener('click',()=>{ if(S.objects&&S.objects.some(o=>o.id===nd.id)) openDetail(nd.id); else vscode.postMessage({type:'open',id:nd.id,kbPath:nd.type==='knowledge'?nd.id:undefined}); });
    const t=document.createElementNS(ns,'text');t.setAttribute('x',nd.x+(10/k));t.setAttribute('y',nd.y+(4/k));t.setAttribute('font-size',fs);t.setAttribute('paint-order','stroke');t.setAttribute('stroke','var(--vscode-editor-background)');t.setAttribute('stroke-width',(3.5/k).toFixed(1));t.setAttribute('stroke-linejoin','round');t.textContent=(nd.label||nd.id).slice(0,30);
    grp.appendChild(c);grp.appendChild(t);g.appendChild(grp);});
  applyZoom();
}
function applyZoom(){const g=$('#gz');if(g)g.setAttribute('transform','translate('+gT.x+','+gT.y+') scale('+gT.k+')');}
(function(){const svg=$('#graph');let drag=false,sx,sy;
  svg.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.1:0.9;gT.k=Math.max(0.2,Math.min(4,gT.k*f));applyZoom();},{passive:false});
  svg.addEventListener('mousedown',e=>{if(e.target.tagName==='circle')return;drag=true;sx=e.clientX-gT.x;sy=e.clientY-gT.y;});
  window.addEventListener('mousemove',e=>{if(!drag)return;gT.x=e.clientX-sx;gT.y=e.clientY-sy;applyZoom();});
  window.addEventListener('mouseup',()=>drag=false);
})();

function renderCanvas(){ $('#canvas').innerHTML='<div style="font-size:40px">✎</div><div><b>Visual canvas — Excalidraw</b></div><div style="max-width:420px">A free-form sketch/whiteboard saved to <code>~/docs/planning/canvas/board.excalidraw</code> (versioned in git with the rest of the plan).</div><button class="ghost" id="cbtn" style="margin-top:6px">Open Excalidraw canvas →</button>'; const b=$('#cbtn'); if(b)b.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openCanvas'})); }

// detail drawer
let flushAutosave=null;
function openDetail(id){ vscode.postMessage({type:'show',id:id}); $('#drawer').classList.remove('hidden'); $('#backdrop').classList.remove('hidden'); $('#drawerInner').innerHTML='<div style="opacity:.6">Loading '+esc(id)+'…</div>'; }
function closeDrawer(){ if(flushAutosave){try{flushAutosave();}catch(e){}} flushAutosave=null; $('#drawer').classList.add('hidden'); $('#backdrop').classList.add('hidden'); }
function domainOptions(){ const s=new Set(); ((S&&S.objects)||[]).forEach(x=>{ if(x.type==='domain')s.add(String(x.title||x.id.split('/').pop())); else if(x.domain)s.add(String(x.domain)); }); return [...s].sort(); }
function projectOptions(){ return ((S&&S.objects)||[]).filter(x=>x.type==='project').map(x=>({id:x.id,title:x.title||x.id.split('/').pop()})).sort((a,b)=>a.title.localeCompare(b.title)); }
// New-item editor rendered in the side drawer — all fields editable before it's
// created (replaces the cramped one-line top-bar input).
function openCreateDrawer(prefill){
  flushAutosave=null;
  prefill=prefill||{};
  $('#drawer').classList.remove('hidden'); $('#backdrop').classList.remove('hidden');
  const I=$('#drawerInner'); I.innerHTML='';
  const head=el('div','dh'); head.appendChild(el('h2',null,'New item')); const ask=el('button','dclose','💬'); ask.title='Ask the planning chat about this item'; ask.addEventListener('click',function(){ closeDrawer(); if(window.__openPlanningChatWith)window.__openPlanningChatWith('About '+o.id+' — '); }); head.appendChild(ask); const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const STAT={task:['inbox','today','in_progress','done','deferred','outdated'],idea:['capture','refine','accepted','parked','done'],plan:['plan','prototype','implement','validate','done','parked'],thought:['new','kept','converted','archived']};
  // tasks default to 'today' (new items are things to do now); ideas/plans/thoughts keep theirs
  const DEF={task:'today',idea:'capture',plan:'plan',thought:'new'};
  let type=prefill.type||'task';
  const row=(label,node)=>{const r=el('div','statusrow'); r.appendChild(el('span',null,label)); r.appendChild(node); I.appendChild(r); return r;};
  // Type
  const tSel=el('select'); ['task','idea','plan','thought'].forEach(t=>{const o=el('option',null,t);o.value=t;if(t===type)o.selected=true;tSel.appendChild(o);}); row('Type:',tSel);
  // Title
  const title=el('input','fldEdit'); title.style.width='100%'; title.placeholder='What needs doing?'; title.value=prefill.title||''; row('Title:',title); title.parentElement.style.flexWrap='wrap';
  // Status
  const sSel=el('select'); const fillStatus=()=>{sSel.innerHTML=''; (STAT[type]||STAT.task).forEach(s=>{const o=el('option',null,s);o.value=s;if(s===(prefill.status||DEF[type]))o.selected=true;sSel.appendChild(o);});}; fillStatus(); row('Status:',sSel);
  // Category/domain with datalist
  const dl=el('datalist'); dl.id='newDomList'; domainOptions().forEach(d=>{const o=el('option');o.value=d;dl.appendChild(o);}); I.appendChild(dl);
  const dom=el('input','fldEdit'); dom.setAttribute('list','newDomList'); dom.placeholder='kids / tech / career…'; dom.value=prefill.domain||''; row('Category:',dom);
  // Lane
  const lane=el('input','fldEdit'); lane.placeholder='(optional)'; lane.value=prefill.lane||''; row('Lane:',lane);
  // Project
  const pSel=el('select'); const pn=el('option',null,'(none)'); pn.value=''; pSel.appendChild(pn); projectOptions().forEach(p=>{const o=el('option',null,p.title);o.value=p.id;if(p.id===prefill.project)o.selected=true;pSel.appendChild(o);}); row('Project:',pSel);
  // Due + priority
  const due=el('input','fldEdit'); due.type='date'; due.value=prefill.due||todayStr(); const prio=el('select'); ['-','p0','p1','p2','p3'].forEach(p=>{const o=el('option',null,p);o.value=p;prio.appendChild(o);}); const dpr=el('div','statusrow'); dpr.appendChild(el('span',null,'Due:')); dpr.appendChild(due); dpr.appendChild(el('span',null,'Priority:')); dpr.appendChild(prio); I.appendChild(dpr);
  // Body
  { const s=el('div','sec'); s.appendChild(el('h4',null,'Notes / details')); const ta=el('textarea','bodyEdit'); ta.id='newBody'; ta.placeholder='Markdown details…'; ta.value=prefill.body||''; s.appendChild(ta); I.appendChild(s); }
  tSel.addEventListener('change',()=>{type=tSel.value;fillStatus();});
  // actions
  const act=el('div','actions'); act.style.marginTop='14px';
  const create=el('button','act primary','Create'); const cancel=el('button','act','Cancel');
  act.appendChild(create); act.appendChild(cancel); I.appendChild(act);
  cancel.addEventListener('click',closeDrawer);
  const submit=()=>{ const t=title.value.trim(); if(!t){title.focus();return;}
    vscode.postMessage({type:'action',action:'createItem',fields:{type:type,title:t,status:sSel.value,domain:dom.value.trim(),lane:lane.value.trim(),project:pSel.value,due:due.value,priority:prio.value==='-'?'':prio.value,body:$('#newBody').value}}); };
  create.addEventListener('click',submit);
  title.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();submit();} });
  setTimeout(()=>title.focus(),50);
}
function mdLite(s){ return esc(s).replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h2>$1</h2>').replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`([^`]+)`/g,'<code>$1</code>'); }
function refRow(r,bad,onclick){ const d=el('div','refitem'+(bad?' bad':'')); d.innerHTML=esc(r.title||r.id||r.path); if(r.status)d.innerHTML+=' <span class="badge">'+esc(r.status)+'</span>'; if(onclick)d.addEventListener('click',onclick); return d; }
function renderDrawer(o){
  const I=$('#drawerInner'); I.innerHTML='';
  const head=el('div','dh'); const ti=el('input','titleEdit'); ti.value=o.title||''; ti.title='Edit name — Enter or click away to save'; ti.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:'title',value:ti.value})); head.appendChild(ti); const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const fm=o.frontmatter||{};
  const meta=el('div','drow'); meta.innerHTML='<span class="badge">'+o.type+'</span>'+(o.status?'<span class="badge">'+esc(o.status)+'</span>':'')+(o.domain?'<span class="badge">'+esc(o.domain)+'</span>':'')+(fm.context?'<span class="badge" title="captured under">◔ '+esc(fm.context)+'</span>':'')+(fm.surfaced_on?'<span class="badge" title="surfaced on">'+esc(fm.surfaced_on)+'</span>':''); I.appendChild(meta);
  if(fm.source_url){ const sr=el('div','drow'); const a=el('span','badge','↗ '+esc(fm.source||'source')); a.style.cursor='pointer'; a.title=fm.source_url; a.addEventListener('click',()=>vscode.postMessage({type:'action',action:'openUrl',url:fm.source_url})); sr.appendChild(a); I.appendChild(sr); }
  // status changer
  const lanes=LANES[o.type]; if(lanes){ const sr=el('div','statusrow'); const sel=el('select'); lanes.forEach(l=>{const op=el('option',null,l);op.value=l;if(l===o.status)op.selected=true;sel.appendChild(op);}); sel.addEventListener('change',()=>postStatus(o.id,sel.value)); sr.appendChild(el('span',null,'Status:')); sr.appendChild(sel); I.appendChild(sr); }
  { const fr=el('div','statusrow'); const mkf=(field,val)=>{ const inp=el('input','fldEdit'); inp.value=val||''; inp.placeholder=field; inp.title='Edit '+field; inp.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:field,value:inp.value})); return inp; };
    const dl=el('datalist'); dl.id='domList';
    const doms=new Set(); ((S&&S.objects)||[]).forEach(x=>{ if(x.type==='domain')doms.add(String(x.title||x.id.split('/').pop())); else if(x.domain)doms.add(String(x.domain)); });
    [...doms].sort().forEach(d=>{const op=el('option');op.value=d;dl.appendChild(op);});
    fr.appendChild(dl);
    fr.appendChild(el('span',null,'Category:')); const di2=mkf('domain',o.domain); di2.setAttribute('list','domList'); di2.title='Category / domain — pick an existing one or type a new one'; fr.appendChild(di2);
    fr.appendChild(el('span',null,'Lane:')); fr.appendChild(mkf('lane',o.lane)); I.appendChild(fr); }
  { const pr=el('div','statusrow'); pr.appendChild(el('span',null,'Project:'));
    const sel=el('select'); const none=el('option',null,'(none)'); none.value='-'; sel.appendChild(none);
    const cur=o.project||(o.frontmatter&&o.frontmatter.project)||'';
    ((S&&S.objects)||[]).filter(x=>x.type==='project').forEach(p=>{const op=el('option',null,p.title||p.id);op.value=p.id;if(p.id===cur)op.selected=true;sel.appendChild(op);});
    if(!cur)none.selected=true;
    sel.addEventListener('change',()=>vscode.postMessage({type:'setProject',id:o.id,project:sel.value}));
    pr.appendChild(sel); I.appendChild(pr); }
  { const dr=el('div','statusrow'); dr.appendChild(el('span',null,'Due:')); const di=el('input','fldEdit'); di.type='date'; di.style.width='150px';
    let lastDue=String(o.due||(o.frontmatter&&o.frontmatter.due)||'').slice(0,10); di.value=lastDue; di.title='Assign a due date — clear to unset';
    // chromium fires 'change' per keystroke in the year segment (year "2" => valid 0002-07-25),
    // so debounce and refuse implausible years instead of saving intermediates
    let dueT=null;
    const commitDue=()=>{const v=di.value; if(v===lastDue)return; if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number(v.slice(0,4))<1970))return; lastDue=v; vscode.postMessage({type:'setDue',id:o.id,due:v||'-'});};
    di.addEventListener('change',()=>{clearTimeout(dueT);dueT=setTimeout(commitDue,700);});
    di.addEventListener('blur',()=>{clearTimeout(dueT);commitDue();});
    di.addEventListener('click',()=>{try{if(di.showPicker)di.showPicker();}catch(e){}});
    dr.appendChild(di);
    // Priority: p0 (highest) … p3, or none
    dr.appendChild(el('span',null,'Priority:'));
    const pi=el('select'); ['-','p0','p1','p2','p3'].forEach(p=>{const op=el('option',null,p);op.value=p;if(p===((o.frontmatter&&o.frontmatter.priority)||'-'))op.selected=true;pi.appendChild(op);});
    pi.addEventListener('change',()=>vscode.postMessage({type:'setPriority',id:o.id,priority:pi.value}));
    dr.appendChild(pi);
    I.appendChild(dr); }
  // agent actions
  const act=el('div','sec'); act.appendChild(el('h4',null,'Agent actions'));
  const grid=el('div','actions');
  const mk=(k,d,action,primary)=>{const b=el('button','act'+(primary?' primary':''),'<span class="k">'+k+'</span><span class="d">'+d+'</span>');b.addEventListener('click',()=>vscode.postMessage({type:'action',action:action,id:o.id}));return b;};
  grid.appendChild(mk('Ideate','expand into sub-ideas','ideate'));
  grid.appendChild(mk('Draft spec','speckit FRs + criteria','spec'));
  grid.appendChild(mk('Decompose','break into tasks','decompose'));
  grid.appendChild(mk('Research KB','find + connect knowledge','research'));
  act.appendChild(grid);
  const grid2=el('div','actions'); grid2.style.marginTop='7px';
  grid2.appendChild(mk('Run in Code Build ▸','review prompt, then run','execute',true));
  grid2.appendChild(mk('Open in Code Build','whole-item context + @refs','openCB'));
  grid2.appendChild(mk('Open file','edit markdown','openFile'));
  grid2.appendChild(mk('Link session','search + attach','link'));
  act.appendChild(grid2);
  const grid3=el('div','actions'); grid3.style.marginTop='7px';
  grid3.appendChild(mk('Edit','title / fields','editItem'));
  grid3.appendChild(mk('Clone','duplicate this item','cloneItem'));
  grid3.appendChild(mk('Recategorize','type / domain / lane','recategorize'));
  if(o.type==='idea'){ grid3.appendChild(mk('Promote → plan','create a plan','promote')); grid3.appendChild(mk('Move → task','convert to task','moveToTask')); }
  if(o.type==='thought'){ grid3.appendChild(mk('Convert → idea','promote this thought','convertToIdea')); grid3.appendChild(mk('Convert → task','make it actionable','convertToTask')); }
  if(o.type==='idea'||o.type==='task'||o.type==='thought'){
    const soc=String((o.frontmatter&&o.frontmatter.lane)||o.lane||'')==='social';
    const b=el('button','act','<span class="k">'+(soc?'★ Unmark social':'✨ Mark for social')+'</span><span class="d">'+(soc?'flagged to polish':'polish → social post')+'</span>');
    b.addEventListener('click',()=>vscode.postMessage({type:'action',action:'toggleSocial',id:o.id,on:!soc}));
    grid3.appendChild(b);
    grid3.appendChild(mk('Polish → social post','draft in Code Build','polishSocial'));
  }
  grid3.appendChild(mk('Delete','remove item','deleteItem'));
  act.appendChild(grid3); I.appendChild(act);
  // body
  { const s=el('div','sec'); const h=el('div','bodyhead'); h.appendChild(el('h4',null,'Notes / details')); const st=el('span','savenote',''); h.appendChild(st); s.appendChild(h);
    const ta=el('textarea','bodyEdit'); ta.value=o.body||''; ta.placeholder='Markdown details… (autosaves)'; s.appendChild(ta);
    let t=null, saved=ta.value;
    const save=()=>{ if(ta.value===saved)return; saved=ta.value; vscode.postMessage({type:'action',action:'autosaveField',id:o.id,field:'body',value:ta.value}); st.textContent='saved ✓'; setTimeout(()=>{if(st.textContent==='saved ✓')st.textContent='';},1500); };
    ta.addEventListener('input',()=>{clearTimeout(t);st.textContent='…';t=setTimeout(save,800);});
    ta.addEventListener('blur',()=>{clearTimeout(t);save();});
    flushAutosave=save;
    I.appendChild(s); }
  // references
  const refs=[['Blocked by knowledge',o.blocked_by,true],['Cites',o.cites,false],['Children',o.children,false],['Depends on',o.depends_on,false],['Related',o.related,false]];
  refs.forEach(([label,list,isBlock])=>{ if(!list||!list.length)return; const s=el('div','sec'); s.appendChild(el('h4',null,label+' ('+list.length+')')); const rl=el('div','reflist'); list.forEach(r=>{ const bad=isBlock?(r.status!=='resolved'):(r.exists===false||r.missing); const open = r.id&&!r.missing? ()=>openDetail(r.id) : (r.path? ()=>vscode.postMessage({type:'open',kbPath:r.path}) : null); rl.appendChild(refRow(r,bad,open)); }); s.appendChild(rl); I.appendChild(s); });
  if(o.parent){ const s=el('div','sec'); s.appendChild(el('h4',null,'Parent')); const rl=el('div','reflist'); rl.appendChild(refRow(o.parent,false,()=>openDetail(o.parent.id))); s.appendChild(rl); I.appendChild(s); }
  if(o.linked_sessions&&o.linked_sessions.length){ const s=el('div','sec'); s.appendChild(el('h4',null,'Linked sessions ('+o.linked_sessions.length+')')); const rl=el('div','reflist'); o.linked_sessions.forEach(u=>rl.appendChild(refRow({id:u,title:'▸ open chat — '+u.slice(0,18)+'…'},false,()=>vscode.postMessage({type:'action',action:'openSession',uuid:u})))); s.appendChild(rl); I.appendChild(s); }
}

// ---- embedded planning chat (host: src/planningChat.ts) --------------------
(function(){
  var drawer=$('#chatDrawer'); if(!drawer) return;
  var msgs=$('#chatMsgs'), input=$('#chatInput'), sendBtn=$('#chatSend'), stopBtn=$('#chatStop'),
      btn=$('#chatBtn'), closeBtn=$('#chatClose'), costEl=$('#chatCost'),
      selProv=$('#chatProvider'), selModel=$('#chatModel'), selEffort=$('#chatEffort'), selAccess=$('#chatAccess');
  var open=false, busy=false, agentEl=null, totalCost=0, lastSeq=0, fullAllowed=false;
  // Same catalogs CB's header offers (host: planningChat.ts CHAT_PROVIDERS).
  var PROVIDERS={claude:{label:'Claude Code',models:['default','fable','opus','sonnet','haiku']},
                 grok:{label:'Grok Build',models:['default','grok-4.6','grok-4.5','grok-code-fast-1']}};
  var EFFORTS=['default','low','medium','high','xhigh','max'];
  function fillSel(sel,opts,cur){ if(!sel)return; sel.innerHTML=''; opts.forEach(function(o){ var op=document.createElement('option'); op.value=o.v; op.textContent=o.t; if(o.v===cur)op.selected=true; sel.appendChild(op); }); }
  function initControls(defModel){ if(!selProv)return;
    fillSel(selProv,Object.keys(PROVIDERS).map(function(k){return {v:k,t:PROVIDERS[k].label};}),'claude');
    fillSel(selModel,PROVIDERS.claude.models.map(function(m){return {v:m,t:m};}),defModel&&PROVIDERS.claude.models.indexOf(defModel)>=0?defModel:'default');
    fillSel(selEffort,EFFORTS.map(function(e2){return {v:e2,t:e2==='default'?'auto · effort':e2};}),'default');
    selProv.addEventListener('change',function(){ var p2=PROVIDERS[selProv.value]||PROVIDERS.claude; fillSel(selModel,p2.models.map(function(m){return {v:m,t:m};}),'default'); });
  }
  function runtime(){ return { provider: selProv?selProv.value:'claude', model: selModel?selModel.value:'default', effort: selEffort?selEffort.value:'default', access: selAccess?selAccess.value:'kp' }; }
  function toggle(v){ open=(v===undefined)?!open:v; drawer.classList.toggle('hidden',!open);
    if(btn)btn.classList.toggle('on',open);
    if(open){ input.focus(); scrollEnd(); } }
  function scrollEnd(){ msgs.scrollTop=msgs.scrollHeight; }
  function el(cls,text){ var d=document.createElement('div'); d.className=cls; d.textContent=text; msgs.appendChild(d); scrollEnd(); return d; }
  function mdChat(s){
    var t=esc(s);
    t=t.replace(/^### (.*)$/gm,'<h3>$1</h3>')
      .replace(/^## (.*)$/gm,'<h2>$1</h2>')
      .replace(/^# (.*)$/gm,'<h2>$1</h2>')
      .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
      .replace(/`([^`]+)`/g,'<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2">$1</a>')
      .replace(/^(?:[-*]|\d+\.) (.*)$/gm,'<li>$1</li>');
    t=t.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g,function(m){return '<ul>'+m+'</ul>';});
    t=t.replace(/\n/g,'<br>');
    return t;
  }
  function paintAgent(raw){
    if(!agentEl){ agentEl=document.createElement('div'); agentEl.className='chat-m agent'; msgs.appendChild(agentEl); }
    agentEl._raw=(agentEl._raw||'')+raw;
    agentEl.innerHTML=mdChat(agentEl._raw);
    scrollEnd();
  }
  function setBusy(v){ busy=v; sendBtn.disabled=v; stopBtn.style.display=v?'':'none';
    if(!v){ var st=msgs.querySelector('.chat-status'); if(st)st.remove(); } }
  function apply(ev){
    if(!ev||!ev.kind)return;
    // Transcript events carry seq; skip anything already painted (a
    // re-opened panel gets live events AND the full history replay).
    if(typeof ev.seq==='number'){ if(ev.seq<=lastSeq)return; lastSeq=ev.seq; }
    if(ev.kind==='busy'){ setBusy(!!ev.busy); agentEl=null; return; }
    if(ev.kind==='status'){ var st=msgs.querySelector('.chat-status'); if(st)st.remove(); el('chat-status',ev.text); return; }
    if(ev.kind==='user'){ el('chat-m user',ev.text); agentEl=null; return; }
    if(ev.kind==='text'){ paintAgent(ev.text); return; }
    if(ev.kind==='board'){ applyBoardCmd(ev.cmd); return; }
    if(ev.kind==='tool'){ el('chat-tool','⚒ '+ev.name+(ev.detail?' · '+ev.detail:'')); agentEl=null; return; }
    if(ev.kind==='result'){ agentEl=null;
      if(ev.isError && ev.text) el('chat-m error',ev.text);
      if(typeof ev.costUsd==='number'){ totalCost+=ev.costUsd; costEl.textContent='$'+totalCost.toFixed(2); } return; }
    if(ev.kind==='error'){ el('chat-m error',ev.message); return; }
  }
  function send(text){ var t=(text!==undefined?text:input.value).trim(); if(!t||busy)return;
    input.value=''; vscode.postMessage({type:'chatSend',text:t,runtime:runtime()}); vscode.postMessage({type:'activity'}); }
  if(btn)btn.addEventListener('click',function(){toggle();});
  if(closeBtn)closeBtn.addEventListener('click',function(){toggle(false);});
  sendBtn.addEventListener('click',function(){send();});
  stopBtn.addEventListener('click',function(){vscode.postMessage({type:'chatCancel'});});
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  msgs.addEventListener('click',function(e){ var c=e.target.closest('.chat-chip'); if(c){ send(c.textContent); } });
  window.addEventListener('message',function(e){ var m=e.data||{};
    if(m.type==='chatEvent'){ apply(m.data); }
    else if(m.type==='openChat'){ toggle(true); }
    else if(m.type==='chatAsk'){ toggle(true); input.value=m.text||''; input.focus(); }
    else if(m.type==='chatHistory'){ (m.data||[]).forEach(apply); setBusy(!!m.busy);
      var ri=m.runtime||{}; fullAllowed=!!ri.fullAllowed; initControls(ri.defaultModel);
      if(selAccess){ var fo=selAccess.querySelector('option[value="full"]');
        if(fo){ fo.disabled=!fullAllowed; fo.textContent=fullAllowed?'full access':'full access (locked — enable chat.fullAccess)'; }
        if(fullAllowed) selAccess.value='full'; }
      if(m.enabled===false){ el('chat-m error','Planning chat is unavailable (claude CLI not found or chat disabled).'); sendBtn.disabled=true; } }
  });
  // Hydrate at script boot (not first open): a reopened panel must know the
  // transcript + busy state before any live event lands.
  vscode.postMessage({type:'chatHistory'});
  window.__openPlanningChatWith=function(text){ toggle(true); if(text){ input.value=text; } input.focus(); };
})();

vscode.postMessage({type:'ready'});

} catch (e) {
  var d = document.getElementById('loadDetail');
  var t = document.getElementById('loadTitle');
  if (t) t.textContent = 'Dashboard script failed to start';
  if (d) d.textContent = (e && e.message ? e.message : String(e)) + '\n' + (e && e.stack ? e.stack : '');
}
})();
