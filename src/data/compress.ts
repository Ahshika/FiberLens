import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';

export function packJson(obj: unknown): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(obj)), { level: 4 });
}

export function unpackJson<T>(data: Uint8Array): T {
  return JSON.parse(strFromU8(gunzipSync(data))) as T;
}

export async function sha256(data: Uint8Array): Promise<string> {
  try {
    const h = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0;
    for (let i = 0; i < data.length; i += 997) h = (h * 31 + data[i]) | 0;
    return 'weak-' + (h >>> 0).toString(16) + '-' + data.length;
  }
}
