import type { Entity, Vec2, TextEnt, MTextEnt, InsertEnt } from '../model/types';
import { type Mat2D, matApply, matDet, matMul, matTranslate } from '../geom/vec';

const clone = <T,>(o: T): T => structuredClone(o);

function tPts(m: Mat2D, pts: number[]): number[] {
  const o = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    o[i] = m.a * pts[i] + m.c * pts[i + 1] + m.e;
    o[i + 1] = m.b * pts[i] + m.d * pts[i + 1] + m.f;
  }
  return o;
}
const linAngle = (m: Mat2D, a: number) => Math.atan2(m.b * Math.cos(a) + m.d * Math.sin(a), m.a * Math.cos(a) + m.c * Math.sin(a));
const linVec = (m: Mat2D, v: Vec2): Vec2 => ({ x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y });

/** readable text rotation after a (possibly mirroring) transform (MIRRTEXT = 0 behaviour) */
function textRot(m: Mat2D, rot: number): number {
  const r1 = linAngle(m, rot);
  if (matDet(m) >= 0) return r1;
  const up = { x: -Math.sin(rot), y: Math.cos(rot) };
  const r2 = r1 + Math.PI;
  const s1 = -Math.sin(r1) * up.x + Math.cos(r1) * up.y;
  const s2 = -Math.sin(r2) * up.x + Math.cos(r2) * up.y;
  return s1 >= s2 ? r1 : r2;
}

function tText<T extends TextEnt | MTextEnt>(t: T, m: Mat2D, s: number): T {
  const o = clone(t) as any;
  o.p = matApply(m, t.p);
  if ((t as TextEnt).p2) o.p2 = matApply(m, (t as TextEnt).p2!);
  o.h = t.h * s;
  o.rot = textRot(m, t.rot);
  if (t.type === 'mtext') o.width = (t as MTextEnt).width * s;
  return o;
}

