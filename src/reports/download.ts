/**
 * Save a generated file. In the browser: regular download. On Android (Capacitor): written to
 * Documents/FiberLens and offered through the system share sheet (email, WhatsApp, Drive…).
 */
function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function downloadBytes(name: string, data: Uint8Array | Blob, mime = 'application/octet-stream') {
  const cap = (window as any).Capacitor;
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_');
  if (cap?.isNativePlatform?.() && cap.Plugins?.Filesystem) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    const res = await cap.Plugins.Filesystem.writeFile({ path: `FiberLens/${safe}`, data: toBase64(bytes), directory: 'DOCUMENTS', recursive: true });
    try { await cap.Plugins.Share?.share({ title: safe, url: res.uri, dialogTitle: 'Share / save file' }); } catch { /* user dismissed */ }
    return res.uri as string;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
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
