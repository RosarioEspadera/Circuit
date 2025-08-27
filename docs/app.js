// app.js — LTSpice-like editor: place, wire, move, rotate, copy, delete, diode, netlist, probe
"use strict";

/* ---- Elements & state ---- */
const svg = document.getElementById("canvas");
const listEl = document.getElementById("list");
const selectedEl = document.getElementById("selected");
const resultsEl = document.getElementById("results");
const backendUrlInput = document.getElementById("backendUrl");
const orthoCheckbox = document.getElementById("opt-ortho");

let comps = [];   // components placed {type,name,x1,y1,x2,y2,n1,n2,value,rot}
let wires = [];   // wires placed {id,p1:{comp,port},p2:{comp,port},x1,y1,x2,y2,ortho}
let autoNodes = []; // extra nodes created by clicking empty space
let mode = null;  // current tool: 'R','V','I','C','L','D','GND','W','MOVE'
let placing = null, activePort=null, selected=null, dragState=null;
let lastSimResult = null;
let idCounter = 1;

function getOrCreateNodeAt(x, y) {
  const gx = snap(x), gy = snap(y);
  let existing = autoNodes.find(n => n.x === gx && n.y === gy);
  if (existing) return existing.id;
  const newId = "N" + (autoNodes.length + 1);
  autoNodes.push({ id: newId, x: gx, y: gy });
  return newId;
}

/* ---- Utilities ---- */
const GRID = 20;
function snap(v){ return Math.round(v/GRID)*GRID; }
function nextName(prefix){
  let i=1; while(comps.find(c=>c.name===`${prefix}${i}`)) i++; return `${prefix}${i}`;
}
function clearSVG(){ while(svg.firstChild) svg.removeChild(svg.firstChild); }

/* ---- Draw grid (subtle dots) ---- */
function drawGrid(){
  const w = svg.clientWidth, h = svg.clientHeight;
  for(let x=0;x<w;x+=GRID){
    for(let y=0;y<h;y+=GRID){
      if((x/GRID)%5===0 && (y/GRID)%5===0) continue;
      const dot = document.createElementNS("http://www.w3.org/2000/svg","rect");
      dot.setAttribute("x", x-0.5); dot.setAttribute("y", y-0.5); dot.setAttribute("width",1); dot.setAttribute("height",1);
      dot.setAttribute("class","grid-dot");
      svg.appendChild(dot);
    }
  }
}

/* ---- Rendering ---- */
function redraw(){
  clearSVG();
  drawGrid();
  // wires below components
  wires.forEach(w => {
    if(w.ortho){
      // draw L-shape (simple: horizontal then vertical)
      const mx = w.x1, my = w.y2;
      const path = document.createElementNS("http://www.w3.org/2000/svg","polyline");
      path.setAttribute("points", `${w.x1},${w.y1} ${w.x1},${w.y2} ${w.x2},${w.y2}`);
      path.setAttribute("class","wire");
      path.addEventListener("click", (e)=>{ e.stopPropagation(); probeWire(w); });
      svg.appendChild(path);
    } else {
      const line = document.createElementNS("http://www.w3.org/2000/svg","line");
      line.setAttribute("x1",w.x1); line.setAttribute("y1",w.y1); line.setAttribute("x2",w.x2); line.setAttribute("y2",w.y2);
      line.setAttribute("class","wire");
      line.addEventListener("click", (e)=>{ e.stopPropagation(); probeWire(w); });
      svg.appendChild(line);
    }
  });
  // draw auto-nodes as small dots
autoNodes.forEach(n => {
  const circ = document.createElementNS("http://www.w3.org/2000/svg","circle");
  circ.setAttribute("cx", n.x);
  circ.setAttribute("cy", n.y);
  circ.setAttribute("r", 3);
  circ.setAttribute("class", "auto-node");
  circ.addEventListener("click", ev => {
    ev.stopPropagation();
    if(mode === 'W') handleWireNodeClick(n, n.x, n.y);
    else if(lastSimResult) alert(`${n.id} = ${lastSimResult.node_voltages[n.id] ?? 0} V`);
  });
  svg.appendChild(circ);
});
  // components
  comps.forEach(c => drawComponent(c));
  refreshList();
}

