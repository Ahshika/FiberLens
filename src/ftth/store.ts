import { create } from 'zustand';
import RBush from 'rbush';
import { db, uid, type FtthObjectRow, type CableRow, type SplitterRow, type CoreRow, type SpliceRow, type CoreStatus } from '../data/db';
import { app } from '../app/controller';
import { useApp } from '../app/store';
import { useSession, audit, require as requirePerm } from '../auth/session';
import { recordChange } from '../data/sync';
import { projectOpenedHooks, currentProjectId } from '../data/projects';
import { entityLength } from '../cad/edit/measure';
import { coreColor } from './model';
import type { Entity, Vec2 } from '../cad/model/types';

interface Pt { minX: number; minY: number; maxX: number; maxY: number; id: string }

export interface FtthState {
  projectId: string | null;
  objects: Map<string, FtthObjectRow>;
  cables: Map<string, CableRow>;
  splitters: Map<string, SplitterRow>;
  rev: number;
  set: (p: Partial<FtthState>) => void;
}

export const useFtth = create<FtthState>((set) => ({ projectId: null, objects: new Map(), cables: new Map(), splitters: new Map(), rev: 0, set: (p) => set(p) }));

let tree = new RBush<Pt>();
let byEntity = new Map<number, { kind: 'object' | 'cable'; id: string }>();
let byHandle = new Map<string, { kind: 'object' | 'cable'; id: string }>();

function stamp<T extends { updatedAt: number; updatedBy?: string; projectId: string }>(r: T): T {
  return { ...r, updatedAt: Date.now(), updatedBy: useSession.getState().user?.id, projectId: r.projectId };
}

function reindex() {
  const s = useFtth.getState();
  tree = new RBush<Pt>();
  byEntity = new Map(); byHandle = new Map();
  const items: Pt[] = [];
  for (const o of s.objects.values()) {
    items.push({ minX: o.cad.x, minY: o.cad.y, maxX: o.cad.x, maxY: o.cad.y, id: o.id });
    if (o.cad.entityId !== undefined) byEntity.set(o.cad.entityId, { kind: 'object', id: o.id });
    if (o.cad.handle) byHandle.set(o.cad.handle, { kind: 'object', id: o.id });
  }
  tree.load(items);
  for (const c of s.cables.values()) {
    if (c.cad.entityId !== undefined) byEntity.set(c.cad.entityId, { kind: 'cable', id: c.id });
    if (c.cad.handle) byHandle.set(c.cad.handle, { kind: 'cable', id: c.id });
  }
}

function bump() { reindex(); useFtth.setState((s) => ({ rev: s.rev + 1 })); app.view?.invalidateOverlay(); }

export async function loadFtth(projectId: string) {
  const [objs, cables, spl] = await Promise.all([
    db.ftthObjects.where('projectId').equals(projectId).toArray(),
    db.cables.where('projectId').equals(projectId).toArray(),
    db.splitters.where('projectId').equals(projectId).toArray(),
  ]);
  useFtth.setState({
    projectId,
    objects: new Map(objs.filter((o) => !o.deleted).map((o) => [o.id, o])),
    cables: new Map(cables.filter((o) => !o.deleted).map((o) => [o.id, o])),
    splitters: new Map(spl.filter((o) => !o.deleted).map((o) => [o.id, o])),
  });
  bump();
}

/** resolve the CAD entity linked to an FTTH row (by id, then by handle) */
export function linkedEntity(cad: { entityId?: number; handle?: string }): Entity | undefined {
  const doc = app.doc;
  if (!doc) return undefined;
  if (cad.entityId !== undefined) { const e = doc.get(cad.entityId); if (e && (!cad.handle || e.handle === cad.handle || !e.handle)) return e; }
  if (cad.handle) for (const e of doc.all()) if (e.handle === cad.handle) return e;
  return undefined;
}

export function ftthForEntity(entityId: number): { kind: 'object' | 'cable'; id: string } | undefined {
  const r = byEntity.get(entityId);
  if (r) return r;
  const e = app.doc?.get(entityId);
  return e?.handle ? byHandle.get(e.handle) : undefined;
}

export const getObject = (id?: string) => (id ? useFtth.getState().objects.get(id) : undefined);
export const getCable = (id?: string) => (id ? useFtth.getState().cables.get(id) : undefined);

export function findByCode(code: string): FtthObjectRow | CableRow | undefined {
  const n = code.trim().toLowerCase();
  const s = useFtth.getState();
  for (const o of s.objects.values()) if (o.code.toLowerCase() === n) return o;
  for (const c of s.cables.values()) if (c.code.toLowerCase() === n) return c;
  return undefined;
}

