import type { Entity, Vec2, PolylineEnt, LineEnt, ArcEnt, BlockDef, TextEnt, InsertEnt } from '../model/types';
import { entityPrims, primIntersect, primPoint, closestParam, type Prim, lineLine, arcParam } from '../geom/intersect';
import { arcToBulge, bulgeToArc } from '../geom/bulge';
import { TAU, normAng, dist, type Mat2D, IDENTITY, matMul } from '../geom/vec';
import { transformEntity } from './transform';
import { insertMatrix, resolveStyle } from '../geom/blocks';
import { geometryOf } from '../geom/tessellate';
import { parseMText } from '../geom/mtext';

const EPS = 1e-9;
type Props = Omit<Entity, 'type'> & Record<string, any>;
const propsOf = (e: Entity): Props => {
  const { id, layer, aci, rgb, lineType, ltScale, lineWeight, transparency } = e;
  return { id, layer, aci, rgb, lineType, ltScale, lineWeight, transparency } as Props;
};

function isClosedEnt(e: Entity) { return e.type === 'circle' || (e.type === 'polyline' && e.closed) || (e.type === 'ellipse' && Math.abs(e.t1 - e.t0) >= TAU - 1e-9) || (e.type === 'spline' && e.closed); }

/** Build an entity covering global parameter range [s0,s1] of prims (s1 may exceed N for wrap-around on closed curves). */
function pieceFromPrims(src: Entity, prims: Prim[], s0: number, s1: number): Entity | null {
  const N = prims.length;
  if (s1 - s0 < 1e-9) return null;
  if ((src.type === 'arc' || src.type === 'circle') && N === 1) {
    const pr = prims[0] as Prim & { kind: 'arc' };
    const a0 = pr.a0 + pr.sweep * s0;
    const sw = pr.sweep * (s1 - s0);
    return { ...propsOf(src), type: 'arc', c: pr.c, r: pr.r, a0: normAng(a0), a1: normAng(a0 + sw) } as ArcEnt;
  }
  const pts: number[] = [];
  const bulges: number[] = [];
  let s = s0;
  const at = (g: number) => { const i = Math.min(N - 1, Math.floor(g % N === 0 && g > 0 && g >= N ? N - 1 : g % N)); return { i, t: g - Math.floor(g / N) * N - i }; };
  while (s < s1 - 1e-12) {
    const k = Math.floor(s + 1e-12);
    const next = Math.min(s1, k + 1);
    const pi = ((k % N) + N) % N;
    const pr = prims[pi];
    const t0 = s - k, t1 = next - k;
    const a = primPoint(pr, t0);
    if (!pts.length) pts.push(a.x, a.y);
    const b = primPoint(pr, t1);
    bulges.push(pr.kind === 'arc' ? arcToBulge(pr.sweep * (t1 - t0)) : 0);
    pts.push(b.x, b.y);
    s = next;
  }
  void at;
  bulges.push(0);
  const base = propsOf(src);
  if (src.type === 'line' && pts.length === 4) return { ...base, type: 'line', p1: { x: pts[0], y: pts[1] }, p2: { x: pts[2], y: pts[3] } } as LineEnt;
  if ((src.type === 'arc' || src.type === 'circle') && pts.length === 4) {
    const pr = prims[0] as Prim & { kind: 'arc' };
    const a0 = pr.a0 + pr.sweep * (s0 - Math.floor(s0 / N) * N);
    const sw = pr.sweep * (s1 - s0);
    return { ...base, type: 'arc', c: pr.c, r: pr.r, a0: normAng(a0), a1: normAng(a0 + sw) } as ArcEnt;
  }
  return { ...base, type: 'polyline', pts, bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined, closed: false, width: src.type === 'polyline' ? src.width : undefined } as PolylineEnt;
}

function boundaryPrims(boundaries: Entity[], exclude?: number): Prim[] {
  const out: Prim[] = [];
  for (const b of boundaries) if (b.id !== exclude) out.push(...entityPrims(b));
  return out;
}

