import Dexie, { type Table } from 'dexie';
import type { TrackPoint } from '../gps/gpsStore';
import type { Calibration } from '../geo/calibration';

export type Role = 'admin' | 'engineer' | 'designer' | 'technician' | 'viewer';

export interface Syncable { projectId: string; updatedAt: number; updatedBy?: string; rev?: number; deleted?: boolean }

export interface UserRow { id: string; username: string; displayName: string; role: Role; pwdHash: string; salt: string; active: boolean; createdAt: number; lastLogin?: number }
export interface ProjectRow { id: string; name: string; code?: string; client?: string; location?: string; createdAt: number; updatedAt: number; ownerId?: string; activeDrawingId?: string; settings?: Record<string, any>; thumb?: string }
export interface ProjectMemberRow { projectId: string; userId: string; role: Role }
export interface FileRow { id: string; projectId: string; kind: 'original' | 'attachment' | 'export' | 'report'; name: string; mime: string; size: number; sha256: string; data: Uint8Array; createdAt: number; createdBy?: string }
export interface DrawingRow { id: string; projectId: string; name: string; originalFileId: string | null; snapshot: Uint8Array; journalSeq: number; snapshotAt: number; calibrationId?: string; entityCount: number; updatedAt: number }
export interface JournalRow { drawingId: string; seq: number; tx: any; kind: 'do' | 'undo' | 'redo'; userId?: string; at: number }
export interface VersionRow { id: string; projectId: string; drawingId: string; number: number; label: string; kind: 'design' | 'asbuilt' | 'import' | 'restore'; snapshot: Uint8Array; ftth?: Uint8Array; createdAt: number; userId?: string; userName?: string; summary: string; parentId?: string; entityCount: number }
export interface CalibrationRow extends Calibration { projectId: string }
export interface TrackRow { id: string; projectId: string; name: string; startedAt: number; endedAt: number; points: TrackPoint[]; userId?: string; length: number }

export type FtthKind = 'OLT' | 'ODF' | 'FDH' | 'FDT' | 'FAT' | 'FTB' | 'Cabinet' | 'Manhole' | 'Handhole' | 'Pole' | 'Closure' | 'Splitter' | 'Customer' | 'Building' | 'Joint';
export type ObjStatus = 'planned' | 'installed' | 'in-service' | 'faulty' | 'removed' | 'pending';
export interface FtthObjectRow extends Syncable {
  id: string; kind: FtthKind; code: string; name?: string; status: ObjStatus;
  props: Record<string, any>;
  /** link to CAD geometry */
  cad: { handle?: string; entityId?: number; x: number; y: number };
  parentId?: string;
  mode: 'design' | 'asbuilt';
  createdAt: number;
}
export type CableCategory = 'feeder' | 'distribution' | 'drop' | 'duct' | 'conduit';
export interface CableRow extends Syncable {
  id: string; code: string; category: CableCategory; fiberCount: number; tubeSize?: number; cableType?: string;
  fromId?: string; toId?: string;
  cad: { handle?: string; entityId?: number };
  lengthMode: 'auto' | 'manual'; length: number; slack: number;
  status: ObjStatus; props: Record<string, any>; mode: 'design' | 'asbuilt'; createdAt: number;
}
export type CoreStatus = 'used' | 'spare' | 'reserved' | 'damaged' | 'available';
export interface CoreRow extends Syncable { cableId: string; index: number; tube: number; color: string; tubeColor: string; status: CoreStatus; assignKind?: 'customer' | 'object' | 'splitter' | 'cable'; assignId?: string; assignLabel?: string; notes?: string }
export interface SplitterRow extends Syncable {
  id: string; code: string; ratio: number; parentId?: string; level?: number;
  input?: { cableId?: string; core?: number };
  outputs: { port: number; cableId?: string; core?: number; customerId?: string; status: CoreStatus }[];
  status: ObjStatus; props: Record<string, any>; createdAt: number;
}
export interface SpliceRow extends Syncable { id: string; closureId?: string; a: { cableId: string; core: number }; b: { cableId: string; core: number }; loss?: number }
export interface PhotoRow extends Syncable { id: string; objectId?: string; noteId?: string; surveyId?: string; faultId?: string; maintId?: string; name: string; mime: string; data: Uint8Array; thumb?: string; lat?: number; lon?: number; x?: number; y?: number; takenAt: number; userId?: string; kind: 'photo' | 'video' | 'audio' }
export interface NoteRow extends Syncable { id: string; objectId?: string; objectCode?: string; x?: number; y?: number; lat?: number; lon?: number; title: string; text: string; issue?: string; status: 'open' | 'pending' | 'resolved'; priority?: 'low' | 'normal' | 'high'; userId?: string; userName?: string; createdAt: number }
export interface SurveyRow extends Syncable { id: string; name: string; startedAt: number; endedAt?: number; userId?: string; userName?: string; notes?: string }
export interface SurveyItemRow extends Syncable { id: string; surveyId: string; kind: 'point' | 'photo' | 'video' | 'voice' | 'note' | 'object' | 'damage' | 'inspection' | 'installation'; x?: number; y?: number; lat?: number; lon?: number; acc?: number; text?: string; payload?: Record<string, any>; mediaId?: string; objectId?: string; createdAt: number; userId?: string }
export interface FaultRow extends Syncable { id: string; objectId?: string; customerId?: string; severity: 'low' | 'medium' | 'high' | 'critical'; description: string; status: 'open' | 'in-progress' | 'resolved'; openedAt: number; closedAt?: number; traceIds?: string[]; userId?: string; resolution?: string }
export interface MaintenanceRow extends Syncable { id: string; objectId: string; action: 'inspection' | 'repair' | 'replace' | 'install' | 'clean' | 'other'; technician: string; date: number; notes: string; faultId?: string; status: string; photoIds?: string[] }
export interface ReportRow { id: string; projectId: string; kind: string; name: string; createdAt: number; fileId?: string }
export interface AuditRow { seq?: number; at: number; userId?: string; userName?: string; projectId?: string; action: string; target?: string; details?: string }
export interface OutboxRow { seq?: number; table: string; rowId: string; op: 'put' | 'delete'; hlc: string; projectId?: string; payload?: any }
export interface SettingRow { key: string; value: any }
export interface DetectRuleRow { id: string; projectId?: string; kind: FtthKind | 'cable'; layerPattern?: string; blockPattern?: string; textPattern?: string; codeFrom?: 'attribute' | 'text-near' | 'block' | 'auto'; codeAttr?: string; category?: CableCategory; fiberCount?: number; enabled: boolean; order: number }