/** Apply a similarity/mirror transform to any entity (returns a new object, same id). */
export function transformEntity(e: Entity, m: Mat2D): Entity {
  const det = matDet(m);
  const s = Math.sqrt(Math.abs(det));
  const mirrored = det < 0;
  switch (e.type) {
    case 'line': return { ...e, p1: matApply(m, e.p1), p2: matApply(m, e.p2) };
    case 'polyline': return {
      ...e, pts: tPts(m, e.pts),
      bulges: e.bulges ? (mirrored ? e.bulges.map((b) => -b) : e.bulges.slice()) : undefined,
      width: e.width ? e.width * s : e.width, widths: e.widths?.map((w) => w * s),
    };
    case 'circle': return { ...e, c: matApply(m, e.c), r: e.r * s };
    case 'arc': {
      const a0 = linAngle(m, e.a0), a1 = linAngle(m, e.a1);
      return { ...e, c: matApply(m, e.c), r: e.r * s, a0: mirrored ? a1 : a0, a1: mirrored ? a0 : a1 };
    }
    case 'ellipse': return {
      ...e, c: matApply(m, e.c), major: linVec(m, e.major),
      t0: mirrored ? -e.t1 : e.t0, t1: mirrored ? -e.t0 : e.t1,
    };
    case 'spline': return { ...e, ctrl: tPts(m, e.ctrl), fit: e.fit ? tPts(m, e.fit) : undefined };
    case 'text': case 'mtext': return tText(e, m, s);
    case 'insert': {
      const o = clone(e) as InsertEnt;
      o.p = matApply(m, e.p);
      if (mirrored) {
        const v = linVec(m, { x: Math.cos(e.rot), y: Math.sin(e.rot) });
        o.rot = Math.atan2(-v.y, -v.x);
        o.sx = -e.sx * s;
      } else {
        o.rot = linAngle(m, e.rot);
        o.sx = e.sx * s;
      }
      o.sy = e.sy * s;
      if (e.attribs) o.attribs = e.attribs.map((a) => tText(a, m, s));
      return o;
    }
    case 'hatch': return {
      ...e,
      loops: e.loops.map((l) => ({ pts: tPts(m, l.pts), bulges: l.bulges ? (mirrored ? l.bulges.map((b) => -b) : l.bulges.slice()) : undefined })),
      patternLines: e.patternLines?.map((pl) => ({
        angle: linAngle(m, pl.angle), base: matApply(m, pl.base), offset: linVec(m, pl.offset), dashes: pl.dashes.map((d) => d * s),
      })),
      patternAngle: e.patternAngle !== undefined ? linAngle(m, e.patternAngle) : undefined,
      patternScale: e.patternScale !== undefined ? e.patternScale * s : undefined,
    };
    case 'point': return { ...e, p: matApply(m, e.p) };
    case 'solid': case 'image': case 'wipeout': return { ...e, pts: tPts(m, e.pts) } as Entity;
    case 'leader': return { ...e, pts: tPts(m, e.pts), textPos: e.textPos ? matApply(m, e.textPos) : undefined, textHeight: e.textHeight ? e.textHeight * s : undefined, arrowSize: e.arrowSize ? e.arrowSize * s : undefined };
    case 'dimension': return {
      ...e, defPts: tPts(m, e.defPts), textPos: matApply(m, e.textPos),
      xf: matMul(m, e.xf ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      measurement: e.measurement * s, textHeight: e.textHeight ? e.textHeight * s : undefined,
    };
  }
  return e;
}

export const translateEntity = (e: Entity, dx: number, dy: number) => transformEntity(e, matTranslate(dx, dy));

const near = (a: Vec2, b: Vec2, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/** Move a characteristic point (grip) of an entity to a new location. */
export function moveGrip(e: Entity, from: Vec2, to: Vec2, tol = 1e-6): Entity {
  const dx = to.x - from.x, dy = to.y - from.y;
  switch (e.type) {
    case 'line':
      if (near(e.p1, from, tol)) return { ...e, p1: to };
      if (near(e.p2, from, tol)) return { ...e, p2: to };
      return translateEntity(e, dx, dy);
    case 'polyline': {
      const pts = e.pts.slice();
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) if (near({ x: pts[i * 2], y: pts[i * 2 + 1] }, from, tol)) {
        pts[i * 2] = to.x; pts[i * 2 + 1] = to.y;
        return { ...e, pts };
      }
      // segment midpoint → move both vertices of that segment
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const mid = { x: (pts[i * 2] + pts[j * 2]) / 2, y: (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2 };
        if (!e.bulges?.[i] && near(mid, from, tol)) {
          pts[i * 2] += dx; pts[i * 2 + 1] += dy; pts[j * 2] += dx; pts[j * 2 + 1] += dy;
          return { ...e, pts };
        }
      }
      return translateEntity(e, dx, dy);
    }
    case 'circle':
      if (near(e.c, from, tol)) return { ...e, c: to };
      return { ...e, r: Math.hypot(to.x - e.c.x, to.y - e.c.y) };
    case 'arc': {
      if (near(e.c, from, tol)) return { ...e, c: to };
      const p0 = { x: e.c.x + Math.cos(e.a0) * e.r, y: e.c.y + Math.sin(e.a0) * e.r };
      const p1 = { x: e.c.x + Math.cos(e.a1) * e.r, y: e.c.y + Math.sin(e.a1) * e.r };
      const ang = Math.atan2(to.y - e.c.y, to.x - e.c.x);
      if (near(p0, from, tol)) return { ...e, a0: ang };
      if (near(p1, from, tol)) return { ...e, a1: ang };
      return { ...e, r: Math.hypot(to.x - e.c.x, to.y - e.c.y) };
    }
    case 'ellipse': {
      if (near(e.c, from, tol)) return { ...e, c: to };
      const maj = { x: e.c.x + e.major.x, y: e.c.y + e.major.y };
      const majN = { x: e.c.x - e.major.x, y: e.c.y - e.major.y };
      if (near(maj, from, tol) || near(majN, from, tol)) {
        const sign = near(maj, from, tol) ? 1 : -1;
        return { ...e, major: { x: (to.x - e.c.x) * sign, y: (to.y - e.c.y) * sign } };
      }
      const L = Math.hypot(e.major.x, e.major.y);
      return { ...e, ratio: Math.max(0.01, Math.min(1, Math.hypot(to.x - e.c.x, to.y - e.c.y) / L)) };
    }
    case 'solid': case 'image': case 'wipeout': case 'leader': {
      const pts = e.pts.slice();
      for (let i = 0; i < pts.length; i += 2) if (near({ x: pts[i], y: pts[i + 1] }, from, tol)) {
        pts[i] = to.x; pts[i + 1] = to.y;
        return { ...e, pts } as Entity;
      }
      return translateEntity(e, dx, dy);
    }
    case 'spline': {
      for (const key of ['fit', 'ctrl'] as const) {
        const arr = e[key];
        if (!arr) continue;
        for (let i = 0; i < arr.length; i += 2) if (near({ x: arr[i], y: arr[i + 1] }, from, tol)) {
          const a = arr.slice(); a[i] = to.x; a[i + 1] = to.y;
          return { ...e, [key]: a };
        }
      }
      return translateEntity(e, dx, dy);
    }
    case 'hatch': {
      const loops = e.loops.map((l) => ({ ...l, pts: l.pts.slice() }));
      for (const l of loops) for (let i = 0; i < l.pts.length; i += 2) if (near({ x: l.pts[i], y: l.pts[i + 1] }, from, tol)) {
        l.pts[i] = to.x; l.pts[i + 1] = to.y;
        return { ...e, loops, patternLines: e.patternLines };
      }
      return translateEntity(e, dx, dy);
    }
    default:
      return translateEntity(e, dx, dy);
  }
}
