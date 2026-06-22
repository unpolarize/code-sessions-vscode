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

  static show(deps: DashboardDeps, view?: string): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      if (view) DashboardPanel.current.panel.webview.postMessage({ type: "setView", view });
      return;
    }
    DashboardPanel.current = new DashboardPanel(deps, view);
  }

  private constructor(private deps: DashboardDeps, private initialView?: string) {
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
      default:
        this.deps.onAction(m); // open / action (agent, CB, promote, link, capture)
    }
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
    <button data-view="graph">Graph</button>
    <button data-view="canvas">Canvas</button>
  </div>
  <div class="seg" id="laneSeg">
    <button data-lane="task" class="on">Tasks</button>
    <button data-lane="idea">Ideas</button>
    <button data-lane="plan">Plans</button>
  </div>
  <span class="spacer"></span>
  <span id="counts" class="counts"></span>
  <button id="captureBtn" class="ghost">＋ Capture</button>
  <button id="refreshBtn" class="ghost">⟳</button>
</div>
<div id="main">
  <div id="board" class="view"></div>
  <svg id="graph" class="view hidden"></svg>
  <div id="canvas" class="view hidden"></div>
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
.card.blocked{border-left:3px solid #e51400}
/* graph */
#graph{width:100%;height:100%;cursor:grab}
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
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:5px;padding:3px 6px}
`;

// ---------------------------------------------------------------- script -----
const SCRIPT = `
const vscode = acquireVsCodeApi();
const LANES = {
  task: ['inbox','today','in_progress','done','deferred'],
  idea: ['capture','refine','accepted','parked','done'],
  plan: ['plan','prototype','implement','validate','done','parked'],
};
const TYPE_COLOR = {idea:'#d7ba7d',plan:'#4ec9b0',task:'#569cd6',project:'#c586c0',catalog_entry:'#c586c0',domain:'#808080',daily_plan:'#dcdcaa',insight:'#4fc1ff',reflection:'#9cdcfe',knowledge:'#ce9178',session:'#608b4e'};
const LANE_COLOR = {inbox:'#888',today:'#569cd6',in_progress:'#dcdcaa',done:'#4ec9b0',deferred:'#a08',capture:'#d7ba7d',refine:'#dcdcaa',accepted:'#4ec9b0',parked:'#888',plan:'#569cd6',prototype:'#c586c0',implement:'#dcdcaa',validate:'#4fc1ff'};
let S = null, view='board', laneSet='task';
const $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='snapshot'){S=m.data;render();}
  else if(m.type==='detail'){renderDrawer(m.data);}
  else if(m.type==='setView'){view=m.view;syncSeg();render();}
});

