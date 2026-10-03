/** NURBS evaluation (de Boor) for SPLINE entities. */

function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let low = p, high = n + 1, mid = (low + high) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) high = mid; else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** evaluate at parameter u; ctrl flat [x,y,...]; returns [x,y] */
export function evalNurbs(degree: number, ctrl: number[], knots: number[], weights: number[] | undefined, u: number): [number, number] {
  const n = ctrl.length / 2 - 1;
  const p = degree;
  const span = findSpan(n, p, u, knots);
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const idx = span - p + j;
    const w = weights && weights.length > idx ? weights[idx] || 1 : 1;
    d.push([ctrl[idx * 2] * w, ctrl[idx * 2 + 1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = span - p + j;
      const denom = knots[i + p - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
      d[j] = [
        (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
        (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
        (1 - alpha) * d[j - 1][2] + alpha * d[j][2],
      ];
    }
  }
  const w = d[p][2] || 1;
  return [d[p][0] / w, d[p][1] / w];
}

/** make a clamped uniform knot vector */
export function clampedKnots(nCtrl: number, degree: number): number[] {
  const m = nCtrl + degree + 1;
  const k: number[] = [];
  const inner = nCtrl - degree;
  for (let i = 0; i < m; i++) {
    if (i <= degree) k.push(0);
    else if (i >= nCtrl) k.push(1);
    else k.push((i - degree) / inner);
  }
  return k;
}

export function tessellateSpline(degree: number, ctrl: number[], knots: number[], weights?: number[], fit?: number[]): number[] {
  const nCtrl = ctrl.length / 2;
  if (nCtrl < 2) return fit && fit.length >= 4 ? fit.slice() : ctrl.slice();
  let p = Math.max(1, Math.min(degree || 3, nCtrl - 1));
  let U = knots;
  if (!U || U.length !== nCtrl + p + 1) U = clampedKnots(nCtrl, p);
  const u0 = U[p], u1 = U[nCtrl];
  const steps = Math.min(400, Math.max(16, nCtrl * 8));
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = u0 + ((u1 - u0) * i) / steps;
    const [x, y] = evalNurbs(p, ctrl, U, weights, Math.min(u, u1 - 1e-12 * Math.abs(u1 || 1)));
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  // ensure end point equals last control point for clamped splines
  if (out.length >= 2 && U[0] === U[p]) {
    out[out.length - 2] = ctrl[ctrl.length - 2];
    out[out.length - 1] = ctrl[ctrl.length - 1];
  }
  return out;
}

/** Catmull-Rom through fit points (fallback / freehand smoothing) */
export function catmullRom(pts: number[], samples = 8): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const P = (i: number) => {
    const k = Math.max(0, Math.min(n - 1, i));
    return [pts[k * 2], pts[k * 2 + 1]];
  };
  const out: number[] = [pts[0], pts[1]];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 1; s <= samples; s++) {
      const t = s / samples, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < 2; c++) {
        out.push(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
      }
    }
  }
  return out;
}