/* ---- Component drawing (respect rotation) ---- */
function drawComponent(c){
  const g = document.createElementNS("http://www.w3.org/2000/svg","g");
  g.setAttribute("data-name", c.name);
  // set transform for rotation about center
  const cx = (c.x1 + c.x2)/2, cy = (c.y1 + c.y2)/2;
  if(c.rot){
    g.setAttribute("transform", `rotate(${c.rot} ${cx} ${cy})`);
  }
  // draw symbol depending on type
  if(c.type==='R' || c.type==='L') drawResistor(g,c.x1,c.y1,c.x2,c.y2,c.type);
  else if(c.type==='V' || c.type==='I') drawSource(g,c.x1,c.y1,c.x2,c.y2,c.type);
  else if(c.type==='C') drawCapacitor(g,c.x1,c.y1,c.x2,c.y2);
  else if(c.type==='D') drawDiode(g,c.x1,c.y1,c.x2,c.y2);
  // label
  const label = document.createElementNS("http://www.w3.org/2000/svg","text");
  label.setAttribute("x", (c.x1+c.x2)/2);
  label.setAttribute("y", (c.y1+c.y2)/2 - 14);
  label.setAttribute("text-anchor","middle");
  label.setAttribute("class","tag");
  label.textContent = `${c.name} ${c.value !== undefined ? c.value : ''}`;
  g.appendChild(label);

  // selection highlight
  if(selected && selected.type==='comp' && selected.ref===c.name){
    const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
    const pad = 18;
    rect.setAttribute("x", Math.min(c.x1,c.x2)-pad);
    rect.setAttribute("y", Math.min(c.y1,c.y2)-pad);
    rect.setAttribute("width", Math.abs(c.x2-c.x1)+pad*2);
    rect.setAttribute("height", Math.abs(c.y2-c.y1)+pad*2);
    rect.setAttribute("class","selected-comp");
    rect.setAttribute("fill","none");
    svg.appendChild(rect);
  }

  svg.appendChild(g);

  // ports: place untransformed circles (so clickable ignoring rotation transform)
  drawPort(c,'n1',c.x1,c.y1);
  drawPort(c,'n2',c.x2,c.y2);

  // attach event for dragging when Move mode (we handle pointer events on port or group)
  g.addEventListener("pointerdown", (ev)=>{
    if(mode==='MOVE' || mode===null){
      startDragComponent(ev, c);
    } else if(mode==='ROTATE'){
      rotateComponent(c);
    } else if(mode==='DEL'){
      deleteComponent(c);
    } else if(mode==='COPY'){
      copyComponent(c);
    }
  });
}

