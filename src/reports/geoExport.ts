import { zipSync, strToU8 } from 'fflate';
import type { CadDoc } from '../cad/doc/CadDoc';
import { cadToGeo, type Calibration } from '../geo/calibration';
import { worldGeometry } from '../cad/geom/bbox';
import type { TrackRow } from '../data/db';
import { aciToRgb } from '../cad/model/color';

export interface GeoFeature { type: 'Feature'; geometry: any; properties: Record<string, any> }
export interface FeatureCollection { type: 'FeatureCollection'; features: GeoFeature[] }

/** Convert visible CAD entities to WGS84 GeoJSON through the drawing calibration. */
export function drawingToGeoJSON(doc: CadDoc, cal: Calibration, opts: { layers?: Set<string>; ids?: number[]; maxFeatures?: number } = {}): FeatureCollection {
  const features: GeoFeature[] = [];
  const ll = (x: number, y: number) => { const g = cadToGeo(cal, x, y); return [+g.lon.toFixed(8), +g.lat.toFixed(8)]; };
  const ids = opts.ids ?? doc.ids();
  const max = opts.maxFeatures ?? 200000;
  for (const id of ids) {
    if (features.length >= max) break;
    const e = doc.get(id);
    if (!e || !doc.isVisible(e)) continue;
    if (opts.layers && !opts.layers.has(e.layer)) continue;
    const g = worldGeometry(e, doc.blocks);
    const layer = doc.layer(e.layer);
    const rgb = e.rgb ?? (e.aci && e.aci !== 256 && e.aci !== 0 ? aciToRgb(e.aci) : layer?.rgb ?? aciToRgb(layer?.aci ?? 7));
    const props: Record<string, any> = { layer: e.layer, type: e.type, handle: e.handle, color: '#' + rgb.toString(16).padStart(6, '0') };
    if (e.type === 'insert') {
      props.block = e.block;
      for (const a of e.attribs ?? []) props[a.tag] = a.value;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(e.p.x, e.p.y) }, properties: props });
      continue;
    }
    if (e.type === 'text' || e.type === 'mtext') {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(e.p.x, e.p.y) }, properties: { ...props, text: e.value.replace(/\\P/g, '\n') } });
      continue;
    }
    if (e.type === 'point') { features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(e.p.x, e.p.y) }, properties: props }); continue; }
    for (const p of g.paths) {
      if (p.pts.length < 4) continue;
      const coords: number[][] = [];
      for (let i = 0; i < p.pts.length; i += 2) coords.push(ll(p.pts[i], p.pts[i + 1]));
      if (p.closed) { coords.push(coords[0]); features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: props }); }
      else features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });
    }
    for (const f of g.fills) {
      const rings = f.map((l) => { const c: number[][] = []; for (let i = 0; i < l.length; i += 2) c.push(ll(l[i], l[i + 1])); c.push(c[0]); return c; });
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings }, properties: { ...props, fill: true } });
    }
  }
  return { type: 'FeatureCollection', features };
}

const esc = (s: any) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const kmlColor = (hex: string, alpha = 'ff') => { const h = (hex || '#ffffff').replace('#', ''); return alpha + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };

/** GeoJSON → KML (folders per layer / kind) */
export function geojsonToKml(fc: FeatureCollection, name: string, groupBy = 'layer'): string {
  const groups = new Map<string, GeoFeature[]>();
  for (const f of fc.features) {
    const k = String(f.properties[groupBy] ?? 'Other');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const coord = (c: number[]) => `${c[0]},${c[1]},0`;
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>`];
  for (const [k, feats] of groups) {
    out.push(`<Folder><name>${esc(k)}</name>`);
    for (const f of feats) {
      const p = f.properties;
      const title = p.code ?? p.text ?? p.block ?? p.type ?? '';
      const desc = Object.entries(p).filter(([kk]) => !['color'].includes(kk)).map(([kk, v]) => `<b>${esc(kk)}</b>: ${esc(v)}`).join('<br/>');
      const col = kmlColor(p.color);
      const style = `<Style><LineStyle><color>${col}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(p.color, p.fill ? '88' : '33')}</color></PolyStyle><IconStyle><color>${col}</color></IconStyle></Style>`;
      let geom = '';
      const g = f.geometry;
      if (g.type === 'Point') geom = `<Point><coordinates>${coord(g.coordinates)}</coordinates></Point>`;
      else if (g.type === 'LineString') geom = `<LineString><tessellate>1</tessellate><coordinates>${g.coordinates.map(coord).join(' ')}</coordinates></LineString>`;
      else if (g.type === 'Polygon') geom = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${g.coordinates[0].map(coord).join(' ')}</coordinates></LinearRing></outerBoundaryIs>${g.coordinates.slice(1).map((r: number[][]) => `<innerBoundaryIs><LinearRing><coordinates>${r.map(coord).join(' ')}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon>`;
      out.push(`<Placemark><name>${esc(title)}</name><description><![CDATA[${desc}]]></description>${style}${geom}</Placemark>`);
    }
    out.push('</Folder>');
  }
  out.push('</Document></kml>');
  return out.join('\n');
}

export function kmlToKmz(kml: string): Uint8Array {
  return zipSync({ 'doc.kml': strToU8(kml) }, { level: 6 });
}

export function tracksToGpx(tracks: TrackRow[]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="FiberLens" xmlns="http://www.topografix.com/GPX/1/1">'];
  for (const t of tracks) {
    out.push(`<trk><name>${esc(t.name)}</name><trkseg>`);
    for (const p of t.points) out.push(`<trkpt lat="${p.lat.toFixed(8)}" lon="${p.lon.toFixed(8)}">${p.alt !== undefined ? `<ele>${p.alt.toFixed(2)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`);
    out.push('</trkseg></trk>');
  }
  out.push('</gpx>');
  return out.join('\n');
}
