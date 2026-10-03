import type { Vec2 } from '../model/types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;
export const norm = (a: Vec2): Vec2 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const angleOf = (a: Vec2, b: Vec2) => Math.atan2(b.y - a.y, b.x - a.x);
export const polar = (c: Vec2, ang: number, r: number): Vec2 => ({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });
export const rotateAround = (p: Vec2, c: Vec2, ang: number): Vec2 => {
  const s = Math.sin(ang), co = Math.cos(ang);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
};
export const eq = (a: Vec2, b: Vec2, tol = 1e-9) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export const TAU = Math.PI * 2;
/** normalise angle into [0, 2π) */
export const normAng = (a: number) => { a %= TAU; return a < 0 ? a + TAU : a; };
/** CCW sweep from a0 to a1 in (0, 2π] */
export const ccwSweep = (a0: number, a1: number) => { const s = normAng(a1 - a0); return s === 0 ? TAU : s; };
/** is angle a within CCW arc a0→a1 */
export const angleInArc = (a: number, a0: number, a1: number, eps = 1e-9) => {
  const s = ccwSweep(a0, a1);
  const d = normAng(a - a0);
  return d <= s + eps || d >= TAU - eps;
};

/** distance from p to segment ab, plus parameter t */
export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

export function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return { pt: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** 2D affine matrix [a c e; b d f] mapping (x,y) → (a x + c y + e, b x + d y + f) */
export interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }
export const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const matMul = (m: Mat2D, n: Mat2D): Mat2D => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
export const matApply = (m: Mat2D, p: Vec2): Vec2 => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
export const matTranslate = (dx: number, dy: number): Mat2D => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export const matRotate = (ang: number, c: Vec2 = { x: 0, y: 0 }): Mat2D => {
  const s = Math.sin(ang), co = Math.cos(ang);
  return { a: co, b: s, c: -s, d: co, e: c.x - co * c.x + s * c.y, f: c.y - s * c.x - co * c.y };
};
export const matScale = (sx: number, sy: number, c: Vec2 = { x: 0, y: 0 }): Mat2D =>
  ({ a: sx, b: 0, c: 0, d: sy, e: c.x - sx * c.x, f: c.y - sy * c.y });
/** mirror about the line through p1, p2 */
export const matMirror = (p1: Vec2, p2: Vec2): Mat2D => {
  const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const c2 = Math.cos(2 * ang), s2 = Math.sin(2 * ang);
  const m: Mat2D = { a: c2, b: s2, c: s2, d: -c2, e: 0, f: 0 };
  // translate so p1 maps to itself
  const q = matApply(m, p1);
  return { ...m, e: p1.x - q.x, f: p1.y - q.y };
};
export const matInvert = (m: Mat2D): Mat2D => {
  const det = m.a * m.d - m.b * m.c;
  const ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
  return { a: ia, b: ib, c: ic, d: id, e: -(ia * m.e + ic * m.f), f: -(ib * m.e + id * m.f) };
};
export const matDet = (m: Mat2D) => m.a * m.d - m.b * m.c;
/** uniform scale factor of a similarity matrix */
export const matScaleFactor = (m: Mat2D) => Math.sqrt(Math.abs(matDet(m)));
export const matRotation = (m: Mat2D) => Math.atan2(m.b, m.a);
