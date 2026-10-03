import type { Entity, Vec2 } from '../model/types';
import { bulgedLength, bulgedArea } from '../geom/bulge';
import { ccwSweep } from '../geom/vec';
import { geometryOf, pathLength } from '../geom/tessellate';

/** curve length in drawing units (null for non-curves) */
export function entityLength(e: Entity): number | null {
  switch (e.type) {
    case 'line': return Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    case 'polyline': return bulgedLength(e.pts, e.bulges, e.closed);
    case 'circle': return 2 * Math.PI * e.r;
    case 'arc': return ccwSweep(e.a0, e.a1) * e.r;
    case 'ellipse': case 'spline': case 'leader': {
      const g = geometryOf(e);
      return g.paths.reduce((s, p) => s + pathLength(p), 0);
    }
    default: return null;
  }
}

/** enclosed area (closed curves only) */
export function entityArea(e: Entity): number | null {
  switch (e.type) {
    case 'polyline': return e.closed ? Math.abs(bulgedArea(e.pts, e.bulges)) : null;
    case 'circle': return Math.PI * e.r * e.r;
    case 'ellipse': return Math.abs(e.t1 - e.t0) >= Math.PI * 2 - 1e-9 ? Math.PI * Math.hypot(e.major.x, e.major.y) ** 2 * e.ratio : null;
    case 'hatch': return e.loops.reduce((s, l, i) => s + (i === 0 ? 1 : -1) * Math.abs(bulgedArea(l.pts, l.bulges)), 0);
    default: return null;
  }
}

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a / 2);
}

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** angle at vertex b between rays b→a and b→c, degrees 0..180 */
export function angleAt(a: Vec2, b: Vec2, c: Vec2): number {
  const a1 = Math.atan2(a.y - b.y, a.x - b.x), a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(a1 - a2) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}
