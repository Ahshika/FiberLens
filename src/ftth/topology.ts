import { useFtth, linkedEntity } from './store';
import { kindMeta, CIVIL } from './model';
import type { FtthObjectRow, CableRow, SplitterRow, SpliceRow } from '../data/db';
import { db } from '../data/db';

interface Edge { to: string; cable?: CableRow; kind: 'cable' | 'parent' }
export interface Graph { adj: Map<string, Edge[]>; objects: Map<string, FtthObjectRow> }

export function buildGraph(): Graph {
  const s = useFtth.getState();
  const adj = new Map<string, Edge[]>();
  const add = (a: string, e: Edge) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(e); };
  for (const c of s.cables.values()) {
    if (!c.fromId || !c.toId || c.category === 'duct' || c.category === 'conduit') continue;
    add(c.fromId, { to: c.toId, cable: c, kind: 'cable' });
    add(c.toId, { to: c.fromId, cable: c, kind: 'cable' });
  }
  for (const o of s.objects.values()) {
    if (o.parentId && s.objects.has(o.parentId)) {
      add(o.id, { to: o.parentId, kind: 'parent' });
      add(o.parentId, { to: o.id, kind: 'parent' });
    }
  }
  return { adj, objects: s.objects };
}

export interface TraceStep { objectId: string; via?: CableRow; viaParent?: boolean }
export interface TraceResult {
  steps: TraceStep[];
  objectIds: string[];
  cableIds: string[];
  entityIds: number[];
  customers: FtthObjectRow[];
  reachedHeadEnd: boolean;
  totalLength: number;
}

const level = (g: Graph, id: string) => kindMeta(g.objects.get(id)!.kind).level;

function entityIdsFor(objIds: string[], cables: CableRow[]): number[] {
  const out: number[] = [];
  const s = useFtth.getState();
  for (const id of objIds) { const o = s.objects.get(id); const e = o && linkedEntity(o.cad); if (e) out.push(e.id); }
  for (const c of cables) { const e = linkedEntity(c.cad); if (e) out.push(e.id); }
  return out;
}

/**
 * Upstream trace: shortest route from an object (customer, FAT…) to the head-end (OLT),
 * preferring moves towards lower hierarchy levels.
 */
export function traceUpstream(startId: string, g = buildGraph()): TraceResult {
  const dist = new Map<string, number>([[startId, 0]]);
  const prev = new Map<string, { from: string; edge: Edge }>();
  const pq = new MinHeap();
  pq.push(0, startId);
  let target: string | null = null;
  let bestRoot = startId;
  while (pq.size) {
    const [d, u] = pq.pop()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    const ou = g.objects.get(u);
    if (!ou) continue;
    if (ou.kind === 'OLT' && u !== startId) { target = u; break; }
    if (level(g, u) < level(g, bestRoot) || (level(g, u) === level(g, bestRoot) && d < (dist.get(bestRoot) ?? 0))) bestRoot = u;
    for (const e of g.adj.get(u) ?? []) {
      if (!g.objects.has(e.to)) continue;
      if (CIVIL.includes(g.objects.get(e.to)!.kind)) continue;
      const up = level(g, e.to) <= level(g, u);
      const w = (up ? 1 : 6) + (e.kind === 'parent' ? 0.5 : 0);
      const nd = d + w;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: u, edge: e }); pq.push(nd, e.to); }
    }
  }
  const end = target ?? bestRoot;
  const chain: TraceStep[] = [];
  let cur: string | undefined = end;
  while (cur) {
    const p = prev.get(cur);
    chain.push({ objectId: cur, via: p?.edge.cable, viaParent: p?.edge.kind === 'parent' });
    cur = p?.from;
  }
  chain.reverse(); // start → … → head-end
  // shift "via" so each step carries the cable used to reach the NEXT element upstream
  const steps: TraceStep[] = chain.map((s, i) => ({ objectId: s.objectId, via: chain[i + 1]?.via, viaParent: chain[i + 1]?.viaParent }));
  const cables = steps.map((s) => s.via).filter(Boolean) as CableRow[];
  const objectIds = steps.map((s) => s.objectId);
  return {
    steps, objectIds, cableIds: cables.map((c) => c.id), entityIds: entityIdsFor(objectIds, cables), customers: [],
    reachedHeadEnd: !!target, totalLength: cables.reduce((s, c) => s + (c.length || 0) + (c.slack || 0), 0),
  };
}

