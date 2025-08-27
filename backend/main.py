from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Dict, Optional
import numpy as np

app = FastAPI(title="Mini LTSpice DC Solver", version="1.0.0", description="Lightweight DC-only circuit solver (R, V, C-open, L-short).")

# Allow CORS for local static frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Component(BaseModel):
    type: str = Field(..., description="R, V, C, L, or GND")
    name: str = Field(..., description="Unique identifier like R1, V1")
    n1: Optional[str] = Field(default=None, description="Positive node / first terminal")
    n2: Optional[str] = Field(default=None, description="Negative node / second terminal")
    value: Optional[float] = Field(default=None, description="Ohms for R, Volts for V, Farads for C, Henry for L")

class Netlist(BaseModel):
    components: List[Component]

def _normalize_node(n: Optional[str]) -> str:
    if n is None: 
        return "0"
    s = str(n).strip().upper()
    return "0" if s in ("0","GND","GROUND") else s

def solve_dc(netlist: Netlist):
    """
    Modified Nodal Analysis (MNA) for linear DC.
    Supports: Resistors (R), Independent Voltage Sources (V).
    Capacitors (C) are open in DC. Inductors (L) are shorts (very small R).
    Ground node is '0' or 'GND'.
    """
    # Normalize nodes and build lists
    comps = []
    for c in netlist.components:
        ctype = c.type.strip().upper()
        n1 = _normalize_node(c.n1)
        n2 = _normalize_node(c.n2)
        val = c.value if c.value is not None else 0.0
        # Skip explicit GND parts (we just use node names for ground)
        if ctype == "GND":
            # Attach the named node to 0 by adding a very small resistor to ground if n1 provided
            continue
        # Treat C as open in DC: skip entirely
        if ctype == "C":
            continue
        # Treat L as short: replace with a very small resistor
        if ctype == "L":
            ctype = "R"
            val = max(val, 0.0)  # ignore L value in DC; just short it
            val = 1e-9  # ~0 ohm
        comps.append((ctype, c.name, n1, n2, val))

    # Collect node names (exclude ground)
    nodes = set()
    voltage_sources = []
    for ctype, name, n1, n2, val in comps:
        if ctype in ("R",):
            if n1 != "0": nodes.add(n1)
            if n2 != "0": nodes.add(n2)
        elif ctype in ("V",):
            # Voltage sources introduce extra rows/cols in MNA
            if n1 != "0": nodes.add(n1)
            if n2 != "0": nodes.add(n2)
            voltage_sources.append((name, n1, n2, val))

    node_list = sorted(nodes)
    node_index = {n:i for i,n in enumerate(node_list)}
    N = len(node_list)
    M = len(voltage_sources)

    if N == 0 and M == 0:
        raise HTTPException(status_code=400, detail="No solvable elements. Add at least one resistor path and a source.")

    # G (N x N), B (N x M), C = B^T (M x N), D (M x M) zeros for independent sources
    G = np.zeros((N, N), dtype=float)
    B = np.zeros((N, M), dtype=float)
    I = np.zeros((N, 1), dtype=float)  # current injections (not used for passive resistors)
    E = np.zeros((M, 1), dtype=float)  # source voltages

    # Stamp resistors: conductance between nodes
    for ctype, name, n1, n2, val in comps:
        if ctype != "R":
            continue
        if val <= 0:
            raise HTTPException(status_code=400, detail=f"Resistor {name} must have R>0 (got {val}).")
        g = 1.0/val
        if n1 != "0":
            i = node_index[n1]
            G[i, i] += g
        if n2 != "0":
            j = node_index[n2]
            G[j, j] += g
        if n1 != "0" and n2 != "0":
            i, j = node_index[n1], node_index[n2]
            G[i, j] -= g
            G[j, i] -= g

    # Stamp independent voltage sources
    for k, (name, n1, n2, val) in enumerate(voltage_sources):
        E[k, 0] = val
        if n1 != "0":
            i = node_index[n1]
            B[i, k] = 1.0
        if n2 != "0":
            j = node_index[n2]
            B[j, k] = -1.0

    # Build MNA matrix
    # [ G  B ] [v] = [ I ]
    # [ C  D ] [j]   [ E ]
    # where C=B^T, D=0 for independent sources
    C = B.T
    D = np.zeros((M, M), dtype=float) if M>0 else np.zeros((0,0))
    A = np.block([[G, B],
                  [C, D]])
    z_top = I
    z_bot = E
    z = np.vstack((z_top, z_bot))

    # Solve Ax=z
    try:
        x = np.linalg.lstsq(A, z, rcond=None)[0]  # robust to singular matrices if open circuits
    except np.linalg.LinAlgError as e:
        raise HTTPException(status_code=422, detail=f"Linear algebra error: {e}")

    v_nodes = x[:N, 0] if N>0 else np.array([])
    j_src = x[N:, 0] if M>0 else np.array([])

    node_voltages: Dict[str, float] = {"0": 0.0}
    for n, idx in node_index.items():
        node_voltages[n] = float(v_nodes[idx])

    # Compute per-element results
    elements: Dict[str, Dict[str, float]] = {}
    # Resistors & inductors-as-resistors
    for ctype, name, n1, n2, val in comps:
        if ctype == "R":
            v1 = node_voltages.get(n1, 0.0)
            v2 = node_voltages.get(n2, 0.0)
            v = v1 - v2  # voltage from n1 to n2
            i = v / val  # current from n1->n2
            p = v * i
            elements[name] = {"type":"R", "n1": n1, "n2": n2, "value": val, "voltage": v, "current": i, "power": p}
    # Voltage sources
    for k, (name, n1, n2, val) in enumerate(voltage_sources):
        # In MNA, the extra variables j_src are currents flowing from n1 to n2 through the voltage source
        i = j_src[k] if M>0 else 0.0
        v = val
        p = v * i  # power delivered (+) if current enters positive terminal
        elements[name] = {"type":"V", "n1": n1, "n2": n2, "value": val, "voltage": v, "current": i, "power": p}

    # Capacitors: open in DC (voltage is node difference; current ~ 0)
    for c in netlist.components:
        if c.type.strip().upper() == "C":
            n1 = _normalize_node(c.n1)
            n2 = _normalize_node(c.n2)
            v = node_voltages.get(n1, 0.0) - node_voltages.get(n2, 0.0)
            elements[c.name] = {"type":"C", "n1": n1, "n2": n2, "value": c.value or 0.0, "voltage": v, "current": 0.0, "power": 0.0}

    # Inductors reported as 'L' but computed as near-short
    for c in netlist.components:
        if c.type.strip().upper() == "L":
            # We already calculated as tiny resistor in elements under its resistor replacement name; if not present, add read-only
            if c.name not in elements:
                n1 = _normalize_node(c.n1)
                n2 = _normalize_node(c.n2)
                v = node_voltages.get(n1, 0.0) - node_voltages.get(n2, 0.0)
                # assume near short => current large if voltage nonzero, but we avoid reporting infinity
                elements[c.name] = {"type":"L", "n1": n1, "n2": n2, "value": c.value or 0.0, "voltage": v, "current": 0.0, "power": 0.0}
            else:
                # Rename the computed resistor-type back to L for UI consistency
                elements[c.name]["type"] = "L"

    total_current = 0.0
    for name, data in elements.items():
        if data["type"] == "V":
            # Sum source currents leaving positive terminal (or magnitude)
            total_current += abs(data["current"])

    # Equivalent resistance seen by first DC source if only one source exists
    equivalent_resistance = None
    if len(voltage_sources) == 1 and total_current > 0:
        V = abs(voltage_sources[0][3])
        equivalent_resistance = V / total_current if total_current != 0 else None

    return {
        "node_voltages": node_voltages,
        "elements": elements,
        "total_current": total_current,
        "equivalent_resistance": equivalent_resistance,
    }

@app.post("/simulate")
def simulate(netlist: Netlist):
    return solve_dc(netlist)

@app.get("/health")
def health():
    return {"status":"ok"}