import { db, uid, type ProjectRow, type VersionRow, type DrawingRow } from './db';
import { packJson, unpackJson, sha256 } from './compress';
import { app } from '../app/controller';
import { useApp } from '../app/store';
import type { Drawing, Entity } from '../cad/model/types';
import type { Transaction } from '../cad/doc/CadDoc';
import { emptyDrawing } from '../cad/model/types';
import { audit, useSession, require as requirePerm } from '../auth/session';
import { gpsController } from '../gps/controller';
import { solveCalibration, type Calibration } from '../geo/calibration';
import { recordChange } from './sync';

/** FTTH tables included in version snapshots and backups */
export const FTTH_TABLES = ['ftthObjects', 'cables', 'cores', 'splitters', 'splices'] as const;
export const FIELD_TABLES = ['notes', 'surveys', 'surveyItems', 'faults', 'maintenance', 'tracks', 'calibrations'] as const;

interface OpenState { projectId: string; drawingId: string; seq: number; snapshotSeq: number; unsub: (() => void) | null }
let open: OpenState | null = null;
let journalQueue: Promise<unknown> = Promise.resolve();

export function currentProjectId() { return open?.projectId ?? null; }
export function currentDrawingId() { return open?.drawingId ?? null; }

export async function listProjects(): Promise<ProjectRow[]> {
  return (await db.projects.toArray()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createProject(p: { name: string; code?: string; client?: string; location?: string }): Promise<ProjectRow> {
  const row: ProjectRow = { id: uid(), name: p.name.trim() || 'Untitled project', code: p.code, client: p.client, location: p.location, createdAt: Date.now(), updatedAt: Date.now(), ownerId: useSession.getState().user?.id };
  await db.projects.add(row);
  const u = useSession.getState().user;
  if (u) await db.projectMembers.put({ projectId: row.id, userId: u.id, role: u.role });
  await audit('project.create', row.name, undefined, row.id);
  return row;
}

/**
 * File safety: the uploaded file is stored once, immutably, as the project's "Original".
 * Editing always happens on a working copy (snapshot + operation journal).
 */
export async function importDrawingFile(projectId: string, name: string, bytes: Uint8Array): Promise<string> {
  const drawing = await app.readFile(name, bytes);
  useApp.setState({ loading: 'Creating project copy…' });
  try {
    const fileId = uid();
    await db.files.add({ id: fileId, projectId, kind: 'original', name, mime: /\.dxf$/i.test(name) ? 'image/vnd.dxf' : 'image/vnd.dwg', size: bytes.length, sha256: await sha256(bytes), data: bytes, createdAt: Date.now(), createdBy: useSession.getState().user?.id });
    const drawingId = uid();
    const snap = packJson(drawing);
    await db.drawings.add({ id: drawingId, projectId, name: drawing.meta.name, originalFileId: fileId, snapshot: snap, journalSeq: 0, snapshotAt: Date.now(), entityCount: drawing.entities.length, updatedAt: Date.now() });
    await db.versions.add({ id: uid(), projectId, drawingId, number: 1, label: 'V1 (original import)', kind: 'import', snapshot: snap, createdAt: Date.now(), userId: useSession.getState().user?.id, userName: useSession.getState().user?.displayName, summary: `Imported ${name}: ${drawing.entities.length} entities, ${drawing.layers.length} layers`, entityCount: drawing.entities.length });
    await db.projects.update(projectId, { activeDrawingId: drawingId, updatedAt: Date.now() });
    await audit('drawing.import', name, `${drawing.entities.length} entities`, projectId);
    // auto calibration from DWG GEODATA when present
    await maybeCalibrationFromGeoData(projectId, drawingId, drawing);
    return drawingId;
  } finally {
    useApp.setState({ loading: null });
  }
}

async function maybeCalibrationFromGeoData(projectId: string, drawingId: string, d: Drawing) {
  if (!d.geo) return;
  const { crsFromDefinition } = await import('../geo/crs');
  const crs = crsFromDefinition(d.geo.csDefinition);
  if (!crs) return;
  const cal: Calibration = solveCalibration({ id: uid(), drawingId, mode: 'crs', crs, method: 'translation', points: [], m: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, rms: 0, unitsPerMeter: 1, northAngle: Math.PI / 2, updatedAt: Date.now(), source: 'geodata' });
  // design point ↔ reference point offset (projected grid)
  if (d.geo.coordinatesType === 1 /* projected grid */) {
    cal.m = { a: 1, b: 0, c: 0, d: 1, e: d.geo.designPoint.x - d.geo.referencePoint.x, f: d.geo.designPoint.y - d.geo.referencePoint.y };
  }
  await db.calibrations.put({ ...cal, projectId });
  await db.drawings.update(drawingId, { calibrationId: cal.id });
}

export async function newBlankDrawing(projectId: string, name = 'Drawing'): Promise<string> {
  const d = emptyDrawing(name);
  const drawingId = uid();
  const snap = packJson(d);
  await db.drawings.add({ id: drawingId, projectId, name, originalFileId: null, snapshot: snap, journalSeq: 0, snapshotAt: Date.now(), entityCount: 0, updatedAt: Date.now() });
  await db.versions.add({ id: uid(), projectId, drawingId, number: 1, label: 'V1 (new drawing)', kind: 'design', snapshot: snap, createdAt: Date.now(), userId: useSession.getState().user?.id, userName: useSession.getState().user?.displayName, summary: 'Blank drawing', entityCount: 0 });
  await db.projects.update(projectId, { activeDrawingId: drawingId, updatedAt: Date.now() });
  return drawingId;
}

/** Open project → load working copy (snapshot + journal replay) → calibration → UI. */
export async function openProject(projectId: string, drawingId?: string) {
  await closeProject();
  const p = await db.projects.get(projectId);
  if (!p) throw new Error('Project not found');
  const did = drawingId ?? p.activeDrawingId;
  (window as any).__flProjectId = projectId;
  const member = useSession.getState().user ? await db.projectMembers.get([projectId, useSession.getState().user!.id]) : undefined;
  useSession.getState().set({ projectRole: member?.role ?? null });
  useApp.setState({ projectId, projectName: p.name, drawingId: did ?? null, mode: (p.settings?.mode as any) ?? 'design' });
  if (!did) { useApp.setState({ screen: 'cad' }); app.loadDrawing(emptyDrawing('Empty')); return; }
  const row = await db.drawings.get(did);
  if (!row) throw new Error('Drawing not found');
  useApp.setState({ loading: `Opening ${row.name}…` });
  try {
    const drawing = unpackJson<Drawing>(row.snapshot);
    const original = row.originalFileId ? (await db.files.get(row.originalFileId))?.data ?? null : null;
    const journal = await db.journal.where('drawingId').equals(did).sortBy('seq');
    app.loadDrawing(drawing, { original, originalName: row.name });
    for (const j of journal) app.doc!.replay(j.tx as Transaction, j.kind);
    app.doc!.clearHistory();
    const seq = journal.length ? journal[journal.length - 1].seq : row.journalSeq;
    open = { projectId, drawingId: did, seq, snapshotSeq: row.journalSeq, unsub: null };
    open.unsub = app.doc!.onCommit((tx, kind) => appendJournal(tx, kind));
    useApp.setState({ dirty: false, canUndo: false, canRedo: false });
    // calibration
    const cal = row.calibrationId ? await db.calibrations.get(row.calibrationId) : (await db.calibrations.where('drawingId').equals(did).first());
    gpsController.setCalibration(cal ? solveCalibration(cal) : null, false);
    // saved tracks
    gpsController.shownTracks = [];
    await db.projects.update(projectId, { updatedAt: Date.now() });
    await audit('project.open', p.name, undefined, projectId);
    for (const h of projectOpenedHooks) await h(projectId, did);
  } finally {
    useApp.setState({ loading: null });
  }
}

export const projectOpenedHooks: ((projectId: string, drawingId: string) => Promise<void> | void)[] = [];
export const projectClosingHooks: (() => Promise<void> | void)[] = [];

function appendJournal(tx: Transaction, kind: 'do' | 'undo' | 'redo') {
  if (!open) return;
  const o = open;
  const seq = ++o.seq;
  journalQueue = journalQueue.then(async () => {
    await db.journal.add({ drawingId: o.drawingId, seq, tx, kind, userId: useSession.getState().user?.id, at: Date.now() });
    recordChange('drawings', o.drawingId, 'put', o.projectId, { seq, kind, label: tx.label });
    if (seq - o.snapshotSeq > 400) await compact();
  }).catch((err) => useApp.getState().toast('Journal write failed: ' + err.message, 'error'));
}

/** fold the journal into a new working snapshot */
export async function compact() {
  if (!open || !app.doc) return;
  const o = open;
  const snap = packJson(app.doc.snapshot());
  await db.transaction('rw', db.drawings, db.journal, async () => {
    await db.drawings.update(o.drawingId, { snapshot: snap, journalSeq: o.seq, snapshotAt: Date.now(), entityCount: app.doc!.size, updatedAt: Date.now() });
    await db.journal.where('drawingId').equals(o.drawingId).delete();
  });
  o.snapshotSeq = o.seq;
}

export async function closeProject() {
  if (!open) return;
  for (const h of projectClosingHooks) await h();
  await journalQueue;
  open.unsub?.();
  open = null;
}

async function ftthSnapshot(projectId: string): Promise<Uint8Array> {
  const data: Record<string, unknown[]> = {};
  for (const t of FTTH_TABLES) data[t] = await (db as any)[t].where('projectId').equals(projectId).toArray();
  return packJson(data);
}

function diffSummary(prev: Drawing | null, cur: Drawing): { text: string; added: number; removed: number; modified: number } {
  if (!prev) return { text: `${cur.entities.length} entities`, added: cur.entities.length, removed: 0, modified: 0 };
  const key = (e: Entity) => e.handle ? 'h' + e.handle : 'i' + e.id;
  const pm = new Map(prev.entities.map((e) => [key(e), e]));
  let added = 0, modified = 0;
  const seen = new Set<string>();
  for (const e of cur.entities) {
    const k = key(e);
    seen.add(k);
    const p = pm.get(k);
    if (!p) added++;
    else if (JSON.stringify({ ...p, id: 0 }) !== JSON.stringify({ ...e, id: 0 })) modified++;
  }
  const removed = prev.entities.length - [...pm.keys()].filter((k) => seen.has(k)).length;
  return { text: `+${added} added · ${modified} modified · −${removed} deleted`, added, removed, modified };
}

export async function listVersions(drawingId: string): Promise<VersionRow[]> {
  return (await db.versions.where('drawingId').equals(drawingId).toArray()).sort((a, b) => b.number - a.number);
}

/** Save V(n+1) (or As-Built) with drawing + FTTH snapshot and an automatic change summary. */
export async function saveVersion(label?: string, kind: VersionRow['kind'] = 'design', note = ''): Promise<VersionRow | null> {
  if (!open || !app.doc) return null;
  requirePerm('version.manage');
  const o = open;
  useApp.setState({ loading: 'Saving version…' });
  try {
    await journalQueue;
    await compact();
    const versions = await listVersions(o.drawingId);
    const last = versions[0];
    const cur = app.doc.snapshot();
    const prev = last ? unpackJson<Drawing>(last.snapshot) : null;
    const diff = diffSummary(prev, cur);
    const number = (last?.number ?? 0) + 1;
    const row: VersionRow = {
      id: uid(), projectId: o.projectId, drawingId: o.drawingId, number,
      label: label || (kind === 'asbuilt' ? `As-Built V${number}` : `V${number}`), kind,
      snapshot: packJson(cur), ftth: await ftthSnapshot(o.projectId), createdAt: Date.now(),
      userId: useSession.getState().user?.id, userName: useSession.getState().user?.displayName,
      summary: diff.text + (note ? ` — ${note}` : ''), parentId: last?.id, entityCount: cur.entities.length,
    };
    await db.versions.add(row);
    await db.projects.update(o.projectId, { updatedAt: Date.now() });
    await audit('version.save', row.label, row.summary, o.projectId);
    recordChange('versions', row.id, 'put', o.projectId);
    useApp.setState({ dirty: false });
    useApp.getState().toast(`Saved ${row.label}: ${diff.text}`, 'success');
    return row;
  } finally {
    useApp.setState({ loading: null });
  }
}

/** Restore a version as the new working copy (history is preserved: a "restore" version is created). */
export async function restoreVersion(versionId: string, restoreFtth = true) {
  if (!open) return;
  requirePerm('version.manage');
  const v = await db.versions.get(versionId);
  if (!v) return;
  const o = open;
  const drawing = unpackJson<Drawing>(v.snapshot);
  await db.transaction('rw', [db.drawings, db.journal, ...FTTH_TABLES.map((t) => (db as any)[t])], async () => {
    await db.drawings.update(o.drawingId, { snapshot: v.snapshot, journalSeq: 0, snapshotAt: Date.now(), entityCount: drawing.entities.length, updatedAt: Date.now() });
    await db.journal.where('drawingId').equals(o.drawingId).delete();
    if (restoreFtth && v.ftth) {
      const data = unpackJson<Record<string, any[]>>(v.ftth);
      for (const t of FTTH_TABLES) {
        await (db as any)[t].where('projectId').equals(o.projectId).delete();
        if (data[t]?.length) await (db as any)[t].bulkPut(data[t]);
      }
    }
  });
  await audit('version.restore', v.label, undefined, o.projectId);
  const pid = o.projectId, did = o.drawingId;
  await openProject(pid, did);
  await saveVersion(`Restored from ${v.label}`, 'restore');
}

export async function loadVersionDrawing(versionId: string): Promise<{ drawing: Drawing; row: VersionRow } | null> {
  const v = await db.versions.get(versionId);
  return v ? { drawing: unpackJson<Drawing>(v.snapshot), row: v } : null;
}

export async function deleteProject(projectId: string) {
  requirePerm('project.manage');
  const tables = ['files', 'drawings', 'versions', 'calibrations', 'tracks', ...FTTH_TABLES, 'photos', 'notes', 'surveys', 'surveyItems', 'faults', 'maintenance', 'reports'];
  const drawings = await db.drawings.where('projectId').equals(projectId).primaryKeys();
  await db.transaction('rw', [...tables.map((t) => (db as any)[t]), db.journal, db.projects, db.projectMembers], async () => {
    for (const t of tables) await (db as any)[t].where('projectId').equals(projectId).delete();
    for (const d of drawings) await db.journal.where('drawingId').equals(d).delete();
    await db.projectMembers.where('projectId').equals(projectId).delete();
    await db.projects.delete(projectId);
  });
  await audit('project.delete', projectId, undefined, projectId);
}

export async function projectDrawings(projectId: string): Promise<DrawingRow[]> {
  return db.drawings.where('projectId').equals(projectId).toArray();
}

export async function saveCalibrationRow(cal: Calibration) {
  if (!open) return;
  await db.calibrations.put({ ...cal, drawingId: open.drawingId, projectId: open.projectId });
  await db.drawings.update(open.drawingId, { calibrationId: cal.id });
  await audit('calibration.save', cal.crs, `${cal.points.filter((p) => p.enabled).length} points, RMS ${cal.rms.toFixed(3)}`, open.projectId);
  recordChange('calibrations', cal.id, 'put', open.projectId);
}

export async function saveTrackRow(name: string, pts: any[]) {
  if (!open) return;
  const upm = app.unitsPerMeter();
  let len = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].x !== undefined && pts[i - 1].x !== undefined) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / upm;
  const id = uid();
  await db.tracks.add({ id, projectId: open.projectId, name, startedAt: pts[0]?.t ?? Date.now(), endedAt: pts[pts.length - 1]?.t ?? Date.now(), points: pts, userId: useSession.getState().user?.id, length: len });
  recordChange('tracks', id, 'put', open.projectId);
}

gpsController.persistence = { saveCalibration: saveCalibrationRow, saveTrack: saveTrackRow };
app.saveVersionQuick = () => { saveVersion().catch((e) => useApp.getState().toast(e.message, 'error')); };
