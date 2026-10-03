/**
 * CadEngine — the only place that knows about the DWG/DXF library.
 * Swap this implementation (e.g. for ODA Drawings SDK) without touching the rest of the app.
 */
import * as A from '@node-projects/acad-ts';
import type { Drawing } from '../model/types';
import { importCadDocument } from './acadImport';
import { computeExtents } from '../model/extents';

export type CadFormat = 'dwg' | 'dxf';

export interface ReadResult { drawing: Drawing; ms: number }

export interface CadEngine {
  readonly name: string;
  read(bytes: Uint8Array, fileName: string): ReadResult;
}

export function detectFormat(bytes: Uint8Array, fileName: string): CadFormat {
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  if (/^AC\d{4}$/.test(sig)) return 'dwg';
  if (/\.dwg$/i.test(fileName)) return 'dwg';
  return 'dxf';
}

export function dwgVersionOf(bytes: Uint8Array): string | null {
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  return /^AC\d{4}$/.test(sig) ? sig : null;
}

const DWG_NAMES: Record<string, string> = {
  AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000-2002', AC1018: '2004-2006',
  AC1021: '2007-2009', AC1024: '2010-2012', AC1027: '2013-2017', AC1032: '2018-2026',
};
export const dwgVersionName = (code: string) => DWG_NAMES[code] ?? code;

export function readAcad(bytes: Uint8Array, onNote?: (m: string) => void): any {
  const fmt = detectFormat(bytes, '');
  const notify = (_s: unknown, e: any) => onNote?.(e?.message ?? String(e));
  if (fmt === 'dwg') {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return (A as any).DwgReader.readFromStream(ab, notify);
  }
  return (A as any).DxfReader.readFromStream(bytes, notify);
}

export class AcadTsEngine implements CadEngine {
  readonly name = 'acad-ts (MIT)';
  read(bytes: Uint8Array, fileName: string): ReadResult {
    const t0 = Date.now();
    const fmt = detectFormat(bytes, fileName);
    const ver = dwgVersionOf(bytes);
    if (fmt === 'dwg' && ver && ['AC1.40', 'AC1.50', 'AC2.10', 'AC1001', 'AC1002', 'AC1003', 'AC1004', 'AC1006', 'AC1009', 'AC1012'].includes(ver)) {
      throw new Error(`DWG ${dwgVersionName(ver)} (${ver}) is too old for the built-in engine. Save it as DXF or DWG 2000+ and retry.`);
    }
    const notes: string[] = [];
    let doc: any;
    try {
      doc = readAcad(bytes, (m) => { if (notes.length < 50) notes.push(m); });
    } catch (err) {
      throw new Error(`Cannot read ${fileName}: ${(err as Error).message}`);
    }
    const drawing = importCadDocument(doc, fileName.replace(/\.(dwg|dxf)$/i, ''), fmt);
    if (ver) drawing.meta.version = ver;
    drawing.meta.notes.unshift(...notes.filter((n) => !/VisualStyle|Unlisted object/i.test(n)).slice(0, 20));
    const ext = computeExtents(drawing);
    drawing.meta.extMin = ext.min;
    drawing.meta.extMax = ext.max;
    return { drawing, ms: Date.now() - t0 };
  }
}
