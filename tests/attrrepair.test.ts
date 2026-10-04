import { describe, it, expect } from 'vitest';
import { repairAttributes } from '../src/cad/io/repair';
import { emptyDrawing, type Entity } from '../src/cad/model/types';

// the real "sub box1" case from Alex_Khorshed_FTTH_003 (handle 11757E)
const P = { x: 216860.94532818143, y: 3456196.90187252 }, ROT = 1.1304245363072434, S = 0.4;
const tr = (q: { x: number; y: number }) => { const c = Math.cos(ROT), s = Math.sin(ROT), lx = q.x * S, ly = q.y * S; return { x: P.x + lx * c - ly * s, y: P.y + lx * s + ly * c }; };
const DEF = { tag: 'SUB', value: 'SUB', p: { x: -3.0697, y: -0.0084 }, p2: { x: -0.0164, y: 1.0546 }, h: 2.1259842519685037, rot: 0, halign: 'middle' as const, valign: 'baseline' as const };

function drawing(attr: Record<string, unknown>, repaired?: number) {
  const d = emptyDrawing('t');
  d.blocks['sub box1'] = { name: 'sub box1', base: { x: 0, y: 0 }, entities: [], attdefs: [DEF] } as any;
  d.entities = [{ id: 1, type: 'insert', layer: '0', block: 'sub box1', p: P, sx: S, sy: S, rot: ROT, attribs: [{ id: 2, type: 'text', layer: '0', tag: 'SUB', value: 'SUB', halign: 'middle', valign: 'baseline', ...attr }] } as unknown as Entity];
  d.meta.attrRepair = repaired;
  return d;
}
const attrOf = (d: ReturnType<typeof drawing>) => (d.entities[0] as any).attribs[0];

describe('attribute repair (acad-ts double transform)', () => {
  const start = tr(DEF.p), align = tr(DEF.p2);
  it('fresh import: undoes position, rotation and height, keeps the alignment point', () => {
    const d = drawing({ p: tr(start), p2: align, rot: 2 * ROT, h: DEF.h * S * S }, 0);
    expect(repairAttributes(d)).toBe(1);
    const a = attrOf(d);
    expect(a.p.x).toBeCloseTo(start.x, 6); expect(a.p.y).toBeCloseTo(start.y, 6);
    expect(a.p2).toEqual(align);
    expect(a.rot).toBeCloseTo(ROT, 9);
    expect(a.h).toBeCloseTo(DEF.h * S, 9);
  });
  it('projects stored by repair v1: restores rotation, height and alignment point once', () => {
    const d = drawing({ p: start, p2: { ...start }, rot: 2 * ROT, h: DEF.h * S * S });
    expect(repairAttributes(d)).toBe(1);
    const a = attrOf(d);
    expect(a.rot).toBeCloseTo(ROT, 9);
    expect(a.h).toBeCloseTo(DEF.h * S, 9);
    expect(a.p2.x).toBeCloseTo(align.x, 9); expect(a.p2.y).toBeCloseTo(align.y, 9);
    expect(repairAttributes(d)).toBe(0); // idempotent
  });
  it('correct attributes are left alone', () => {
    const d = drawing({ p: start, p2: align, rot: ROT, h: DEF.h * S });
    repairAttributes(d);
    expect(attrOf(d)).toMatchObject({ p: start, p2: align, rot: ROT, h: DEF.h * S });
  });
});
