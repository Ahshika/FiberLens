import type { Mat2D } from '../cad/geom/vec';

export interface Pair { src: { x: number; y: number }; dst: { x: number; y: number } }
export type FitMethod = 'translation' | 'helmert' | 'affine';
export interface FitResult {
  m: Mat2D;
  method: FitMethod;
  residuals: number[];
  rms: number;
  /** similarity scale and rotation (for display) */
  scale: number;
  rotation: number;
}

function apply(m: Mat2D, p: { x: number; y: number }) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

function finish(m: Mat2D, method: FitMethod, pairs: Pair[]): FitResult {
  const residuals = pairs.map((p) => { const q = apply(m, p.src); return Math.hypot(q.x - p.dst.x, q.y - p.dst.y); });
  const rms = residuals.length ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) : 0;
  return { m, method, residuals, rms, scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)), rotation: Math.atan2(m.b, m.a) };
}

/** solve small dense linear system (Gaussian elimination with partial pivoting) */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-15) throw new Error('Singular system — control points are collinear or duplicated');
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r[n]);
}

/**
 * Least-squares transform src → dst.
 * - translation: 1+ points (scale 1, no rotation)
 * - helmert: 2+ points (4-parameter similarity: scale, rotation, translation)
 * - affine: 3+ points (6-parameter)
 * Coordinates are centred before solving for numerical stability (UTM ~ 10^6).
 */
export function fitTransform(pairs: Pair[], method: FitMethod): FitResult {
  const n = pairs.length;
  if (!n) throw new Error('No control points');
  const sc = { x: pairs.reduce((s, p) => s + p.src.x, 0) / n, y: pairs.reduce((s, p) => s + p.src.y, 0) / n };
  const dc = { x: pairs.reduce((s, p) => s + p.dst.x, 0) / n, y: pairs.reduce((s, p) => s + p.dst.y, 0) / n };
  const P = pairs.map((p) => ({ sx: p.src.x - sc.x, sy: p.src.y - sc.y, dx: p.dst.x - dc.x, dy: p.dst.y - dc.y }));
  let local: Mat2D;
  if (method === 'translation' || (method === 'helmert' && n < 2) || (method === 'affine' && n < 2)) {
    local = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    method = 'translation';
  } else if (method === 'helmert' || (method === 'affine' && n < 3)) {
    // x' = a x - b y ; y' = b x + a y
    let sxx = 0, sab = 0, sbb = 0;
    for (const p of P) {
      sxx += p.sx * p.sx + p.sy * p.sy;
      sab += p.sx * p.dx + p.sy * p.dy;
      sbb += p.sx * p.dy - p.sy * p.dx;
    }
    if (sxx < 1e-18) throw new Error('Control points coincide');
    const a = sab / sxx, b = sbb / sxx;
    local = { a, b, c: -b, d: a, e: 0, f: 0 };
    method = 'helmert';
  } else {
    // normal equations for [a c] and [b d]
    let xx = 0, xy = 0, yy = 0, xX = 0, yX = 0, xY = 0, yY = 0;
    for (const p of P) {
      xx += p.sx * p.sx; xy += p.sx * p.sy; yy += p.sy * p.sy;
      xX += p.sx * p.dx; yX += p.sy * p.dx; xY += p.sx * p.dy; yY += p.sy * p.dy;
    }
    const [a, c] = solve([[xx, xy], [xy, yy]], [xX, yX]);
    const [b, d] = solve([[xx, xy], [xy, yy]], [xY, yY]);
    local = { a, b, c, d, e: 0, f: 0 };
  }
  // un-centre: dst = L (src - sc) + dc
  const m: Mat2D = { ...local, e: dc.x - (local.a * sc.x + local.c * sc.y), f: dc.y - (local.b * sc.x + local.d * sc.y) };
  return finish(m, method, pairs);
}

export function invert(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c;
  const ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
  return { a: ia, b: ib, c: ic, d: id, e: -(ia * m.e + ic * m.f), f: -(ib * m.e + id * m.f) };
}

export { apply as applyMat };
