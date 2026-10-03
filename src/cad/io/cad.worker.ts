/// <reference lib="webworker" />
import { AcadTsEngine } from './engine';
import { exportDrawing } from './acadExport';

const engine = new AcadTsEngine();

self.onmessage = (ev: MessageEvent) => {
  const { id, op } = ev.data;
  try {
    if (op === 'read') {
      const { bytes, name } = ev.data as { bytes: Uint8Array; name: string };
      const r = engine.read(bytes, name);
      (self as any).postMessage({ id, ok: true, result: r });
    } else if (op === 'export') {
      const { drawing, original, format, version } = ev.data;
      const out = exportDrawing(drawing, original ?? null, format, version);
      (self as any).postMessage({ id, ok: true, result: out }, [out.bytes.buffer]);
    } else {
      throw new Error('Unknown op ' + op);
    }
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
