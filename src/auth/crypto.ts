/** AES-256-GCM with PBKDF2-derived keys — for backups and sync payloads. */
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 150000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** returns salt(16) | iv(12) | ciphertext */
export async function encryptBytes(data: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource));
  const out = new Uint8Array(28 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return out;
}

export async function decryptBytes(data: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const salt = data.slice(0, 16), iv = data.slice(16, 28), ct = data.slice(28);
  const key = await deriveKey(passphrase, salt);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct as BufferSource));
  } catch {
    throw new Error('Wrong passphrase or corrupted data');
  }
}

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptJson(obj: unknown, passphrase: string): Promise<string> {
  return b64(await encryptBytes(enc.encode(JSON.stringify(obj)), passphrase));
}
export async function decryptJson<T>(s: string, passphrase: string): Promise<T> {
  return JSON.parse(dec.decode(await decryptBytes(unb64(s), passphrase)));
}
