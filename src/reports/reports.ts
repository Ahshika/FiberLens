import { db } from '../data/db';
import { useFtth, getObject, getCable } from '../ftth/store';
import { computeBoq } from '../ftth/boq';
import { traceUpstream } from '../ftth/topology';
import { cableTypeLabel, kindMeta } from '../ftth/model';
import type { Row } from './tables';
import { useGps } from '../gps/gpsStore';
import { isUsable, cadToGeo } from '../geo/calibration';
import { listVersions, currentDrawingId } from '../data/projects';
import { unpackJson } from '../data/compress';

export interface ReportDef { id: string; title: string; description: string; build: (projectId: string) => Promise<{ title: string; rows: Row[] }[]> }

const d = (t?: number) => (t ? new Date(t).toLocaleString() : '');
const ll = (x?: number, y?: number) => {
  const cal = useGps.getState().calibration;
  if (x === undefined || y === undefined || !isUsable(cal)) return { Lat: '', Lon: '' };
  const g = cadToGeo(cal, x, y);
  return { Lat: +g.lat.toFixed(7), Lon: +g.lon.toFixed(7) };
};

function objectRows(filter?: (o: any) => boolean): Row[] {
  return [...useFtth.getState().objects.values()].filter((o) => !filter || filter(o)).sort((a, b) => kindMeta(a.kind).level - kindMeta(b.kind).level || a.code.localeCompare(b.code, undefined, { numeric: true })).map((o) => ({
    Type: o.kind, ID: o.code, Name: o.name ?? '', Status: o.status, Parent: getObject(o.parentId)?.code ?? '', Mode: o.mode,
    X: +o.cad.x.toFixed(3), Y: +o.cad.y.toFixed(3), ...ll(o.cad.x, o.cad.y), Updated: d(o.updatedAt),
  }));
}
function cableRows(filter?: (c: any) => boolean): Row[] {
  return [...useFtth.getState().cables.values()].filter((c) => !filter || filter(c)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).map((c) => ({
    'Cable ID': c.code, Type: cableTypeLabel(c.category, c.fiberCount), Category: c.category, Fibres: c.fiberCount,
    From: getObject(c.fromId)?.code ?? '', To: getObject(c.toId)?.code ?? '', 'Length (m)': +c.length.toFixed(2), 'Slack (m)': c.slack, 'Total (m)': +(c.length + c.slack).toFixed(2),
    'Length mode': c.lengthMode, Status: c.status, Mode: c.mode,
  }));
}