/* ---- Primitive symbols ---- */
function drawResistor(g,x1,y1,x2,y2,type){
  // zigzag line between x1,y1 and x2,y2
  const path = document.createElementNS("http://www.w3.org/2000/svg","path");
  const dx = x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  if(len<1){ return; }
  const ux = dx/len, uy = dy/len;
  const ax = x1 + ux*20, ay = y1 + uy*20;
  const bx = x2 - ux*20, by = y2 - uy*20;
  const mx = (ax+bx)/2, my=(ay+by)/2;
  const zig = 6;
  let d = `M ${x1} ${y1} L ${ax} ${ay}`;
  d += ` L ${mx-uy*zig} ${my+ux*zig}`;
  d += ` L ${mx+uy*zig} ${my-ux*zig}`;
  d += ` L ${bx} ${by} L ${x2} ${y2}`;
  path.setAttribute("d", d);
  path.setAttribute("class","comp-shape");
  g.appendChild(path);
}
function drawSource(g,x1,y1,x2,y2,type){
  // simple plate + line style: V or I (I displayed like a circle with arrow)
  const line = document.createElementNS("http://www.w3.org/2000/svg","line");
  line.setAttribute("x1",x1); line.setAttribute("y1",y1); line.setAttribute("x2",x2); line.setAttribute("y2",y2);
  line.setAttribute("class","wire"); g.appendChild(line);
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2, off=10;
  if(type==='V'){
    // two plate lines
    const p1 = document.createElementNS("http://www.w3.org/2000/svg","line");
    p1.setAttribute("x1", cx-uy*8 - ux*off); p1.setAttribute("y1", cy+ux*8 - uy*off);
    p1.setAttribute("x2", cx+uy*8 - ux*off); p1.setAttribute("y2", cy-ux*8 - uy*off);
    p1.setAttribute("class","comp-shape"); g.appendChild(p1);
    const p2 = document.createElementNS("http://www.w3.org/2000/svg","line");
    p2.setAttribute("x1", cx-uy*12 + ux*off); p2.setAttribute("y1", cy+ux*12 + uy*off);
    p2.setAttribute("x2", cx+uy*12 + ux*off); p2.setAttribute("y2", cy-ux*12 + uy*off);
    p2.setAttribute("class","comp-shape"); g.appendChild(p2);
  } else {
    // current source: circle + arrow
    const circ = document.createElementNS("http://www.w3.org/2000/svg","circle");
    circ.setAttribute("cx", (x1+x2)/2); circ.setAttribute("cy", (y1+y2)/2);
    circ.setAttribute("r", 10); circ.setAttribute("class","comp-shape"); g.appendChild(circ);
    const arrow = document.createElementNS("http://www.w3.org/2000/svg","path");
    const ax=(x1+x2)/2 + ux*6, ay=(y1+y2)/2 + uy*6;
    const bx=(x1+x2)/2 - ux*6, by=(y1+y2)/2 - uy*6;
    arrow.setAttribute("d", `M ${bx} ${by} L ${ax} ${ay}`);
    arrow.setAttribute("class","comp-shape"); g.appendChild(arrow);
  }
}
function drawCapacitor(g,x1,y1,x2,y2){
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2, off=10;
  const n1x=cx-ux*off, n1y=cy-uy*off;
  const n2x=cx+ux*off, n2y=cy+uy*off;
  const p1=document.createElementNS("http://www.w3.org/2000/svg","line");
  p1.setAttribute("x1", n1x-uy*10); p1.setAttribute("y1", n1y+ux*10);
  p1.setAttribute("x2", n1x+uy*10); p1.setAttribute("y2", n1y-ux*10); p1.setAttribute("class","comp-shape"); g.appendChild(p1);
  const p2=document.createElementNS("http://www.w3.org/2000/svg","line");
  p2.setAttribute("x1", n2x-uy*10); p2.setAttribute("y1", n2y+ux*10);
  p2.setAttribute("x2", n2x+uy*10); p2.setAttribute("y2", n2y-ux*10); p2.setAttribute("class","comp-shape"); g.appendChild(p2);
  const lead1=document.createElementNS("http://www.w3.org/2000/svg","line");
  lead1.setAttribute("x1", x1); lead1.setAttribute("y1", y1); lead1.setAttribute("x2", n1x); lead1.setAttribute("y2", n1y); lead1.setAttribute("class","comp-shape"); g.appendChild(lead1);
  const lead2=document.createElementNS("http://www.w3.org/2000/svg","line");
  lead2.setAttribute("x1", x2); lead2.setAttribute("y1", y2); lead2.setAttribute("x2", n2x); lead2.setAttribute("y2", n2y); lead2.setAttribute("class","comp-shape"); g.appendChild(lead2);
}
function drawDiode(g,x1,y1,x2,y2){
  // triangle -> line diode
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ux=dx/len, uy=dy/len;
  const midx=(x1+x2)/2, midy=(y1+y2)/2;
  const p1x = midx - uy*10, p1y = midy + ux*10;
  const p2x = midx + uy*10, p2y = midy - ux*10;
  const tri = document.createElementNS("http://www.w3.org/2000/svg","path");
  tri.setAttribute("d", `M ${x1} ${y1} L ${p1x} ${p1y} L ${p2x} ${p2y} Z`);
  tri.setAttribute("class","comp-shape"); g.appendChild(tri);
  const bar = document.createElementNS("http://www.w3.org/2000/svg","line");
  bar.setAttribute("x1", x2 - ux*6 - uy*10); bar.setAttribute("y1", y2 - uy*6 + ux*10);
  bar.setAttribute("x2", x2 + ux*6 - uy*10); bar.setAttribute("y2", y2 + uy*6 + ux*10);
  bar.setAttribute("class","comp-shape"); g.appendChild(bar);
}

