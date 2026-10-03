import React, { useEffect, useState } from 'react';
import { app } from '../../app/controller';
import { useApp, type PanelId } from '../../app/store';
import { Icon } from '../icons';
import { fmt } from '../common';
import { db, type ProjectRow, type VersionRow, type DrawingRow, type FileRow } from '../../data/db';
import { closeProject, listVersions, saveVersion, restoreVersion, currentProjectId, currentDrawingId, openProject, projectDrawings, importDrawingFile } from '../../data/projects';
import { ask, confirmDialog } from '../../app/dialogs';
import { can, useSession, ROLE_LABEL, logout } from '../../auth/session';
import { downloadBytes } from '../../reports/download';
import { exportCadFile } from '../../cad/io/cadClient';
import { unpackJson } from '../../data/compress';
import type { Drawing } from '../../cad/model/types';
import { exportBackup, importBackup } from '../../data/backup';
import { useDialog } from '../../app/dialogs';
import { XrefSection } from './XrefSection';
import { isPhone } from '../useDevice';
import { useT, useLang } from '../../app/i18n';

export function ProjectPanel() {
  const st = useApp();
  const [p, setP] = useState<ProjectRow | null>(null);
  const [drawings, setDrawings] = useState<DrawingRow[]>([]);
  const [orig, setOrig] = useState<FileRow | null>(null);
  const pid = currentProjectId();
  const load = async () => {
    if (!pid) return;
    setP((await db.projects.get(pid)) ?? null);
    setDrawings(await projectDrawings(pid));
    const d = await db.drawings.get(currentDrawingId() ?? '');
    setOrig(d?.originalFileId ? (await db.files.get(d.originalFileId)) ?? null : null);
  };
  useEffect(() => { load(); }, [pid]);
  const user = useSession((s) => s.user);
  if (!p) return <div className="empty">No project open</div>;
  const edit = async () => {
    const r = await ask('Project details', [
      { key: 'name', label: 'Name', value: p.name }, { key: 'code', label: 'Code', value: p.code ?? '' },
      { key: 'client', label: 'Client / operator', value: p.client ?? '' }, { key: 'location', label: 'Location', value: p.location ?? '' },
    ]);
    if (!r) return;
    await db.projects.update(p.id, { name: r.name, code: r.code, client: r.client, location: r.location, updatedAt: Date.now() });
    useApp.setState({ projectName: r.name });
    load();
  };
  const setMode = async (mode: 'design' | 'asbuilt') => {
    if (mode === st.mode) return;
    if (mode === 'asbuilt' && !(await confirmDialog('Switch to As-Built mode', 'As-Built mode records field changes so the design can be compared with what was actually installed. A design version (snapshot) is saved first.', false, 'Switch'))) return;
    if (mode === 'asbuilt' && can('version.manage')) await saveVersion(undefined, 'design', 'Before As-Built');
    await db.projects.update(p.id, { settings: { ...(p.settings ?? {}), mode } });
    useApp.setState({ mode });
    st.toast(mode === 'asbuilt' ? 'As-Built mode: edits now reflect the real installation' : 'Design mode', 'success');
  };
  const addDrawing = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.dwg,.dxf';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const did = await importDrawingFile(p.id, f.name, new Uint8Array(await f.arrayBuffer()));
      await openProject(p.id, did);
    };
    inp.click();
  };
  return (
    <div>
      <div className="card">
        <div className="row"><Icon name="folder" /><b className="grow">{p.name}</b><button className="btn sm" onClick={edit} disabled={!can('project.manage')}>Edit</button></div>
        <div className="kv small" style={{ marginTop: 6 }}>
          {p.code && <><div>Code</div><div>{p.code}</div></>}
          {p.client && <><div>Client</div><div>{p.client}</div></>}
          {p.location && <><div>Location</div><div>{p.location}</div></>}
          <div>Created</div><div>{new Date(p.createdAt).toLocaleString()}</div>
          <div>Signed in</div><div>{user?.displayName} ({ROLE_LABEL[useSession.getState().projectRole ?? user?.role ?? 'viewer']})</div>
        </div>
      </div>
      <div className="section">Mode</div>
      <div className="grid2">
        <button className={`btn ${st.mode === 'design' ? 'primary' : ''}`} onClick={() => setMode('design')}>Design</button>
        <button className={`btn ${st.mode === 'asbuilt' ? 'primary' : ''}`} onClick={() => setMode('asbuilt')} disabled={!can('field.edit')}>As-Built</button>
      </div>
      <div className="section">Drawings</div>
      <div className="list">
        {drawings.map((d) => (
          <div key={d.id} className={`list-item ${d.id === currentDrawingId() ? 'active' : ''}`} onClick={() => d.id !== currentDrawingId() && openProject(p.id, d.id)}>
            <Icon name="file" /><div className="grow"><div>{d.name}</div><div className="small muted">{d.entityCount.toLocaleString()} objects · updated {new Date(d.updatedAt).toLocaleString()}</div></div>
          </div>
        ))}
      </div>
      <button className="btn sm" style={{ marginTop: 6 }} onClick={addDrawing} disabled={!can('project.manage')}><Icon name="plus" />Add drawing</button>
      {orig && (
        <>
          <div className="section">Original file (read-only)</div>
          <div className="card small">
            <div className="kv"><div>Name</div><div>{orig.name}</div><div>Size</div><div>{(orig.size / 1048576).toFixed(2)} MB</div><div>SHA-256</div><div className="mono" style={{ fontSize: 10 }}>{orig.sha256.slice(0, 32)}…</div><div>Imported</div><div>{new Date(orig.createdAt).toLocaleString()}</div></div>
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => downloadBytes(orig.name, orig.data)}>Download original</button>
          </div>
        </>
      )}
      <XrefSection />
      <div className="section">Backup</div>
      <div className="row wrap">
        <button className="btn sm" onClick={async () => { const r = await ask('Encrypted backup', [{ key: 'pw', label: 'Passphrase (leave empty for no encryption)', type: 'password' }]); if (r) await exportBackup(p.id, r.pw || undefined); }}><Icon name="export" />Export project backup</button>
        <button className="btn sm" onClick={() => importBackup()}><Icon name="import" />Import backup</button>
      </div>
      <div className="section">Session</div>
      <div className="row wrap">
        <button className="btn" onClick={async () => { await closeProject(); useApp.setState({ screen: 'start', panel: null, projectId: null }); app.loadDrawing; }}><Icon name="home" />All projects</button>
        <button className="btn" onClick={async () => { await closeProject(); logout(); useApp.setState({ screen: 'start', panel: null }); }}><Icon name="logout" />Sign out</button>
      </div>
    </div>
  );
}

