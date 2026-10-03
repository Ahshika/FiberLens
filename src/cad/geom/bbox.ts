import type { BlockDef, Entity } from '../model/types';
import { geometryOf, textCorners, transformGeom, type Geometry } from './tessellate';
import { walkInsert } from './blocks';
import { IDENTITY } from './vec';

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export const emptyBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const boxValid = (b: BBox) => b.minX <= b.maxX && b.minY <= b.maxY;
export function boxAddPts(b: BBox, pts: ArrayLike<number>) {
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
  }
}
export function boxUnion(a: BBox, b: BBox) {
  if (b.minX < a.minX) a.minX = b.minX; if (b.maxX > a.maxX) a.maxX = b.maxX;
  if (b.minY < a.minY) a.minY = b.minY; if (b.maxY > a.maxY) a.maxY = b.maxY;
}
export const boxIntersects = (a: BBox, b: BBox) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
export const boxContains = (outer: BBox, inner: BBox) => inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;

export function geomBox(g: Geometry, b: BBox = emptyBox()): BBox {
  for (const p of g.paths) boxAddPts(b, p.pts);
  for (const f of g.fills) for (const l of f) boxAddPts(b, l);
  if (g.masks) for (const f of g.masks) for (const l of f) boxAddPts(b, l);
  for (const t of g.texts) boxAddPts(b, textCorners(t));
  return b;
}

/** World geometry of any entity, expanding INSERT/DIMENSION blocks (without per-child styles). */
export function worldGeometry(e: Entity, blocks: Record<string, BlockDef>): Geometry {
  if (e.type === 'insert' || (e.type === 'dimension' && e.block && blocks[e.block])) {
    const g: Geometry = { paths: [], fills: [], texts: [] };
    walkInsert(e, blocks, (child, m) => {
      const cg = transformGeom(geometryOf(child), m);
      g.paths.push(...cg.paths); g.fills.push(...cg.fills); g.texts.push(...cg.texts);
    });
    if (e.type === 'insert' && e.attribs) for (const a of e.attribs) g.texts.push(...geometryOf(a).texts);
    return g;
  }
  return geometryOf(e);
}

/** Block-local bbox cache (block bbox is transformed for inserts — approximate but fast). */
export class BoxCache {
  private blockBoxes = new Map<string, BBox>();
  constructor(private blocks: Record<string, BlockDef>) {}
  invalidateBlocks() { this.blockBoxes.clear(); }

  entityBox(e: Entity): BBox {
    if (e.type === 'insert' || (e.type === 'dimension' && e.block && this.blocks[e.block])) {
      if (e.type === 'dimension') return geomBox(worldGeometry(e, this.blocks));
      const blk = this.blocks[e.block];
      const b = emptyBox();
      if (blk) {
        const lb = this.blockBox(e.block, 0);
        if (boxValid(lb)) {
          // transform 4 corners via a synthetic walk for the top-level matrix only
          const cols = Math.max(1, e.cols ?? 1), rows = Math.max(1, e.rows ?? 1);
          const c = Math.cos(e.rot), s = Math.sin(e.rot);
          for (let r = 0; r < rows; r += Math.max(1, rows - 1)) {
            for (let cc = 0; cc < cols; cc += Math.max(1, cols - 1)) {
              const ox = cc * (e.colSpacing ?? 0), oy = r * (e.rowSpacing ?? 0);
              const px = e.p.x + ox * c - oy * s, py = e.p.y + ox * s + oy * c;
              const corners = [lb.minX, lb.minY, lb.maxX, lb.minY, lb.maxX, lb.maxY, lb.minX, lb.maxY];
              for (let i = 0; i < 8; i += 2) {
                const lx = (corners[i] - blk.base.x) * e.sx, ly = (corners[i + 1] - blk.base.y) * e.sy;
                boxAddPts(b, [px + lx * c - ly * s, py + lx * s + ly * c]);
              }
              if (cols === 1) break;
            }
            if (rows === 1) break;
          }
        }
      }
      if (e.attribs) for (const a of e.attribs) geomBox(geometryOf(a), b);
      if (!boxValid(b)) boxAddPts(b, [e.p.x, e.p.y]);
      return b;
    }
    const b = geomBox(geometryOf(e));
    if (!boxValid(b) && 'p' in e) boxAddPts(b, [(e as any).p.x, (e as any).p.y]);
    return b;
  }

  blockBox(name: string, depth: number): BBox {
    const cached = this.blockBoxes.get(name);
    if (cached) return cached;
    const blk = this.blocks[name];
    const b = emptyBox();
    if (blk && depth < 16) {
      this.blockBoxes.set(name, b); // guard recursion
      for (const e of blk.entities) {
        if (e.type === 'insert') boxUnion(b, this.entityBox(e));
        else geomBox(geometryOf(e), b);
      }
    }
    this.blockBoxes.set(name, b);
    return b;
  }
}

export { IDENTITY };
