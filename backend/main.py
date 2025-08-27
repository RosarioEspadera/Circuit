from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import numpy as np

app = FastAPI(title="Mini LTSpice DC Solver", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Component(BaseModel):
    type: str
    name: str
    n1: Optional[str] = None
    n2: Optional[str] = None
    value: Optional[float] = None

class Netlist(BaseModel):
    components: List[Component]

def _normalize_node(n: Optional[str]) -> str:
    if n is None:
        return "0"
    s = str(n).strip().upper()
    return "0" if s in ("0","GND","GROUND") else s

@app.get("/health")
def health():
    return {"status":"ok"}

@app.post("/simulate")
def simulate(netlist: Netlist):
    comps = []
    for c in netlist.components:
        ctype = c.type.strip().upper()
        n1 = _normalize_node(c.n1)
        n2 = _normalize_node(c.n2)
        val = c.value if c.value is not None else 0.0
        if ctype == "C":
            comps.append(("C", c.name, n1, n2, val))
            continue
        if ctype == "L":
            comps.append(("R", c.name, n1, n2, 1e-9))
            continue
        comps.append((ctype, c.name, n1, n2, val))

    nodes = set()
    voltage_sources = []
    for ctype, name, n1, n2, val in comps:
        if ctype in ("R",):
            if n1 != "0": nodes.add(n1)
            if n2 != "0": nodes.add(n2)
        elif ctype in ("V",):
            if n1 != "0": nodes.add(n1)
            if n2 != "0": nodes.add(n2)
            voltage_sources.append((name, n1, n2, val))

    node_list = sorted(nodes)
    node_index = {n:i for i,n in enumerate(node_list)}
    N = len(node_list)
    M = len(voltage_sources)

    if N == 0 and M == 0:
        raise HTTPException(status_code=400, detail="No solvable elements. Add at least one resistor path and a source.")

    G = np.zeros((N, N), dtype=float)
    B = np.zeros((N, M), dtype=float)
    I = np.zeros((N, 1), dtype=float)
    E = np.zeros((M, 1), dtype=float)

    for ctype, name, n1, n2, val in comps:
        if ctype == "R":
            if val <= 0:
                raise HTTPException(status_code=400, detail=f"Resistor {name} must have R>0 (got {val}).")
            g = 1.0/val
            if n1 != "0":
                i = node_index[n1]; G[i,i] += g
            if n2 != "0":
                j = node_index[n2]; G[j,j] += g
            if n1 != "0" and n2 != "0":
                i, j = node_index[n1], node_index[n2]
                G[i,j] -= g; G[j,i] -= g

    for k, (name, n1, n2, val) in enumerate(voltage_sources):
        E[k,0] = val
        if n1 != "0":
            i = node_index[n1]; B[i,k] = 1.0
        if n2 != "0":
            j = node_index[n2]; B[j,k] = -1.0

    C = B.T
    D = np.zeros((M, M), dtype=float) if M>0 else np.zeros((0,0))
    A = np.block([[G, B],[C, D]])
    z = np.vstack((I, E))

    try:
        x = np.linalg.lstsq(A, z, rcond=None)[0]
    except np.linalg.LinAlgError as e:
        raise HTTPException(status_code=422, detail=f"Linear algebra error: {e}")

    v_nodes = x[:N,0] if N>0 else np.array([])
    j_src = x[N:,0] if M>0 else np.array([])

    node_voltages = {"0": 0.0}
    for n, idx in node_index.items():
        node_voltages[n] = float(v_nodes[idx])

    elements = {}
    for ctype, name, n1, n2, val in comps:
        if ctype == "R":
            v1 = node_voltages.get(n1,0.0)
            v2 = node_voltages.get(n2,0.0)
            v = v1 - v2
            i = v / val
            p = v * i
            elements[name] = {"type":"R","n1":n1,"n2":n2,"value":val,"voltage":v,"current":i,"power":p}
        elif ctype == "V":
            idx = None
            for k,(nm,nn1,nn2,valv) in enumerate(voltage_sources):
                if nm==name: idx = k; break
            i = float(j_src[idx]) if idx is not None and M>0 else 0.0
            v = val
            p = v * i
            elements[name] = {"type":"V","n1":n1,"n2":n2,"value":val,"voltage":v,"current":i,"power":p}
        elif ctype == "C":
            v1 = node_voltages.get(n1,0.0); v2 = node_voltages.get(n2,0.0)
            v = v1 - v2
            elements[name] = {"type":"C","n1":n1,"n2":n2,"value":val,"voltage":v,"current":0.0,"power":0.0}

    total_current = 0.0
    for name,data in elements.items():
        if data["type"]=="V":
            total_current += abs(data["current"])
    equivalent_resistance = None
    if len(voltage_sources)==1 and total_current>0:
        equivalent_resistance = abs(voltage_sources[0][3]) / total_current

    return {"node_voltages": node_voltages, "elements": elements, "total_current": total_current, "equivalent_resistance": equivalent_resistance}