function intersectionParams(prims: Prim[], bprims: Prim[]): number[] {
  const s: number[] = [];
  prims.forEach((p, i) => {
    for (const q of bprims) for (const x of primIntersect(p, q)) s.push(i + Math.max(0, Math.min(1, x.t)));
  });
  s.sort((a, b) => a - b);
  return s.filter((v, i) => i === 0 || v - s[i - 1] > 1e-9);
}

/** TRIM: remove the part of `target` between the cutting edges that contains `pick`. */
export function trimEntity(target: Entity, boundaries: Entity[], pick: Vec2): Entity[] | null {
  const prims = entityPrims(target);
  if (!prims.length) return null;
  const N = prims.length;
  const xs = intersectionParams(prims, boundaryPrims(boundaries, target.id));
  const sp = closestParam(prims, pick).s;
  const closed = isClosedEnt(target);
  if (!closed) {
    const cuts = xs.filter((v) => v > 1e-7 && v < N - 1e-7);
    if (!cuts.length) return null;
    let a = 0, b = N;
    for (const c of cuts) { if (c <= sp) a = c; else { b = c; break; } }
    const out: Entity[] = [];
    if (a > 1e-9) { const p = pieceFromPrims(target, prims, 0, a); if (p) out.push(p); }
    if (b < N - 1e-9) { const p = pieceFromPrims(target, prims, b, N); if (p) out.push(p); }
    return out;
  }
  if (xs.length < 2) return null;
  // closed: remove interval containing sp, keep the rest (wrapping)
  let a = xs[xs.length - 1] - N, b = xs[0];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] <= sp) { a = xs[i]; b = xs[i + 1] ?? xs[0] + N; }
  }
  if (sp < xs[0]) { a = xs[xs.length - 1] - N; b = xs[0]; }
  // keep from b to a+N
  const piece = pieceFromPrims(target, prims, b, a + N);
  return piece ? [piece] : [];
}

/** BREAK between two points (same point = split in two) */
export function breakEntity(target: Entity, p1: Vec2, p2: Vec2): Entity[] | null {
  const prims = entityPrims(target);
  if (!prims.length) return null;
  const N = prims.length;
  let s1 = closestParam(prims, p1).s, s2 = closestParam(prims, p2).s;
  if (s1 > s2) [s1, s2] = [s2, s1];
  if (isClosedEnt(target)) {
    if (Math.abs(s2 - s1) < 1e-9) return null;
    const p = pieceFromPrims(target, prims, s2, s1 + N);
    return p ? [p] : [];
  }
  const out: Entity[] = [];
  const a = pieceFromPrims(target, prims, 0, s1); if (a) out.push(a);
  const b = pieceFromPrims(target, prims, s2, N); if (b) out.push(b);
  return out;
}

/** EXTEND the end of an open line/arc/polyline (nearest to pick) to the nearest boundary. */
export function extendEntity(target: Entity, boundaries: Entity[], pick: Vec2): Entity | null {
  if (isClosedEnt(target) || !['line', 'arc', 'polyline'].includes(target.type)) return null;
  const prims = entityPrims(target);
  const N = prims.length;
  const sp = closestParam(prims, pick).s;
  const atEnd = sp > N / 2;
  const pr = atEnd ? prims[N - 1] : prims[0];
  const bprims = boundaryPrims(boundaries, target.id);
  let best: number | null = null;
  for (const q of bprims) {
    for (const x of primIntersect(pr, q, true)) {
      let t = x.t;
      if (pr.kind === 'arc') {
        // consider both representations of the angle
        const alt = t - Math.sign(pr.sweep) * TAU / pr.sweep;
        const cands = [t, alt, t + TAU / Math.abs(pr.sweep)];
        for (const c of cands) {
          if (atEnd && c > 1 + 1e-9 && (best === null || c < best)) best = c;
          if (!atEnd && c < -1e-9 && (best === null || c > best)) best = c;
        }
        continue;
      }
      if (atEnd && t > 1 + 1e-9 && (best === null || t < best)) best = t;
      if (!atEnd && t < -1e-9 && (best === null || t > best)) best = t;
    }
  }
  if (best === null) return null;
  const np = primPoint(pr, best);
  switch (target.type) {
    case 'line': return atEnd ? { ...target, p2: np } : { ...target, p1: np };
    case 'arc': {
      const ang = Math.atan2(np.y - target.c.y, np.x - target.c.x);
      return atEnd ? { ...target, a1: ang } : { ...target, a0: ang };
    }
    case 'polyline': {
      const pts = target.pts.slice();
      const bulges = target.bulges?.slice();
      if (atEnd) {
        pts[pts.length - 2] = np.x; pts[pts.length - 1] = np.y;
        if (bulges && pr.kind === 'arc') bulges[N - 1] = arcToBulge(pr.sweep * best);
      } else {
        pts[0] = np.x; pts[1] = np.y;
        if (bulges && pr.kind === 'arc') bulges[0] = arcToBulge(pr.sweep * (1 - best));
      }
      return { ...target, pts, bulges };
    }
  }
  return null;
}

