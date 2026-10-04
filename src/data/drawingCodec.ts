import { Gzip, gunzipSync, strToU8 } from 'fflate';
import type { Drawing } from '../cad/model/types';
import { unpackJson } from './compress';

/**
 * Drawing snapshots as gzipped JSON lines: line 1 = everything except model-space entities,
 * then one entity per line. Encoding and decoding never build one giant string, which keeps
 * peak memory low on phones (a 85k-entity drawing would otherwise need ~75 MB of UTF-16 text).
 */
const MAGIC = 'FLD1\n';

export function packDrawing(d: Drawing): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const gz = new Gzip({ level: 4 }, (chunk) => { parts.push(chunk); total += chunk.length; });
  const { entities, ...head } = d;
  gz.push(strToU8(MAGIC + JSON.stringify(head) + '\n'));
  let buf: string[] = [];
  let size = 0;
  for (const e of entities) {
    const s = JSON.stringify(e);
    buf.push(s);
    size += s.length;
    if (size > 256 * 1024) { gz.push(strToU8(buf.join('\n') + '\n')); buf = []; size = 0; }
  }
  gz.push(strToU8(buf.join('\n')), true);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function unpackDrawing(data: Uint8Array): Drawing {
  const raw = gunzipSync(data);
  const isLines = raw.length > 5 && raw[0] === 0x46 && raw[1] === 0x4c && raw[2] === 0x44 && raw[3] === 0x31 && raw[4] === 0x0a;
  if (!isLines) return unpackJson<Drawing>(data); // legacy single-JSON snapshot
  const dec = new TextDecoder();
  let start = 5;
  let nl = raw.indexOf(0x0a, start);
  const head = JSON.parse(dec.decode(raw.subarray(start, nl < 0 ? raw.length : nl)));
  const entities: any[] = [];
  start = nl < 0 ? raw.length : nl + 1;
  while (start < raw.length) {
    nl = raw.indexOf(0x0a, start);
    const end = nl < 0 ? raw.length : nl;
    if (end > start) entities.push(JSON.parse(dec.decode(raw.subarray(start, end))));
    start = end + 1;
  }
  return { ...head, entities } as Drawing;
}
