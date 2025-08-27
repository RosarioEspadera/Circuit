// Minimal SVG-based editor with component placement and DC simulation via FastAPI
const svg = document.getElementById('canvas');
const listEl = document.getElementById('list');
const selectedEl = document.getElementById('selected');
const resultsEl = document.getElementById('results');
const backendUrlInput = document.getElementById('backendUrl');

let comps = []; // {type,name,n1,n2,value,x1,y1,x2,y2}
let mode = null; // "R" | "V" | "C" | "L" | "GND"
let placing = null; // partial component during placement

const GRID = 20;
function snap(v){ return Math.round(v/GRID)*GRID; }
function nextName(prefix){
  let idx = 1;
  while (comps.find(c => c.name === `${prefix}${idx}`)) idx++;
  return `${prefix}${idx}`;
}

function redraw(){
  // clear
  while(svg.firstChild) svg.removeChild(svg.firstChild);

  // draw components
  comps.forEach(c => drawComponent(c));

  // list
  listEl.innerHTML = '';
  comps.forEach(c => {
    const div = document.createElement('div');
    div.className = 'comp';
    div.textContent = `${c.name} (${c.type}) ${c.value ?? ''}  ${c.n1||'?'}-${c.n2||'?'}`;
    div.onclick = () => selectComp(c);
    listEl.appendChild(div);
  });
}

function selectComp(c){
  selectedEl.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = `<b>${c.name}</b> (${c.type})`;
  selectedEl.appendChild(title);

  const val = document.createElement('input');
  val.type = 'number'; val.step = 'any'; val.value = c.value ?? 0;
  val.onchange = ()=>{ c.value = parseFloat(val.value); redraw(); };
  selectedEl.appendChild(labelWrap('Value', val));

  const n1 = document.createElement('input');
  n1.type = 'text'; n1.value = c.n1 || 'N1';
  n1.onchange = ()=>{ c.n1 = n1.value.toUpperCase(); redraw(); };
  selectedEl.appendChild(labelWrap('Node n1', n1));

  const n2 = document.createElement('input');
  n2.type = 'text'; n2.value = c.n2 || 'N2';
  n2.onchange = ()=>{ c.n2 = n2.value.toUpperCase(); redraw(); };
  selectedEl.appendChild(labelWrap('Node n2', n2));
}

function labelWrap(text, el){
  const wrap = document.createElement('div');
  const lab = document.createElement('div'); lab.textContent = text;
  wrap.appendChild(lab); wrap.appendChild(el);
  return wrap;
}

function drawComponent(c){
  // line between endpoints
  const x1 = c.x1, y1 = c.y1, x2 = c.x2, y2 = c.y2;
  const group = document.createElementNS('http://www.w3.org/2000/svg','g');
  group.setAttribute('data-name', c.name);

  // draw symbol depending on type
  if (c.type === 'R' || c.type === 'L') {
    drawResistorSymbol(group, x1, y1, x2, y2);
  } else if (c.type === 'V') {
    drawBatterySymbol(group, x1, y1, x2, y2);
  } else if (c.type === 'C') {
    drawCapacitorSymbol(group, x1, y1, x2, y2);
  }

  const label = document.createElementNS('http://www.w3.org/2000/svg','text');
  label.setAttribute('x', (x1+x2)/2);
  label.setAttribute('y', (y1+y2)/2 - 12);
  label.setAttribute('text-anchor','middle');
  label.textContent = `${c.name} ${c.value ?? ''}`;
  group.appendChild(label);

  // clickable
  group.classList.add('comp-shape');
  group.addEventListener('click', ()=> selectComp(c));

  svg.appendChild(group);

  // nodes
  drawNode(x1,y1, c.n1 || '');
  drawNode(x2,y2, c.n2 || '');
}

