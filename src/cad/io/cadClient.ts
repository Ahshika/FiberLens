import type { Drawing } from '../model/types';
import type { ExportFormat, ExportResult } from './acadExport';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    worker.onerror = (ev) => {
      for (const p of pending.values()) p.reject(new Error(ev.message || 'CAD worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(msg: any, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** Parse a DWG/DXF file off the UI thread. */
export function readCadFile(bytes: Uint8Array, name: string): Promise<{ drawing: Drawing; ms: number }> {
  // copy so the caller keeps its buffer (originals are also stored in the project)
  const copy = bytes.slice();
  return call({ op: 'read', bytes: copy, name }, [copy.buffer]);
}

/** Export the drawing (merging edits into the original file when provided). */
export function exportCadFile(drawing: Drawing, original: Uint8Array | null, format: ExportFormat, version?: string): Promise<ExportResult> {
  return call({ op: 'export', drawing, original: original ? original.slice() : null, format, version });
}
