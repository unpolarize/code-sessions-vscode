// Full-page Planning Dashboard webview — the interactive cockpit.
//
// One editor tab with a Board (polished kanban, drag-and-drop), a meaningful
// force-directed Graph, and a Canvas (Excalidraw, staged), plus a right-hand detail
// drawer that loads `kp show <id>` (body + resolved references + children) and exposes
// agent actions (Ideate / Draft spec / Decompose / Execute) and Open-in-Code-Build.
//
// The host (planning.ts) injects the data/runner deps so this file stays UI-only.

import * as vscode from "vscode";

export interface DashboardDeps {
  getSnapshot: () => unknown | null;
  reload: () => boolean;
  onChange: vscode.Event<void>;
  runKp: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
  /** delegate open-file / agent actions to the host (needs vscode + terminals) */
  onAction: (msg: { type: string; [k: string]: unknown }) => void;
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(deps: DashboardDeps, view?: string, itemId?: string): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      if (view) DashboardPanel.current.panel.webview.postMessage({ type: "setView", view });
      if (itemId) DashboardPanel.current.panel.webview.postMessage({ type: "openItem", id: itemId });
      return;
    }
    DashboardPanel.current = new DashboardPanel(deps, view, itemId);
  }

  private constructor(private deps: DashboardDeps, private initialView?: string, private initialItem?: string) {
    this.panel = vscode.window.createWebviewPanel("codePlanningDashboard", "Planning Dashboard", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.deps.onChange(() => this.pushSnapshot(), null, this.disposables);
    this.panel.webview.html = this.html();
  }

  private pushSnapshot(): void {
    this.panel.webview.postMessage({ type: "snapshot", data: this.deps.getSnapshot() });
  }

  private onMessage(m: { type: string; [k: string]: unknown }): void {
    switch (m.type) {
      case "ready":
        this.pushSnapshot();
        if (this.initialView) this.panel.webview.postMessage({ type: "setView", view: this.initialView });
        if (this.initialItem) this.panel.webview.postMessage({ type: "openItem", id: this.initialItem });
        break;
      case "refresh":
        this.deps.reload();
        this.pushSnapshot();
        break;
      case "show": {
        const res = this.deps.runKp(["show", String(m.id)]);
        if (res.ok) {
          try {
            this.panel.webview.postMessage({ type: "detail", data: JSON.parse(res.stdout) });
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "setStatus":
        this.deps.runKp(["set-status", String(m.id), String(m.status)]);
        this.deps.reload();
        this.pushSnapshot();
        // refresh the open drawer
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      case "setDue":
        this.deps.runKp(["set-due", String(m.id), String(m.due || "-")]);
        this.deps.reload();
        this.pushSnapshot();
        if (m.id) this.onMessage({ type: "show", id: m.id });
        break;
      default:
        this.deps.onAction(m); // open / action (agent, CB, promote, link, capture)
    }
  }

  post(msg: unknown): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const n = nonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; img-src data:;`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLE}</style></head>
<body>
<div id="topbar">
  <span class="brand">◧ Planning</span>
  <div class="seg" id="viewSeg">
    <button data-view="board" class="on">Board</button>
    <button data-view="calendar">Calendar</button>
    <button data-view="graph">Graph</button>
    <button data-view="canvas">Canvas</button>
  </div>
  <div class="seg" id="laneSeg">
    <button data-lane="task" class="on">Tasks</button>
    <button data-lane="idea">Ideas</button>
    <button data-lane="plan">Plans</button>
  </div>
  <div class="seg" id="calModeSeg" style="display:none">
    <button data-cm="month" class="on">Month</button>
    <button data-cm="week">Week</button>
    <button data-cm="workweek">Work week</button>
    <button data-cm="list">List</button>
  </div>
  <select id="groupBy" title="Group lanes by">
    <option value="status">▦ status</option>
    <option value="domain">▦ domain</option>
    <option value="type">▦ type</option>
    <option value="lane">▦ lane</option>
  </select>
  <button id="addLaneBtn" class="ghost" title="Add a custom lane">＋ lane</button>
  <span class="spacer"></span>
  <span id="counts" class="counts"></span>
  <input id="search" placeholder="Search… (⌘F)" style="display:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:3px 8px;width:180px">
  <button id="captureBtn" class="ghost">＋ New</button>
  <button id="refreshBtn" class="ghost">⟳</button>
</div>
<div id="main">
  <div id="board" class="view"></div>
  <div id="calendar" class="view hidden"></div>
  <svg id="graph" class="view hidden"></svg>
  <div id="canvas" class="view hidden"></div>
  <div id="gfilters" class="hidden"></div>
</div>
<div id="drawer" class="hidden"><div id="drawerInner"></div></div>
<div id="backdrop" class="hidden"></div>
<script nonce="${n}">${SCRIPT}</script>
</body></html>`;
  }
}

// ---------------------------------------------------------------- styles -----
const STYLE = `
:root{ --gap:10px; }
*{box-sizing:border-box}
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;overflow:hidden;display:flex;flex-direction:column}
#topbar{display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid var(--vscode-widget-border);flex:0 0 auto}
.brand{font-weight:700;letter-spacing:.3px}
.spacer{flex:1}
.counts{opacity:.7;font-size:12px}
.seg{display:inline-flex;border:1px solid var(--vscode-widget-border);border-radius:7px;overflow:hidden}
.seg button{background:transparent;color:var(--vscode-foreground);border:0;padding:4px 11px;cursor:pointer;font-size:12px}
.seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.ghost{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
.ghost:hover{background:var(--vscode-toolbar-hoverBackground)}
#main{flex:1;position:relative;overflow:hidden}
.view{position:absolute;inset:0}
.hidden{display:none!important}
/* board */
#board{display:flex;gap:var(--gap);padding:14px;overflow-x:auto;align-items:flex-start}
.col{flex:0 0 270px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:10px;display:flex;flex-direction:column;max-height:100%}
.col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
.col h3{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:0;padding:10px 12px;display:flex;align-items:center;gap:7px;position:sticky;top:0}
.dot{width:8px;height:8px;border-radius:50%}
.col .cnt{margin-left:auto;opacity:.6;font-weight:400}
.cards{padding:0 10px 10px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.card{background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border);border-radius:8px;padding:10px;cursor:grab;transition:border-color .1s,transform .05s}
.card:hover{border-color:var(--vscode-focusBorder)}
.card.dragging{opacity:.4}
.card .ct{font-weight:600;font-size:13px;line-height:1.3}
.card .cm{display:flex;gap:6px;align-items:center;margin-top:6px;font-size:11px;opacity:.75;flex-wrap:wrap}
.badge{border-radius:4px;padding:1px 6px;font-size:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.prio{border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700;background:#444;color:#ddd}
.prio.p0{background:#d16969;color:#fff}.prio.p1{background:#d7ba7d;color:#222}.prio.p2{background:#569cd6;color:#fff}
.due{font-size:10px;opacity:.9}.due.late{color:#d16969;font-weight:700}
.calbar{display:flex;gap:10px;align-items:center;padding:8px 4px;font-size:12px}
.calbar input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:2px 4px}
.calday h3{margin:14px 0 4px;font-size:12px;text-transform:none;opacity:.85;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:3px}
.calrow{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px}
.calrow:hover{background:var(--vscode-list-hoverBackground)}
.calrow.done{opacity:.5;text-decoration:line-through}
.calrow.late .ct{color:#d16969}
.calrow .cm{opacity:.6;font-size:11px;margin-left:auto}
.calrow .dot{width:8px;height:8px;border-radius:50%;flex:none}
.calempty{opacity:.6;padding:16px;font-size:12px}
.calbar .title{font-weight:700;font-size:14px;min-width:150px}
.mgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.mgrid .dow{opacity:.6;font-size:10px;text-transform:uppercase;text-align:center;padding:2px}
.mcell{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;min-height:88px;padding:5px;cursor:pointer;overflow:hidden}
.mcell:hover{border-color:var(--vscode-focusBorder)}
.mcell.dim{opacity:.35}
.mcell.today{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder) inset}
.mcell .d{font-size:11px;opacity:.7;display:flex;justify-content:space-between}
.mcell .mi{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;padding:1px 3px;border-radius:3px;background:var(--vscode-editorWidget-background)}
.mcell .mi.late{color:#d16969}
.mcell.over{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
.wgrid{display:grid;gap:6px}
.wcol{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:6px;min-height:180px;min-width:0}
.wcol.today{border-color:var(--vscode-focusBorder)}
.wcol.over{background:var(--vscode-list-hoverBackground)}
.wcol h4{margin:0 0 5px;font-size:11px;opacity:.75;cursor:pointer;display:flex;justify-content:space-between}
.wcol h4:hover{opacity:1}
.witem{font-size:11px;padding:3px 5px;border-radius:5px;margin-top:3px;background:var(--vscode-editorWidget-background);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;border-left:3px solid var(--vscode-charts-yellow)}
.witem.late{border-left-color:#d16969}
.card.blocked{border-left:3px solid #e51400}
/* graph */
#graph{width:100%;height:100%;cursor:grab}
#gfilters{position:absolute;top:8px;left:10px;right:10px;z-index:4;display:flex;flex-direction:column;gap:5px;pointer-events:none}
#gfilters.hidden{display:none}
.gf-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.gf-lab{font-size:10px;opacity:.55;text-transform:uppercase;width:44px;flex:0 0 44px}
.gf-btn{pointer-events:auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:11px;border:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);cursor:pointer;opacity:.95}
.gf-btn.off{opacity:.38;text-decoration:line-through}
.gf-dot{width:8px;height:8px;border-radius:50%}
.gf-fit{margin-left:auto;opacity:.8}
#graph text{fill:var(--vscode-foreground);font-size:10px;pointer-events:none}
#graph line{stroke:var(--vscode-widget-border);stroke-opacity:.6}
#graph line.blocked{stroke:#e51400;stroke-opacity:.9}
#graph circle{cursor:pointer;stroke:var(--vscode-editor-background);stroke-width:1.5}
.glegend{position:absolute;top:10px;left:14px;font-size:11px;opacity:.7}
/* canvas */
#canvas{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;opacity:.7;text-align:center;padding:40px}
/* drawer */
#backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35);z-index:5}
#drawer{position:absolute;top:0;right:0;bottom:0;width:440px;max-width:90vw;background:var(--vscode-sideBar-background,var(--vscode-editorWidget-background));border-left:1px solid var(--vscode-widget-border);z-index:6;overflow-y:auto;box-shadow:-8px 0 24px rgba(0,0,0,.25)}
#drawerInner{padding:16px 18px}
.dh{display:flex;align-items:flex-start;gap:8px}
.dh h2{font-size:16px;margin:0;flex:1;line-height:1.3}
.dclose{background:transparent;border:0;color:var(--vscode-foreground);cursor:pointer;font-size:18px;opacity:.7}
.drow{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.sec{margin-top:16px}
.sec h4{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6;margin:0 0 6px}
.body{background:var(--vscode-textCodeBlock-background,var(--vscode-editor-background));border:1px solid var(--vscode-widget-border);border-radius:6px;padding:10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;max-height:280px;overflow:auto}
.body h1,.body h2,.body h3{font-size:13px;margin:8px 0 4px}
.body code{background:var(--vscode-textPreformat-background);padding:1px 4px;border-radius:3px}
.reflist{display:flex;flex-direction:column;gap:5px}
.refitem{display:flex;align-items:center;gap:7px;font-size:12px;padding:5px 8px;border:1px solid var(--vscode-widget-border);border-radius:6px;cursor:pointer}
.refitem:hover{background:var(--vscode-toolbar-hoverBackground)}
.refitem.bad{border-color:#e51400}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.act{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:6px;padding:8px;cursor:pointer;font-size:12px;text-align:left}
.act:hover{background:var(--vscode-button-hoverBackground)}
.act.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.act .k{font-weight:600}.act .d{opacity:.7;font-size:10.5px;display:block}
.statusrow{display:flex;gap:6px;align-items:center;margin-top:6px}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:5px;padding:3px 6px;font-size:12px}
.card{position:relative}
.cact{position:absolute;top:4px;right:5px;display:none;gap:2px;z-index:2}
.card:hover .cact{display:flex}
.cact button{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:4px;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:11px;line-height:1;padding:2px 4px}
.cact button:hover{color:var(--vscode-foreground)}
.col.over{outline:2px dashed var(--vscode-focusBorder);outline-offset:-2px}
.titleEdit{flex:1;font-size:16px;font-weight:600;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--vscode-foreground);padding:3px 5px}
.titleEdit:hover,.titleEdit:focus{border-color:var(--vscode-input-border);background:var(--vscode-input-background);outline:none}
.bodyhead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bodyEdit{width:100%;min-height:120px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:6px;font-family:var(--vscode-editor-font-family);font-size:12px;margin-top:4px}
.fldEdit{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:2px 6px;width:120px}
.ghost.mini{padding:2px 8px;font-size:11px}
`;

// ---------------------------------------------------------------- script -----
const SCRIPT = `
const vscode = acquireVsCodeApi();
const LANES = {
  task: ['inbox','today','in_progress','done','deferred','outdated'],
  idea: ['capture','refine','accepted','parked','done'],
  plan: ['plan','prototype','implement','validate','done','parked'],
};
const TYPE_COLOR = {idea:'#d7ba7d',plan:'#4ec9b0',task:'#569cd6',project:'#c586c0',catalog_entry:'#c586c0',domain:'#808080',daily_plan:'#dcdcaa',insight:'#4fc1ff',reflection:'#9cdcfe',knowledge:'#ce9178',session:'#608b4e'};
const LANE_COLOR = {inbox:'#888',today:'#569cd6',in_progress:'#dcdcaa',done:'#4ec9b0',deferred:'#a08',outdated:'#d16969',capture:'#d7ba7d',refine:'#dcdcaa',accepted:'#4ec9b0',parked:'#888',plan:'#569cd6',prototype:'#c586c0',implement:'#dcdcaa',validate:'#4fc1ff'};
let S = null, view='board', laneSet='task';
const _st=(vscode.getState&&vscode.getState())||{};
let groupBy = _st.groupBy || 'status';
let customLanes = _st.customLanes || [];
function saveState(){ try{ vscode.setState({groupBy, customLanes}); }catch(e){} }
const BOARD_TYPES=['task','idea','plan'];
const $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='snapshot'){S=m.data;render();}
  else if(m.type==='detail'){renderDrawer(m.data);}
  else if(m.type==='setView'){view=m.view;syncSeg();render();}
  else if(m.type==='laneAdded'){ if(groupBy!=='lane'){groupBy='lane';const gb=$('#groupBy');if(gb)gb.value='lane';} if(m.name&&!customLanes.includes(m.name))customLanes.push(m.name); saveState(); renderBoard(); }
  else if(m.type==='openItem'){ view='board'; syncSeg(); render(); if(m.id)openDetail(m.id); }
});

// top bar
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;view=b.dataset.view;syncSeg();render();});
$('#laneSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;laneSet=b.dataset.lane;syncSeg();renderBoard();});
$('#calModeSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;calMode=b.dataset.cm;syncSeg();renderCalendar();});
$('#refreshBtn').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
$('#captureBtn').addEventListener('click',()=>vscode.postMessage({type:'action',action:'capture'}));
let searchTerm='';
function applySearch(){const q=searchTerm.toLowerCase();
  document.querySelectorAll('#board .card').forEach(c=>{c.style.display=(!q||c.textContent.toLowerCase().includes(q))?'':'none';});}
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key==='f'){e.preventDefault();const s=$('#search');s.style.display='inline-block';s.focus();s.select();}
  if(e.key==='Escape'){const s=$('#search');if(document.activeElement===s){searchTerm='';s.value='';s.style.display='none';applySearch();}}
});
$('#search').addEventListener('input',e=>{searchTerm=e.target.value;applySearch();});
(function(){const gb=$('#groupBy'); if(gb){gb.value=groupBy; gb.addEventListener('change',()=>{groupBy=gb.value;saveState();renderBoard();});}
  const al=$('#addLaneBtn'); if(al)al.addEventListener('click',()=>vscode.postMessage({type:'action',action:'addLane'}));})();
$('#backdrop').addEventListener('click',closeDrawer);
function syncSeg(){
  document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  document.querySelectorAll('#laneSeg button').forEach(b=>b.classList.toggle('on',b.dataset.lane===laneSet));
  document.querySelectorAll('#calModeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.cm===calMode));
  $('#laneSeg').style.display = view==='board'?'inline-flex':'none';
  $('#calModeSeg').style.display = view==='calendar'?'inline-flex':'none';
  $('#board').classList.toggle('hidden',view!=='board');
  $('#calendar').classList.toggle('hidden',view!=='calendar');
  $('#graph').classList.toggle('hidden',view!=='graph');
  $('#gfilters').classList.toggle('hidden',view!=='graph');
  $('#canvas').classList.toggle('hidden',view!=='canvas');
}
function render(){ if(!S){return;} syncSeg();
  $('#counts').textContent = Object.entries(S.counts||{}).map(([k,v])=>k+':'+v).join('  ');
  if(view==='board')renderBoard(); else if(view==='calendar')renderCalendar(); else if(view==='graph')requestAnimationFrame(renderGraph); else renderCanvas();
  applySearch();
}
const blockedSet=()=>new Set((S.blocked||[]).map(b=>b.id));

function laneFieldAndList(objs){
  if(groupBy==='status') return {field:'status', lanes:(LANES[laneSet]||[...new Set(objs.map(o=>o.status||'inbox'))])};
  if(groupBy==='type') return {field:'type', lanes:BOARD_TYPES.slice()};
  const vals=new Set(objs.map(o=>o[groupBy]||'(none)')); customLanes.forEach(l=>vals.add(l)); const lanes=[...vals]; if(!lanes.includes('(none)'))lanes.push('(none)');
  return {field:groupBy, lanes};
}
function renderBoard(){
  const bl=blockedSet();
  const objs = groupBy==='type' ? (S.objects||[]).filter(o=>BOARD_TYPES.indexOf(o.type)>=0) : (S.objects||[]).filter(o=>o.type===laneSet);
  const {field, lanes} = laneFieldAndList(objs);
  const board=$('#board'); board.innerHTML='';
  lanes.forEach(lane=>{
    const rows=objs.filter(o=>String(o[field]||'(none)')===String(lane));
    const col=el('div','col'); col.dataset.lane=lane;
    col.appendChild(el('h3',null,'<span class="dot" style="background:'+(LANE_COLOR[lane]||TYPE_COLOR[lane]||'#888')+'"></span>'+esc(lane)+'<span class="cnt">'+rows.length+'</span>'));
    const cards=el('div','cards');
    rows.forEach(o=>{
      const card=el('div','card'+(bl.has(o.id)?' blocked':'')); card.draggable=true; card.dataset.id=o.id;
      card.innerHTML='<div class="cact"><button data-act="edit" title="Edit">✎</button><button data-act="recat" title="Recategorize / move">⇄</button><button data-act="del" title="Delete">✕</button></div>'+
        '<div class="ct">'+esc(o.title||o.id)+'</div><div class="cm"><span class="badge">'+o.type+'</span>'+(o.priority?'<span class="prio '+esc(o.priority)+'">'+esc(o.priority)+'</span>':'')+(o.due?'<span class="due'+(o.due<todayStr()&&o.status!=='done'&&o.status!=='outdated'?' late':'')+'">⏰ '+esc(o.due)+'</span>':'')+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.lane?'<span>⋔ '+esc(o.lane)+'</span>':'')+(o.project?'<span>· '+esc(o.project.split('/').pop())+'</span>':'')+'</div>';
      card.addEventListener('click',ev=>{ if(ev.target.closest('[data-act]'))return; openDetail(o.id); });
      card.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();const a=b.dataset.act;vscode.postMessage({type:'action',action:a==='edit'?'editItem':a==='recat'?'recategorize':'deleteItem',id:o.id});}));
      card.addEventListener('dragstart',ev=>{ev.dataTransfer.setData('text/plain',o.id);card.classList.add('dragging');});
      card.addEventListener('dragend',()=>card.classList.remove('dragging'));
      cards.appendChild(card);
    });
    col.appendChild(cards);
    col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',ev=>{ev.preventDefault();col.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(!id)return;
      if(field==='status')vscode.postMessage({type:'setStatus',id:id,status:lane});
      else if(field==='type')vscode.postMessage({type:'action',action:'setType',id:id,toType:lane});
      else vscode.postMessage({type:'action',action:'setField',id:id,field:field,value:lane==='(none)'?'':lane});});
    board.appendChild(col);
  });
}

function todayStr(){return (S&&S.board&&S.board.date)||new Date().toISOString().slice(0,10);}
let calFrom=null, calTo=null, calMode='month', calAnchor=null;
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const weekStart=d=>{const x=new Date(d+'T00:00:00Z');return addDays(d,-((x.getUTCDay()+6)%7));}; // Monday
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
      cell.addEventListener('click',ev=>{ if(ev.target.closest('.mi'))return; vscode.postMessage({type:'action',action:'createOnDay',due:d}); });
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
      col.addEventListener('click',ev=>{ if(ev.target.closest('.witem')||ev.target.closest('h4'))return; vscode.postMessage({type:'action',action:'createOnDay',due:d}); });
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
function openDetail(id){ vscode.postMessage({type:'show',id:id}); $('#drawer').classList.remove('hidden'); $('#backdrop').classList.remove('hidden'); $('#drawerInner').innerHTML='<div style="opacity:.6">Loading '+esc(id)+'…</div>'; }
function closeDrawer(){ $('#drawer').classList.add('hidden'); $('#backdrop').classList.add('hidden'); }
function mdLite(s){ return esc(s).replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h2>$1</h2>').replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\`([^\`]+)\`/g,'<code>$1</code>'); }
function refRow(r,bad,onclick){ const d=el('div','refitem'+(bad?' bad':'')); d.innerHTML=esc(r.title||r.id||r.path); if(r.status)d.innerHTML+=' <span class="badge">'+esc(r.status)+'</span>'; if(onclick)d.addEventListener('click',onclick); return d; }
function renderDrawer(o){
  const I=$('#drawerInner'); I.innerHTML='';
  const head=el('div','dh'); const ti=el('input','titleEdit'); ti.value=o.title||''; ti.title='Edit name — Enter or click away to save'; ti.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:'title',value:ti.value})); head.appendChild(ti); const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const meta=el('div','drow'); meta.innerHTML='<span class="badge">'+o.type+'</span>'+(o.status?'<span class="badge">'+esc(o.status)+'</span>':'')+(o.domain?'<span class="badge">'+esc(o.domain)+'</span>':''); I.appendChild(meta);
  // status changer
  const lanes=LANES[o.type]; if(lanes){ const sr=el('div','statusrow'); const sel=el('select'); lanes.forEach(l=>{const op=el('option',null,l);op.value=l;if(l===o.status)op.selected=true;sel.appendChild(op);}); sel.addEventListener('change',()=>vscode.postMessage({type:'setStatus',id:o.id,status:sel.value})); sr.appendChild(el('span',null,'Status:')); sr.appendChild(sel); I.appendChild(sr); }
  { const fr=el('div','statusrow'); const mkf=(field,val)=>{ const inp=el('input','fldEdit'); inp.value=val||''; inp.placeholder=field; inp.title='Edit '+field; inp.addEventListener('change',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:field,value:inp.value})); return inp; }; fr.appendChild(el('span',null,'Domain:')); fr.appendChild(mkf('domain',o.domain)); fr.appendChild(el('span',null,'Lane:')); fr.appendChild(mkf('lane',o.lane)); I.appendChild(fr); }
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
  grid3.appendChild(mk('Recategorize','type / domain / lane','recategorize'));
  if(o.type==='idea'){ grid3.appendChild(mk('Promote → plan','create a plan','promote')); grid3.appendChild(mk('Move → task','convert to task','moveToTask')); }
  grid3.appendChild(mk('Delete','remove item','deleteItem'));
  act.appendChild(grid3); I.appendChild(act);
  // body
  { const s=el('div','sec'); const h=el('div','bodyhead'); h.appendChild(el('h4',null,'Notes / details')); const sb=el('button','ghost mini','Save'); h.appendChild(sb); s.appendChild(h); const ta=el('textarea','bodyEdit'); ta.value=o.body||''; ta.placeholder='Markdown details…'; s.appendChild(ta); sb.addEventListener('click',()=>vscode.postMessage({type:'action',action:'updateField',id:o.id,field:'body',value:ta.value})); I.appendChild(s); }
  // references
  const refs=[['Blocked by knowledge',o.blocked_by,true],['Cites',o.cites,false],['Children',o.children,false],['Depends on',o.depends_on,false],['Related',o.related,false]];
  refs.forEach(([label,list,isBlock])=>{ if(!list||!list.length)return; const s=el('div','sec'); s.appendChild(el('h4',null,label+' ('+list.length+')')); const rl=el('div','reflist'); list.forEach(r=>{ const bad=isBlock?(r.status!=='resolved'):(r.exists===false||r.missing); const open = r.id&&!r.missing? ()=>openDetail(r.id) : (r.path? ()=>vscode.postMessage({type:'open',kbPath:r.path}) : null); rl.appendChild(refRow(r,bad,open)); }); s.appendChild(rl); I.appendChild(s); });
  if(o.parent){ const s=el('div','sec'); s.appendChild(el('h4',null,'Parent')); const rl=el('div','reflist'); rl.appendChild(refRow(o.parent,false,()=>openDetail(o.parent.id))); s.appendChild(rl); I.appendChild(s); }
  if(o.linked_sessions&&o.linked_sessions.length){ const s=el('div','sec'); s.appendChild(el('h4',null,'Linked sessions ('+o.linked_sessions.length+')')); const rl=el('div','reflist'); o.linked_sessions.forEach(u=>rl.appendChild(refRow({id:u,title:'▸ open chat — '+u.slice(0,18)+'…'},false,()=>vscode.postMessage({type:'action',action:'openSession',uuid:u})))); s.appendChild(rl); I.appendChild(s); }
}
vscode.postMessage({type:'ready'});
`;
