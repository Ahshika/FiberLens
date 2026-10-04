import React, { useState } from 'react';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { Icon } from '../icons';
import { exportCadFile } from '../../cad/io/cadClient';
import { downloadBytes, downloadText, dataUrlToBytes, stamp } from '../../reports/download';
import { exportViewPdf, renderHighRes } from '../../reports/pdfView';
import { drawingToGeoJSON, geojsonToKml, kmlToKmz } from '../../reports/geoExport';
import { useGps } from '../../gps/gpsStore';
import { isUsable } from '../../geo/calibration';
import { audit, can, useSession } from '../../auth/session';
import { entityLength, entityArea } from '../../cad/edit/measure';
import { toCsv, downloadXlsx } from '../../reports/tables';

const DWG_VERSIONS = [['AC1032', 'AutoCAD 2018+'], ['AC1027', 'AutoCAD 2013'], ['AC1024', 'AutoCAD 2010'], ['AC1021', 'AutoCAD 2007'], ['AC1018', 'AutoCAD 2004'], ['AC1015', 'AutoCAD 2000']];

export function ExportPanel() {
  const st = useApp();
  const cal = useGps((s) => s.calibration);
  const [ver, setVer] = useState('AC1032');
  const [paper, setPaper] = useState<'a4' | 'a3' | 'a2' | 'a1' | 'a0'>('a3');
  const [mode, setMode] = useState<'raster' | 'vector'>('raster');
  const [scope, setScope] = useState<'all' | 'visible' | 'selection'>('all');
  const name = (st.drawingName || 'drawing').replace(/[^\w\-. ()]+/g, '_');
  const busy = (label: string) => useApp.setState({ loading: label });
  const done = () => useApp.setState({ loading: null });
  const fail = (e: unknown) => { done(); st.toast((e as Error).message, 'error'); };

  const cad = async (format: 'dwg' | 'dxf') => {
    if (!app.doc) return;
    busy(`Exporting ${format.toUpperCase()}… (merging edits into the original)`);
    try {
      const r = await exportCadFile(app.doc.live(), app.original, format, ver);
      const suffix = st.mode === 'asbuilt' ? '_AsBuilt' : '';
      await downloadBytes(`${name}${suffix}_${stamp()}.${format}`, r.bytes, format === 'dwg' ? 'image/vnd.dwg' : 'image/vnd.dxf');
      st.toast(`${format.toUpperCase()} exported · kept ${r.stats.kept}, modified ${r.stats.modified}, added ${r.stats.added}, deleted ${r.stats.deleted}${r.warnings.length ? ` · ${r.warnings.length} warnings` : ''}`, 'success');
      audit('export.' + format, name, JSON.stringify(r.stats));
    } catch (e) { fail(e); return; }
    done();
  };

  const pdf = async () => {
    if (!app.view) return;
    busy('Rendering PDF…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const bytes = exportViewPdf(app.view, { title: `${st.projectName} — ${st.drawingName}`, subtitle: st.mode === 'asbuilt' ? 'AS-BUILT' : 'DESIGN', paper, landscape: true, mode, author: useSession.getState().user?.displayName, unitsPerMeter: app.unitsPerMeter(), northAngle: isUsable(cal) ? cal.northAngle : undefined });
      await downloadBytes(`${name}_${stamp()}.pdf`, bytes, 'application/pdf');
      audit('export.pdf', name);
    } catch (e) { fail(e); return; }
    done();
  };

  const image = async (type: 'png' | 'jpg') => {
    if (!app.view) return;
    const url = renderHighRes(app.view, 2, type === 'png' ? 'image/png' : 'image/jpeg', 0.92);
    await downloadBytes(`${name}_${stamp()}.${type}`, dataUrlToBytes(url), type === 'png' ? 'image/png' : 'image/jpeg');
  };

  const scopeIds = (): number[] | undefined => {
    const doc = app.doc!;
    if (scope === 'selection') return app.selection?.list;
    if (scope === 'visible') return doc.search(app.view!.cam.viewBox());
    return undefined;
  };

  const geo = async (fmt: 'geojson' | 'kml' | 'kmz') => {
    if (!isUsable(cal) || !app.doc) { st.toast('Calibrate the drawing first (GPS → Calibration)', 'error'); return; }
    busy('Converting to WGS84…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const fc = drawingToGeoJSON(app.doc, cal, { ids: scopeIds() });
      if (fmt === 'geojson') await downloadText(`${name}.geojson`, JSON.stringify(fc), 'application/geo+json');
      else {
        const kml = geojsonToKml(fc, name);
        if (fmt === 'kml') await downloadText(`${name}.kml`, kml, 'application/vnd.google-earth.kml+xml');
        else await downloadBytes(`${name}.kmz`, kmlToKmz(kml), 'application/vnd.google-earth.kmz');
      }
      st.toast(`${fc.features.length} features exported`, 'success');
    } catch (e) { fail(e); return; }
    done();
  };

  const table = async (fmt: 'csv' | 'xlsx') => {
    const doc = app.doc!;
    const ids = scopeIds() ?? doc.ids();
    const upm = app.unitsPerMeter();
    const rows = ids.map((id) => doc.get(id)!).filter(Boolean).map((e) => ({
      Handle: e.handle ?? '', Type: e.type, Layer: e.layer,
      'Length (m)': entityLength(e) !== null ? +(entityLength(e)! / upm).toFixed(3) : '',
      'Area (m²)': entityArea(e) !== null ? +(entityArea(e)! / upm / upm).toFixed(3) : '',
      Block: e.type === 'insert' ? e.block : '',
      Text: e.type === 'text' || e.type === 'mtext' ? e.value : e.type === 'insert' ? (e.attribs ?? []).map((a) => `${a.tag}=${a.value}`).join('; ') : '',
    }));
    if (fmt === 'csv') await downloadText(`${name}_objects.csv`, toCsv(rows), 'text/csv');
    else await downloadXlsx(`${name}_objects.xlsx`, [{ name: 'Objects', rows }]);
  };

  return (
    <div>
      {!can('export') && <div className="badge err">Your role cannot export</div>}
      <div className="section">CAD</div>
      <div className="field"><label>DWG version</label>
        <select value={ver} onChange={(e) => setVer(e.target.value)}>{DWG_VERSIONS.map(([v, l]) => <option key={v} value={v}>{l} ({v})</option>)}</select>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={() => cad('dwg')}><Icon name="export" />DWG</button>
        <button className="btn" onClick={() => cad('dxf')}><Icon name="export" />DXF</button>
      </div>
      <p className="small muted">{app.original ? 'Edits are merged into a copy of the original file — xdata, layouts, dimension styles and unknown objects are preserved. The original is never modified.' : 'New drawing: exported from scratch.'}</p>

      <div className="section">Print / image (current view)</div>
      <div className="grid2">
        <div className="field"><label>Paper</label><select value={paper} onChange={(e) => setPaper(e.target.value as any)}>{['a4', 'a3', 'a2', 'a1', 'a0'].map((p) => <option key={p} value={p}>{p.toUpperCase()} landscape</option>)}</select></div>
        <div className="field"><label>PDF mode</label><select value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="raster">High-res image (exact look, Arabic text)</option><option value="vector">Vector (Latin text)</option></select></div>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={pdf}><Icon name="file" />PDF</button>
        <button className="btn" onClick={() => image('png')}>PNG</button>
        <button className="btn" onClick={() => image('jpg')}>JPG</button>
      </div>

      <div className="section">GIS & tables</div>
      <div className="field"><label>Scope</label>
        <select value={scope} onChange={(e) => setScope(e.target.value as any)}><option value="all">Whole drawing</option><option value="visible">Visible area</option><option value="selection">Selection ({st.selectionCount})</option></select>
      </div>
      <div className="row wrap">
        <button className="btn" onClick={() => geo('geojson')}>GeoJSON</button>
        <button className="btn" onClick={() => geo('kml')}>KML</button>
        <button className="btn" onClick={() => geo('kmz')}>KMZ</button>
        <button className="btn" onClick={() => table('csv')}>CSV</button>
        <button className="btn" onClick={() => table('xlsx')}>Excel</button>
      </div>
      {!isUsable(cal) && <p className="small muted">GeoJSON/KML need a calibration (GPS → Calibration wizard).</p>}
      <p className="small muted">FTTH network, BOQ and field reports: More → Reports.</p>
    </div>
  );
}
