import type { Vec2 } from '../cad/model/types';
import type { Mat2D } from '../cad/geom/vec';
import { project, unproject, utmZoneFor } from './crs';
import { fitTransform, invert, applyMat, type FitMethod } from './fit';

export interface ControlPoint {
  id: string;
  name: string;
  cad: Vec2;
  lat: number;
  lon: number;
  /** horizontal accuracy of the GPS observation (m) */
  accuracy?: number;
  enabled: boolean;
  residual?: number;
}

/**
 * Georeference of a drawing.
 *  - mode 'crs': drawing coordinates are already projected coordinates in `crs`
 *    (optionally refined by control points → small correction transform)
 *  - mode 'points': drawing has arbitrary coordinates; control points define a fit from
 *    a working projection (`crs`, auto UTM) to CAD.
 */
export interface Calibration {
  id: string;
  drawingId?: string;
  mode: 'crs' | 'points';
  crs: string;
  method: FitMethod;
  points: ControlPoint[];
  /** projected → CAD */
  m: Mat2D;
  rms: number;
  /** CAD units per metre */
  unitsPerMeter: number;
  /** rotation of grid north in CAD (radians, CCW from +X to north) */
  northAngle: number;
  updatedAt: number;
  source: 'manual' | 'geodata' | 'auto-detect';
}

const IDENT: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function newCalibration(crs = 'EPSG:32636', mode: Calibration['mode'] = 'points'): Calibration {
  return { id: crypto.randomUUID(), mode, crs, method: 'helmert', points: [], m: { ...IDENT }, rms: 0, unitsPerMeter: 1, northAngle: Math.PI / 2, updatedAt: Date.now(), source: 'manual' };
}

/** Recompute the transform from enabled control points. */
export function solveCalibration(cal: Calibration): Calibration {
  const pts = cal.points.filter((p) => p.enabled);
  let crs = cal.crs;
  if (cal.mode === 'points' && pts.length && (!crs || crs === 'auto')) crs = utmZoneFor(pts[0].lon, pts[0].lat);
  const out: Calibration = { ...cal, crs, updatedAt: Date.now() };
  if (!pts.length) {
    out.m = { ...IDENT };
    out.rms = 0;
    out.points = cal.points.map((p) => ({ ...p, residual: undefined }));
  } else {
    const pairs = pts.map((p) => ({ src: project(crs, p.lon, p.lat), dst: p.cad }));
    let method: FitMethod = cal.method;
    if (cal.mode === 'crs') method = pts.length >= 3 && cal.method === 'affine' ? 'affine' : pts.length >= 2 && cal.method === 'helmert' ? 'helmert' : 'translation';
    const r = fitTransform(pairs, method);
    out.m = r.m;
    out.rms = r.rms;
    out.method = r.method;
    let k = 0;
    out.points = cal.points.map((p) => (p.enabled ? { ...p, residual: r.residuals[k++] } : { ...p, residual: undefined }));
  }
  // derived scale & north
  const m = out.m;
  out.unitsPerMeter = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  out.northAngle = Math.atan2(m.d, m.c); // image of projected +Y axis
  return out;
}

export function geoToCad(cal: Calibration, lat: number, lon: number): Vec2 {
  const p = project(cal.crs, lon, lat);
  return applyMat(cal.m, p);
}

export function cadToGeo(cal: Calibration, x: number, y: number): { lat: number; lon: number } {
  const p = applyMat(invert(cal.m), { x, y });
  const g = unproject(cal.crs, p.x, p.y);
  return { lat: g.lat, lon: g.lon };
}

/** convert a compass heading (degrees, clockwise from true north) to a CAD angle (radians CCW from +X) */
export function headingToCadAngle(cal: Calibration, headingDeg: number): number {
  return cal.northAngle - (headingDeg * Math.PI) / 180;
}

/** a calibration is usable when it has a CRS and either mode=crs or ≥1 control point */
export function isUsable(cal: Calibration | null | undefined): cal is Calibration {
  return !!cal && (cal.mode === 'crs' || cal.points.some((p) => p.enabled));
}

export function minPointsFor(method: FitMethod) { return method === 'affine' ? 3 : method === 'helmert' ? 2 : 1; }