/* ---- Ports (clickable dots) ---- */
function drawPort(comp, which, x, y){
  const circ = document.createElementNS("http://www.w3.org/2000/svg","circle");
  circ.setAttribute("cx", x); circ.setAttribute("cy", y); circ.setAttribute("r", 5); circ.setAttribute("class","port");
  circ.dataset.comp = comp.name; circ.dataset.port = which;
  // hover visuals
  circ.addEventListener("mouseenter", ()=> circ.classList.add("hover"));
  circ.addEventListener("mouseleave", ()=> circ.classList.remove("hover"));
  // click handling: either start/finish wiring, assign ground, or probe after sim
  circ.addEventListener("click", (ev)=> {
    ev.stopPropagation();
    if(mode === 'W') { handleWirePortClick(comp, which, x, y, circ); return; }
    if(mode === 'GND'){ comp[which] = '0'; redraw(); mode=null; return; }
    if(lastSimResult){ probePort(comp, which); return; }
    selectComponent(comp);
  });
  svg.appendChild(circ);
  // tag
  const tag = document.createElementNS("http://www.w3.org/2000/svg","text");
  tag.setAttribute("x", x+8); tag.setAttribute("y", y-8); tag.setAttribute("class","tag");
  tag.textContent = comp[which] || '';
  svg.appendChild(tag);
}

/* ---- Wire handling ---- */
function handleWirePortClick(comp, which, x, y, el){
  if(!activePort){
    activePort = {compName: comp.name, which, x, y, el, isNode:false};
    el.classList.add("active");
    return;
  }

  // === Node → Port ===
  if(activePort.isNode){
    const nodeId = activePort.which;
    comp[which] = nodeId;
    const wid = 'W'+(idCounter++);
    const ortho = !!orthoCheckbox.checked;
    wires.push({
      id:wid,
      p1:activePort,
      p2:{compName:comp.name,which,x,y,isNode:false},
      x1:activePort.x,y1:activePort.y,x2:x,y2:y, ortho
    });
    activePort = null;
    redraw();
    return;
  }

  // === Port-to-port (unchanged) ===
  if(activePort.compName === comp.name && activePort.which === which){
    activePort.el.classList.remove("active"); activePort = null; return;
  }
  const a = activePort; const b = {compName:comp.name,which,x,y,el,isNode:false};
  const wid = 'W'+(idCounter++);
  const ortho = !!orthoCheckbox.checked;
  wires.push({id:wid, p1:a, p2:b, x1:a.x,y1:a.y,x2:b.x,y2:b.y, ortho});

  // Merge node labels between ports
  const compA = comps.find(cc=>cc.name===a.compName);
  const compB = comps.find(cc=>cc.name===b.compName);
  const nameA = compA[a.which] || `${compA.name}_${a.which}`;
  compA[a.which] = nameA;
  compB[b.which] = nameA;

  a.el.classList.remove("active"); activePort=null;
  redraw();
}

function handleWireNodeClick(node, x, y){
  if(!activePort){
    // First click = select this node
    activePort = {compName: null, which: node.id, x, y, isNode: true};
    return;
  }

  const a = activePort;
  const b = {compName:null, which:node.id, x, y, isNode: true};
  const wid = 'W'+(idCounter++);
  const ortho = !!orthoCheckbox.checked;
  wires.push({id:wid, p1:a, p2:b, x1:a.x,y1:a.y,x2:b.x,y2:b.y, ortho});

  // === Node-to-node merge ===
  if(a.isNode && b.isNode){
    const keep = a.which;     // keep this label
    const drop = b.which;     // replace this one
    comps.forEach(c=>{
      ["n1","n2"].forEach(p=>{
        if(c[p] === drop) c[p] = keep;
      });
    });
    wires.forEach(w=>{
      if(w.p1.which === drop) w.p1.which = keep;
      if(w.p2.which === drop) w.p2.which = keep;
    });
    console.log(`Merged node ${drop} → ${keep}`);
  }

  // === Node-to-port connection ===
  if(a.compName){
    const comp = comps.find(c => c.name === a.compName);
    if(comp) comp[a.which] = node.id;
  }

  activePort = null;
  redraw();
}