function drawNode(x,y, tag){
  const circ = document.createElementNS('http://www.w3.org/2000/svg','circle');
  circ.setAttribute('cx', x); circ.setAttribute('cy', y); circ.setAttribute('r', 3);
  circ.setAttribute('class','node');
  svg.appendChild(circ);
  if(tag){
    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x', x+6); t.setAttribute('y', y-6);
    t.textContent = tag;
    t.setAttribute('class','tag');
    svg.appendChild(t);
  }
}

function drawResistorSymbol(g, x1,y1,x2,y2){
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  const midx=(x1+x2)/2, midy=(y1+y2)/2;
  const dx = (x2-x1), dy=(y2-y1);
  const len = Math.hypot(dx,dy);
  const ux = dx/len, uy=dy/len;
  const p = 30; // symbol half length
  const ax = x1 + ux*20, ay = y1 + uy*20;
  const bx = x2 - ux*20, by = y2 - uy*20;
  const mx = (ax+bx)/2, my=(ay+by)/2;
  // simple zig-zag
  const zig = 6;
  let d = `M ${x1} ${y1} L ${ax} ${ay}`;
  d += ` L ${mx - uy*zig} ${my + ux*zig}`;
  d += ` L ${mx + uy*zig} ${my - ux*zig}`;
  d += ` L ${bx} ${by} L ${x2} ${y2}`;
  path.setAttribute('d', d);
  path.setAttribute('class','comp-shape');
  g.appendChild(path);
}