export function VersionsPanel() {
  const st = useApp();
  const [list, setList] = useState<VersionRow[]>([]);
  const did = currentDrawingId();
  const load = () => { if (did) listVersions(did).then(setList); };
  useEffect(load, [did, st.dirty]);
  const save = async (kind: 'design' | 'asbuilt') => {
    const r = await ask(kind === 'asbuilt' ? 'Save As-Built version' : 'Save version', [{ key: 'label', label: 'Label (optional)', value: '' }, { key: 'note', label: 'Change note', type: 'textarea', value: '' }]);
    if (!r) return;
    try { await saveVersion(r.label || undefined, kind, r.note); load(); } catch (e) { st.toast((e as Error).message, 'error'); }
  };
  const exportVersion = async (v: VersionRow) => {
    useApp.setState({ loading: `Exporting ${v.label}…` });
    try {
      const d = unpackJson<Drawing>(v.snapshot);
      const r = await exportCadFile(d, app.original, 'dwg');
      await downloadBytes(`${st.drawingName}_${v.label.replace(/\W+/g, '_')}.dwg`, r.bytes);
    } catch (e) { st.toast((e as Error).message, 'error'); }
    useApp.setState({ loading: null });
  };
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <button className="btn primary" disabled={!can('version.manage')} onClick={() => save('design')}><Icon name="save" />Save V{(list[0]?.number ?? 0) + 1}</button>
        <button className="btn" disabled={!can('version.manage')} onClick={() => save('asbuilt')}>Save As-Built</button>
        <button className="btn" onClick={() => useApp.getState().set({ panel: 'compare' })}><Icon name="compare" />Compare</button>
      </div>
      <div className="list">
        {list.map((v) => (
          <div key={v.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
            <span className={`badge ${v.kind === 'asbuilt' ? 'warn' : v.kind === 'import' ? 'info' : v.kind === 'restore' ? 'err' : ''}`}>V{v.number}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div><b>{v.label}</b></div>
              <div className="small muted">{new Date(v.createdAt).toLocaleString()} · {v.userName ?? 'unknown'} · {v.entityCount.toLocaleString()} obj</div>
              <div className="small">{v.summary}</div>
              <div className="row wrap" style={{ marginTop: 4 }}>
                <button className="btn sm" disabled={!can('version.manage')} onClick={async () => { if (await confirmDialog('Restore version', `Restore "${v.label}" as the working copy? The current state stays in history (a new "restored" version is created).`, false, 'Restore')) await restoreVersion(v.id); }}>Restore</button>
                <button className="btn sm" onClick={() => exportVersion(v)}>DWG</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const st = useApp();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.set);
  const kinds = Object.keys(st.snap.kinds) as (keyof typeof st.snap.kinds)[];
  const [usage, setUsage] = useState<string>('');
  useEffect(() => { navigator.storage?.estimate?.().then((e) => setUsage(`${((e.usage ?? 0) / 1048576).toFixed(0)} MB used of ${((e.quota ?? 0) / 1073741824).toFixed(1)} GB`)); navigator.storage?.persist?.(); }, []);
  const v = app.view;
  return (
    <div>
      <div className="section">Language / اللغة</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={`btn sm ${lang === 'en' ? 'primary' : ''}`} onClick={() => setLang('en')}>English</button>
        <button className={`btn sm ${lang === 'ar' ? 'primary' : ''}`} onClick={() => setLang('ar')}>العربية</button>
      </div>
      <div className="section">Display</div>
      <label className="row"><input type="checkbox" checked={st.dark} onChange={(e) => app.setOption('dark', e.target.checked)} /> Dark canvas (ACI 7 = white)</label>
      <label className="row"><input type="checkbox" checked={st.lineweights} onChange={(e) => app.setOption('lineweights', e.target.checked)} /> Show lineweights</label>
      <label className="row"><input type="checkbox" checked={st.grid} onChange={(e) => app.setOption('grid', e.target.checked)} /> Grid</label>
      <label className="row"><input type="checkbox" defaultChecked={v?.opts.showText ?? true} onChange={(e) => { if (v) { v.opts.showText = e.target.checked; v.invalidate(); } }} /> Show text</label>
      <div className="field"><label>Max texts per frame (performance)</label><input type="number" defaultValue={v?.text.maxTexts ?? 4000} onChange={(e) => { if (v) { v.text.maxTexts = Math.max(200, +e.target.value || 4000); v.invalidate(); } }} /></div>
      <div className="section">Object snap</div>
      <label className="row"><input type="checkbox" checked={st.snap.enabled} onChange={(e) => st.set({ snap: { ...st.snap, enabled: e.target.checked } })} /> Enabled (F3)</label>
      <div className="grid2">
        {kinds.map((k) => <label key={k} className="row small"><input type="checkbox" checked={st.snap.kinds[k]} onChange={(e) => st.set({ snap: { ...st.snap, kinds: { ...st.snap.kinds, [k]: e.target.checked } } })} /> {k}</label>)}
      </div>
      <div className="field"><label>Grid / snap spacing</label><input type="number" value={st.snap.gridSpacing} onChange={(e) => { const g = Math.max(0.001, +e.target.value || 1); st.set({ snap: { ...st.snap, gridSpacing: g } }); if (v) { v.opts.gridSpacing = g; v.invalidate(); } }} /></div>
      <div className="section">Diagnostics</div>
      <div className="kv small mono">
        <div>Objects</div><div>{app.doc?.size.toLocaleString()}</div>
        <div>GPU segments</div><div>{v?.stats.segments.toLocaleString()}</div>
        <div>GPU memory</div><div>{v?.stats.gpuMB.toFixed(1)} MB</div>
        <div>Chunks drawn</div><div>{v?.stats.chunks}</div>
        <div>Text pass</div><div>{v?.stats.textMs.toFixed(1)} ms ({v?.stats.texts})</div>
        <div>Storage</div><div>{usage}</div>
        <div>CAD engine</div><div>acad-ts (MIT) · DWG R14–2018+, DXF R12+</div>
        <div>Version</div><div>FiberLens 1.0.0</div>
      </div>
      {app.doc?.drawing.meta.notes.length ? <><div className="section">Import notes</div><div className="small muted" style={{ maxHeight: 140, overflow: 'auto' }}>{app.doc.drawing.meta.notes.map((n, i) => <div key={i}>{n}</div>)}</div></> : null}
    </div>
  );
}

const MORE_FIELD: { id: PanelId; label: string; icon: string }[] = [
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'measure', label: 'Measure', icon: 'measure' },
  { id: 'survey', label: 'Survey', icon: 'survey' },
  { id: 'notes', label: 'Notes', icon: 'note' },
  { id: 'photos', label: 'Photos', icon: 'photo' },
];

const MORE: { id: PanelId; label: string; icon: string }[] = [
  { id: 'project', label: 'Project', icon: 'folder' },
  { id: 'versions', label: 'Versions', icon: 'version' },
  { id: 'compare', label: 'Design vs As-Built', icon: 'compare' },
  { id: 'export', label: 'Export', icon: 'export' },
  { id: 'reports', label: 'Reports & BOQ', icon: 'report' },
  { id: 'maintenance', label: 'Maintenance & Faults', icon: 'wrench' },
  { id: 'qr', label: 'QR codes', icon: 'qr' },
  { id: 'calib', label: 'Calibration', icon: 'calibrate' },
  { id: 'users', label: 'Users & roles', icon: 'users' },
  { id: 'sync', label: 'Cloud sync', icon: 'sync' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'props', label: 'Properties', icon: 'props' },
];

export function MorePanel() {
  const t = useT();
  return (
    <div className="tool-grid">
      {[...(isPhone() ? MORE_FIELD : []), ...MORE].map((m) => <button key={m.id} className="tool-btn" onClick={() => useApp.getState().set({ panel: m.id })}><Icon name={m.icon} />{t(m.label)}</button>)}
    </div>
  );
}

export { fmt, useDialog };