export function nearestObjects(p: Vec2, n = 5, filter?: (o: FtthObjectRow) => boolean): { o: FtthObjectRow; d: number }[] {
  const s = useFtth.getState();
  const out: { o: FtthObjectRow; d: number }[] = [];
  let r = 50 * app.unitsPerMeter();
  for (let it = 0; it < 12 && out.length < n; it++, r *= 3) {
    out.length = 0;
    for (const hit of tree.search({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      const o = s.objects.get(hit.id);
      if (!o || (filter && !filter(o))) continue;
      out.push({ o, d: Math.hypot(o.cad.x - p.x, o.cad.y - p.y) });
    }
  }
  return out.sort((a, b) => a.d - b.d).slice(0, n);
}

// ---------------- objects ----------------
export async function saveObject(o: Partial<FtthObjectRow> & { kind: FtthObjectRow['kind']; cad: FtthObjectRow['cad'] }): Promise<FtthObjectRow> {
  requirePerm(o.id ? 'field.edit' : 'ftth.edit');
  const pid = currentProjectId()!;
  const prev = o.id ? useFtth.getState().objects.get(o.id) : undefined;
  const row: FtthObjectRow = stamp({
    id: o.id ?? uid(), projectId: pid, kind: o.kind, code: o.code ?? '', name: o.name, status: o.status ?? 'planned',
    props: o.props ?? {}, cad: o.cad, parentId: o.parentId, mode: o.mode ?? useApp.getState().mode, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
    ...(prev ? { ...prev, ...o } : {}),
  } as FtthObjectRow);
  await db.ftthObjects.put(row);
  recordChange('ftthObjects', row.id, 'put', pid);
  audit(prev ? 'ftth.update' : 'ftth.create', `${row.kind} ${row.code}`, undefined, pid);
  const m = new Map(useFtth.getState().objects); m.set(row.id, row);
  useFtth.setState({ objects: m });
  bump();
  return row;
}

export async function deleteObject(id: string) {
  requirePerm('ftth.edit');
  const o = getObject(id);
  if (!o) return;
  await db.ftthObjects.delete(id);
  recordChange('ftthObjects', id, 'delete', o.projectId);
  audit('ftth.delete', `${o.kind} ${o.code}`, undefined, o.projectId);
  const m = new Map(useFtth.getState().objects); m.delete(id);
  useFtth.setState({ objects: m });
  bump();
}

// ---------------- cables ----------------
export function cableGeometryLength(c: CableRow): number | null {
  const e = linkedEntity(c.cad);
  if (!e) return null;
  const L = entityLength(e);
  return L === null ? null : L / app.unitsPerMeter();
}

export async function saveCable(c: Partial<CableRow> & { cad: CableRow['cad'] }): Promise<CableRow> {
  requirePerm(c.id ? 'field.edit' : 'ftth.edit');
  const pid = currentProjectId()!;
  const prev = c.id ? getCable(c.id) : undefined;
  let row: CableRow = stamp({
    id: uid(), projectId: pid, code: '', category: 'distribution', fiberCount: 12, lengthMode: 'auto', length: 0, slack: 0,
    status: 'planned', props: {}, mode: useApp.getState().mode, createdAt: Date.now(), updatedAt: Date.now(),
    ...(prev ?? {}), ...c,
  } as CableRow);
  if (row.lengthMode === 'auto') { const L = cableGeometryLength(row); if (L !== null) row = { ...row, length: +L.toFixed(2) }; }
  await db.cables.put(row);
  recordChange('cables', row.id, 'put', pid);
  audit(prev ? 'cable.update' : 'cable.create', row.code, undefined, pid);
  const m = new Map(useFtth.getState().cables); m.set(row.id, row);
  useFtth.setState({ cables: m });
  if (!prev || prev.fiberCount !== row.fiberCount) await ensureCores(row);
  bump();
  return row;
}

export async function deleteCable(id: string) {
  requirePerm('ftth.edit');
  const c = getCable(id);
  if (!c) return;
  await db.transaction('rw', db.cables, db.cores, async () => { await db.cables.delete(id); await db.cores.where('cableId').equals(id).delete(); });
  recordChange('cables', id, 'delete', c.projectId);
  audit('cable.delete', c.code, undefined, c.projectId);
  const m = new Map(useFtth.getState().cables); m.delete(id);
  useFtth.setState({ cables: m });
  bump();
}

/** create / trim core rows so that they match the cable fibre count */
export async function ensureCores(c: CableRow) {
  if (c.category === 'duct' || c.category === 'conduit') return;
  const existing = await db.cores.where('cableId').equals(c.id).toArray();
  const have = new Set(existing.map((r) => r.index));
  const tubeSize = c.tubeSize ?? (c.fiberCount <= 12 ? c.fiberCount : 12);
  const add: CoreRow[] = [];
  for (let i = 1; i <= c.fiberCount; i++) {
    if (have.has(i)) continue;
    const cc = coreColor(i, tubeSize);
    add.push({ cableId: c.id, index: i, tube: cc.tubeNo, color: cc.fiber.name, tubeColor: cc.tube.name, status: 'available', projectId: c.projectId, updatedAt: Date.now() });
  }
  if (add.length) await db.cores.bulkPut(add);
  const extra = existing.filter((r) => r.index > c.fiberCount && r.status === 'available');
  if (extra.length) await db.cores.bulkDelete(extra.map((r) => [r.cableId, r.index] as [string, number]));
}

export async function getCores(cableId: string): Promise<CoreRow[]> {
  return (await db.cores.where('cableId').equals(cableId).toArray()).sort((a, b) => a.index - b.index);
}

export async function updateCores(rows: CoreRow[]) {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const now = Date.now();
  await db.cores.bulkPut(rows.map((r) => ({ ...r, updatedAt: now, updatedBy: useSession.getState().user?.id })));
  if (rows[0]) recordChange('cores', rows[0].cableId, 'put', pid);
  useFtth.setState((s) => ({ rev: s.rev + 1 }));
}

export async function assignCore(cableId: string, index: number, status: CoreStatus, assign?: { kind: CoreRow['assignKind']; id?: string; label?: string }) {
  const r = await db.cores.get([cableId, index]);
  if (!r) return;
  await updateCores([{ ...r, status, assignKind: assign?.kind, assignId: assign?.id, assignLabel: assign?.label }]);
}

// ---------------- splitters ----------------
export async function saveSplitter(s: Partial<SplitterRow> & { ratio: number }): Promise<SplitterRow> {
  requirePerm(s.id ? 'field.edit' : 'ftth.edit');
  const pid = currentProjectId()!;
  const prev = s.id ? useFtth.getState().splitters.get(s.id) : undefined;
  const ratio = s.ratio;
  let outputs = s.outputs ?? prev?.outputs ?? [];
  if (outputs.length !== ratio) {
    const old = new Map(outputs.map((o) => [o.port, o]));
    outputs = Array.from({ length: ratio }, (_, i) => old.get(i + 1) ?? { port: i + 1, status: 'available' as CoreStatus });
  }
  const row: SplitterRow = stamp({ id: uid(), projectId: pid, code: '', status: 'planned', props: {}, createdAt: Date.now(), updatedAt: Date.now(), ...(prev ?? {}), ...s, outputs } as SplitterRow);
  await db.splitters.put(row);
  recordChange('splitters', row.id, 'put', pid);
  audit(prev ? 'splitter.update' : 'splitter.create', row.code, `1:${ratio}`, pid);
  const m = new Map(useFtth.getState().splitters); m.set(row.id, row);
  useFtth.setState({ splitters: m });
  bump();
  return row;
}

export async function deleteSplitter(id: string) {
  requirePerm('ftth.edit');
  const s = useFtth.getState().splitters.get(id);
  if (!s) return;
  await db.splitters.delete(id);
  recordChange('splitters', id, 'delete', s.projectId);
  const m = new Map(useFtth.getState().splitters); m.delete(id);
  useFtth.setState({ splitters: m });
  bump();
}

export async function saveSplice(sp: Omit<SpliceRow, 'id' | 'projectId' | 'updatedAt'> & { id?: string }) {
  requirePerm('ftth.edit');
  const pid = currentProjectId()!;
  const row: SpliceRow = stamp({ ...sp, id: sp.id ?? uid(), projectId: pid, updatedAt: Date.now() } as SpliceRow);
  await db.splices.put(row);
  recordChange('splices', row.id, 'put', pid);
  return row;
}

/** keep FTTH rows in sync with CAD edits: positions of linked objects, auto cable lengths */
async function onDocChange(ids: number[]) {
  const s = useFtth.getState();
  const objUpdates: FtthObjectRow[] = [], cabUpdates: CableRow[] = [];
  for (const id of ids) {
    const link = byEntity.get(id);
    if (!link) continue;
    if (link.kind === 'object') {
      const o = s.objects.get(link.id);
      const e = app.doc?.get(id);
      if (o && e && 'p' in e) {
        const p = (e as any).p as Vec2;
        if (p.x !== o.cad.x || p.y !== o.cad.y) objUpdates.push({ ...o, cad: { ...o.cad, x: p.x, y: p.y }, updatedAt: Date.now() });
      }
    } else {
      const c = s.cables.get(link.id);
      if (c && c.lengthMode === 'auto') {
        const L = cableGeometryLength(c);
        if (L !== null && Math.abs(L - c.length) > 0.005) cabUpdates.push({ ...c, length: +L.toFixed(2), updatedAt: Date.now() });
      }
    }
  }
  if (!objUpdates.length && !cabUpdates.length) return;
  if (objUpdates.length) await db.ftthObjects.bulkPut(objUpdates);
  if (cabUpdates.length) await db.cables.bulkPut(cabUpdates);
  const om = new Map(s.objects), cm = new Map(s.cables);
  for (const o of objUpdates) { om.set(o.id, o); recordChange('ftthObjects', o.id, 'put', o.projectId); }
  for (const c of cabUpdates) { cm.set(c.id, c); recordChange('cables', c.id, 'put', c.projectId); }
  useFtth.setState({ objects: om, cables: cm });
  if (cabUpdates.length) useApp.getState().toast(`Cable length updated: ${cabUpdates.map((c) => `${c.code} ${c.length} m`).join(', ')}`, 'info');
  bump();
}

app.docLoadedHooks.push((doc) => {
  doc.onChange((cs) => { if (cs.modified.length) onDocChange(cs.modified); });
});
projectOpenedHooks.push((pid) => loadFtth(pid));
