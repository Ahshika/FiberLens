import type { Drawing, Entity, Vec2 } from '../model/types';

/**
 * Some DWGs carry attribute positions that are far away from their INSERT (corrupt or
 * stale OCS data). Re-place such attributes from the block's attribute definitions.
 */
export function repairAttributes(d: Drawing): number {
  let fixed = 0;
  const visit = (list: Entity[]) => {
    for (const e of list) {
      if (e.type !== 'insert' || !e.attribs?.length) continue;
      const blk = d.blocks[e.block];
      const s = Math.max(Math.abs(e.sx), Math.abs(e.sy), 1e-9);
      for (const a of e.attribs) {
        // an alignment point far from the text (often 0,0 = unset) must not stretch aligned/fit text
        if (a.p2 && Math.hypot(a.p2.x - a.p.x, a.p2.y - a.p.y) > Math.max(1000 * (a.h || 1), 1000)) a.p2 = { ...a.p };
        const dist = Math.hypot(a.p.x - e.p.x, a.p.y - e.p.y);
        const limit = Math.max(200 * (a.h || 1), 500 * s, 100);
        if (dist <= limit) continue;
        const def = blk?.attdefs?.find((x) => x.tag === a.tag);
        const c = Math.cos(e.rot), sn = Math.sin(e.rot);
        const bx = blk?.base.x ?? 0, by = blk?.base.y ?? 0;
        const tr = (q: Vec2) => { const lx = (q.x - bx) * e.sx, ly = (q.y - by) * e.sy; return { x: e.p.x + lx * c - ly * sn, y: e.p.y + lx * sn + ly * c }; };
        // the reader sometimes applies the insert transform twice: undo it exactly
        const inv = (q: Vec2) => { const dx = q.x - e.p.x, dy = q.y - e.p.y; const lx = dx * c + dy * sn, ly = -dx * sn + dy * c; return { x: bx + lx / e.sx, y: by + ly / e.sy }; };
        const back = inv(a.p);
        if (Math.hypot(back.x - e.p.x, back.y - e.p.y) <= limit) {
          a.p = back;
          if (a.p2) { const q = inv(a.p2); a.p2 = Math.hypot(q.x - a.p.x, q.y - a.p.y) <= limit ? q : { ...a.p }; }
          fixed++;
          continue;
        }
        if (def?.p) {
          a.p = tr(def.p);
          a.p2 = def.p2 ? tr(def.p2) : a.p;
          if (def.h) a.h = def.h * Math.abs(e.sy);
          a.rot = (def.rot ?? 0) + e.rot;
        } else { a.p = { ...e.p }; a.p2 = { ...e.p }; }
        fixed++;
      }
    }
  };
  visit(d.entities);
  for (const b of Object.values(d.blocks)) visit(b.entities);
  return fixed;
}

