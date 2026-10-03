/**
 * Cloud sync (optional). The app is fully functional offline; every local change is recorded
 * in an outbox with a hybrid logical clock (HLC). When a server is configured, `syncNow`
 * pushes the outbox and pulls remote changes. Conflicts: last-writer-wins per row by HLC,
 * with the losing version kept in `conflicts` for review. Payloads can be AES-GCM encrypted.
 */
import { db, getSetting, setSetting } from './db';
import { encryptJson, decryptJson } from '../auth/crypto';

let lastWall = 0, counter = 0;
const nodeId = (() => {
  let n = localStorage.getItem('fl.node');
  if (!n) { n = Math.random().toString(36).slice(2, 10); localStorage.setItem('fl.node', n); }
  return n;
})();

/** HLC timestamp: wallclock(ms, 13 digits) - counter(4) - node */
export function hlc(): string {
  const now = Date.now();
  if (now > lastWall) { lastWall = now; counter = 0; } else counter++;
  return `${String(lastWall).padStart(13, '0')}-${String(counter).padStart(4, '0')}-${nodeId}`;
}
export function hlcMerge(remote: string) {
  const w = parseInt(remote.slice(0, 13), 10);
  if (w > lastWall) { lastWall = w; counter = 0; }
}

export const SYNC_TABLES = ['ftthObjects', 'cables', 'cores', 'splitters', 'splices', 'notes', 'photos', 'surveys', 'surveyItems', 'faults', 'maintenance', 'tracks', 'calibrations', 'versions', 'drawings'] as const;

export function recordChange(table: string, rowId: string, op: 'put' | 'delete', projectId?: string, payload?: any) {
  db.syncOutbox.add({ table, rowId, op, hlc: hlc(), projectId, payload }).catch(() => {});
}

export interface SyncConfig { url: string; token?: string; passphrase?: string; enabled: boolean; lastPull?: string; lastPullAt?: number }
export interface RemoteChange { table: string; rowId: string; op: 'put' | 'delete'; hlc: string; projectId?: string; row?: any; enc?: string }

export interface SyncAdapter {
  push(changes: RemoteChange[]): Promise<void>;
  pull(since: string | undefined, projectIds: string[]): Promise<{ changes: RemoteChange[]; cursor: string }>;
}

export class HttpSyncAdapter implements SyncAdapter {
  constructor(private cfg: SyncConfig) {}
  private headers() { return { 'Content-Type': 'application/json', ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}) }; }
  async push(changes: RemoteChange[]) {
    const r = await fetch(this.cfg.url.replace(/\/$/, '') + '/sync/push', { method: 'POST', headers: this.headers(), body: JSON.stringify({ changes }) });
    if (!r.ok) throw new Error(`Push failed: HTTP ${r.status}`);
  }
  async pull(since: string | undefined, projectIds: string[]) {
    const r = await fetch(this.cfg.url.replace(/\/$/, '') + '/sync/pull', { method: 'POST', headers: this.headers(), body: JSON.stringify({ since, projectIds }) });
    if (!r.ok) throw new Error(`Pull failed: HTTP ${r.status}`);
    return r.json();
  }
}

export async function getSyncConfig(): Promise<SyncConfig> { return getSetting<SyncConfig>('sync', { url: '', enabled: false }); }
export async function setSyncConfig(c: SyncConfig) { await setSetting('sync', c); }

const conflicts: { table: string; rowId: string; local: any; remote: any; at: number }[] = [];
export function syncConflicts() { return conflicts; }

const tableHasRowsKey = (t: string) => t === 'cores' ? null : 'id';

