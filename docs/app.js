// app.js - editor with ports, wire mode, and simulation export
const svg = document.getElementById('canvas');
const listEl = document.getElementById('list');
const selectedEl = document.getElementById('selected');
const resultsEl = document.getElementById('results');
const backendUrlInput = document.getElementById('backendUrl');

let comps = []; // components placed
let wires = []; // {id, p1:{comp,port}, p2:{comp,port}, x1,y1,x2,y2}
let mode = null; // 'R','V','C','L','GND','W'(wire)
let placing = null;
let activePort = null;
let idCounter = 1;

// simple union-find for node grouping
class UF {
  constructor(){ this.p = {}; }
  find(a){
    if(!(a in this.p)) this.p[a]=a;
    if(this.p[a]===a) return a;
    this.p[a]=this.find(this.p[a]); return this.p[a];
  }
  union(a,b){ const ra=this.find(a), rb=this.find(b); if(ra!==rb) this.p[rb]=ra; }
}

function snap(v){ return Math.round(v/20)*20; }
function nextName(prefix){ let idx=1; while(comps.find(c=>c.name===`${prefix}${idx}`)) idx++; return `${prefix}${idx}`; }

function redraw(){
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  // draw wires first (so under components)
  wires.forEach(w => {
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', w.x1); line.setAttribute('y1', w.y1);
    line.setAttribute('x2', w.x2); line.setAttribute('y2', w.y2);
    line.setAttribute('class','wire');
    svg.appendChild(line);
  });
  comps.forEach(c => drawComponent(c));
  // list
  listEl.innerHTML='';
  comps.forEach(c => {
    const div=document.createElement('div'); div.className='comp';
    div.textContent=`${c.name} (${c.type}) ${c.value??''} ${c.n1||'?'}-${c.n2||'?'}`;
    div.onclick = ()=> selectComp(c);
    listEl.appendChild(div);
  });
}

function selectComp(c){
  selectedEl.innerHTML='';
  const title=document.createElement('div'); title.innerHTML=`<b>${c.name}</b> (${c.type})`;
  selectedEl.appendChild(title);
  const val=document.createElement('input'); val.type='number'; val.step='any'; val.value=c.value||0;
  val.onchange=()=>{ c.value=parseFloat(val.value); redraw(); };
  selectedEl.appendChild(labelWrap('Value', val));
  const n1=document.createElement('input'); n1.type='text'; n1.value=c.n1||'';
  n1.onchange=()=>{ c.n1=n1.value.trim().toUpperCase()||c.n1; redraw(); };
  selectedEl.appendChild(labelWrap('Node n1', n1));
  const n2=document.createElement('input'); n2.type='text'; n2.value=c.n2||'';
  n2.onchange=()=>{ c.n2=n2.value.trim().toUpperCase()||c.n2; redraw(); };
  selectedEl.appendChild(labelWrap('Node n2', n2));
}

function labelWrap(t, el){ const wrap=document.createElement('div'); const lab=document.createElement('div'); lab.textContent=t; wrap.appendChild(lab); wrap.appendChild(el); return wrap; }

function drawComponent(c){
  const g=document.createElementNS('http://www.w3.org/2000/svg','g'); g.setAttribute('data-name', c.name);
  const x1=c.x1, y1=c.y1, x2=c.x2, y2=c.y2;
  if(c.type==='R' || c.type==='L') drawResistorSymbol(g,x1,y1,x2,y2);
  else if(c.type==='V') drawBatterySymbol(g,x1,y1,x2,y2);
  else if(c.type==='C') drawCapacitorSymbol(g,x1,y1,x2,y2);
  const label=document.createElementNS('http://www.w3.org/2000/svg','text');
  label.setAttribute('x',(x1+x2)/2); label.setAttribute('y',(y1+y2)/2 - 12);
  label.setAttribute('text-anchor','middle'); label.textContent=`${c.name} ${c.value??''}`; g.appendChild(label);
  g.classList.add('comp-shape'); g.addEventListener('click', ()=> selectComp(c));
  svg.appendChild(g);
  // ports
  drawPort(c, 'n1', x1, y1);
  drawPort(c, 'n2', x2, y2);
}

function drawPort(comp, which, x, y){
  const cx = x, cy = y;
  const circ = document.createElementNS('http://www.w3.org/2000/svg','circle');
  circ.setAttribute('cx', cx); circ.setAttribute('cy', cy); circ.setAttribute('r', 5);
  circ.setAttribute('class', 'port');
  circ.dataset.comp = comp.name; circ.dataset.port = which;
  circ.addEventListener('mouseenter', ()=> circ.classList.add('hover'));
  circ.addEventListener('mouseleave', ()=> circ.classList.remove('hover'));
  circ.addEventListener('click', (e)=> {
    e.stopPropagation();
    handlePortClick(comp, which, cx, cy, circ);
  });
  svg.appendChild(circ);
  // node tag
  const tag = document.createElementNS('http://www.w3.org/2000/svg','text');
  tag.setAttribute('x', cx+8); tag.setAttribute('y', cy-8); tag.setAttribute('class','tag');
  tag.textContent = comp[which] || '';
  svg.appendChild(tag);
}

