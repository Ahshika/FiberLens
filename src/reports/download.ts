/**
 * Save a generated file. In the browser: regular download. On Android (Capacitor): written to
 * Documents/FiberLens and offered through the system share sheet (email, WhatsApp, Drive…).
 */
import { isNative, Filesystem, Directory, Share } from '../platform/native';
import { isIOS } from '../platform/ios';

function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function downloadBytes(name: string, data: Uint8Array | Blob, mime = 'application/octet-stream') {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_');
  if (isNative()) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    let res: { uri: string };
    try {
      res = await Filesystem.writeFile({ path: `FiberLens/${safe}`, data: toBase64(bytes), directory: Directory.Documents, recursive: true });
    } catch {
      // scoped storage fallback: app cache (always writable), then share
      res = await Filesystem.writeFile({ path: safe, data: toBase64(bytes), directory: Directory.Cache, recursive: true });
    }
    try { await Share.share({ title: safe, url: res.uri, dialogTitle: 'Share / save file' }); } catch { /* user dismissed */ }
    return res.uri;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  // iPhone web app: <a download> opens a preview (or nothing in home-screen mode); the share sheet
  // offers "Save to Files", WhatsApp, Mail…
  if (isIOS() && typeof navigator.share === 'function') {
    const file = new File([blob], safe, { type: mime.split(';')[0] });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: safe }); return safe; } catch (e) { if ((e as Error).name === 'AbortError') return safe; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = safe;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return safe;
}

export function downloadText(name: string, text: string, mime = 'text/plain') {
  return downloadBytes(name, new TextEncoder().encode(text), mime + ';charset=utf-8');
}

export function dataUrlToBytes(url: string): Uint8Array {
  const b = atob(url.split(',')[1]);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