/* ---- Selection & editing actions ---- */
function selectComponent(c){
  selected = {type:'comp', ref:c.name};
  showSelectedPanel(c);
  redraw();
}
function showSelectedPanel(c){
  selectedEl.innerHTML = '';
  const title = document.createElement('div'); title.innerHTML = `<b>${c.name}</b> (${c.type})`;
  selectedEl.appendChild(title);
  const valIn = document.createElement('input'); valIn.type='number'; valIn.step='any'; valIn.value= c.value===undefined? 0 : c.value;
  valIn.onchange = ()=>{ c.value = parseFloat(valIn.value); redraw(); };
  selectedEl.appendChild(labelWrap('Value', valIn));
  const n1 = document.createElement('input'); n1.type='text'; n1.value = c.n1 || '';
  n1.onchange = ()=>{ c.n1 = n1.value.trim()||c.n1; redraw(); };
  selectedEl.appendChild(labelWrap('Node n1', n1));
  const n2 = document.createElement('input'); n2.type='text'; n2.value = c.n2 || '';
  n2.onchange = ()=>{ c.n2 = n2.value.trim()||c.n2; redraw(); };
  selectedEl.appendChild(labelWrap('Node n2', n2));
  const btnRotate = document.createElement('button'); btnRotate.textContent='Rotate 90°';
  btnRotate.onclick = ()=>{ rotateComponent(c); };
  selectedEl.appendChild(btnRotate);
  const btnCopy = document.createElement('button'); btnCopy.textContent='Copy';
  btnCopy.onclick = ()=>{ copyComponent(c); };
  selectedEl.appendChild(btnCopy);
  const btnDel = document.createElement('button'); btnDel.textContent='Delete';
  btnDel.onclick = ()=>{ deleteComponent(c); };
  selectedEl.appendChild(btnDel);
}
function labelWrap(t, el){ const wrap=document.createElement('div'); const lab=document.createElement('div'); lab.textContent=t; wrap.appendChild(lab); wrap.appendChild(el); return wrap; }

/* ---- Drag/move support ---- */
function startDragComponent(ev, comp){
  if(mode!=='MOVE' && mode!==null) return;
  ev.preventDefault();
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const start = {x: pt.x, y: pt.y};
  dragState = {comp, start, orig: {...comp}};
  window.addEventListener('pointermove', dragMove);
  window.addEventListener('pointerup', dragEnd);
}
function dragMove(e){
  if(!dragState) return;
  const pt = svg.createSVGPoint(); pt.x=e.clientX; pt.y=e.clientY;
  const dx = snap(pt.x - dragState.start.x);
  const dy = snap(pt.y - dragState.start.y);
  dragState.comp.x1 = dragState.orig.x1 + dx; dragState.comp.y1 = dragState.orig.y1 + dy;
  dragState.comp.x2 = dragState.orig.x2 + dx; dragState.comp.y2 = dragState.orig.y2 + dy;
  redraw();
}
function dragEnd(e){
  window.removeEventListener('pointermove', dragMove);
  window.removeEventListener('pointerup', dragEnd);
  dragState = null;
}

/* ---- Rotate / Copy / Delete ---- */
function rotateComponent(c){
  c.rot = ((c.rot||0) + 90) % 360;
  // rotate coordinates around center for port positions — easier to keep x1/x2 mathematical and only rotate display
  redraw();
}
function copyComponent(c){
  const newName = nextName(c.type);
  const dx = 40, dy = 40;
  const copy = Object.assign({}, c);
  copy.name = newName; copy.x1 = c.x1 + dx; copy.y1 = c.y1 + dy; copy.x2 = c.x2 + dx; copy.y2 = c.y2 + dy;
  // reset wiring ports on the copy
  copy.n1 = undefined; copy.n2 = undefined;
  comps.push(copy); redraw();
}
function deleteComponent(c){
  // remove wires that reference it
  wires = wires.filter(w => w.p1.comp !== c.name && w.p2.comp !== c.name);
  comps = comps.filter(cc => cc.name !== c.name);
  selected = null; redraw();
}
function deleteSelected(){
  if(!selected) return;
  if(selected.type==='comp'){ const c = comps.find(cc=>cc.name===selected.ref); if(c) deleteComponent(c); }
  else if(selected.type==='wire'){ wires = wires.filter(w => w.id !== selected.ref); selected=null; redraw(); }
}