function offsetPrim(p: Prim, d: number): Prim | null {
  if (p.kind === 'seg') {
    const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, L = Math.hypot(dx, dy);
    if (!L) return null;
    const nx = -dy / L * d, ny = dx / L * d; // left normal
    return { kind: 'seg', a: { x: p.a.x + nx, y: p.a.y + ny }, b: { x: p.b.x + nx, y: p.b.y + ny } };
  }
  // left side of a CCW arc is towards the centre
  const r = p.sweep > 0 ? p.r - d : p.r + d;
  if (r <= 1e-12) return null;
  return { ...p, r };
}

/** OFFSET: parallel copy at distance d on the side of `side` point. */
export function offsetEntity(e: Entity, d: number, side: Vec2): Entity | null {
  const prims = entityPrims(e);
  if (!prims.length || d <= 0) return null;
  // side: sign of cross product with the closest prim direction
  const cp = closestParam(prims, side);
  const k = Math.min(prims.length - 1, Math.floor(cp.s));
  const pr = prims[k];
  let left: boolean;
  if (pr.kind === 'seg') left = (pr.b.x - pr.a.x) * (side.y - pr.a.y) - (pr.b.y - pr.a.y) * (side.x - pr.a.x) > 0;
  else left = (dist(side, pr.c) < pr.r) === (pr.sweep > 0);
  const sd = left ? d : -d;
  switch (e.type) {
    case 'circle': { const r = e.r + (dist(side, e.c) > e.r ? d : -d); return r > 0 ? { ...e, r } : null; }
    case 'arc': { const r = e.r + (dist(side, e.c) > e.r ? d : -d); return r > 0 ? { ...e, r } : null; }
    case 'line': { const o = offsetPrim(prims[0], sd) as Prim & { kind: 'seg' }; return { ...e, p1: o.a, p2: o.b }; }
    case 'polyline': {
      const offs = prims.map((p) => offsetPrim(p, sd));
      if (offs.some((o) => !o)) return null;
      const os = offs as Prim[];
      const n = os.length;
      const closed = e.closed;
      const startOf = (p: Prim) => primPoint(p, 0), endOf = (p: Prim) => primPoint(p, 1);
      const verts: Vec2[] = [];
      const bulges: number[] = [];
      for (let i = 0; i < n; i++) {
        const cur = os[i];
        let start = startOf(cur);
        if (i > 0 || closed) {
          const prev = os[(i - 1 + n) % n];
          if (prev.kind === 'seg' && cur.kind === 'seg') {
            const x = lineLine(prev.a, prev.b, cur.a, cur.b);
            if (x) start = x.p;
          }
        }
        verts.push(start);
        bulges.push(cur.kind === 'arc' ? arcToBulge(cur.sweep) : 0);
      }
      if (!closed) verts.push(endOf(os[n - 1]));
      return { ...e, pts: verts.flatMap((v) => [v.x, v.y]), bulges: bulges.some((b) => b) ? bulges : undefined };
    }
    default: {
      // curves: offset tessellated points along normals (approximation → polyline)
      const g = geometryOf(e);
      const path = g.paths[0];
      if (!path) return null;
      const a = path.pts, out: number[] = [];
      const n = a.length / 2;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        const dx = a[i1 * 2] - a[i0 * 2], dy = a[i1 * 2 + 1] - a[i0 * 2 + 1], L = Math.hypot(dx, dy) || 1;
        out.push(a[i * 2] - dy / L * sd, a[i * 2 + 1] + dx / L * sd);
      }
      return { ...propsOf(e), type: 'polyline', pts: out, closed: path.closed } as PolylineEnt;
    }
  }
}

