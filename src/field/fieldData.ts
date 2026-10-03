import { create } from 'zustand';
import { db, uid, type PhotoRow, type NoteRow, type SurveyRow, type SurveyItemRow, type FaultRow, type MaintenanceRow } from '../data/db';
import { currentProjectId, projectOpenedHooks } from '../data/projects';
import { recordChange } from '../data/sync';
import { useSession, audit, require as requirePerm } from '../auth/session';
import { useGps } from '../gps/gpsStore';
import { isUsable, cadToGeo } from '../geo/calibration';
import { app } from '../app/controller';
import type { Vec2 } from '../cad/model/types';

/** reactive revision counter so UIs refresh after field-data writes */
export const useField = create<{ rev: number; activeSurvey: string | null; set: (p: any) => void }>((set) => ({ rev: 0, activeSurvey: null, set: (p) => set(p) }));
const bump = () => { useField.setState((s) => ({ rev: s.rev + 1 })); app.view?.invalidateOverlay(); };

export interface Located { x?: number; y?: number; lat?: number; lon?: number; acc?: number }

/** current location: GPS when available, else a given CAD point (converted to lat/lon when calibrated) */
export function hereOr(p?: Vec2): Located {
  const g = useGps.getState();
  if (p) {
    const out: Located = { x: p.x, y: p.y };
    if (isUsable(g.calibration)) { const ll = cadToGeo(g.calibration, p.x, p.y); out.lat = ll.lat; out.lon = ll.lon; }
    return out;
  }
  if (g.fix) return { lat: g.fix.lat, lon: g.fix.lon, acc: g.fix.accuracy, x: g.cad?.x, y: g.cad?.y };
  if (app.view) return { x: app.view.cam.cx, y: app.view.cam.cy };
  return {};
}

const me = () => ({ id: useSession.getState().user?.id, name: useSession.getState().user?.displayName });

/** pick a file from camera / gallery / recorder */
export function pickFile(accept: string, capture?: 'environment' | 'user'): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    if (capture) inp.setAttribute('capture', capture);
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

async function resizeImage(file: Blob, max: number, quality = 0.85): Promise<{ bytes: Uint8Array; dataUrl?: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return { bytes: new Uint8Array(await file.arrayBuffer()), w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', quality);
  const b = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return { bytes, dataUrl, w: c.width, h: c.height };
}

export interface MediaLink { objectId?: string; noteId?: string; surveyId?: string; faultId?: string; maintId?: string; at?: Vec2 }

export async function addPhoto(file: File | Blob, link: MediaLink = {}, name?: string): Promise<PhotoRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const full = await resizeImage(file, 2400, 0.86);
  const thumb = await resizeImage(file, 320, 0.7);
  const loc = hereOr(link.at);
  const n = (await db.photos.where('projectId').equals(pid).count()) + 1;
  const row: PhotoRow = {
    id: uid(), projectId: pid, objectId: link.objectId, noteId: link.noteId, surveyId: link.surveyId, faultId: link.faultId, maintId: link.maintId,
    name: name ?? `IMG${String(n).padStart(4, '0')}.jpg`, mime: 'image/jpeg', data: full.bytes, thumb: thumb.dataUrl,
    lat: loc.lat, lon: loc.lon, x: loc.x, y: loc.y, takenAt: Date.now(), userId: me().id, kind: 'photo', updatedAt: Date.now(),
  };
  await db.photos.put(row);
  recordChange('photos', row.id, 'put', pid);
  audit('photo.add', row.name, link.objectId, pid);
  bump();
  return row;
}

export async function addMedia(file: Blob, kind: 'video' | 'audio', link: MediaLink = {}, name?: string): Promise<PhotoRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const loc = hereOr(link.at);
  const ext = kind === 'video' ? 'mp4' : 'webm';
  const row: PhotoRow = {
    id: uid(), projectId: pid, ...link, name: name ?? `${kind === 'video' ? 'VID' : 'VOICE'}_${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}.${ext}`,
    mime: file.type || (kind === 'video' ? 'video/mp4' : 'audio/webm'), data: new Uint8Array(await file.arrayBuffer()),
    lat: loc.lat, lon: loc.lon, x: loc.x, y: loc.y, takenAt: Date.now(), userId: me().id, kind, updatedAt: Date.now(),
  } as PhotoRow;
  delete (row as any).at;
  await db.photos.put(row);
  recordChange('photos', row.id, 'put', pid);
  bump();
  return row;
}

export async function deleteMedia(id: string) {
  requirePerm('field.edit');
  const r = await db.photos.get(id);
  await db.photos.delete(id);
  if (r) recordChange('photos', id, 'delete', r.projectId);
  bump();
}