/* ---- Placement & canvas interactions ---- */
svg.addEventListener("click", (ev)=>{
  // clicking empty area clears selection (unless in place mode start)
  if(mode && mode !== 'W' && mode !== 'MOVE'){
    // placement mode: first click sets start, second sets end
    handlePlacementClick(ev);
    return;
  }
  selected = null; showSelectedPanelEmpty(); redraw();
});

function handlePlacementClick(ev){
  const rect = svg.getBoundingClientRect();
  const x = snap(ev.clientX - rect.left);
  const y = snap(ev.clientY - rect.top);
  if(!placing){
    const name = nextName(mode || 'X');
    placing = {type:mode, name, x1:x, y1:y, x2:x, y2:y, n1: undefined, n2: undefined, value: defaultValue(mode), rot:0};
  } else {
    placing.x2 = x; placing.y2 = y; placing.n1 = placing.name + '_n1'; placing.n2 = placing.name + '_n2';
    comps.push(placing); placing = null;
    redraw();
  }
}

/* ---- helpers ---- */
function defaultValue(t){ if(t==='R') return 1000; if(t==='V') return 5; if(t==='I') return 0.001; if(t==='C') return 1e-6; if(t==='L') return 1e-3; return 0; }
function showSelectedPanelEmpty(){ selectedEl.innerHTML = '<div>No selection</div>'; }

/* ---- List refresh ---- */
function refreshList(){
  listEl.innerHTML='';
  comps.forEach(c=>{
    const d = document.createElement('div'); d.className='comp'; d.textContent = `${c.name} (${c.type}) ${c.value||''} ${c.n1?c.n1:'?'}-${c.n2?c.n2:'?'}`;
    d.onclick = ()=> selectComponent(c);
    listEl.appendChild(d);
  });
}

/* ---- Netlist generation (SPICE-like) ---- */
function generateNetlist(){
  // Build node mapping using union-find like before (ports + wires)
  const uf = {};
  function find(a){ if(!(a in uf)) uf[a]=a; return uf[a]===a ? a : (uf[a]=find(uf[a])); }
  function union(a,b){ const ra=find(a), rb=find(b); if(ra!==rb) uf[rb]=ra; }
  // ensure all ports exist
  comps.forEach(c => { const a = c.n1 || c.name+'_n1'; const b = c.n2 || c.name+'_n2'; find(a); find(b); });
  // unify via wires
  wires.forEach(w=>{
    const aComp = comps.find(c=>c.name===w.p1.comp);
    const bComp = comps.find(c=>c.name===w.p2.comp);
    const aName = (aComp[w.p1.port] || (aComp.name + '_' + w.p1.port));
    const bName = (bComp[w.p2.port] || (bComp.name + '_' + w.p2.port));
    union(aName, bName);
  });
  // map reps to N0/N1... reserve 0 for ground
  const reps = {}; let idx=1;
  comps.forEach(c=>{
    ['n1','n2'].forEach(k=>{
      const lbl = c[k] || (c.name+'_'+k);
      const r = find(lbl);
      if(!(r in reps)){
        if(lbl === '0' || c[k] === '0') reps[r]='0';
        else reps[r] = null;
      }
    });
  });
  Object.keys(reps).forEach(r=>{ if(reps[r]===null) reps[r] = 'N'+(idx++); });
  // produce spice-like lines
  const lines = [];
  comps.forEach(c=>{
    const n1 = reps[find(c.n1 || (c.name+'_n1'))] || '0';
    const n2 = reps[find(c.n2 || (c.name+'_n2'))] || '0';
    if(c.type==='R') lines.push(`${c.name} ${n1} ${n2} ${c.value || 1000}`);
    else if(c.type==='V') lines.push(`${c.name} ${n1} ${n2} DC ${c.value || 5}`);
    else if(c.type==='I') lines.push(`${c.name} ${n1} ${n2} DC ${c.value || 0.001}`);
    else if(c.type==='C') lines.push(`${c.name} ${n1} ${n2} ${c.value || 1e-6}`);
    else if(c.type==='L') lines.push(`${c.name} ${n1} ${n2} ${c.value || 1e-3}`);
    else if(c.type==='D') lines.push(`${c.name} ${n1} ${n2} Dmodel`);
  });
  return lines.join('\n');
}

