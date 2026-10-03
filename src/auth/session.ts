import { create } from 'zustand';
import { db, uid, type Role, type UserRow } from '../data/db';

export type Permission =
  | 'view' | 'export' | 'measure'
  | 'field.edit' | 'calibrate'
  | 'cad.edit' | 'ftth.edit'
  | 'version.manage' | 'project.manage' | 'users.manage' | 'reports';

export const ROLE_PERMS: Record<Role, Permission[]> = {
  viewer: ['view', 'export', 'measure'],
  technician: ['view', 'export', 'measure', 'field.edit', 'calibrate'],
  designer: ['view', 'export', 'measure', 'field.edit', 'calibrate', 'cad.edit', 'ftth.edit', 'reports'],
  engineer: ['view', 'export', 'measure', 'field.edit', 'calibrate', 'cad.edit', 'ftth.edit', 'version.manage', 'reports', 'project.manage'],
  admin: ['view', 'export', 'measure', 'field.edit', 'calibrate', 'cad.edit', 'ftth.edit', 'version.manage', 'reports', 'project.manage', 'users.manage'],
};

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', engineer: 'Engineer', designer: 'Designer', technician: 'Field Technician', viewer: 'Viewer' };

interface SessionState { user: Omit<UserRow, 'pwdHash' | 'salt'> | null; ready: boolean; needsSetup: boolean; projectRole: Role | null; set: (p: Partial<SessionState>) => void }
export const useSession = create<SessionState>((set) => ({ user: null, ready: false, needsSetup: false, projectRole: null, set: (p) => set(p) }));

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** PBKDF2-SHA256, 120k iterations */
export async function hashPassword(password: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 120000 }, key, 256);
  return { hash: b64(new Uint8Array(bits)), salt: b64(salt) };
}

function strip(u: UserRow) { const { pwdHash, salt, ...rest } = u; void pwdHash; void salt; return rest; }

export async function initSession() {
  const count = await db.users.count();
  const lastId = localStorage.getItem('fl.session');
  let user = null;
  if (lastId) {
    const u = await db.users.get(lastId);
    if (u?.active) user = strip(u);
  }
  useSession.getState().set({ ready: true, needsSetup: count === 0, user });
}

export async function createUser(username: string, displayName: string, password: string, role: Role): Promise<UserRow> {
  if (!/^[\w.\-@]{3,40}$/.test(username)) throw new Error('Username: 3–40 letters, digits, . _ - @');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  if (await db.users.where('username').equals(username.toLowerCase()).first()) throw new Error('Username already exists');
  const { hash, salt } = await hashPassword(password);
  const row: UserRow = { id: uid(), username: username.toLowerCase(), displayName: displayName || username, role, pwdHash: hash, salt, active: true, createdAt: Date.now() };
  await db.users.add(row);
  await audit('user.create', row.username, `role=${role}`);
  return row;
}

export async function login(username: string, password: string): Promise<boolean> {
  const u = await db.users.where('username').equals(username.toLowerCase()).first();
  if (!u || !u.active) { await audit('auth.fail', username); return false; }
  const { hash } = await hashPassword(password, u.salt);
  if (hash !== u.pwdHash) { await audit('auth.fail', username); return false; }
  await db.users.update(u.id, { lastLogin: Date.now() });
  localStorage.setItem('fl.session', u.id);
  useSession.getState().set({ user: strip(u), needsSetup: false });
  await audit('auth.login', u.username);
  return true;
}

export async function setupAdmin(username: string, displayName: string, password: string) {
  const u = await createUser(username, displayName, password, 'admin');
  return login(u.username, password);
}

export async function changePassword(userId: string, password: string) {
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const { hash, salt } = await hashPassword(password);
  await db.users.update(userId, { pwdHash: hash, salt });
  await audit('user.password', userId);
}

export function logout() {
  localStorage.removeItem('fl.session');
  audit('auth.logout');
  useSession.getState().set({ user: null });
}

export function currentRole(): Role {
  const s = useSession.getState();
  return s.projectRole ?? s.user?.role ?? 'viewer';
}

export function can(p: Permission): boolean {
  return ROLE_PERMS[currentRole()].includes(p);
}

/** throws (with a friendly message) when the current user lacks a permission */
export function require(p: Permission): void {
  if (!can(p)) throw new Error(`Your role (${ROLE_LABEL[currentRole()]}) does not allow this action (${p}).`);
}

export async function audit(action: string, target?: string, details?: string, projectId?: string) {
  const u = useSession.getState().user;
  try {
    await db.auditLog.add({ at: Date.now(), userId: u?.id, userName: u?.displayName, projectId: projectId ?? (window as any).__flProjectId, action, target, details });
  } catch { /* never block on audit */ }
}