export const REPORTS: ReportDef[] = [
  { id: 'network', title: 'FTTH Network Report', description: 'Summary, all network elements and cables', build: async (pid) => {
    const s = useFtth.getState();
    const byKind = new Map<string, number>();
    for (const o of s.objects.values()) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
    const summary: Row[] = [...byKind.entries()].map(([k, n]) => ({ Item: k, Count: n }));
    summary.push({ Item: 'Cables', Count: s.cables.size }, { Item: 'Fibre length (m)', Count: +[...s.cables.values()].filter((c) => c.category !== 'duct').reduce((a, c) => a + c.length + c.slack, 0).toFixed(1) }, { Item: 'Splitters', Count: s.splitters.size });
    void pid;
    return [{ title: 'Summary', rows: summary }, { title: 'Network elements', rows: objectRows() }, { title: 'Cables', rows: cableRows() }];
  } },
  { id: 'cables', title: 'Cable Report', description: 'Every cable/duct with route, type and length', build: async () => [{ title: 'Cables', rows: cableRows() }] },
  { id: 'cores', title: 'Fiber Core Report', description: 'Core-by-core status and assignments', build: async (pid) => {
    const cores = await db.cores.where('projectId').equals(pid).toArray();
    return [{ title: 'Fibre cores', rows: cores.sort((a, b) => (getCable(a.cableId)?.code ?? '').localeCompare(getCable(b.cableId)?.code ?? '', undefined, { numeric: true }) || a.index - b.index).map((c) => ({ Cable: getCable(c.cableId)?.code ?? '?', Core: c.index, Tube: c.tube, 'Tube colour': c.tubeColor, 'Fibre colour': c.color, Status: c.status, 'Assigned to': c.assignLabel ?? '', Notes: c.notes ?? '' })) }];
  } },
  { id: 'splitters', title: 'Splitter Report', description: 'Splitters, ratios, port usage', build: async () => {
    const s = [...useFtth.getState().splitters.values()];
    return [
      { title: 'Splitters', rows: s.map((x) => ({ ID: x.code, Ratio: `1:${x.ratio}`, Level: x.level ?? 1, Device: getObject(x.parentId)?.code ?? '', Input: x.input?.cableId ? `${getCable(x.input.cableId)?.code}#${x.input.core ?? ''}` : '', Used: x.outputs.filter((o) => o.status === 'used').length, Free: x.outputs.filter((o) => o.status === 'available' || o.status === 'spare').length, Status: x.status })) },
      { title: 'Splitter ports', rows: s.flatMap((x) => x.outputs.map((o) => ({ Splitter: x.code, Port: o.port, Status: o.status, Cable: getCable(o.cableId)?.code ?? '', Core: o.core ?? '', Customer: getObject(o.customerId)?.code ?? '' }))) },
    ];
  } },
  { id: 'customers', title: 'Customer Report', description: 'Customers with their serving box and path to OLT', build: async () => {
    const cust = [...useFtth.getState().objects.values()].filter((o) => o.kind === 'Customer');
    return [{ title: 'Customers', rows: cust.map((c) => { const t = traceUpstream(c.id); const ids = t.objectIds.map((x) => getObject(x)!); const box = ids.find((o) => ['FAT', 'FTB'].includes(o.kind)); return { Customer: c.code, Name: c.name ?? '', Status: c.status, 'Serving box': box?.code ?? getObject(c.parentId)?.code ?? '', Path: ids.map((o) => o.code).join(' > '), 'OLT reached': t.reachedHeadEnd ? 'yes' : 'no', 'Fibre distance (m)': +t.totalLength.toFixed(1), ...ll(c.cad.x, c.cad.y) }; }) }];
  } },
  { id: 'survey', title: 'Field Survey Report', description: 'Survey sessions and items with locations', build: async (pid) => {
    const surveys = await db.surveys.where('projectId').equals(pid).toArray();
    const items = await db.surveyItems.where('projectId').equals(pid).toArray();
    return [
      { title: 'Sessions', rows: surveys.map((s) => ({ Name: s.name, By: s.userName ?? '', Started: d(s.startedAt), Ended: d(s.endedAt), Items: items.filter((i) => i.surveyId === s.id).length })) },
      { title: 'Items', rows: items.sort((a, b) => a.createdAt - b.createdAt).map((i) => ({ Session: surveys.find((s) => s.id === i.surveyId)?.name ?? '', Kind: i.kind, Text: i.text ?? '', Object: getObject(i.objectId)?.code ?? '', Lat: i.lat ?? '', Lon: i.lon ?? '', 'Accuracy (m)': i.acc ? +i.acc.toFixed(1) : '', X: i.x ?? '', Y: i.y ?? '', Time: d(i.createdAt), Details: i.payload ? Object.entries(i.payload).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ') : '' })) },
    ];
  } },
  { id: 'asbuilt', title: 'As-Built Report', description: 'As-built items and differences from the last design version', build: async (pid) => {
    const out = [{ title: 'As-built elements', rows: objectRows((o) => o.mode === 'asbuilt') }, { title: 'As-built cables', rows: cableRows((c) => c.mode === 'asbuilt') }];
    const did = currentDrawingId();
    if (did) {
      const vs = (await listVersions(did)).filter((v) => v.kind === 'design' || v.kind === 'import');
      const v = vs[0];
      if (v?.ftth) {
        const old = unpackJson<Record<string, any[]>>(v.ftth);
        const oldObj = new Map((old.ftthObjects ?? []).map((o: any) => [o.id, o]));
        const rows: Row[] = [];
        for (const o of useFtth.getState().objects.values()) {
          const p = oldObj.get(o.id);
          if (!p) rows.push({ Change: 'Added', Type: o.kind, ID: o.code, Detail: o.status });
          else {
            const ch: string[] = [];
            if (p.status !== o.status) ch.push(`status ${p.status}→${o.status}`);
            if (p.code !== o.code) ch.push(`id ${p.code}→${o.code}`);
            const mv = Math.hypot(p.cad.x - o.cad.x, p.cad.y - o.cad.y);
            if (mv > 0.01) ch.push(`moved ${mv.toFixed(2)}`);
            if (ch.length) rows.push({ Change: 'Modified', Type: o.kind, ID: o.code, Detail: ch.join(', ') });
          }
          oldObj.delete(o.id);
        }
        for (const o of oldObj.values()) rows.push({ Change: 'Removed', Type: o.kind, ID: o.code, Detail: '' });
        const oldCab = new Map((old.cables ?? []).map((c: any) => [c.id, c]));
        for (const c of useFtth.getState().cables.values()) {
          const p = oldCab.get(c.id);
          if (!p) rows.push({ Change: 'Added', Type: 'Cable', ID: c.code, Detail: `${c.length} m` });
          else if (Math.abs(p.length - c.length) > 0.05 || p.status !== c.status) rows.push({ Change: 'Modified', Type: 'Cable', ID: c.code, Detail: `length ${p.length}→${c.length} m${p.status !== c.status ? `, status ${p.status}→${c.status}` : ''}` });
          oldCab.delete(c.id);
        }
        for (const c of oldCab.values()) rows.push({ Change: 'Removed', Type: 'Cable', ID: c.code, Detail: '' });
        out.push({ title: `Design (${v.label}) vs As-Built`, rows });
      }
    }
    void pid;
    return out;
  } },
  { id: 'faults', title: 'Fault Report', description: 'Faults, severity, resolution time', build: async (pid) => {
    const f = await db.faults.where('projectId').equals(pid).toArray();
    return [{ title: 'Faults', rows: f.sort((a, b) => b.openedAt - a.openedAt).map((x) => ({ Object: getObject(x.objectId)?.code ?? '', Severity: x.severity, Status: x.status, Description: x.description, Opened: d(x.openedAt), Closed: d(x.closedAt), 'Hours to fix': x.closedAt ? +((x.closedAt - x.openedAt) / 3600000).toFixed(1) : '', Resolution: x.resolution ?? '' })) },
      { title: 'Maintenance', rows: (await db.maintenance.where('projectId').equals(pid).toArray()).map((m) => ({ Object: getObject(m.objectId)?.code ?? '', Action: m.action, Status: m.status, Technician: m.technician, Date: d(m.date), Notes: m.notes })) }];
  } },
  { id: 'boq', title: 'BOQ Report', description: 'Bill of quantities (cables by type, elements, splitters, CAD takeoff)', build: async (pid) => {
    const rows = await computeBoq(pid);
    const sections = [...new Set(rows.map((r) => r.section))];
    return sections.map((s) => ({ title: s, rows: rows.filter((r) => r.section === s).map((r) => ({ Item: r.item, Unit: r.unit, Quantity: r.qty, Notes: r.notes ?? '' })) }));
  } },
  { id: 'gps', title: 'GPS / Survey Report', description: 'GPS tracks, calibration and control points', build: async (pid) => {
    const tracks = await db.tracks.where('projectId').equals(pid).toArray();
    const cals = await db.calibrations.where('projectId').equals(pid).toArray();
    return [
      { title: 'Calibration', rows: cals.flatMap((c) => c.points.map((p) => ({ CRS: c.crs, Mode: c.mode, Method: c.method, 'RMS (du)': +c.rms.toFixed(3), Point: p.name, 'CAD X': p.cad.x, 'CAD Y': p.cad.y, Lat: p.lat, Lon: p.lon, 'Residual (du)': p.residual !== undefined ? +p.residual.toFixed(3) : '', Enabled: p.enabled ? 'yes' : 'no' }))) },
      { title: 'Tracks', rows: tracks.map((t) => ({ Name: t.name, Points: t.points.length, 'Length (m)': +t.length.toFixed(1), Start: d(t.startedAt), End: d(t.endedAt) })) },
      { title: 'Track points', rows: tracks.flatMap((t) => t.points.map((p) => ({ Track: t.name, Time: d(p.t), Lat: p.lat, Lon: p.lon, 'Acc (m)': +p.acc.toFixed(1), X: p.x !== undefined ? +p.x.toFixed(3) : '', Y: p.y !== undefined ? +p.y.toFixed(3) : '', 'Speed (km/h)': p.spd !== undefined ? +(p.spd * 3.6).toFixed(1) : '' }))) },
    ];
  } },
];