function lineOf(e: Entity): { a: Vec2; b: Vec2 } | null {
  if (e.type === 'line') return { a: e.p1, b: e.p2 };
  if (e.type === 'polyline' && e.pts.length === 4 && !e.bulges?.some((b) => b)) return { a: { x: e.pts[0], y: e.pts[1] }, b: { x: e.pts[2], y: e.pts[3] } };
  return null;
}

/** FILLET (r ≥ 0) or CHAMFER (d1,d2) between two lines. Returns modified lines + new arc/line. */
export function filletLines(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, r: number, chamfer?: { d1: number; d2: number }): { e1: Entity; e2: Entity; extra: Entity | null } | null {
  const L1 = lineOf(e1), L2 = lineOf(e2);
  if (!L1 || !L2) return null;
  const x = lineLine(L1.a, L1.b, L2.a, L2.b);
  if (!x) return null;
  const X = x.p;
  const side = (L: { a: Vec2; b: Vec2 }, pick: Vec2) => {
    const dx = L.b.x - L.a.x, dy = L.b.y - L.a.y, l = Math.hypot(dx, dy);
    let u = { x: dx / l, y: dy / l };
    if ((pick.x - X.x) * u.x + (pick.y - X.y) * u.y < 0) u = { x: -u.x, y: -u.y };
    // far end on pick side
    const ea = (L.a.x - X.x) * u.x + (L.a.y - X.y) * u.y, eb = (L.b.x - X.x) * u.x + (L.b.y - X.y) * u.y;
    const far = ea > eb ? L.a : L.b;
    return { u, far };
  };
  const s1 = side(L1, pick1), s2 = side(L2, pick2);
  const mk = (src: Entity, p: Vec2, q: Vec2): Entity => src.type === 'line' ? { ...src, p1: p, p2: q } : { ...(src as PolylineEnt), pts: [p.x, p.y, q.x, q.y] };
  if (chamfer) {
    const C1 = { x: X.x + s1.u.x * chamfer.d1, y: X.y + s1.u.y * chamfer.d1 };
    const C2 = { x: X.x + s2.u.x * chamfer.d2, y: X.y + s2.u.y * chamfer.d2 };
    const extra = chamfer.d1 > 0 || chamfer.d2 > 0 ? ({ ...propsOf(e1), id: 0, type: 'line', p1: C1, p2: C2 } as LineEnt) : null;
    return { e1: mk(e1, s1.far, C1), e2: mk(e2, s2.far, C2), extra };
  }
  if (r <= 0) return { e1: mk(e1, s1.far, X), e2: mk(e2, s2.far, X), extra: null };
  const cosT = s1.u.x * s2.u.x + s1.u.y * s2.u.y;
  const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
  if (theta < 1e-6 || Math.PI - theta < 1e-6) return null;
  const t = r / Math.tan(theta / 2);
  const T1 = { x: X.x + s1.u.x * t, y: X.y + s1.u.y * t }, T2 = { x: X.x + s2.u.x * t, y: X.y + s2.u.y * t };
  const bis = { x: s1.u.x + s2.u.x, y: s1.u.y + s2.u.y };
  const bl = Math.hypot(bis.x, bis.y);
  const h = r / Math.sin(theta / 2);
  const C = { x: X.x + bis.x / bl * h, y: X.y + bis.y / bl * h };
  let a0 = Math.atan2(T1.y - C.y, T1.x - C.x), a1 = Math.atan2(T2.y - C.y, T2.x - C.x);
  if (normAng(a1 - a0) > Math.PI) [a0, a1] = [a1, a0];
  const arc: ArcEnt = { ...propsOf(e1), id: 0, type: 'arc', c: C, r, a0, a1 } as ArcEnt;
  return { e1: mk(e1, s1.far, T1), e2: mk(e2, s2.far, T2), extra: arc };
}