export class FiberLensDB extends Dexie {
  users!: Table<UserRow, string>;
  projects!: Table<ProjectRow, string>;
  projectMembers!: Table<ProjectMemberRow, [string, string]>;
  files!: Table<FileRow, string>;
  drawings!: Table<DrawingRow, string>;
  journal!: Table<JournalRow, [string, number]>;
  versions!: Table<VersionRow, string>;
  calibrations!: Table<CalibrationRow, string>;
  tracks!: Table<TrackRow, string>;
  ftthObjects!: Table<FtthObjectRow, string>;
  cables!: Table<CableRow, string>;
  cores!: Table<CoreRow, [string, number]>;
  splitters!: Table<SplitterRow, string>;
  splices!: Table<SpliceRow, string>;
  photos!: Table<PhotoRow, string>;
  notes!: Table<NoteRow, string>;
  surveys!: Table<SurveyRow, string>;
  surveyItems!: Table<SurveyItemRow, string>;
  faults!: Table<FaultRow, string>;
  maintenance!: Table<MaintenanceRow, string>;
  reports!: Table<ReportRow, string>;
  auditLog!: Table<AuditRow, number>;
  syncOutbox!: Table<OutboxRow, number>;
  settings!: Table<SettingRow, string>;
  detectRules!: Table<DetectRuleRow, string>;

  constructor(name = 'fiberlens') {
    super(name);
    this.version(1).stores({
      users: 'id, &username, role',
      projects: 'id, name, updatedAt',
      projectMembers: '[projectId+userId], projectId, userId',
      files: 'id, projectId, kind',
      drawings: 'id, projectId',
      journal: '[drawingId+seq], drawingId',
      versions: 'id, projectId, drawingId, createdAt, [drawingId+number]',
      calibrations: 'id, projectId, drawingId',
      tracks: 'id, projectId, startedAt',
      ftthObjects: 'id, projectId, kind, code, [projectId+kind], [projectId+code], cad.handle, parentId',
      cables: 'id, projectId, code, fromId, toId, [projectId+code], cad.handle',
      cores: '[cableId+index], cableId, projectId, assignId, status',
      splitters: 'id, projectId, code, parentId',
      splices: 'id, projectId, closureId, a.cableId, b.cableId',
      photos: 'id, projectId, objectId, noteId, surveyId, faultId, takenAt',
      notes: 'id, projectId, objectId, status, createdAt',
      surveys: 'id, projectId, startedAt',
      surveyItems: 'id, surveyId, projectId, createdAt',
      faults: 'id, projectId, objectId, status, openedAt',
      maintenance: 'id, projectId, objectId, date',
      reports: 'id, projectId, createdAt',
      auditLog: '++seq, at, projectId, userId, action',
      syncOutbox: '++seq, table, projectId',
      settings: 'key',
      detectRules: 'id, projectId, order',
    });
  }
}

export const db = new FiberLensDB();

export const uid = () => (crypto as any).randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);

export async function getSetting<T>(key: string, def: T): Promise<T> {
  const r = await db.settings.get(key);
  return r ? (r.value as T) : def;
}
export async function setSetting(key: string, value: any) { await db.settings.put({ key, value }); }
