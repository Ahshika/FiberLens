import { describe, it, expect } from 'vitest';
import { bulgeToArc, bulgedLength, bulgedArea, expandBulges } from '../src/cad/geom/bulge';
import { matMirror, matRotate, matApply, matScale } from '../src/cad/geom/vec';
import { transformEntity } from '../src/cad/edit/transform';
import { trimEntity, extendEntity, offsetEntity, filletLines, joinEntities, breakEntity, explodeEntity } from '../src/cad/edit/ops';
import { entityLength, entityArea } from '../src/cad/edit/measure';
import type { Entity } from '../src/cad/model/types';
import { parseMText } from '../src/cad/geom/mtext';
import { evalNurbs, clampedKnots } from '../src/cad/geom/spline';

const L = (x1: number, y1: number, x2: number, y2: number, id = 1): Entity => ({ id, type: 'line', layer: '0', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });

describe('bulges', () => {
  it('semicircle bulge = 1', () => {
    const a = bulgeToArc(0, 0, 2, 0, 1);
    expect(a.r).toBeCloseTo(1);
    expect(a.c.x).toBeCloseTo(1);
    expect(a.c.y).toBeCloseTo(0);
    expect(bulgedLength([0, 0, 2, 0], [1, 0], false)).toBeCloseTo(Math.PI);
  });
  it('circle as 2-vertex closed polyline has area πr²', () => {
    expect(Math.abs(bulgedArea([-1, 0, 1, 0], [1, 1]))).toBeCloseTo(Math.PI, 5);
  });
  it('expand ends exactly on the vertex', () => {
    const p = expandBulges([0, 0, 2, 0], [1, 0], false);
    expect(p[p.length - 2]).toBe(2);
    expect(p[p.length - 1]).toBe(0);
  });
});

describe('transforms', () => {
  it('rotate 90° maps (1,0) to (0,1)', () => {
    const q = matApply(matRotate(Math.PI / 2), { x: 1, y: 0 });
    expect(q.x).toBeCloseTo(0);
    expect(q.y).toBeCloseTo(1);
  });
  it('mirror about the y axis flips x', () => {
    const q = matApply(matMirror({ x: 0, y: 0 }, { x: 0, y: 1 }), { x: 3, y: 2 });
    expect(q.x).toBeCloseTo(-3);
    expect(q.y).toBeCloseTo(2);
  });
  it('scaling a circle scales the radius', () => {
    const c = transformEntity({ id: 1, type: 'circle', layer: '0', c: { x: 0, y: 0 }, r: 2 } as Entity, matScale(3, 3));
    expect((c as any).r).toBeCloseTo(6);
  });
  it('mirrored arc keeps its length', () => {
    const arc: Entity = { id: 1, type: 'arc', layer: '0', c: { x: 0, y: 0 }, r: 5, a0: 0, a1: Math.PI / 3 };
    const m = transformEntity(arc, matMirror({ x: 0, y: 0 }, { x: 0, y: 1 }));
    expect(entityLength(m)).toBeCloseTo(entityLength(arc)!);
  });
});

describe('edit ops', () => {
  it('trims the middle of a line between two cutters', () => {
    const r = trimEntity(L(0, 0, 10, 0), [L(3, -1, 3, 1, 2), L(7, -1, 7, 1, 3)], { x: 5, y: 0 })!;
    expect(r).toHaveLength(2);
    expect((r[0] as any).p2.x).toBeCloseTo(3);
    expect((r[1] as any).p1.x).toBeCloseTo(7);
  });
  it('trims a circle into an arc', () => {
    const r = trimEntity({ id: 1, type: 'circle', layer: '0', c: { x: 0, y: 0 }, r: 5 } as Entity, [L(-10, 0, 10, 0, 2)], { x: 0, y: 5 })!;
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe('arc');
    expect(entityLength(r[0])).toBeCloseTo(Math.PI * 5);
  });
  it('extends a line to a boundary', () => {
    const r = extendEntity(L(0, 0, 4, 0), [L(10, -5, 10, 5, 2)], { x: 3.9, y: 0 }) as any;
    expect(r.p2.x).toBeCloseTo(10);
  });
  it('offsets a closed rectangle outward', () => {
    const rect: Entity = { id: 1, type: 'polyline', layer: '0', pts: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const o = offsetEntity(rect, 1, { x: -5, y: 5 })!;
    expect(entityArea(o)).toBeCloseTo(144);
  });
  it('fillets two perpendicular lines with an arc', () => {
    const r = filletLines(L(0, 0, 10, 0, 1), { x: 5, y: 0 }, L(10, -10, 10, 10, 2), { x: 10, y: -5 }, 2)!;
    expect(r.extra?.type).toBe('arc');
    expect((r.extra as any).r).toBeCloseTo(2);
  });
  it('joins touching lines into a closed polyline', () => {
    const r = joinEntities([L(0, 0, 1, 0, 1), L(1, 0, 1, 1, 2), L(1, 1, 0, 1, 3), L(0, 1, 0, 0, 4)], 1e-6)!;
    expect(r.result.closed).toBe(true);
    expect(entityArea(r.result)).toBeCloseTo(1);
  });
  it('breaks a line into two pieces', () => {
    expect(breakEntity(L(0, 0, 10, 0), { x: 2, y: 0 }, { x: 4, y: 0 })).toHaveLength(2);
  });
  it('explodes a bulged polyline into line + arc', () => {
    const parts = explodeEntity({ id: 1, type: 'polyline', layer: '0', pts: [0, 0, 2, 0, 4, 0], bulges: [0, 1, 0], closed: false } as Entity, {})!;
    expect(parts.map((p) => p.type)).toEqual(['line', 'arc']);
  });
});

describe('text & splines', () => {
  it('parses MTEXT formatting', () => {
    const r = parseMText('{\\fArial|b1;HUAWEI}\\PSecond \\H2x;line');
    expect(r.lines).toEqual(['HUAWEI', 'Second line']);
    expect(r.bold).toBe(true);
  });
  it('evaluates a clamped NURBS at its start', () => {
    const k = clampedKnots(4, 3);
    expect(evalNurbs(3, [0, 0, 1, 2, 3, 2, 4, 0], k, undefined, 0)).toEqual([0, 0]);
  });
});
