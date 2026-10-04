import type { Drawing, Entity, InsertEnt, Vec2 } from '../model/types';

/** bump when the repair changes; stored drawings below this version get the legacy pass once */
export const ATTR_REPAIR_VERSION = 2;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/**
 * acad-ts applies the INSERT transform to ATTRIB insertion points and rotations a second time
 * (the alignment point is read correctly). Undo that exactly:
 *  - insertion point: inverse insert transform once
 *  - rotation: subtract the insert rotation once
 *  - height: divide by the insert Y scale once
 *  - alignment point (anchor of centred / right / middle text): keep as read
 * Attributes that cannot be recovered are re-placed from the block's attribute definitions.
 *
 * Drawings stored by version 1 of this repair lost the alignment point (it was replaced by the
 * start point) and kept the doubled rotation; the legacy pass restores both.
 */
export function repairAttributes(d: Drawing): number {
  if ((d.meta.attrRepair ?? 0) >= ATTR_REPAIR_VERSION) return 0;
  const legacy = d.meta.attrRepair === undefined;
  let fixed = 0;
  const visit = (list: Entity[]) => {
    for (const e of list) {
      if (e.type !== 'insert' || !e.attribs?.length) continue;
      const blk = d.blocks[e.block];
      const s = Math.max(Math.abs(e.sx), Math.abs(e.sy), 1e-9);
      const c = Math.cos(e.rot), sn = Math.sin(e.rot);
      const bx = blk?.base.x ?? 0, by = blk?.base.y ?? 0;
      const tr = (q: Vec2) => { const lx = (q.x - bx) * e.sx, ly = (q.y - by) * e.sy; return { x: e.p.x + lx * c - ly * sn, y: e.p.y + lx * sn + ly * c }; };
      const inv = (q: Vec2) => { const dx = q.x - e.p.x, dy = q.y - e.p.y; const lx = dx * c + dy * sn, ly = -dx * sn + dy * c; return { x: bx + lx / e.sx, y: by + ly / e.sy }; };
      for (const a of e.attribs) {
        const limit = Math.max(200 * (a.h || 1), 500 * s, 100);
        const near = (q: Vec2) => Math.hypot(q.x - e.p.x, q.y - e.p.y) <= limit;
        const def = blk?.attdefs?.find((x) => x.tag === a.tag);
        if (!near(a.p)) {
          const back = inv(a.p);
          if (near(back)) {
            a.p = back;
            a.rot = wrap(a.rot - e.rot);
            if (a.h && Math.abs(e.sy) > 1e-9) a.h /= Math.abs(e.sy);
            if (!a.p2 || !near(a.p2)) {
              const q = a.p2 && inv(a.p2);
              a.p2 = q && near(q) ? q : def?.p2 ? tr(def.p2) : { ...a.p };
            }
          } else if (def?.p) {
            a.p = tr(def.p);
            a.p2 = def.p2 ? tr(def.p2) : a.p;
            if (def.h) a.h = def.h * Math.abs(e.sy);
            a.rot = (def.rot ?? 0) + e.rot;
          } else { a.p = { ...e.p }; a.p2 = { ...e.p }; }
          fixed++;
        } else if (legacy) fixed += legacyFix(e, a, def, tr);
        // an alignment point far from the text (often 0,0 = unset) must not stretch aligned/fit text
        if (a.p2 && Math.hypot(a.p2.x - a.p.x, a.p2.y - a.p.y) > Math.max(1000 * (a.h || 1), 1000)) a.p2 = { ...a.p };
      }
    }
  };
  visit(d.entities);
  for (const b of Object.values(d.blocks)) visit(b.entities);
  d.meta.attrRepair = ATTR_REPAIR_VERSION;
  return fixed;
}

type Attr = NonNullable<InsertEnt['attribs']>[number];
type Def = NonNullable<Drawing['blocks'][string]['attdefs']>[number];

/** stored by repair v1: doubled rotation, alignment point replaced by the start point */
function legacyFix(e: InsertEnt, a: Attr, def: Def | undefined, tr: (q: Vec2) => Vec2): number {
  let n = 0;
  const r0 = def?.rot ?? 0;
  if (Math.abs(wrap(e.rot)) > 1e-6 && Math.abs(wrap(a.rot - r0 - 2 * e.rot)) < 1e-6) { a.rot = wrap(a.rot - e.rot); n = 1; }
  const k = Math.abs(e.sy);
  if (def?.h && a.h && Math.abs(k - 1) > 1e-6 && Math.abs(a.h - def.h * k * k) < 1e-6 * def.h) { a.h = def.h * k; n = 1; }
  const aligned = (a.halign && a.halign !== 'left') || (a.valign && a.valign !== 'baseline');
  if (aligned && def?.p2 && def.p && !same(def.p, def.p2) && (!a.p2 || same(a.p, a.p2))) { a.p2 = tr(def.p2); n = 1; }
  return n;
}