/* ---- Simulation (POST to backend) ---- */
async function runSim(){
  const backend = backendUrlInput.value.replace(/\/$/,'') || 'https://circuit-rc1c.onrender.com';
  // build node mapping with union-find (same approach as netlist)
  const uf = new UF_custom(); // small local UF helper
  comps.forEach(c => { uf.find(c.n1 || c.name+'_n1'); uf.find(c.n2 || c.name+'_n2'); });
  wires.forEach(w=>{
    const a = comps.find(c=>c.name===w.p1.comp); const b = comps.find(c=>c.name===w.p2.comp);
    const an = a[w.p1.port] || (a.name+'_'+w.p1.port); const bn = b[w.p2.port] || (b.name+'_'+w.p2.port);
    uf.union(an,bn);
  });
  // make rep->N mapping
  const reps = {}; let mi = 1;
  comps.forEach(c => {
    ['n1','n2'].forEach(k=>{
      const lab = c[k] || (c.name+'_'+k);
      const r = uf.find(lab);
      if(!(r in reps)){
        if(lab==='0' || c[k]==='0') reps[r] = '0'; else reps[r] = null;
      }
    });
  });
  Object.keys(reps).forEach(r=>{ if(reps[r]===null) reps[r] = 'N'+(mi++); });
  // build payload
  const payload = { components: comps.map(c=>{
    const n1 = reps[ uf.find(c.n1 || (c.name+'_n1')) ] || '0';
    const n2 = reps[ uf.find(c.n2 || (c.name+'_n2')) ] || '0';
    return { type: c.type, name: c.name, n1, n2, value: c.value };
  })};
  try{
    const r = await fetch(backend + "/simulate", { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
    if(!r.ok){ const t = await r.text(); throw new Error(t); }
    const data = await r.json();
    lastSimResult = {node_voltages: data.node_voltages, elements: data.elements};
    resultsEl.textContent = JSON.stringify(data, null, 2);
    // annotate UI: update port tags with node names for quick probing
    redraw();
  }catch(err){
    resultsEl.textContent = `Simulation error: ${err.message}`;
  }
}

/* ---- small custom union-find used for runSim ---- */
function UF_custom(){
  this.p = {};
  this.find = (a) => { if(!(a in this.p)) this.p[a]=a; return this.p[a]===a? a : (this.p[a]=this.find(this.p[a])); };
  this.union = (a,b) => { const ra=this.find(a), rb=this.find(b); if(ra!==rb) this.p[rb]=ra; };
}

/* ---- Probing (click wire or port after sim) ---- */
function probePort(comp, which){
  if(!lastSimResult) return;
  // find rep mapping using same logic as runSim -> but we can try to map simply by sending netlist and reading node_voltages (the backend returns node names like N1,N2).
  // To keep it simple: regenerate reps and read node_voltages
  const netlistText = generateNetlist();
  // parse backend mapping by re-running same mapping algorithm (duplicated)
  // Here we will re-run the local mapping used before and use lastSimResult.node_voltages
  const uf = new UF_custom();
  comps.forEach(c => { uf.find(c.n1 || c.name+'_n1'); uf.find(c.n2 || c.name+'_n2'); });
  wires.forEach(w=>{
    const a = comps.find(c=>c.name===w.p1.comp); const b = comps.find(c=>c.name===w.p2.comp);
    const an = a[w.p1.port] || (a.name+'_'+w.p1.port); const bn = b[w.p2.port] || (b.name+'_'+w.p2.port);
    uf.union(an,bn);
  });
  const reps = {}; let idx=1;
  comps.forEach(c=>{ ['n1','n2'].forEach(k=>{ const label = c[k] || (c.name+'_'+k); const r = uf.find(label); if(!(r in reps)){ if(label==='0' || c[k]==='0') reps[r]='0'; else reps[r]=null; } }); });
  Object.keys(reps).forEach(r=>{ if(reps[r]===null) reps[r]='N'+(idx++); });
  const portLabel = uf.find(comp[which] || (comp.name+'_'+which));
  const nodeName = reps[portLabel] || '0';
  const v = lastSimResult.node_voltages[nodeName] ?? lastSimResult.node_voltages['0'] ?? 0;
  alert(`${comp.name}.${which} -> node ${nodeName} = ${v} V`);
}
function probeWire(w){
  if(!lastSimResult) { alert("No simulation yet."); return; }
  // pick p1 comp/port to probe
  const a = comps.find(c=>c.name===w.p1.comp);
  probePort(a, w.p1.port);
}

/* ---- Button wiring ---- */
document.getElementById('btn-add-R').onclick = ()=> { mode='R'; placing=null; };
document.getElementById('btn-add-V').onclick = ()=> { mode='V'; placing=null; };
document.getElementById('btn-add-I').onclick = ()=> { mode='I'; placing=null; };
document.getElementById('btn-add-C').onclick = ()=> { mode='C'; placing=null; };
document.getElementById('btn-add-L').onclick = ()=> { mode='L'; placing=null; };
document.getElementById('btn-add-D').onclick = ()=> { mode='D'; placing=null; };
document.getElementById('btn-add-GND').onclick = ()=> { mode='GND'; placing=null; };
document.getElementById('btn-add-W').onclick = ()=> { mode='W'; placing=null; activePort=null; };
document.getElementById('btn-move').onclick = ()=> { mode='MOVE'; placing=null; };
document.getElementById('btn-rotate').onclick = ()=> { mode='ROTATE'; placing=null; };
document.getElementById('btn-copy').onclick = ()=> { mode='COPY'; placing=null; };
document.getElementById('btn-del').onclick = ()=> { mode='DEL'; placing=null; };
document.getElementById('btn-clear').onclick = ()=> { comps=[]; wires=[]; placing=null; activePort=null; selected=null; lastSimResult=null; resultsEl.textContent=''; redraw(); };
document.getElementById('btn-sim').onclick = ()=> runSim();
document.getElementById('btn-netlist').onclick = ()=> { const n = generateNetlist(); prompt("SPICE-like netlist (copy):", n); };

/* ---- keyboard handlers: Del to delete selected, Esc to cancel activePort/placing, Space to toggle wire mode ---- */
window.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Delete' || ev.key === 'Backspace'){ deleteSelected(); }
  if(ev.key === 'Escape'){ activePort && activePort.el && activePort.el.classList.remove('active'); activePort=null; placing=null; mode=null; redraw(); }
  if(ev.code === 'Space'){ ev.preventDefault(); mode = (mode==='W'? null : 'W'); activePort=null; redraw(); }
});