function drawBatterySymbol(g, x1,y1,x2,y2){
  // two parallel plates for DC source
  const line = document.createElementNS('http://www.w3.org/2000/svg','line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('class','wire'); g.appendChild(line);

  const dx = x2-x1, dy=y2-y1; const len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2;
  const off=10;
  const n1x=cx-ux*off, n1y=cy-uy*off;
  const n2x=cx+ux*off, n2y=cy+uy*off;

  const p1 = document.createElementNS('http://www.w3.org/2000/svg','line');
  p1.setAttribute('x1', n1x-uy*8); p1.setAttribute('y1', n1y+ux*8);
  p1.setAttribute('x2', n1x+uy*8); p1.setAttribute('y2', n1y-ux*8);
  p1.setAttribute('class','comp-shape');
  g.appendChild(p1);

  const p2 = document.createElementNS('http://www.w3.org/2000/svg','line');
  p2.setAttribute('x1', n2x-uy*12); p2.setAttribute('y1', n2y+ux*12);
  p2.setAttribute('x2', n2x+uy*12); p2.setAttribute('y2', n2y-ux*12);
  p2.setAttribute('class','comp-shape');
  g.appendChild(p2);
}

function drawCapacitorSymbol(g, x1,y1,x2,y2){
  const dx = x2-x1, dy=y2-y1; const len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;
  const cx=(x1+x2)/2, cy=(y1+y2)/2;
  const off=10;
  const n1x=cx-ux*off, n1y=cy-uy*off;
  const n2x=cx+ux*off, n2y=cy+uy*off;

  const p1 = document.createElementNS('http:// www.w3.org/2000/svg','line');
  p1.setAttribute('x1', n1x-uy*12); p1.setAttribute('y1', n1y+ux*12);
  p1.setAttribute('x2', n1x+uy*12); p1.setAttribute('y2', n1y-ux*12);
  p1.setAttribute('class','comp-shape'); g.appendChild(p1);

  const p2 = document.createElementNS('http://www.w3.org/2000/svg','line');
  p2.setAttribute('x1', n2x-uy*12); p2.setAttribute('y1', n2y+ux*12);
  p2.setAttribute('x2', n2x+uy*12); p2.setAttribute('y2', n2y-ux*12);
  p2.setAttribute('class','comp-shape'); g.appendChild(p2);

  // leads
  const lead1 = document.createElementNS('http://www.w3.org/2000/svg','line');
  lead1.setAttribute('x1', x1); lead1.setAttribute('y1', y1);
  lead1.setAttribute('x2', n1x); lead1.setAttribute('y2', n1y);
  lead1.setAttribute('class','comp-shape'); g.appendChild(lead1);

  const lead2 = document.createElementNS('http://www.w3.org/2000/svg','line');
  lead2.setAttribute('x1', x2); lead2.setAttribute('y1', y2);
  lead2.setAttribute('x2', n2x); lead2.setAttribute('y2', n2y);
  lead2.setAttribute('class','comp-shape'); g.appendChild(lead2);
}

function onCanvasClick(e){
  const rect = svg.getBoundingClientRect();
  const x = snap(e.clientX - rect.left);
  const y = snap(e.clientY - rect.top);

  if(!mode) return;

  if(!placing){
    // start placing a component
    const name = nextName(mode);
    placing = {type:mode, name, x1:x, y1:y, x2:x, y2:y, n1:`N${Math.floor(x/GRID)}_${Math.floor(y/GRID)}`, n2: null, value: defaultValue(mode)};
  }else{
    // finalize
    placing.x2 = x; placing.y2 = y;
    placing.n2 = `N${Math.floor(x/GRID)}_${Math.floor(y/GRID)}`;
    comps.push(placing);
    placing = null;
    mode = null;
    redraw();
  }
}

function defaultValue(t){
  if(t==='R') return 1000;
  if(t==='V') return 5;
  if(t==='C') return 1e-6;
  if(t==='L') return 1e-3;
  return 0;
}

svg.addEventListener('click', onCanvasClick);

document.getElementById('btn-add-R').onclick = ()=> { mode = 'R'; };
document.getElementById('btn-add-V').onclick = ()=> { mode = 'V'; };
document.getElementById('btn-add-C').onclick = ()=> { mode = 'C'; };
document.getElementById('btn-add-L').onclick = ()=> { mode = 'L'; };
document.getElementById('btn-add-GND').onclick = ()=> { 
  // set nearest endpoint to GND on next click
  mode = 'GND';
  placing = null;
  svg.addEventListener('click', setGroundOnce, {once:true});
};
document.getElementById('btn-clear').onclick = ()=> { comps = []; placing = null; resultsEl.textContent=''; redraw(); };

function setGroundOnce(e){
  const rect = svg.getBoundingClientRect();
  const x = snap(e.clientX - rect.left);
  const y = snap(e.clientY - rect.top);
  const targetNode = `N${Math.floor(x/GRID)}_${Math.floor(y/GRID)}`;
  // Attach any node tag equal to target to '0'
  comps.forEach(c => {
    if(c.n1 === targetNode) c.n1 = '0';
    if(c.n2 === targetNode) c.n2 = '0';
  });
  redraw();
  mode = null;
}

document.getElementById('btn-sim').onclick = async ()=> {
  const backend = backendUrlInput.value.replace(/\/$/,'')
  const payload = {
    components: comps.map(c => ({
      type: c.type,
      name: c.name,
      n1: c.n1,
      n2: c.n2,
      value: c.value
    }))
  };
  try{
    const res = await fetch(`${backend}/simulate`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const txt = await res.text();
      throw new Error(txt);
    }
    const data = await res.json();
    showResults(data);
  }catch(err){
    resultsEl.textContent = `Error: ${err.message}`;
  }
};

function showResults(data){
  const lines = [];
  lines.push('Node Voltages:');
  Object.entries(data.node_voltages).forEach(([n,v])=>{
    lines.push(`  ${n}: ${v.toFixed(6)} V`);
  });
  lines.push('');
  lines.push('Elements:');
  Object.entries(data.elements).forEach(([name, e])=>{
    lines.push(`  ${name} (${e.type}) ${e.n1}-${e.n2}`);
    lines.push(`     value=${e.value}  V=${e.voltage.toFixed(6)}  I=${e.current.toExponential(6)}  P=${e.power.toExponential(6)}`);
  });
  if(data.equivalent_resistance){
    lines.push('');
    lines.push(`Req (seen by first source): ${data.equivalent_resistance} ohm`);
  }
  resultsEl.textContent = lines.join('\n');
}

redraw();