/** record audio with MediaRecorder (voice notes) */
export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.rec = new MediaRecorder(this.stream);
    this.chunks = [];
    this.rec.ondataavailable = (e) => this.chunks.push(e.data);
    this.rec.start();
  }
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(new Blob());
      this.rec.onstop = () => { this.stream?.getTracks().forEach((t) => t.stop()); resolve(new Blob(this.chunks, { type: this.rec!.mimeType || 'audio/webm' })); };
      this.rec.stop();
    });
  }
}

// ---------------- notes ----------------
export async function saveNote(n: Partial<NoteRow> & { title: string }): Promise<NoteRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const prev = n.id ? await db.notes.get(n.id) : undefined;
  const loc = prev ? {} : hereOr(n.x !== undefined ? { x: n.x, y: n.y! } : undefined);
  const row: NoteRow = { id: uid(), projectId: pid, text: '', status: 'open', priority: 'normal', userId: me().id, userName: me().name, createdAt: Date.now(), ...loc, ...(prev ?? {}), ...n, updatedAt: Date.now() } as NoteRow;
  await db.notes.put(row);
  recordChange('notes', row.id, 'put', pid);
  audit(prev ? 'note.update' : 'note.create', row.title, row.objectCode, pid);
  bump();
  return row;
}
export async function deleteNote(id: string) {
  requirePerm('field.edit');
  const r = await db.notes.get(id);
  await db.notes.delete(id);
  if (r) recordChange('notes', id, 'delete', r.projectId);
  bump();
}

// ---------------- surveys ----------------
export async function startSurvey(name: string): Promise<SurveyRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const row: SurveyRow = { id: uid(), projectId: pid, name, startedAt: Date.now(), userId: me().id, userName: me().name, updatedAt: Date.now() };
  await db.surveys.put(row);
  recordChange('surveys', row.id, 'put', pid);
  useField.setState({ activeSurvey: row.id });
  bump();
  return row;
}
export async function endSurvey(id: string) {
  await db.surveys.update(id, { endedAt: Date.now(), updatedAt: Date.now() });
  recordChange('surveys', id, 'put', currentProjectId() ?? undefined);
  useField.setState({ activeSurvey: null });
  bump();
}
export async function addSurveyItem(item: Omit<SurveyItemRow, 'id' | 'projectId' | 'createdAt' | 'updatedAt'> & { at?: Vec2 }): Promise<SurveyItemRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const loc = hereOr(item.at);
  const { at, ...rest } = item;
  void at;
  const row: SurveyItemRow = { id: uid(), projectId: pid, createdAt: Date.now(), updatedAt: Date.now(), userId: me().id, ...loc, ...rest } as SurveyItemRow;
  await db.surveyItems.put(row);
  recordChange('surveyItems', row.id, 'put', pid);
  bump();
  return row;
}

// ---------------- faults & maintenance ----------------
export async function saveFault(f: Partial<FaultRow> & { description: string }): Promise<FaultRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const prev = f.id ? await db.faults.get(f.id) : undefined;
  const row: FaultRow = { id: uid(), projectId: pid, severity: 'medium', status: 'open', openedAt: Date.now(), userId: me().id, ...(prev ?? {}), ...f, updatedAt: Date.now() } as FaultRow;
  if (row.status === 'resolved' && !row.closedAt) row.closedAt = Date.now();
  await db.faults.put(row);
  recordChange('faults', row.id, 'put', pid);
  audit(prev ? 'fault.update' : 'fault.open', row.description.slice(0, 60), row.objectId, pid);
  bump();
  return row;
}
export async function saveMaintenance(m: Partial<MaintenanceRow> & { objectId: string; action: MaintenanceRow['action'] }): Promise<MaintenanceRow> {
  requirePerm('field.edit');
  const pid = currentProjectId()!;
  const prev = m.id ? await db.maintenance.get(m.id) : undefined;
  const row: MaintenanceRow = { id: uid(), projectId: pid, technician: me().name ?? '', date: Date.now(), notes: '', status: 'done', ...(prev ?? {}), ...m, updatedAt: Date.now() } as MaintenanceRow;
  await db.maintenance.put(row);
  recordChange('maintenance', row.id, 'put', pid);
  audit('maintenance.save', row.action, row.objectId, pid);
  bump();
  return row;
}

projectOpenedHooks.push(async (pid) => {
  const open = await db.surveys.where('projectId').equals(pid).filter((s) => !s.endedAt).first();
  useField.setState({ activeSurvey: open?.id ?? null });
  bump();
});