/* ---- Canvas click placement handler (for tools that need two clicks) ---- */
svg.addEventListener('pointerdown', (ev)=>{
  // prevent default to keep pointer capture behavior
  const rect=svg.getBoundingClientRect(); const x=snap(ev.clientX-rect.left); const y=snap(ev.clientY-rect.top);
  if(mode && ['R','V','I','C','L','D'].includes(mode)){
    if(!placing){ const name = nextName(mode); placing = {type:mode,name,x1:x,y1:y,x2:x,y2:y,n1:undefined,n2:undefined,value:defaultValue(mode),rot:0}; }
    else { placing.x2=x; placing.y2=y; placing.n1 = placing.name + '_n1'; placing.n2 = placing.name + '_n2'; comps.push(placing); placing=null; redraw(); }
  }
});
svg.addEventListener("click", (ev)=>{
  const rect = svg.getBoundingClientRect();
  const x = snap(ev.clientX - rect.left);
  const y = snap(ev.clientY - rect.top);

  if(mode === 'W'){
    // click on empty space → create/use node
    const nid = getOrCreateNodeAt(x,y);
    const node = autoNodes.find(n=>n.id===nid);
    handleWireNodeClick(node, node.x, node.y);
    return;
  }

  if(mode && mode !== 'MOVE'){
    handlePlacementClick(ev);
    return;
  }

  selected = null;
  showSelectedPanelEmpty();
  redraw();
});


/* ---- initialize UI ---- */
showSelectedPanelEmpty();
redraw();