function handlePortClick(comp, which, x, y, circEl){
  if(mode !== 'W') {
    // allow quick assign ground by setting port to 0 when GND mode
    if(mode === 'GND') {
      comp[which] = '0'; redraw(); mode = null; return;
    }
    // otherwise select component normally
    selectComp(comp); return;
  }
  // Wire mode: start or finish a connection
  if(!activePort){
    activePort = {compName: comp.name, which, x, y, el: circEl};
    circEl.classList.add('active');
  } else {
    // don't connect same port
    if(activePort.compName === comp.name && activePort.which === which){
      // cancel
      activePort.el.classList.remove('active'); activePort = null; return;
    }
    // create wire
    const a = activePort; const b = {compName: comp.name, which, x, y, el: circEl};
    const wid = 'W'+(idCounter++);
    wires.push({id:wid, p1:{comp:a.compName, port:a.which}, p2:{comp:b.compName, port:b.which}, x1:a.x, y1:a.y, x2:b.x, y2:b.y});
    // merge node names: if any port had explicit node name, reuse; else assign temporary unique
    const compA = comps.find(c=>c.name===a.compName); const compB = comps.find(c=>c.name===b.compName);
    const nameA = compA[a.which] || `${compA.name}_${a.which}`;
    const nameB = compB[b.which] || `${compB.name}_${b.which}`;
    // set both ports to the same node name (use nameA)
    compA[a.which] = nameA; compB[b.which] = nameA;
    activePort.el.classList.remove('active'); activePort = null;
    mode = null; // exit wire mode after one connection for simplicity
    redraw();
  }
}

function drawResistorSymbol(g,x1,y1,x2,y2){
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  const dx = x2-x1, dy=y2-y1; const len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;
  const ax=x1+ux*20, ay=y1+uy*20, bx=x2-ux*20, by=y2-uy*20;
  const mx=(ax+bx)/2, my=(ay+by)/2; const zig=6;
  let d=`M ${x1} ${y1} L ${ax} ${ay} L ${mx-uy*zig} ${my+ux*zig} L ${mx+uy*zig} ${my-ux*zig} L ${bx} ${by} L ${x2} ${y2}`;
  path.setAttribute('d', d); path.setAttribute('class','comp-shape'); g.appendChild(path);
}

function drawBatterySymbol(g,x1,y1,x2,y2){
  const line = document.createElementNS('http://www.w3.org/2000/svg','line');
  line.setAttribute('x1',x1); line.setAttribute('y1',y1); line.setAttribute('x2',x2); line.setAttribute('y2',y2);
  line.setAttribute('class','wire'); g.appendChild(line);
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2, off=10;
  const n1x=cx-ux*off, n1y=cy-uy*off, n2x=cx+ux*off, n2y=cy+uy*off;
  const p1=document.createElementNS('http://www.w3.org/2000/svg','line');
  p1.setAttribute('x1', n1x-uy*8); p1.setAttribute('y1', n1y+ux*8); p1.setAttribute('x2', n1x+uy*8); p1.setAttribute('y2', n1y-ux*8);
  p1.setAttribute('class','comp-shape'); g.appendChild(p1);
  const p2=document.createElementNS('http://www.w3.org/2000/svg','line');
  p2.setAttribute('x1', n2x-uy*12); p2.setAttribute('y1', n2y+ux*12); p2.setAttribute('x2', n2x+uy*12); p2.setAttribute('y2', n2y-ux*12);
  p2.setAttribute('class','comp-shape'); g.appendChild(p2);
}

function drawCapacitorSymbol(g,x1,y1,x2,y2){
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2, off=10;
  const n1x=cx-ux*off, n1y=cy-uy*off, n2x=cx+ux*off, n2y=cy+uy*off;
  const p1=document.createElementNS('http://www.w3.org/2000/svg','line');
  p1.setAttribute('x1', n1x-uy*12); p1.setAttribute('y1', n1y+ux*12); p1.setAttribute('x2', n1x+uy*12); p1.setAttribute('y2', n1y-ux*12);
  p1.setAttribute('class','comp-shape'); g.appendChild(p1);
  const p2=document.createElementNS('http://www.w3.org/2000/svg','line');
  p2.setAttribute('x1', n2x-uy*12); p2.setAttribute('y1', n2y+ux*12); p2.setAttribute('x2', n2x+uy*12); p2.setAttribute('y2', n2y-ux*12);
  p2.setAttribute('class','comp-shape'); g.appendChild(p2);
  const lead1=document.createElementNS('http://www.w3.org/2000/svg','line');
  lead1.setAttribute('x1', x1); lead1.setAttribute('y1', y1); lead1.setAttribute('x2', n1x); lead1.setAttribute('y2', n1y);
  lead1.setAttribute('class','comp-shape'); g.appendChild(lead1);
  const lead2=document.createElementNS('http://www.w3.org/2000/svg','line');
  lead2.setAttribute('x1', x2); lead2.setAttribute('y1', y2); lead2.setAttribute('x2', n2x); lead2.setAttribute('y2', n2y);
  lead2.setAttribute('class','comp-shape'); g.appendChild(lead2);
}

