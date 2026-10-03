import proj4 from 'proj4';

export interface CrsDef { id: string; name: string; proj: string; group: string }

/** Built-in offline CRS catalogue (extendable with custom proj strings). */
const BUILTIN: CrsDef[] = [
  { id: 'EPSG:4326', name: 'WGS 84 (lat/lon)', proj: '+proj=longlat +datum=WGS84 +no_defs', group: 'Geographic' },
  { id: 'EPSG:3857', name: 'Web Mercator', proj: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs', group: 'Global' },
  // Egypt
  { id: 'EPSG:22992', name: 'Egypt 1907 / Red Belt', proj: '+proj=tmerc +lat_0=30 +lon_0=31 +k=1 +x_0=615000 +y_0=810000 +ellps=helmert +towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs', group: 'Egypt' },
  { id: 'EPSG:22991', name: 'Egypt 1907 / Blue Belt', proj: '+proj=tmerc +lat_0=30 +lon_0=35 +k=1 +x_0=300000 +y_0=1100000 +ellps=helmert +towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs', group: 'Egypt' },
  { id: 'EPSG:22993', name: 'Egypt 1907 / Purple Belt', proj: '+proj=tmerc +lat_0=30 +lon_0=27 +k=1 +x_0=700000 +y_0=200000 +ellps=helmert +towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs', group: 'Egypt' },
  { id: 'EPSG:22994', name: 'Egypt 1907 / Extended Purple Belt', proj: '+proj=tmerc +lat_0=30 +lon_0=27 +k=1 +x_0=700000 +y_0=1200000 +ellps=helmert +towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs', group: 'Egypt' },
  { id: 'EPSG:22521', name: 'Egypt Gulf of Suez S-650 TL / Red Belt', proj: '+proj=tmerc +lat_0=30 +lon_0=31 +k=1 +x_0=615000 +y_0=810000 +ellps=helmert +towgs84=-146.21,112.63,4.05,0,0,0,0 +units=m +no_defs', group: 'Egypt' },
  // Saudi / Gulf commonly used
  { id: 'EPSG:20437', name: 'Ain el Abd / UTM 37N', proj: '+proj=utm +zone=37 +ellps=intl +towgs84=-143,-236,7,0,0,0,0 +units=m +no_defs', group: 'Middle East' },
  { id: 'EPSG:20438', name: 'Ain el Abd / UTM 38N', proj: '+proj=utm +zone=38 +ellps=intl +towgs84=-143,-236,7,0,0,0,0 +units=m +no_defs', group: 'Middle East' },
];

function utmDefs(): CrsDef[] {
  const out: CrsDef[] = [];
  for (let z = 1; z <= 60; z++) {
    out.push({ id: `EPSG:${32600 + z}`, name: `WGS 84 / UTM ${z}N`, proj: `+proj=utm +zone=${z} +datum=WGS84 +units=m +no_defs`, group: 'UTM North' });
    out.push({ id: `EPSG:${32700 + z}`, name: `WGS 84 / UTM ${z}S`, proj: `+proj=utm +zone=${z} +south +datum=WGS84 +units=m +no_defs`, group: 'UTM South' });
  }
  return out;
}

const ALL = [...BUILTIN, ...utmDefs()];
const BY_ID = new Map(ALL.map((d) => [d.id, d]));
for (const d of ALL) proj4.defs(d.id, d.proj);

export function listCrs(): CrsDef[] { return ALL; }
export function getCrs(id: string): CrsDef | undefined { return BY_ID.get(id); }

/** register a user-supplied proj4 string; returns its id */
export function registerCustomCrs(proj: string, name = 'Custom'): string {
  const id = 'CUSTOM:' + hash(proj);
  if (!BY_ID.has(id)) {
    proj4.defs(id, proj);
    const d = { id, name, proj, group: 'Custom' };
    ALL.push(d);
    BY_ID.set(id, d);
  }
  return id;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function utmZoneFor(lon: number, lat: number): string {
  const z = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return lat >= 0 ? `EPSG:${32600 + z}` : `EPSG:${32700 + z}`;
}

/** WGS84 lon/lat → projected (x,y) in CRS */
export function project(crsId: string, lon: number, lat: number): { x: number; y: number } {
  if (crsId === 'EPSG:4326') return { x: lon, y: lat };
  const [x, y] = proj4('EPSG:4326', crsId, [lon, lat]);
  return { x, y };
}

/** projected (x,y) → WGS84 lon/lat */
export function unproject(crsId: string, x: number, y: number): { lon: number; lat: number } {
  if (crsId === 'EPSG:4326') return { lon: x, lat: y };
  const [lon, lat] = proj4(crsId, 'EPSG:4326', [x, y]);
  return { lon, lat };
}

/** Try to recognise an EPSG code / UTM zone inside a GEODATA coordinate system definition. */
export function crsFromDefinition(def: string | undefined): string | null {
  if (!def) return null;
  const epsg = /EPSG["':,\s]*(\d{4,5})/i.exec(def);
  if (epsg && BY_ID.has(`EPSG:${epsg[1]}`)) return `EPSG:${epsg[1]}`;
  const utm = /UTM[^\d]{0,12}(\d{1,2})\s*([NS])?/i.exec(def);
  if (utm) {
    const z = parseInt(utm[1], 10);
    const south = (utm[2] ?? 'N').toUpperCase() === 'S';
    return `EPSG:${(south ? 32700 : 32600) + z}`;
  }
  if (/red\s*belt/i.test(def)) return 'EPSG:22992';
  if (/purple\s*belt/i.test(def)) return 'EPSG:22993';
  if (/blue\s*belt/i.test(def)) return 'EPSG:22991';
  return null;
}

export interface CrsCandidate { crs: string; name: string; distance: number; inside: boolean }

/**
 * Rank CRSs that would place a GPS fix inside the drawing extents — used to auto-detect
 * drawings already drawn in projected coordinates (UTM, Egyptian belts…).
 */
export function detectCrs(ext: { minX: number; minY: number; maxX: number; maxY: number }, lon: number, lat: number): CrsCandidate[] {
  const cx = (ext.minX + ext.maxX) / 2, cy = (ext.minY + ext.maxY) / 2;
  const size = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1);
  const cands = new Set<string>([utmZoneFor(lon, lat), utmZoneFor(lon - 6, lat), utmZoneFor(lon + 6, lat), ...BUILTIN.filter((d) => d.group !== 'Geographic' && d.group !== 'Global').map((d) => d.id)]);
  const out: CrsCandidate[] = [];
  for (const id of cands) {
    try {
      const p = project(id, lon, lat);
      if (!Number.isFinite(p.x)) continue;
      const inside = p.x >= ext.minX - size * 0.5 && p.x <= ext.maxX + size * 0.5 && p.y >= ext.minY - size * 0.5 && p.y <= ext.maxY + size * 0.5;
      out.push({ crs: id, name: BY_ID.get(id)?.name ?? id, distance: Math.hypot(p.x - cx, p.y - cy), inside });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** heuristics on extents alone (no GPS) */
export function guessProjectedFromExtents(ext: { minX: number; minY: number; maxX: number; maxY: number }): string | null {
  const cx = (ext.minX + ext.maxX) / 2, cy = (ext.minY + ext.maxY) / 2;
  if (cx > 100000 && cx < 900000 && cy > 1000000 && cy < 9400000) return 'utm';
  if (cx > 0 && cx < 1200000 && cy > 0 && cy < 1500000) return 'belt';
  return null;
}

/** geodesic distance (m) between two WGS84 points (haversine) */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