// top bar
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;view=b.dataset.view;syncSeg();render();});
$('#laneSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;laneSet=b.dataset.lane;syncSeg();renderBoard();});
$('#refreshBtn').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
$('#captureBtn').addEventListener('click',()=>vscode.postMessage({type:'action',action:'capture'}));
$('#backdrop').addEventListener('click',closeDrawer);
function syncSeg(){
  document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  document.querySelectorAll('#laneSeg button').forEach(b=>b.classList.toggle('on',b.dataset.lane===laneSet));
  $('#laneSeg').style.display = view==='board'?'inline-flex':'none';
  $('#board').classList.toggle('hidden',view!=='board');
  $('#graph').classList.toggle('hidden',view!=='graph');
  $('#canvas').classList.toggle('hidden',view!=='canvas');
}
function render(){ if(!S){return;} syncSeg();
  $('#counts').textContent = Object.entries(S.counts||{}).map(([k,v])=>k+':'+v).join('  ');
  if(view==='board')renderBoard(); else if(view==='graph')requestAnimationFrame(renderGraph); else renderCanvas();
}
const blockedSet=()=>new Set((S.blocked||[]).map(b=>b.id));

function renderBoard(){
  const lanes=LANES[laneSet], bl=blockedSet();
  const objs=(S.objects||[]).filter(o=>o.type===laneSet);
  const board=$('#board'); board.innerHTML='';
  lanes.forEach(lane=>{
    const rows=objs.filter(o=>(o.status||'')===lane);
    const col=el('div','col'); col.dataset.lane=lane;
    col.appendChild(el('h3',null,'<span class="dot" style="background:'+(LANE_COLOR[lane]||'#888')+'"></span>'+lane+'<span class="cnt">'+rows.length+'</span>'));
    const cards=el('div','cards');
    rows.forEach(o=>{
      const card=el('div','card'+(bl.has(o.id)?' blocked':'')); card.draggable=true; card.dataset.id=o.id;
      card.innerHTML='<div class="ct">'+esc(o.title||o.id)+'</div><div class="cm"><span class="badge">'+o.type+'</span>'+(o.domain?'<span>'+esc(o.domain)+'</span>':'')+(o.project?'<span>· '+esc(o.project.split('/').pop())+'</span>':'')+'</div>';
      card.addEventListener('click',()=>openDetail(o.id));
      card.addEventListener('dragstart',ev=>{ev.dataTransfer.setData('text/plain',o.id);card.classList.add('dragging');});
      card.addEventListener('dragend',()=>card.classList.remove('dragging'));
      cards.appendChild(card);
    });
    col.appendChild(cards);
    col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',ev=>{ev.preventDefault();col.classList.remove('over');const id=ev.dataTransfer.getData('text/plain');if(id)vscode.postMessage({type:'setStatus',id:id,status:lane});});
    board.appendChild(col);
  });
}

// force-directed graph
let gT={x:0,y:0,k:1};
function renderGraph(){
  const svg=$('#graph'); const r=svg.getBoundingClientRect();
  const W=(r.width||window.innerWidth||900), H=(r.height||(window.innerHeight-60)||600);
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  const allNodes=(S&&S.graph&&S.graph.nodes)||[];
  if(!allNodes.length){ svg.innerHTML='<text x="20" y="40" fill="currentColor" opacity="0.6">No graph data — capture ideas or add cites/blocked_by edges.</text>'; return; }
  const nodes=allNodes.map((n,i)=>({...n,x:W/2+Math.cos(i)*200+(i%7)*9,y:H/2+Math.sin(i*1.3)*180,vx:0,vy:0}));
  const idx={}; nodes.forEach(n=>idx[n.id]=n);
  const edges=(S.graph?.edges||[]).filter(e=>idx[e.from]&&idx[e.to]);
  for(let it=0;it<260;it++){
    for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
      const p=nodes[a],q=nodes[b];let dx=p.x-q.x,dy=p.y-q.y;let d2=dx*dx+dy*dy+0.01;let f=2600/d2;p.vx+=dx*f;p.vy+=dy*f;q.vx-=dx*f;q.vy-=dy*f;}
    edges.forEach(e=>{const p=idx[e.from],q=idx[e.to];let dx=q.x-p.x,dy=q.y-p.y;let d=Math.sqrt(dx*dx+dy*dy)||1;let f=(d-90)*0.02;p.vx+=dx/d*f;p.vy+=dy/d*f;q.vx-=dx/d*f;q.vy-=dy/d*f;});
    nodes.forEach(n=>{n.vx+=(W/2-n.x)*0.002;n.vy+=(H/2-n.y)*0.002;n.x+=Math.max(-12,Math.min(12,n.vx));n.y+=Math.max(-12,Math.min(12,n.vy));n.vx*=0.85;n.vy*=0.85;});
  }
  const ns='http://www.w3.org/2000/svg';
  svg.innerHTML='';
  const g=document.createElementNS(ns,'g'); g.setAttribute('id','gz'); svg.appendChild(g);
  edges.forEach(e=>{const p=idx[e.from],q=idx[e.to];const l=document.createElementNS(ns,'line');l.setAttribute('x1',p.x);l.setAttribute('y1',p.y);l.setAttribute('x2',q.x);l.setAttribute('y2',q.y);if(e.kind==='blocked_by'&&e.status!=='resolved')l.setAttribute('class','blocked');g.appendChild(l);});
  nodes.forEach(nd=>{const grp=document.createElementNS(ns,'g');
    const c=document.createElementNS(ns,'circle');c.setAttribute('cx',nd.x);c.setAttribute('cy',nd.y);c.setAttribute('r',nd.blocked?9:6.5);c.setAttribute('fill',nd.blocked?'#e51400':(TYPE_COLOR[nd.type]||'#888'));
    c.addEventListener('click',()=>{ if(S.objects?.some(o=>o.id===nd.id)) openDetail(nd.id); else vscode.postMessage({type:'open',id:nd.id,nodeType:nd.type}); });
    const t=document.createElementNS(ns,'text');t.setAttribute('x',nd.x+9);t.setAttribute('y',nd.y+3);t.textContent=(nd.label||nd.id).slice(0,26);
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
  const head=el('div','dh'); head.innerHTML='<h2>'+esc(o.title)+'</h2>'; const x=el('button','dclose','✕'); x.addEventListener('click',closeDrawer); head.appendChild(x); I.appendChild(head);
  const meta=el('div','drow'); meta.innerHTML='<span class="badge">'+o.type+'</span>'+(o.status?'<span class="badge">'+esc(o.status)+'</span>':'')+(o.domain?'<span class="badge">'+esc(o.domain)+'</span>':''); I.appendChild(meta);
  // status changer
  const lanes=LANES[o.type]; if(lanes){ const sr=el('div','statusrow'); const sel=el('select'); lanes.forEach(l=>{const op=el('option',null,l);op.value=l;if(l===o.status)op.selected=true;sel.appendChild(op);}); sel.addEventListener('change',()=>vscode.postMessage({type:'setStatus',id:o.id,status:sel.value})); sr.appendChild(el('span',null,'Status:')); sr.appendChild(sel); I.appendChild(sr); }
  // agent actions
  const act=el('div','sec'); act.appendChild(el('h4',null,'Agent actions'));
  const grid=el('div','actions');
  const mk=(k,d,action,primary)=>{const b=el('button','act'+(primary?' primary':''),'<span class="k">'+k+'</span><span class="d">'+d+'</span>');b.addEventListener('click',()=>vscode.postMessage({type:'action',action:action,id:o.id}));return b;};
  grid.appendChild(mk('Ideate','expand into sub-ideas','ideate'));
  grid.appendChild(mk('Draft spec','speckit FRs + criteria','spec'));
  grid.appendChild(mk('Decompose','break into tasks','decompose'));
  grid.appendChild(mk('Execute ▸','start a Code Build session','execute',true));
  act.appendChild(grid);
  const grid2=el('div','actions'); grid2.style.marginTop='7px';
  grid2.appendChild(mk('Open in Code Build','whole-item context','openCB'));
  grid2.appendChild(mk('Open file','edit markdown','openFile'));
  if(o.type==='idea'){ grid2.appendChild(mk('Promote → plan','create a plan','promote')); }
  grid2.appendChild(mk('Link session','attach a uuid','link'));
  act.appendChild(grid2); I.appendChild(act);
  // body
  if(o.body&&o.body.trim()){ const s=el('div','sec'); s.appendChild(el('h4',null,'Notes')); s.appendChild(el('div','body',mdLite(o.body))); I.appendChild(s); }
  // references
  const refs=[['Blocked by knowledge',o.blocked_by,true],['Cites',o.cites,false],['Children',o.children,false],['Depends on',o.depends_on,false],['Related',o.related,false]];
  refs.forEach(([label,list,isBlock])=>{ if(!list||!list.length)return; const s=el('div','sec'); s.appendChild(el('h4',null,label+' ('+list.length+')')); const rl=el('div','reflist'); list.forEach(r=>{ const bad=isBlock?(r.status!=='resolved'):(r.exists===false||r.missing); const open = r.id&&!r.missing? ()=>openDetail(r.id) : (r.path? ()=>vscode.postMessage({type:'open',kbPath:r.path}) : null); rl.appendChild(refRow(r,bad,open)); }); s.appendChild(rl); I.appendChild(s); });
  if(o.parent){ const s=el('div','sec'); s.appendChild(el('h4',null,'Parent')); const rl=el('div','reflist'); rl.appendChild(refRow(o.parent,false,()=>openDetail(o.parent.id))); s.appendChild(rl); I.appendChild(s); }
  if(o.linked_sessions&&o.linked_sessions.length){ const s=el('div','sec'); s.appendChild(el('h4',null,'Linked sessions ('+o.linked_sessions.length+')')); const rl=el('div','reflist'); o.linked_sessions.forEach(u=>rl.appendChild(refRow({id:u,title:u.slice(0,18)+'…'},false,null))); s.appendChild(rl); I.appendChild(s); }
}
vscode.postMessage({type:'ready'});
`;
