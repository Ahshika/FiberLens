import React, { useEffect, useState } from 'react';
import { db, type UserRow, type AuditRow, type Role, type ProjectMemberRow } from '../../data/db';
import { useSession, createUser, changePassword, ROLE_LABEL, ROLE_PERMS, can, audit } from '../../auth/session';
import { Icon } from '../icons';
import { ask, confirmDialog } from '../../app/dialogs';
import { useApp } from '../../app/store';
import { currentProjectId } from '../../data/projects';
import { getSyncConfig, setSyncConfig, syncNow, pendingChanges, syncConflicts, type SyncConfig } from '../../data/sync';
import { toCsv } from '../../reports/tables';
import { downloadText } from '../../reports/download';

const toast = (m: string, k: 'info' | 'error' | 'success' = 'info') => useApp.getState().toast(m, k);
const ROLES: Role[] = ['admin', 'engineer', 'designer', 'technician', 'viewer'];

export function UsersPanel() {
  const me = useSession((s) => s.user);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [members, setMembers] = useState<ProjectMemberRow[]>([]);
  const [tab, setTab] = useState<'users' | 'roles' | 'audit'>('users');
  const [log, setLog] = useState<AuditRow[]>([]);
  const [q, setQ] = useState('');
  const pid = currentProjectId();
  const load = async () => {
    setUsers(await db.users.toArray());
    if (pid) setMembers(await db.projectMembers.where('projectId').equals(pid).toArray());
    setLog((await db.auditLog.orderBy('seq').reverse().limit(500).toArray()));
  };
  useEffect(() => { load(); }, [pid]);
  const admin = can('users.manage');
  const add = async () => {
    const r = await ask('New user', [
      { key: 'username', label: 'Username' }, { key: 'name', label: 'Display name' }, { key: 'pw', label: 'Initial password', type: 'password' },
      { key: 'role', label: 'Role', type: 'select', value: 'technician', options: ROLES.map((x) => ({ value: x, label: ROLE_LABEL[x] })) },
    ], { okLabel: 'Create' });
    if (!r) return;
    try { await createUser(r.username, r.name, r.pw, r.role); toast('User created', 'success'); load(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div>
      <div className="tabs">
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>Roles</button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>
      </div>
      {tab === 'users' && <>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {admin && <button className="btn primary" onClick={add}><Icon name="plus" />New user</button>}
          <button className="btn" onClick={async () => { const r = await ask('Change my password', [{ key: 'pw', label: 'New password', type: 'password' }, { key: 'pw2', label: 'Repeat', type: 'password' }]); if (!r) return; if (r.pw !== r.pw2) { toast('Passwords differ', 'error'); return; } try { await changePassword(me!.id, r.pw); toast('Password changed', 'success'); } catch (e) { toast((e as Error).message, 'error'); } }}>Change my password</button>
        </div>
        <div className="list">
          {users.map((u) => {
            const m = members.find((x) => x.userId === u.id);
            return (
              <div key={u.id} className="list-item" style={{ cursor: 'default' }}>
                <Icon name="user" />
                <div className="grow"><b>{u.displayName}</b> <span className="small muted">@{u.username}{!u.active ? ' · disabled' : ''}</span>
                  <div className="small muted">Last login {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'never'}</div>
                </div>
                {admin ? (
                  <div className="col" style={{ gap: 4 }}>
                    <select value={u.role} style={{ minHeight: 28, padding: '1px 4px' }} disabled={u.id === me?.id} onChange={async (e) => { await db.users.update(u.id, { role: e.target.value as Role }); audit('user.role', u.username, e.target.value); load(); }}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
                    {pid && <select value={m?.role ?? ''} title="Role in this project" style={{ minHeight: 28, padding: '1px 4px' }} onChange={async (e) => { if (e.target.value) await db.projectMembers.put({ projectId: pid, userId: u.id, role: e.target.value as Role }); else await db.projectMembers.delete([pid, u.id]); audit('project.member', u.username, e.target.value || 'removed', pid); load(); }}>
                      <option value="">Project: default</option>{ROLES.map((r) => <option key={r} value={r}>Project: {ROLE_LABEL[r]}</option>)}
                    </select>}
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn sm" onClick={async () => { const r = await ask(`Reset password — ${u.username}`, [{ key: 'pw', label: 'New password', type: 'password' }]); if (r) { try { await changePassword(u.id, r.pw); toast('Password reset', 'success'); } catch (e) { toast((e as Error).message, 'error'); } } }}>Reset pw</button>
                      {u.id !== me?.id && <button className="btn sm" onClick={async () => { if (await confirmDialog(u.active ? 'Disable user' : 'Enable user', u.username)) { await db.users.update(u.id, { active: !u.active }); audit('user.active', u.username, String(!u.active)); load(); } }}>{u.active ? 'Disable' : 'Enable'}</button>}
                    </div>
                  </div>
                ) : <span className="badge">{ROLE_LABEL[u.role]}</span>}
              </div>
            );
          })}
        </div>
      </>}
      {tab === 'roles' && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Permission</th>{ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}</tr></thead>
            <tbody>{[...new Set(Object.values(ROLE_PERMS).flat())].map((p) => <tr key={p}><td>{p}</td>{ROLES.map((r) => <td key={r} style={{ textAlign: 'center' }}>{ROLE_PERMS[r].includes(p) ? '✓' : ''}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {tab === 'audit' && <>
        <div className="row" style={{ marginBottom: 8 }}>
          <input className="grow" placeholder="Filter (user, action, target)" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={() => downloadText('audit_log.csv', toCsv(log.map((l) => ({ Time: new Date(l.at).toISOString(), User: l.userName ?? '', Action: l.action, Target: l.target ?? '', Details: l.details ?? '', Project: l.projectId ?? '' }))), 'text/csv')}>CSV</button>
        </div>
        <div className="list">
          {log.filter((l) => !q || `${l.userName} ${l.action} ${l.target} ${l.details}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300).map((l) => (
            <div key={l.seq} className="small" style={{ padding: '5px 2px', borderBottom: '1px solid var(--line)' }}>
              <span className="mono muted">{new Date(l.at).toLocaleString()}</span> · <b>{l.userName ?? 'system'}</b> · <span className="badge">{l.action}</span> {l.target} <span className="muted">{l.details}</span>
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

export function SyncPanel() {
  const [cfg, setCfg] = useState<SyncConfig | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => { getSyncConfig().then(setCfg); pendingChanges().then(setPending); const on = () => setOnline(navigator.onLine); addEventListener('online', on); addEventListener('offline', on); return () => { removeEventListener('online', on); removeEventListener('offline', on); }; }, []);
  if (!cfg) return null;
  const save = async (c: SyncConfig) => { setCfg(c); await setSyncConfig(c); };
  return (
    <div>
      <div className="card small" style={{ marginBottom: 10 }}>
        FiberLens works fully offline. Every change is queued locally (with a hybrid logical clock) and pushed when a server is reachable. Conflicts: newest write wins per record; the other version is kept for review. With a passphrase, payloads are end-to-end encrypted (AES-256-GCM) before leaving the device.
      </div>
      <div className="kv small" style={{ marginBottom: 10 }}>
        <div>Network</div><div>{online ? <span className="badge ok">online</span> : <span className="badge warn">offline</span>}</div>
        <div>Pending changes</div><div>{pending}</div>
        <div>Last sync</div><div>{cfg.lastPullAt ? new Date(cfg.lastPullAt).toLocaleString() : 'never'}</div>
      </div>
      <div className="field"><label>Server URL (e.g. https://sync.example.com — see server/README)</label><input value={cfg.url} onChange={(e) => save({ ...cfg, url: e.target.value })} placeholder="https://…" /></div>
      <div className="field"><label>Access token</label><input type="password" value={cfg.token ?? ''} onChange={(e) => save({ ...cfg, token: e.target.value })} /></div>
      <div className="field"><label>End-to-end passphrase (optional, same on all devices)</label><input type="password" value={cfg.passphrase ?? ''} onChange={(e) => save({ ...cfg, passphrase: e.target.value })} /></div>
      <label className="row"><input type="checkbox" checked={cfg.enabled} onChange={(e) => save({ ...cfg, enabled: e.target.checked })} /> Auto-sync when online</label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !cfg.url || !can('field.edit')} onClick={async () => {
          setBusy(true);
          try { const r = await syncNow(); toast(`Sync: pushed ${r.pushed}, pulled ${r.pulled}${r.conflicts ? `, ${r.conflicts} conflicts` : ''}`, 'success'); }
          catch (e) { toast((e as Error).message, 'error'); }
          setBusy(false); setPending(await pendingChanges());
        }}><Icon name="sync" />{busy ? 'Syncing…' : 'Sync now'}</button>
      </div>
      {syncConflicts().length > 0 && <><div className="section">Conflicts ({syncConflicts().length})</div>{syncConflicts().slice(-20).map((c, i) => <div key={i} className="small">{c.table} {c.rowId} · {new Date(c.at).toLocaleString()} (local kept)</div>)}</>}
    </div>
  );
}
