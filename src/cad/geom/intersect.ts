import type { Entity, Vec2 } from '../model/types';
import { bulgeToArc } from './bulge';
import { ccwSweep, TAU, normAng } from './vec';
import { geometryOf } from './tessellate';

/** Primitive curve pieces: straight segment or circular arc (signed sweep). */
export type Prim =
  | { kind: 'seg'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number };

export function segSegIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** infinite line intersection: returns params along each line */
export function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { p: Vec2; t: number; u: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return { p: { x: a.x + t * r.x, y: a.y + t * r.y }, t, u };
}

/** line (a + t·(b−a)) ∩ circle → params t */
export function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): number[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return [];
  const sq = Math.sqrt(disc);
  return disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
}

export function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = Math.hypot(c2.x - c1.x, c2.y - c1.y);
  if (d === 0 || d > r1 + r2 + 1e-12 || d < Math.abs(r1 - r2) - 1e-12) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + (a * (c2.x - c1.x)) / d, my = c1.y + (a * (c2.y - c1.y)) / d;
  const ox = (h * (c2.y - c1.y)) / d, oy = (h * (c2.x - c1.x)) / d;
  if (h < 1e-12) return [{ x: mx, y: my }];
  return [{ x: mx + ox, y: my - oy }, { x: mx - ox, y: my + oy }];
}

/** parameter (0..1 along signed sweep) of angle on arc, or null if outside (unless extend) */
export function arcParam(p: Prim & { kind: 'arc' }, ang: number, extend = false): number | null {
  const sw = p.sweep;
  let d = sw >= 0 ? normAng(ang - p.a0) : -normAng(p.a0 - ang);
  let t = d / sw;
  if (t > 1 + 1e-9 && !extend) {
    // maybe it's at the other side numerically near 0
    if (Math.abs(sw) >= TAU - 1e-9) t = 0;
    else return null;
  }
  if (extend && t > 1) {
    // choose the representation closest to the arc (allow negative extension)
    const alt = (d - Math.sign(sw) * TAU) / sw;
    if (Math.abs(alt) < Math.abs(t - 1)) t = alt;
  }
  return t;
}

export function primPoint(p: Prim, t: number): Vec2 {
  if (p.kind === 'seg') return { x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t };
  const a = p.a0 + p.sweep * t;
  return { x: p.c.x + Math.cos(a) * p.r, y: p.c.y + Math.sin(a) * p.r };
}

export function primLength(p: Prim): number {
  return p.kind === 'seg' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : Math.abs(p.sweep) * p.r;
}

/** intersections of prim p (params on p) with prim q (must lie within q). extendP allows t outside [0,1]. */
export function primIntersect(p: Prim, q: Prim, extendP = false): { t: number; pt: Vec2 }[] {
  const out: { t: number; pt: Vec2 }[] = [];
  const inQ = (pt: Vec2): boolean => {
    if (q.kind === 'seg') {
      const dx = q.b.x - q.a.x, dy = q.b.y - q.a.y;
      const l2 = dx * dx + dy * dy;
      const u = l2 ? ((pt.x - q.a.x) * dx + (pt.y - q.a.y) * dy) / l2 : 0;
      return u >= -1e-9 && u <= 1 + 1e-9;
    }
    return arcParam(q, Math.atan2(pt.y - q.c.y, pt.x - q.c.x)) !== null;
  };
  const okT = (t: number) => extendP || (t >= -1e-9 && t <= 1 + 1e-9);
  if (p.kind === 'seg') {
    if (q.kind === 'seg') {
      const r = lineLine(p.a, p.b, q.a, q.b);
      if (r && okT(r.t) && r.u >= -1e-9 && r.u <= 1 + 1e-9) out.push({ t: r.t, pt: r.p });
    } else {
      for (const t of lineCircle(p.a, p.b, q.c, q.r)) {
        const pt = primPoint(p, t);
        if (okT(t) && inQ(pt)) out.push({ t, pt });
      }
    }
  } else {
    let pts: Vec2[];
    if (q.kind === 'seg') {
      pts = lineCircle(q.a, q.b, p.c, p.r).filter((u) => u >= -1e-9 && u <= 1 + 1e-9).map((u) => primPoint(q, u));
    } else {
      pts = circleCircle(p.c, p.r, q.c, q.r).filter(inQ);
    }
    for (const pt of pts) {
      const t = arcParam(p, Math.atan2(pt.y - p.c.y, pt.x - p.c.x), extendP);
      if (t !== null && okT(t)) out.push({ t, pt });
    }
  }
  return out;
}

