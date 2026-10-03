import { describe, it, expect } from 'vitest';
import { emptyDrawing, type Entity } from '../src/cad/model/types';
import { exportDrawing } from '../src/cad/io/acadExport';
import { AcadTsEngine } from '../src/cad/io/engine';

function sample() {
  const d = emptyDrawing('test');
  d.layers.push({ name: 'FIBER', aci: 1, lineType: 'Continuous', lineWeight: 30, transparency: 0, on: true, frozen: false, locked: false, plot: true });
  const ents: Entity[] = [
    { id: 1, type: 'line', layer: 'FIBER', p1: { x: 0, y: 0 }, p2: { x: 100, y: 50 } },
    { id: 2, type: 'circle', layer: '0', aci: 3, c: { x: 10, y: 10 }, r: 5 },
    { id: 3, type: 'polyline', layer: 'FIBER', pts: [0, 0, 10, 0, 10, 10], bulges: [0, 0.5, 0], closed: false },
    { id: 4, type: 'text', layer: '0', p: { x: 1, y: 1 }, h: 2.5, rot: 0, value: 'FAT-027 عربي' },
    { id: 5, type: 'arc', layer: '0', rgb: 0x12ab34, c: { x: 0, y: 0 }, r: 3, a0: 0, a1: Math.PI / 2 },
  ];
  d.entities = ents;
  d.nextId = 6;
  return d;
}

describe('CAD I/O round trip', () => {
  for (const fmt of ['dwg', 'dxf'] as const) {
    it(`writes and reads back a new ${fmt.toUpperCase()}`, () => {
      const out = exportDrawing(sample(), null, fmt);
      expect(out.bytes.length).toBeGreaterThan(1000);
      const back = new AcadTsEngine().read(out.bytes, 'rt.' + fmt).drawing;
      const types = back.entities.map((e) => e.type).sort();
      expect(types).toEqual(['arc', 'circle', 'line', 'polyline', 'text']);
      expect(back.layers.find((l) => l.name === 'FIBER')?.aci).toBe(1);
      const t = back.entities.find((e) => e.type === 'text') as any;
      expect(t.value).toBe('FAT-027 عربي');
      const pl = back.entities.find((e) => e.type === 'polyline') as any;
      expect(pl.bulges?.[1]).toBeCloseTo(0.5);
      const arc = back.entities.find((e) => e.type === 'arc') as any;
      expect(arc.rgb).toBe(0x12ab34);
    });
  }
  it('merges edits into an existing DWG by handle', () => {
    const first = exportDrawing(sample(), null, 'dwg');
    const eng = new AcadTsEngine();
    const d = eng.read(first.bytes, 'a.dwg').drawing;
    const line = d.entities.find((e) => e.type === 'line')!;
    d.entities = d.entities.filter((e) => e.type !== 'circle');
    (line as any).p2 = { x: 200, y: 50 };
    d.entities.push({ id: 999, type: 'point', layer: '0', p: { x: 5, y: 5 } } as Entity);
    const r = exportDrawing(d, first.bytes, 'dwg');
    expect(r.stats).toMatchObject({ deleted: 1, modified: 1, added: 1 });
    const back = eng.read(r.bytes, 'b.dwg').drawing;
    expect(back.entities.some((e) => e.type === 'circle')).toBe(false);
    expect((back.entities.find((e) => e.type === 'line') as any).p2.x).toBeCloseTo(200);
    expect(back.entities.some((e) => e.type === 'point')).toBe(true);
  });
});