/** fillet every corner of a polyline */
export function filletPolyline(e: PolylineEnt, r: number): PolylineEnt {
  const n = e.pts.length / 2;
  if (n < 3 || r <= 0) return e;
  const V = (i: number) => ({ x: e.pts[((i + n) % n) * 2], y: e.pts[((i + n) % n) * 2 + 1] });
  const pts: number[] = [], bulges: number[] = [];
  for (let i = 0; i < n; i++) {
    const isEnd = !e.closed && (i === 0 || i === n - 1);
    const P = V(i);
    if (isEnd || e.bulges?.[i] || e.bulges?.[(i - 1 + n) % n]) { pts.push(P.x, P.y); bulges.push(e.bulges?.[i] ?? 0); continue; }
    const A = V(i - 1), B = V(i + 1);
    const u1 = { x: A.x - P.x, y: A.y - P.y }, u2 = { x: B.x - P.x, y: B.y - P.y };
    const l1 = Math.hypot(u1.x, u1.y), l2 = Math.hypot(u2.x, u2.y);
    const th = Math.acos(Math.max(-1, Math.min(1, (u1.x * u2.x + u1.y * u2.y) / (l1 * l2))));
    const t = r / Math.tan(th / 2);
    if (th < 1e-6 || t > Math.min(l1, l2) * 0.999) { pts.push(P.x, P.y); bulges.push(0); continue; }
    const T1 = { x: P.x + u1.x / l1 * t, y: P.y + u1.y / l1 * t }, T2 = { x: P.x + u2.x / l2 * t, y: P.y + u2.y / l2 * t };
    const turn = (P.x - A.x) * (B.y - P.y) - (P.y - A.y) * (B.x - P.x);
    const sweep = (Math.PI - th) * Math.sign(turn);
    pts.push(T1.x, T1.y, T2.x, T2.y);
    bulges.push(arcToBulge(sweep), 0);
  }
  return { ...e, pts, bulges };
}

