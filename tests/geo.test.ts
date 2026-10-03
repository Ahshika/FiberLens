import { describe, it, expect } from 'vitest';
import { fitTransform } from '../src/geo/fit';
import { project, unproject, utmZoneFor, detectCrs } from '../src/geo/crs';
import { solveCalibration, newCalibration, geoToCad, cadToGeo } from '../src/geo/calibration';
import { NmeaParser } from '../src/gps/nmea';

describe('least-squares fit', () => {
  it('recovers a Helmert transform exactly', () => {
    const s = 0.5, r = 0.3, t = { x: 1000, y: -2000 };
    const f = (p: { x: number; y: number }) => ({ x: s * (Math.cos(r) * p.x - Math.sin(r) * p.y) + t.x, y: s * (Math.sin(r) * p.x + Math.cos(r) * p.y) + t.y });
    const src = [{ x: 220000, y: 3455000 }, { x: 221000, y: 3456000 }, { x: 219500, y: 3457200 }];
    const res = fitTransform(src.map((p) => ({ src: p, dst: f(p) })), 'helmert');
    expect(res.rms).toBeLessThan(1e-6);
    expect(res.scale).toBeCloseTo(s, 9);
    expect(res.rotation).toBeCloseTo(r, 9);
  });
  it('affine reports residuals for every point', () => {
    const pairs = [
      { src: { x: 0, y: 0 }, dst: { x: 0, y: 0 } }, { src: { x: 1, y: 0 }, dst: { x: 2, y: 0 } },
      { src: { x: 0, y: 1 }, dst: { x: 0, y: 3 } }, { src: { x: 1, y: 1 }, dst: { x: 2.1, y: 3 } },
    ];
    const res = fitTransform(pairs, 'affine');
    expect(res.residuals).toHaveLength(4);
    expect(res.rms).toBeGreaterThan(0);
  });
});

describe('CRS', () => {
  it('UTM 36N round trip (Alexandria)', () => {
    const p = project('EPSG:32636', 29.9553, 31.2156);
    const g = unproject('EPSG:32636', p.x, p.y);
    expect(g.lat).toBeCloseTo(31.2156, 8);
    expect(g.lon).toBeCloseTo(29.9553, 8);
    expect(utmZoneFor(29.95, 31.2)).toBe('EPSG:32635');
  });
  it('detects a drawing drawn in UTM 36N from a GPS fix', () => {
    const ext = { minX: 198000, minY: 3450000, maxX: 230000, maxY: 3464000 };
    const c = detectCrs(ext, 29.9991, 31.2137);
    expect(c.find((x) => x.inside)?.crs).toBe('EPSG:32636');
  });
});

describe('calibration', () => {
  it('two control points: GPS ↔ CAD within a millimetre', () => {
    let cal = newCalibration('EPSG:32636', 'points');
    const geo = [{ lat: 31.21, lon: 29.99 }, { lat: 31.22, lon: 30.005 }, { lat: 31.215, lon: 29.98 }];
    const toCad = (lat: number, lon: number) => { const p = project('EPSG:32636', lon, lat); return { x: (p.x - 200000) * 1000, y: (p.y - 3450000) * 1000 }; };
    cal.points = geo.slice(0, 2).map((g, i) => ({ id: String(i), name: 'P' + i, cad: toCad(g.lat, g.lon), lat: g.lat, lon: g.lon, enabled: true }));
    cal = solveCalibration(cal);
    expect(cal.unitsPerMeter).toBeCloseTo(1000, 3);
    const c = geoToCad(cal, geo[2].lat, geo[2].lon), expected = toCad(geo[2].lat, geo[2].lon);
    expect(Math.hypot(c.x - expected.x, c.y - expected.y)).toBeLessThan(1);
    const back = cadToGeo(cal, c.x, c.y);
    expect(back.lat).toBeCloseTo(geo[2].lat, 8);
  });
});

describe('NMEA', () => {
  it('parses GGA with RTK fixed quality', () => {
    const fixes: any[] = [];
    const body = 'GPGGA,123519,3112.936,N,02957.318,E,4,12,0.6,12.3,M,0.0,M,,';
    let cs = 0;
    for (const ch of body) cs ^= ch.charCodeAt(0);
    const p = new NmeaParser('test', (f) => fixes.push(f));
    p.push(`$${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}\r\n`);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].lat).toBeCloseTo(31.2156, 4);
    expect(fixes[0].lon).toBeCloseTo(29.9553, 4);
    expect(fixes[0].fixType).toBe('rtk-fixed');
    expect(fixes[0].satellites).toBe(12);
  });
  it('rejects a bad checksum', () => {
    const fixes: any[] = [];
    new NmeaParser('t', (f) => fixes.push(f)).push('$GPGGA,1,3112.936,N,02957.318,E,1,8,1,0,M,0,M,,*00\n');
    expect(fixes).toHaveLength(0);
  });
});