/** Downstream trace: everything fed by an object (e.g. OLT port, FDT, splitter) and its customers. */
export function traceDownstream(startId: string, g = buildGraph()): TraceResult {
  // depth from the head-end of this component
  const up = traceUpstream(startId, g);
  const root = up.objectIds[up.objectIds.length - 1] ?? startId;
  const depth = new Map<string, number>([[root, 0]]);
  const q = [root];
  while (q.length) {
    const u = q.shift()!;
    for (const e of g.adj.get(u) ?? []) if (!depth.has(e.to) && g.objects.has(e.to)) { depth.set(e.to, depth.get(u)! + 1); q.push(e.to); }
  }
  const seen = new Set([startId]);
  const cables: CableRow[] = [];
  const stack = [startId];
  const startLevel = level(g, startId);
  while (stack.length) {
    const u = stack.pop()!;
    for (const e of g.adj.get(u) ?? []) {
      if (seen.has(e.to) || !g.objects.has(e.to)) continue;
      if (CIVIL.includes(g.objects.get(e.to)!.kind)) continue;
      if ((depth.get(e.to) ?? 0) <= (depth.get(u) ?? 0)) continue;
      // never climb above the start element in the hierarchy (no head-ends downstream of a box)
      if (level(g, e.to) < startLevel) continue;
      seen.add(e.to);
      if (e.cable) cables.push(e.cable);
      stack.push(e.to);
    }
  }
  const objectIds = [...seen];
  const customers = objectIds.map((id) => g.objects.get(id)!).filter((o) => o.kind === 'Customer');
  return {
    steps: objectIds.map((id) => ({ objectId: id })), objectIds, cableIds: cables.map((c) => c.id),
    entityIds: entityIdsFor(objectIds, cables), customers, reachedHeadEnd: true,
    totalLength: cables.reduce((s, c) => s + (c.length || 0), 0),
  };
}

/** objects that a fault on `objectId` would affect, with the probable root-cause candidates (upstream chain) */
export function faultImpact(objectId: string) {
  const down = traceDownstream(objectId);
  const up = traceUpstream(objectId);
  return { affected: down, suspects: up };
}

export interface CoreHop { cableId: string; core: number; via: string }

/** follow a single fibre through splices and splitters */
export async function traceCore(projectId: string, cableId: string, core: number): Promise<CoreHop[]> {
  const splices: SpliceRow[] = await db.splices.where('projectId').equals(projectId).toArray();
  const splitters: SplitterRow[] = [...useFtth.getState().splitters.values()];
  const key = (c: string, n: number) => `${c}#${n}`;
  const seen = new Set<string>([key(cableId, core)]);
  const out: CoreHop[] = [{ cableId, core, via: 'start' }];
  const q: { c: string; n: number }[] = [{ c: cableId, n: core }];
  while (q.length) {
    const { c, n } = q.shift()!;
    for (const sp of splices) {
      let other: { cableId: string; core: number } | null = null;
      if (sp.a.cableId === c && sp.a.core === n) other = sp.b;
      else if (sp.b.cableId === c && sp.b.core === n) other = sp.a;
      if (other && !seen.has(key(other.cableId, other.core))) {
        seen.add(key(other.cableId, other.core));
        out.push({ cableId: other.cableId, core: other.core, via: `splice${sp.closureId ? ' @' + (useFtth.getState().objects.get(sp.closureId)?.code ?? '') : ''}` });
        q.push({ c: other.cableId, n: other.core });
      }
    }
    for (const s of splitters) {
      if (s.input?.cableId === c && s.input.core === n) {
        for (const o of s.outputs) if (o.cableId && o.core && !seen.has(key(o.cableId, o.core))) {
          seen.add(key(o.cableId, o.core));
          out.push({ cableId: o.cableId, core: o.core, via: `splitter ${s.code} port ${o.port}` });
          q.push({ c: o.cableId, n: o.core });
        }
      }
      for (const o of s.outputs) if (o.cableId === c && o.core === n && s.input?.cableId && s.input.core && !seen.has(key(s.input.cableId, s.input.core))) {
        seen.add(key(s.input.cableId, s.input.core));
        out.push({ cableId: s.input.cableId, core: s.input.core, via: `splitter ${s.code} input` });
        q.push({ c: s.input.cableId, n: s.input.core });
      }
    }
  }
  return out;
}

/** binary min-heap of [priority, id] */
class MinHeap {
  private a: [number, string][] = [];
  get size() { return this.a.length; }
  push(p: number, v: string) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop(): [number, string] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}
