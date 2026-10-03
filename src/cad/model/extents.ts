import type { Drawing, Vec2 } from './types';
import { BoxCache, boxValid } from '../geom/bbox';

/**
 * Robust drawing extents: computes entity boxes, then trims statistical outliers
 * (stray entities far from the main drawing, e.g. objects left at 0,0 in a UTM drawing)
 * so "Fit" frames the real content. Full extents are still available via `full`.
 */
export function computeExtents(d: Drawing): { min: Vec2; max: Vec2; full: { min: Vec2; max: Vec2 } } {
  const cache = new BoxCache(d.blocks);
  const xs: number[] = [], ys: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of d.entities) {
    const layer = e.layer;
    void layer;
    const b = cache.entityBox(e);
    if (!boxValid(b)) continue;
    xs.push((b.minX + b.maxX) / 2); ys.push((b.minY + b.maxY) / 2);
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!xs.length) return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 }, full: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } } };
  const full = { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  if (xs.length < 20) return { ...full, full };
  const q = (arr: number[], p: number) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  const x1 = q(xs, 0.01), x2 = q(xs, 0.99), y1 = q(ys, 0.01), y2 = q(ys, 0.99);
  const w = Math.max(x2 - x1, 1e-6), h = Math.max(y2 - y1, 1e-6);
  const pad = 0.15;
  const tMin = { x: Math.max(minX, x1 - w * pad), y: Math.max(minY, y1 - h * pad) };
  const tMax = { x: Math.min(maxX, x2 + w * pad), y: Math.min(maxY, y2 + h * pad) };
  return { min: tMin, max: tMax, full };
}
