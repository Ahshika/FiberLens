import { describe, it, expect } from 'vitest';
import { guessCrsFromPoint, medianPoint, project } from '../src/geo/crs';

describe('CRS guess from drawing coordinates', () => {
  const near = (crs: string, lon: number, lat: number) => {
    const p = project(crs, lon, lat);
    const g = guessCrsFromPoint(p.x, p.y)!;
    expect(g.crs).toBe(crs);
    expect(Math.abs(g.lon - lon) + Math.abs(g.lat - lat)).toBeLessThan(1e-6);
  };
  it('Alexandria / Cairo / Aswan in UTM 36N', () => { near('EPSG:32636', 29.92, 31.2); near('EPSG:32636', 31.24, 30.04); near('EPSG:32636', 32.9, 24.09); });
  it('the sample drawings (X≈214k, Y≈3.457M) → UTM 36N, Alexandria', () => {
    const g = guessCrsFromPoint(214116, 3457069)!;
    expect(g.crs).toBe('EPSG:32636');
    expect(g.lat).toBeGreaterThan(31); expect(g.lat).toBeLessThan(31.4);
    expect(g.lon).toBeGreaterThan(29.8); expect(g.lon).toBeLessThan(30.1);
  });
  it('ambiguous zone numbers default to 36N (corrected from GPS later)', () => expect(guessCrsFromPoint(...Object.values(project('EPSG:32635', 25.5, 29.2)) as [number, number])!.crs).toBe('EPSG:32636'));
  it('Egypt 1907 belts', () => { near('EPSG:22992', 31.24, 30.04); near('EPSG:22991', 34.3, 28.0); });
  it('local / arbitrary coordinates are not guessed', () => {
    expect(guessCrsFromPoint(0, 0)).toBeNull();
    expect(guessCrsFromPoint(1500, 2300)).toBeNull();
    expect(guessCrsFromPoint(500000, 5000000)).toBeNull();
  });
  it('median point ignores stray entities', () => {
    const ents = [...Array.from({ length: 99 }, (_, i) => ({ p1: { x: 214000 + i, y: 3457000 } })), { p: { x: 0, y: 0 } }];
    expect(medianPoint(ents)).toEqual({ x: 214049, y: 3457000 });
  });
});
