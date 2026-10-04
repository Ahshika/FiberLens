import { describe, it, expect } from 'vitest';
import { packDrawing, unpackDrawing } from '../src/data/drawingCodec';
import { packJson } from '../src/data/compress';
import { emptyDrawing, type Entity } from '../src/cad/model/types';

describe('drawing codec', () => {
  const d = emptyDrawing('codec');
  d.entities = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, type: 'line', layer: '0', p1: { x: i, y: 0 }, p2: { x: i, y: 10 } }) as Entity);
  d.entities.push({ id: 9999, type: 'text', layer: '0', p: { x: 0, y: 0 }, h: 1, rot: 0, value: 'سطر\nwith newline' } as Entity);
  it('round-trips JSON-lines snapshots', () => {
    const back = unpackDrawing(packDrawing(d));
    expect(back.entities).toHaveLength(5001);
    expect(back.entities[5000]).toEqual(d.entities[5000]);
    expect(back.layers).toEqual(d.layers);
  });
  it('still reads legacy single-JSON snapshots', () => {
    expect(unpackDrawing(packJson(d)).entities).toHaveLength(5001);
  });
});