/** EXPLODE one level */
export function explodeEntity(e: Entity, blocks: Record<string, BlockDef>): Entity[] | null {
  const base = propsOf(e);
  switch (e.type) {
    case 'polyline': {
      const out: Entity[] = [];
      const n = e.pts.length / 2;
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const a = { x: e.pts[i * 2], y: e.pts[i * 2 + 1] }, b = { x: e.pts[j * 2], y: e.pts[j * 2 + 1] };
        const bu = e.bulges?.[i] ?? 0;
        if (bu) {
          const arc = bulgeToArc(a.x, a.y, b.x, b.y, bu);
          let a0 = arc.a0, a1 = arc.a0 + arc.sweep;
          if (arc.sweep < 0) [a0, a1] = [a1, a0];
          out.push({ ...base, type: 'arc', c: arc.c, r: arc.r, a0: normAng(a0), a1: normAng(a1) } as ArcEnt);
        } else out.push({ ...base, type: 'line', p1: a, p2: b } as LineEnt);
      }
      return out;
    }
    case 'insert': case 'dimension': {
      if (!e.block || !blocks[e.block]) return null;
      const blk = blocks[e.block];
      const out: Entity[] = [];
      const parentStyle = resolveStyle(e, null);
      const cols = e.type === 'insert' ? Math.max(1, e.cols ?? 1) : 1, rows = e.type === 'insert' ? Math.max(1, e.rows ?? 1) : 1;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const m: Mat2D = e.type === 'insert' ? insertMatrix(e, blk, c, r) : (e.xf ?? IDENTITY);
        for (const child of blk.entities) {
          if (child.invisible) continue;
          const st = resolveStyle(child, parentStyle);
          let t = transformEntity(structuredClone(child), m);
          t = { ...t, layer: st.layer, aci: st.aci, rgb: st.rgb, lineType: st.lineType, lineWeight: st.lineWeight, transparency: st.transparency, handle: undefined } as Entity;
          out.push(t);
        }
      }
      if (e.type === 'insert' && e.attribs) for (const a of e.attribs) { const { tag, ...t } = a; void tag; out.push({ ...(t as TextEnt), handle: undefined }); }
      void matMul;
      return out;
    }
    case 'hatch':
      return e.loops.map((l) => ({ ...base, type: 'polyline', pts: l.pts.slice(), bulges: l.bulges?.slice(), closed: true } as PolylineEnt));
    case 'mtext': {
      const parsed = parseMText(e.value);
      const c = Math.cos(e.rot), s = Math.sin(e.rot);
      return parsed.lines.map((line, i) => {
        const dy = -(i + 1) * e.h * 1.666 * (e.lineSpacing || 1) + e.h * 0.666;
        return { ...base, type: 'text', p: { x: e.p.x - dy * s, y: e.p.y + dy * c }, h: e.h, rot: e.rot, value: line, font: e.font } as TextEnt;
      });
    }
    case 'leader': {
      const out: Entity[] = [{ ...base, type: 'polyline', pts: e.pts.slice(), closed: false } as PolylineEnt];
      if (e.text && e.textPos) out.push({ ...base, type: 'mtext', p: e.textPos, h: e.textHeight ?? 2.5, rot: 0, width: 0, attach: 4, value: e.text } as any);
      return out;
    }
    case 'solid':
      return [{ ...base, type: 'polyline', pts: [e.pts[0], e.pts[1], e.pts[2], e.pts[3], e.pts[6] ?? e.pts[4], e.pts[7] ?? e.pts[5], e.pts[4], e.pts[5]], closed: true } as PolylineEnt];
    default: return null;
  }
}

interface Chain { pts: Vec2[]; bulges: number[] }
function toChain(e: Entity): Chain | null {
  switch (e.type) {
    case 'line': return { pts: [e.p1, e.p2], bulges: [0] };
    case 'arc': {
      const sw = normAng(e.a1 - e.a0) || TAU;
      return { pts: [{ x: e.c.x + Math.cos(e.a0) * e.r, y: e.c.y + Math.sin(e.a0) * e.r }, { x: e.c.x + Math.cos(e.a0 + sw) * e.r, y: e.c.y + Math.sin(e.a0 + sw) * e.r }], bulges: [arcToBulge(sw)] };
    }
    case 'polyline': {
      if (e.closed) return null;
      const pts: Vec2[] = [];
      for (let i = 0; i < e.pts.length; i += 2) pts.push({ x: e.pts[i], y: e.pts[i + 1] });
      return { pts, bulges: pts.slice(0, -1).map((_, i) => e.bulges?.[i] ?? 0) };
    }
    default: return null;
  }
}
const revChain = (c: Chain): Chain => ({ pts: c.pts.slice().reverse(), bulges: c.bulges.slice().reverse().map((b) => -b) });