function onCanvasClick(e){
  const rect = svg.getBoundingClientRect(); const x = snap(e.clientX - rect.left); const y = snap(e.clientY - rect.top);
  if(!mode) return;
  if(!placing){
    const name = nextName(mode); placing = {type:mode, name, x1:x, y1:y, x2:x, y2:y, n1:`${name}_n1`, n2:null, value: defaultValue(mode)};
  } else {
    placing.x2 = x; placing.y2 = y; placing.n2 = `${placing.name}_n2`; comps.push(placing); placing = null; mode = null; redraw();
  }
}

function defaultValue(t){ if(t==='R') return 1000; if(t==='V') return 5; if(t==='C') return 1e-6; if(t==='L') return 1e-3; return 0; }

svg.addEventListener('click', onCanvasClick);

document.getElementById('btn-add-R').onclick = ()=> { mode='R'; };
document.getElementById('btn-add-V').onclick = ()=> { mode='V'; };
document.getElementById('btn-add-C').onclick = ()=> { mode='C'; };
document.getElementById('btn-add-L').onclick = ()=> { mode='L'; };
document.getElementById('btn-add-GND').onclick = ()=> { mode='GND'; };
document.getElementById('btn-add-W').onclick = ()=> { mode='W'; activePort=null; };

document.getElementById('btn-clear').onclick = ()=> { comps=[]; wires=[]; placing=null; activePort=null; resultsEl.textContent=''; redraw(); };

document.getElementById('btn-sim').onclick = async ()=> {
  const backend = backendUrlInput.value.replace(/\/$/,'') || 'http://localhost:8000';
  // build net grouping via UF
  const uf = new UF();
  // ensure ports names are present in UF
  comps.forEach(c => { if(c.n1) uf.find(c.name+'_n1'); if(c.n2) uf.find(c.name+'_n2'); });
  wires.forEach(w => {
    const a = comps.find(c=>c.name===w.p1.comp); const b = comps.find(c=>c.name===w.p2.comp);
    const an = a[w.p1.port] || (a.name+'_'+w.p1.port); const bn = b[w.p2.port] || (b.name+'_'+w.p2.port);
    uf.union(an, bn);
  });
  // create node map: representative -> N1, N2,... with ground as '0'
  const reps = {};
  let mapIdx = 1;
  comps.forEach(c => {
    ['n1','n2'].forEach(k=>{
      const label = c[k] || (c.name+'_'+k);
      const r = uf.find(label);
      if(r in reps) return;
      // if any port explicitly labeled '0', map rep->0
      if(label === '0' || c[k]=== '0') { reps[r] = '0'; return; }
      reps[r] = null;
    });
  });
  // assign names
  Object.keys(reps).forEach(r=>{ if(reps[r]===null) { reps[r] = 'N'+(mapIdx++); } });
  // build components payload with normalized node names
  const payload = { components: comps.map(c=>{
    const n1label = uf.find(c.n1 || (c.name+'_n1')); const n2label = uf.find(c.n2 || (c.name+'_n2'));
    return { type: c.type, name: c.name, n1: reps[n1label]||'0', n2: reps[n2label]||'0', value: c.value };
  })};
  try{
    const res = await fetch(`${backend}/simulate`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok){ const txt = await res.text(); throw new Error(txt); }
    const data = await res.json(); showResults(data);
  }catch(err){ resultsEl.textContent = `Error: ${err.message}`; }
};

function showResults(data){
  const lines=[]; lines.push('Node Voltages:'); Object.entries(data.node_voltages).forEach(([n,v])=>lines.push(`  ${n}: ${v.toFixed(6)} V`)); lines.push(''); lines.push('Elements:');
  Object.entries(data.elements).forEach(([name,e])=>{ lines.push(`  ${name} (${e.type}) ${e.n1}-${e.n2}`); lines.push(`     value=${e.value}  V=${e.voltage.toFixed(6)}  I=${e.current.toExponential(6)}  P=${e.power.toExponential(6)}`); });
  if(data.equivalent_resistance) { lines.push(''); lines.push(`Req (seen by first source): ${data.equivalent_resistance} ohm`); }
  resultsEl.textContent = lines.join('\n');
}

redraw();
