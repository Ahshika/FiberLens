import type { Vec2 } from '../model/types';
import { TAU } from './vec';

export interface ArcParams { c: Vec2; r: number; a0: number; sweep: number }

/** Arc for a polyline segment p1→p2 with bulge b (b = tan(θ/4), positive = CCW). */
export function bulgeToArc(x1: number, y1: number, x2: number, y2: number, b: number): ArcParams {
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  const theta = 4 * Math.atan(b);
  const r = chord / (2 * Math.sin(theta / 2));
  // distance from chord midpoint to centre (signed)
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const h = r * Math.cos(theta / 2);
  // left normal of chord
  const nx = -dy / chord, ny = dx / chord;
  const c = { x: mx + nx * h, y: my + ny * h };
  const a0 = Math.atan2(y1 - c.y, x1 - c.x);
  return { c, r: Math.abs(r), a0, sweep: theta };
}

export function arcToBulge(sweep: number) { return Math.tan(sweep / 4); }

let TESS_TOL = 0;
/** global chord tolerance (drawing units) for arc tessellation; 0 = angle based only */
export function setTessTolerance(tol: number) { TESS_TOL = tol; }

/** number of segments for an arc sweep (≈ 4° per segment, adaptive bounds) */
export function arcSegments(sweep: number, r = 1, maxErr = TESS_TOL): number {
  let n = Math.ceil(Math.abs(sweep) / (TAU / 96));
  if (maxErr > 0 && r > 0) {
    const step = 2 * Math.acos(Math.max(-1, 1 - maxErr / r));
    if (step > 0) n = Math.min(n, Math.max(Math.ceil(Math.abs(sweep) / (TAU / 12)), Math.ceil(Math.abs(sweep) / step)));
  }
  return Math.max(2, Math.min(512, n));
}

/** push points of arc (excluding first point) into out */
export function pushArcPoints(out: number[], c: Vec2, r: number, a0: number, sweep: number, includeFirst = false) {
  const n = arcSegments(sweep, r);
  for (let i = includeFirst ? 0 : 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  }
}

/** expand a bulged vertex list (flat) into polyline points */
export function expandBulges(pts: number[], bulges: number[] | undefined, closed: boolean): number[] {
  const n = pts.length / 2;
  if (n === 0) return [];
  const out: number[] = [pts[0], pts[1]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const b = bulges ? bulges[i] || 0 : 0;
    const x1 = pts[i * 2], y1 = pts[i * 2 + 1], x2 = pts[j * 2], y2 = pts[j * 2 + 1];
    if (Math.abs(b) > 1e-12 && (x1 !== x2 || y1 !== y2)) {
      const a = bulgeToArc(x1, y1, x2, y2, b);
      pushArcPoints(out, a.c, a.r, a.a0, a.sweep);
      // snap last to exact vertex
      out[out.length - 2] = x2; out[out.length - 1] = y2;
    } else {
      out.push(x2, y2);
    }
  }
  return out;
}

/** length of a bulged polyline */
export function bulgedLength(pts: number[], bulges: number[] | undefined, closed: boolean): number {
  const n = pts.length / 2;
  let L = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const x1 = pts[i * 2], y1 = pts[i * 2 + 1], x2 = pts[j * 2], y2 = pts[j * 2 + 1];
    const chord = Math.hypot(x2 - x1, y2 - y1);
    const b = bulges ? bulges[i] || 0 : 0;
    if (Math.abs(b) > 1e-12 && chord > 0) {
      const theta = 4 * Math.atan(Math.abs(b));
      const r = chord / (2 * Math.sin(theta / 2));
      L += r * theta;
    } else L += chord;
  }
  return L;
}

/** signed area of a bulged closed polyline (CCW positive) */
export function bulgedArea(pts: number[], bulges: number[] | undefined): number {
  const n = pts.length / 2;
  let A = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = pts[i * 2], y1 = pts[i * 2 + 1], x2 = pts[j * 2], y2 = pts[j * 2 + 1];
    A += (x1 * y2 - x2 * y1) / 2;
    const b = bulges ? bulges[i] || 0 : 0;
    if (Math.abs(b) > 1e-12) {
      const chord = Math.hypot(x2 - x1, y2 - y1);
      const theta = 4 * Math.atan(b);
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      // circular segment area, signed by bulge direction
      const seg = (r * r / 2) * (Math.abs(theta) - Math.sin(Math.abs(theta)));
      A += Math.sign(b) * seg;
    }
  }
  return A;
}
