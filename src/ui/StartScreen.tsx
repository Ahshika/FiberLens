import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/store';
import { Icon, Logo } from './icons';
import { useSession, initSession, login, setupAdmin, logout, ROLE_LABEL, can } from '../auth/session';
import { listProjects, createProject, importDrawingFile, openProject, newBlankDrawing, deleteProject } from '../data/projects';
import type { ProjectRow } from '../data/db';
import { ask, confirmDialog } from '../app/dialogs';
import { DEV_SEED } from '../dev/seed';
import { useT } from '../app/i18n';

function AuthForm({ setup }: { setup: boolean }) {
  const [u, setU] = useState(setup ? 'admin' : '');
  const [n, setN] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    try {
      const ok = setup ? await setupAdmin(u, n || u, p) : await login(u, p);
      if (!ok) setErr('Invalid username or password');
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card" style={{ maxWidth: 420, margin: '30px auto', padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>{setup ? 'Create the administrator account' : 'Sign in'}</h3>
      {setup && <p className="muted small">First launch on this device. Accounts are stored locally (PBKDF2-hashed) and work offline.</p>}
      <div className="field"><label>Username</label><input value={u} onChange={(e) => setU(e.target.value)} autoCapitalize="none" /></div>
      {setup && <div className="field"><label>Display name</label><input value={n} onChange={(e) => setN(e.target.value)} /></div>}
      <div className="field"><label>Password</label><input type="password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>
      {err && <div className="badge err" style={{ marginBottom: 8 }}>{err}</div>}
      <button className="btn primary" style={{ width: '100%' }} onClick={submit}>{setup ? 'Create & continue' : 'Sign in'}</button>
    </div>
  );
}

export function StartScreen() {
  const session = useSession();
  const t = useT();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingProject = useRef<string | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => { initSession(); }, []);
  const refresh = () => listProjects().then(setProjects);
  useEffect(() => { if (session.user) refresh(); }, [session.user]);

  // developer convenience: ?sample=<url>&devseed=1 (test data from src/dev/seed.ts)
  useEffect(() => {
    if (!session.ready) return;
    const q = new URLSearchParams(import.meta.env.DEV ? location.search : '');
    if (q.get('devseed') && session.needsSetup) { setupAdmin(DEV_SEED.username, DEV_SEED.displayName, DEV_SEED.password); return; }
    if (q.get('devseed') && !session.user) { login(DEV_SEED.username, DEV_SEED.password); return; }
    const sample = q.get('sample');
    if (sample && session.user && !(window as any).__sampleLoaded) {
      (window as any).__sampleLoaded = true;
      (async () => {
        const name = decodeURIComponent(sample.split('/').pop()!);
        const existing = (await listProjects()).find((p) => p.name === name);
        if (existing && existing.activeDrawingId && !q.get('fresh')) { await openProject(existing.id); return; }
        useApp.setState({ loading: 'Downloading sample…' });
        const res = await fetch(sample);
        const bytes = new Uint8Array(await res.arrayBuffer());
        useApp.setState({ loading: null });
        const p = await createProject({ name });
        await importDrawingFile(p.id, name, bytes);
        await openProject(p.id);
      })().catch((e) => { useApp.setState({ loading: null }); toast(e.message, 'error'); });
    }
  }, [session.ready, session.user, session.needsSetup]);

  const handleFiles = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (!/\.(dwg|dxf)$/i.test(f.name)) { toast('Please choose a .dwg or .dxf file', 'error'); return; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let pid = pendingProject.current;
      pendingProject.current = null;
      if (!pid) {
        const r = await ask('New project', [
          { key: 'name', label: 'Project name', value: f.name.replace(/\.(dwg|dxf)$/i, '') },
          { key: 'code', label: 'Project code (optional)' },
          { key: 'client', label: 'Client / operator (optional)' },
        ], { okLabel: 'Create' });
        if (!r) return;
        pid = (await createProject({ name: r.name, code: r.code, client: r.client })).id;
      }
      await importDrawingFile(pid, f.name, bytes);
      await openProject(pid);
    } catch (e) {
      useApp.setState({ loading: null });
      toast((e as Error).message, 'error');
    }
  };

  const newEmpty = async () => {
    const r = await ask('New blank project', [{ key: 'name', label: 'Project name', value: 'New FTTH project' }], { okLabel: 'Create' });
    if (!r) return;
    const p = await createProject({ name: r.name });
    await newBlankDrawing(p.id, 'Drawing 1');
    await openProject(p.id);
  };

  if (!session.ready) return <div className="start"><div className="empty">Loading…</div></div>;

  return (
    <div className="start" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); handleFiles(e.dataTransfer.files); }}>
      <div className="start-inner">
        <div className="hero">
          <Logo size={56} />
          <div className="grow">
            <h1>FiberLens</h1>
            <p>{t('Smart CAD + FTTH Field Engineering — your DWG is the map.')}</p>
          </div>
          {session.user && (
            <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
              <span className="badge info">{session.user.displayName} · {ROLE_LABEL[session.user.role]}</span>
              <button className="btn sm" onClick={logout}><Icon name="logout" />{t('Sign out')}</button>
            </div>
          )}
        </div>
        {session.needsSetup ? <AuthForm setup /> : !session.user ? <AuthForm setup={false} /> : (
          <>
            <div className="start-actions">
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={!can('project.manage') && !can('cad.edit')}><Icon name="import" />{t('Open DWG / DXF')}</button>
              <button className="btn" onClick={newEmpty} disabled={!can('project.manage')} title={t('New blank project')}><Icon name="plus" />{t('New blank project')}</button>
              <input ref={fileRef} type="file" accept=".dwg,.dxf" style={{ display: 'none' }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <div className={`dropzone ${over ? 'over' : ''}`} style={{ marginBottom: 20 }}>
              {t('Drop a DWG or DXF file here. The original is stored read-only; you always edit a project copy.')}
            </div>
            <div className="section">{t('Projects')} ({projects.length})</div>
            {projects.length === 0 ? <div className="empty">No projects yet.</div> : (
              <div className="proj-grid">
                {projects.map((p) => (
                  <div key={p.id} className="proj-card" onClick={() => openProject(p.id).catch((e) => toast(e.message, 'error'))}>
                    <div className="row"><Icon name="folder" /><h4 className="grow">{p.name}</h4>
                      {can('project.manage') && <button className="icon-btn" style={{ minWidth: 32, height: 32 }} title="Delete project" onClick={async (e) => {
                        e.stopPropagation();
                        if (await confirmDialog('Delete project', `Delete "${p.name}" and all its drawings, versions, FTTH data, photos and notes from this device?`, true, 'Delete')) { await deleteProject(p.id); refresh(); }
                      }}><Icon name="trash" /></button>}
                    </div>
                    {p.code && <div className="small muted">Code: {p.code}</div>}
                    {p.client && <div className="small muted">Client: {p.client}</div>}
                    <div className="small muted">Updated {new Date(p.updatedAt).toLocaleString()}</div>
                    <div className="row"><button className="btn sm" onClick={(e) => { e.stopPropagation(); pendingProject.current = p.id; fileRef.current?.click(); }}><Icon name="import" />Add drawing</button></div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