/** decompose an entity into primitives (lines/arcs exact; curves tessellated) */
export function entityPrims(e: Entity): Prim[] {
  switch (e.type) {
    case 'line': return [{ kind: 'seg', a: e.p1, b: e.p2 }];
    case 'arc': return [{ kind: 'arc', c: e.c, r: e.r, a0: e.a0, sweep: ccwSweep(e.a0, e.a1) }];
    case 'circle': return [{ kind: 'arc', c: e.c, r: e.r, a0: 0, sweep: TAU }];
    case 'polyline': {
      const n = e.pts.length / 2;
      const out: Prim[] = [];
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const a = { x: e.pts[i * 2], y: e.pts[i * 2 + 1] }, b = { x: e.pts[j * 2], y: e.pts[j * 2 + 1] };
        const bu = e.bulges?.[i] ?? 0;
        if (bu && (a.x !== b.x || a.y !== b.y)) {
          const arc = bulgeToArc(a.x, a.y, b.x, b.y, bu);
          out.push({ kind: 'arc', c: arc.c, r: arc.r, a0: arc.a0, sweep: arc.sweep });
        } else out.push({ kind: 'seg', a, b });
      }
      return out;
    }
    default: {
      const g = geometryOf(e);
      const out: Prim[] = [];
      for (const p of g.paths) {
        const a = p.pts;
        for (let i = 0; i + 3 < a.length; i += 2) out.push({ kind: 'seg', a: { x: a[i], y: a[i + 1] }, b: { x: a[i + 2], y: a[i + 3] } });
        if (p.closed && a.length >= 6) out.push({ kind: 'seg', a: { x: a[a.length - 2], y: a[a.length - 1] }, b: { x: a[0], y: a[1] } });
      }
      return out;
    }
  }
}

/** closest global parameter (primIndex + t) on prims to point */
export function closestParam(prims: Prim[], p: Vec2): { s: number; d: number; pt: Vec2 } {
  let best = { s: 0, d: Infinity, pt: p };
  prims.forEach((pr, i) => {
    let t: number;
    if (pr.kind === 'seg') {
      const dx = pr.b.x - pr.a.x, dy = pr.b.y - pr.a.y;
      const l2 = dx * dx + dy * dy;
      t = l2 ? Math.max(0, Math.min(1, ((p.x - pr.a.x) * dx + (p.y - pr.a.y) * dy) / l2)) : 0;
    } else {
      const tt = arcParam(pr, Math.atan2(p.y - pr.c.y, p.x - pr.c.x));
      if (tt === null) {
        const d0 = Math.hypot(primPoint(pr, 0).x - p.x, primPoint(pr, 0).y - p.y);
        const d1 = Math.hypot(primPoint(pr, 1).x - p.x, primPoint(pr, 1).y - p.y);
        t = d0 < d1 ? 0 : 1;
      } else t = tt;
    }
    const q = primPoint(pr, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { s: i + t, d, pt: q };
  });
  return best;
}

/** total length of prims up to global parameter s */
export function lengthAt(prims: Prim[], s: number): number {
  let L = 0;
  const k = Math.floor(s);
  for (let i = 0; i < Math.min(k, prims.length); i++) L += primLength(prims[i]);
  if (k < prims.length) L += primLength(prims[k]) * (s - k);
  return L;
}
