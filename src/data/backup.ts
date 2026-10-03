import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db } from './db';
import { encryptBytes, decryptBytes } from '../auth/crypto';
import { downloadBytes, stamp } from '../reports/download';
import { useApp } from '../app/store';
import { ask, confirmDialog } from '../app/dialogs';
import { audit } from '../auth/session';

const PROJECT_TABLES = ['files', 'drawings', 'versions', 'calibrations', 'tracks', 'ftthObjects', 'cables', 'cores', 'splitters', 'splices', 'photos', 'notes', 'surveys', 'surveyItems', 'faults', 'maintenance', 'reports', 'detectRules', 'projectMembers'] as const;
const BINARY: Record<string, string[]> = { files: ['data'], drawings: ['snapshot'], versions: ['snapshot', 'ftth'], photos: ['data'] };
const MAGIC = strToU8('FLBAK1');

/** Full offline project backup (.flbak = zip, optionally AES-GCM encrypted). */
export async function exportBackup(projectId: string, passphrase?: string) {
  useApp.setState({ loading: 'Creating backup…' });
  try {
    const p = await db.projects.get(projectId);
    if (!p) throw new Error('Project not found');
    const files: Record<string, Uint8Array> = {};
    const manifest: Record<string, any[]> = { projects: [p] };
    for (const t of PROJECT_TABLES) {
      const rows: any[] = await (db as any)[t].where('projectId').equals(projectId).toArray();
      manifest[t] = rows.map((r, i) => {
        const copy = { ...r };
        for (const k of BINARY[t] ?? []) if (copy[k] instanceof Uint8Array) { const path = `bin/${t}/${i}_${k}`; files[path] = copy[k]; copy[k] = { $bin: path }; }
        return copy;
      });
    }
    const drawings = manifest.drawings.map((d: any) => d.id);
    manifest.journal = [];
    for (const d of drawings) manifest.journal.push(...(await db.journal.where('drawingId').equals(d).toArray()));
    files['manifest.json'] = strToU8(JSON.stringify({ version: 1, createdAt: Date.now(), app: 'FiberLens 1.0.0', data: manifest }));
    let out: Uint8Array = zipSync(files, { level: 1 });
    if (passphrase) {
      const enc = await encryptBytes(out, passphrase);
      out = new Uint8Array(MAGIC.length + enc.length);
      out.set(MAGIC, 0); out.set(enc, MAGIC.length);
    }
    await downloadBytes(`${p.name.replace(/\W+/g, '_')}_${stamp()}.flbak`, out);
    await audit('backup.export', p.name, passphrase ? 'encrypted' : 'plain', projectId);
    useApp.getState().toast('Backup created', 'success');
  } finally {
    useApp.setState({ loading: null });
  }
}

export function importBackup(): Promise<void> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.flbak,.zip';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve();
      try {
        let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer());
        if (strFromU8(bytes.slice(0, MAGIC.length)) === 'FLBAK1') {
          const r = await ask('Encrypted backup', [{ key: 'pw', label: 'Passphrase', type: 'password' }]);
          if (!r) return resolve();
          bytes = await decryptBytes(bytes.slice(MAGIC.length), r.pw);
        }
        useApp.setState({ loading: 'Restoring backup…' });
        const z = unzipSync(bytes);
        const m = JSON.parse(strFromU8(z['manifest.json']));
        const data = m.data as Record<string, any[]>;
        const proj = data.projects[0];
        if (await db.projects.get(proj.id)) {
          useApp.setState({ loading: null });
          if (!(await confirmDialog('Project exists', `"${proj.name}" already exists on this device. Overwrite it with the backup?`, true, 'Overwrite'))) return resolve();
          useApp.setState({ loading: 'Restoring backup…' });
        }
        const revive = (t: string, r: any) => { for (const k of BINARY[t] ?? []) if (r[k]?.$bin) r[k] = z[r[k].$bin]; return r; };
        await db.transaction('rw', db.tables, async () => {
          await db.projects.put(proj);
          for (const t of PROJECT_TABLES) {
            await (db as any)[t].where('projectId').equals(proj.id).delete();
            if (data[t]?.length) await (db as any)[t].bulkPut(data[t].map((r) => revive(t, r)));
          }
          if (data.journal?.length) await db.journal.bulkPut(data.journal);
        });
        await audit('backup.import', proj.name, undefined, proj.id);
        useApp.getState().toast(`Restored "${proj.name}"`, 'success');
      } catch (e) {
        useApp.getState().toast('Backup import failed: ' + (e as Error).message, 'error');
      } finally {
        useApp.setState({ loading: null });
        resolve();
      }
    };
    inp.click();
  });
}
