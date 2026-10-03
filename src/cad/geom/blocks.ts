import type { BlockDef, Entity, InsertEnt, DimensionEnt } from '../model/types';
import { type Mat2D, IDENTITY, matMul } from './vec';

/** Style an entity inherits from its parent INSERT (ByBlock / layer 0 rules). */
export interface InheritedStyle {
  layer: string;
  aci?: number;
  rgb?: number;
  lineType?: string;
  lineWeight?: number;
  transparency?: number;
}

export function insertMatrix(ins: InsertEnt, block: BlockDef | undefined, col = 0, row = 0): Mat2D {
  const bx = block?.base.x ?? 0, by = block?.base.y ?? 0;
  const c = Math.cos(ins.rot), s = Math.sin(ins.rot);
  // array offsets are in the insert's rotated frame
  const ox = col * (ins.colSpacing ?? 0), oy = row * (ins.rowSpacing ?? 0);
  const px = ins.p.x + ox * c - oy * s, py = ins.p.y + ox * s + oy * c;
  // T(p) · R(rot) · S(sx,sy) · T(-base)
  return {
    a: c * ins.sx, b: s * ins.sx, c: -s * ins.sy, d: c * ins.sy,
    e: px - (c * ins.sx * bx - s * ins.sy * by),
    f: py - (s * ins.sx * bx + c * ins.sy * by),
  };
}

/** resolve the effective style of a child entity inside an insert */
export function resolveStyle(child: Entity, parent: InheritedStyle | null): InheritedStyle {
  if (!parent) {
    return {
      layer: child.layer, aci: child.aci === 0 ? 7 : child.aci, rgb: child.rgb,
      lineType: child.lineType && /^byblock$/i.test(child.lineType) ? undefined : child.lineType,
      lineWeight: child.lineWeight === -2 ? -3 : child.lineWeight, transparency: child.transparency,
    };
  }
  const byBlockColor = child.aci === 0 && child.rgb === undefined;
  return {
    layer: child.layer === '0' ? parent.layer : child.layer,
    aci: byBlockColor ? parent.aci : child.aci,
    rgb: byBlockColor ? parent.rgb : child.rgb,
    lineType: child.lineType && /^byblock$/i.test(child.lineType) ? parent.lineType : child.lineType,
    lineWeight: child.lineWeight === -2 ? parent.lineWeight : child.lineWeight,
    transparency: child.transparency ?? parent.transparency,
  };
}

export type InsertVisitor = (child: Entity, m: Mat2D, style: InheritedStyle, depth: number) => void;

/**
 * Walk all primitive entities produced by an INSERT (or DIMENSION block), recursively.
 * Inserts inside blocks are expanded; ByBlock properties are inherited.
 */
export function walkInsert(
  ins: InsertEnt | DimensionEnt,
  blocks: Record<string, BlockDef>,
  visit: InsertVisitor,
  parentM: Mat2D = IDENTITY,
  parentStyle: InheritedStyle | null = null,
  depth = 0,
) {
  if (depth > 16 || !ins.block) return;
  const block = blocks[ins.block];
  if (!block) return;
  const style = resolveStyle(ins, parentStyle);
  const cols = ins.type === 'insert' ? Math.max(1, ins.cols ?? 1) : 1;
  const rows = ins.type === 'insert' ? Math.max(1, ins.rows ?? 1) : 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const local = ins.type === 'insert' ? insertMatrix(ins, block, c, r) : (ins.xf ?? IDENTITY);
      const m = matMul(parentM, local);
      for (const child of block.entities) {
        if (child.invisible) continue;
        if (child.type === 'insert' || (child.type === 'dimension' && child.block && blocks[child.block])) {
          walkInsert(child, blocks, visit, m, style, depth + 1);
          if (child.type === 'insert' && child.attribs) {
            const cs = resolveStyle(child, style);
            for (const a of child.attribs) visit(a, m, resolveStyle(a, cs), depth + 1);
          }
        } else {
          visit(child, m, resolveStyle(child, style), depth);
        }
      }
    }
  }
}