export async function syncNow(adapter?: SyncAdapter): Promise<{ pushed: number; pulled: number; conflicts: number }> {
  const cfg = await getSyncConfig();
  if (!cfg.url) throw new Error('No sync server configured');
  const ad = adapter ?? new HttpSyncAdapter(cfg);
  // ---- push ----
  const out = await db.syncOutbox.orderBy('seq').limit(500).toArray();
  const changes: RemoteChange[] = [];
  // keep only the latest queued change per row (a drawing edited 50× is uploaded once)
  const latest = new Map<string, (typeof out)[number]>();
  for (const o of out) latest.set(`${o.table}|${o.rowId}`, o);
  for (const o of latest.values()) {
    if (!(SYNC_TABLES as readonly string[]).includes(o.table)) continue;
    let row: any = undefined;
    if (o.op === 'put') {
      const t = (db as any)[o.table];
      row = o.table === 'cores' ? await t.where('cableId').equals(o.rowId).toArray() : await t.get(o.rowId);
      if (row && o.table === 'photos') row = { ...row, data: Array.from(row.data as Uint8Array) };
      if (row && (o.table === 'drawings' || o.table === 'versions')) row = { ...row, snapshot: Array.from(row.snapshot), ftth: row.ftth ? Array.from(row.ftth) : undefined };
    }
    const ch: RemoteChange = { table: o.table, rowId: o.rowId, op: o.op, hlc: o.hlc, projectId: o.projectId };
    if (row !== undefined) {
      if (cfg.passphrase) ch.enc = await encryptJson(row, cfg.passphrase);
      else ch.row = row;
    }
    changes.push(ch);
  }
  if (changes.length) await ad.push(changes);
  if (out.length) await db.syncOutbox.bulkDelete(out.map((o) => o.seq!));
  // ---- pull ----
  const projectIds = (await db.projects.toArray()).map((p) => p.id);
  const { changes: incoming, cursor } = await ad.pull(cfg.lastPull, projectIds);
  let nConf = 0;
  for (const ch of incoming) {
    hlcMerge(ch.hlc);
    const t = (db as any)[ch.table];
    if (!t) continue;
    let row = ch.row;
    if (ch.enc && cfg.passphrase) row = await decryptJson(ch.enc, cfg.passphrase);
    if (ch.op === 'delete') { await t.delete(ch.rowId); continue; }
    if (!row) continue;
    if (ch.table === 'cores') { await t.where('cableId').equals(ch.rowId).delete(); await t.bulkPut(row); continue; }
    if (ch.table === 'photos' && Array.isArray(row.data)) row.data = new Uint8Array(row.data);
    if ((ch.table === 'drawings' || ch.table === 'versions') && Array.isArray(row.snapshot)) { row.snapshot = new Uint8Array(row.snapshot); if (row.ftth) row.ftth = new Uint8Array(row.ftth); }
    const local = tableHasRowsKey(ch.table) ? await t.get(ch.rowId) : null;
    if (local && local.updatedAt && row.updatedAt && local.updatedAt > row.updatedAt) {
      conflicts.push({ table: ch.table, rowId: ch.rowId, local, remote: row, at: Date.now() });
      nConf++;
      continue; // local is newer: keep it (it will be pushed)
    }
    await t.put(row);
  }
  await setSyncConfig({ ...cfg, lastPull: cursor, lastPullAt: Date.now() });
  return { pushed: changes.length, pulled: incoming.length, conflicts: nConf };
}

export async function pendingChanges(): Promise<number> { return db.syncOutbox.count(); }

let autoTimer: any = 0;
let syncing = false;
/** background sync every 2 minutes (and when the device comes online) while enabled */
export function startAutoSync(onResult?: (r: { pushed: number; pulled: number; conflicts: number }) => void) {
  const run = async () => {
    if (syncing || !navigator.onLine) return;
    const cfg = await getSyncConfig();
    if (!cfg.enabled || !cfg.url) return;
    syncing = true;
    try { const r = await syncNow(); if (r.pushed || r.pulled) onResult?.(r); } catch { /* retry next tick */ }
    finally { syncing = false; }
  };
  clearInterval(autoTimer);
  autoTimer = setInterval(run, 120000);
  addEventListener('online', run);
  setTimeout(run, 5000);
}