/** JOIN lines/arcs/open polylines with coincident endpoints into one polyline. */
export function joinEntities(ents: Entity[], tol: number): { result: PolylineEnt; used: number[] } | null {
  const items = ents.map((e) => ({ e, c: toChain(e) })).filter((x) => x.c) as { e: Entity; c: Chain }[];
  if (items.length < 2) return null;
  const near = (a: Vec2, b: Vec2) => dist(a, b) <= tol;
  let chain = items[0].c;
  const used = [items[0].e.id];
  const rest = items.slice(1);
  let progress = true;
  while (progress && rest.length) {
    progress = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i].c;
      const end = chain.pts[chain.pts.length - 1], start = chain.pts[0];
      let add: Chain | null = null, atEnd = true;
      if (near(end, c.pts[0])) add = c;
      else if (near(end, c.pts[c.pts.length - 1])) add = revChain(c);
      else if (near(start, c.pts[c.pts.length - 1])) { add = c; atEnd = false; }
      else if (near(start, c.pts[0])) { add = revChain(c); atEnd = false; }
      if (!add) continue;
      if (atEnd) chain = { pts: [...chain.pts, ...add.pts.slice(1)], bulges: [...chain.bulges, ...add.bulges] };
      else chain = { pts: [...add.pts, ...chain.pts.slice(1)], bulges: [...add.bulges, ...chain.bulges] };
      used.push(rest[i].e.id);
      rest.splice(i, 1);
      progress = true;
      break;
    }
  }
  if (used.length < 2) return null;
  let closed = false;
  if (chain.pts.length > 2 && near(chain.pts[0], chain.pts[chain.pts.length - 1])) { chain.pts.pop(); closed = true; }
  else chain.bulges.push(0);
  const first = items[0].e;
  return {
    result: { ...propsOf(first), handle: undefined, type: 'polyline', pts: chain.pts.flatMap((p) => [p.x, p.y]), bulges: chain.bulges.some((b) => b) ? chain.bulges : undefined, closed } as PolylineEnt,
    used,
  };
}

/** convert line/arc/circle to polyline (PEDIT) */
export function toPolyline(e: Entity): PolylineEnt | null {
  if (e.type === 'polyline') return e;
  const c = toChain(e);
  if (c) return { ...propsOf(e), handle: e.handle, type: 'polyline', pts: c.pts.flatMap((p) => [p.x, p.y]), bulges: [...c.bulges, 0].some((b) => b) ? [...c.bulges, 0] : undefined, closed: false } as PolylineEnt;
  if (e.type === 'circle') return { ...propsOf(e), handle: e.handle, type: 'polyline', pts: [e.c.x + e.r, e.c.y, e.c.x - e.r, e.c.y], bulges: [1, 1], closed: true } as PolylineEnt;
  return null;
}

export function reversePolyline(e: PolylineEnt): PolylineEnt {
  const n = e.pts.length / 2;
  const pts: number[] = [];
  for (let i = n - 1; i >= 0; i--) pts.push(e.pts[i * 2], e.pts[i * 2 + 1]);
  let bulges = e.bulges ? e.bulges.slice(0, e.closed ? n : n - 1).reverse().map((b) => -b) : undefined;
  if (bulges && !e.closed) bulges.push(0);
  if (bulges && e.closed) bulges = [...bulges.slice(1), bulges[0]];
  return { ...e, pts, bulges };
}

/** insert a vertex into a polyline at the closest point to p */
export function addVertex(e: PolylineEnt, p: Vec2): PolylineEnt {
  const prims = entityPrims(e);
  const cp = closestParam(prims, p);
  const k = Math.min(prims.length - 1, Math.floor(cp.s));
  const pts = e.pts.slice();
  pts.splice((k + 1) * 2, 0, cp.pt.x, cp.pt.y);
  const bulges = e.bulges?.slice();
  if (bulges) {
    const b = bulges[k] ?? 0;
    const t = cp.s - k;
    const sw = 4 * Math.atan(b);
    bulges.splice(k, 1, Math.tan(sw * t / 4), Math.tan(sw * (1 - t) / 4));
  }
  return { ...e, pts, bulges };
}

export function removeVertex(e: PolylineEnt, p: Vec2): PolylineEnt | null {
  const n = e.pts.length / 2;
  if (n <= 2) return null;
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) { const d = Math.hypot(e.pts[i * 2] - p.x, e.pts[i * 2 + 1] - p.y); if (d < bd) { bd = d; best = i; } }
  const pts = e.pts.slice();
  pts.splice(best * 2, 2);
  const bulges = e.bulges?.slice();
  if (bulges) bulges.splice(best, 1);
  return { ...e, pts, bulges };
}

export { arcParam, EPS };
export type { InsertEnt };
