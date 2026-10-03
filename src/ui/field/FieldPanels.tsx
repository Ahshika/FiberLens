import React, { useEffect, useMemo, useState } from 'react';
import { db, type SurveyRow, type SurveyItemRow, type NoteRow, type PhotoRow, type FaultRow, type MaintenanceRow, type FtthKind } from '../../data/db';
import { useField, startSurvey, endSurvey, addSurveyItem, saveNote, deleteNote, saveFault, addPhoto, pickFile, addMedia, VoiceRecorder } from '../../field/fieldData';
import { currentProjectId } from '../../data/projects';
import { Icon } from '../icons';
import { ask, confirmDialog } from '../../app/dialogs';
import { useApp } from '../../app/store';
import { app } from '../../app/controller';
import { can } from '../../auth/session';
import { Thumbs } from './ObjectMedia';
import { pickPoint } from '../gps/GpsPanels';
import { useGps } from '../../gps/gpsStore';
import { saveObject, getObject, nearestObjects } from '../../ftth/store';
import { KINDS } from '../../ftth/model';
import { faultImpact } from '../../ftth/topology';
import { openCard } from '../ftth/ftthUi';
import { fmt } from '../common';

const toast = (m: string, k: 'info' | 'error' | 'success' = 'info') => useApp.getState().toast(m, k);

function useRows<T>(table: string, deps: any[] = []): T[] {
  const rev = useField((s) => s.rev);
  const [rows, setRows] = useState<T[]>([]);
  const pid = currentProjectId();
  useEffect(() => { if (pid) (db as any)[table].where('projectId').equals(pid).toArray().then(setRows); }, [pid, rev, ...deps]);
  return rows;
}

/** where to put a new field item: GPS position if available, else ask the user to tap */
async function locate(): Promise<{ x: number; y: number } | undefined> {
  const g = useGps.getState();
  if (g.cad && g.fix && Date.now() - g.fix.time < 15000) return g.cad;
  return pickPoint('Tap the location on the drawing (no recent GPS fix)');
}

const ITEM_KINDS: { id: SurveyItemRow['kind']; label: string; icon: string }[] = [
  { id: 'point', label: 'GPS point', icon: 'pin' }, { id: 'photo', label: 'Photo', icon: 'camera' }, { id: 'video', label: 'Video', icon: 'video' },
  { id: 'voice', label: 'Voice note', icon: 'mic' }, { id: 'note', label: 'Text note', icon: 'note' }, { id: 'object', label: 'FTTH object', icon: 'fiber' },
  { id: 'damage', label: 'Damage', icon: 'warning' }, { id: 'inspection', label: 'Inspection', icon: 'check' }, { id: 'installation', label: 'Installation status', icon: 'wrench' },
];

let surveyRec: VoiceRecorder | null = null;

export function SurveyPanel() {
  const active = useField((s) => s.activeSurvey);
  const surveys = useRows<SurveyRow>('surveys').sort((a, b) => b.startedAt - a.startedAt);
  const items = useRows<SurveyItemRow>('surveyItems');
  const [recording, setRecording] = useState(false);
  const cur = surveys.find((s) => s.id === active);
  const curItems = items.filter((i) => i.surveyId === active).sort((a, b) => b.createdAt - a.createdAt);

  const add = async (kind: SurveyItemRow['kind']) => {
    if (!active) return;
    try {
      const at = await locate();
      if (!at && kind !== 'voice') return;
      if (kind === 'photo') { const f = await pickFile('image/*', 'environment'); if (!f) return; const ph = await addPhoto(f, { surveyId: active, at }); await addSurveyItem({ surveyId: active, kind, mediaId: ph.id, text: ph.name, at }); }
      else if (kind === 'video') { const f = await pickFile('video/*', 'environment'); if (!f) return; const m = await addMedia(f, 'video', { surveyId: active, at }); await addSurveyItem({ surveyId: active, kind, mediaId: m.id, text: m.name, at }); }
      else if (kind === 'voice') {
        if (!recording) { surveyRec = new VoiceRecorder(); await surveyRec.start(); setRecording(true); return; }
        const b = await surveyRec!.stop(); setRecording(false);
        const m = await addMedia(b, 'audio', { surveyId: active, at });
        await addSurveyItem({ surveyId: active, kind, mediaId: m.id, text: m.name, at });
      } else if (kind === 'object') {
        const r = await ask('New FTTH object (field)', [
          { key: 'kind', label: 'Type', type: 'select', value: 'FAT', options: KINDS.map((k) => ({ value: k.kind, label: k.label })) },
          { key: 'code', label: 'ID / code' }, { key: 'status', label: 'Status', type: 'select', value: 'installed', options: ['planned', 'installed', 'in-service', 'pending', 'faulty'].map((s) => ({ value: s, label: s })) },
        ]);
        if (!r || !at) return;
        const o = await saveObject({ kind: r.kind as FtthKind, code: r.code || `${r.kind}-NEW`, status: r.status, props: { survey: cur?.name }, cad: { x: at.x, y: at.y }, mode: 'asbuilt' });
        await addSurveyItem({ surveyId: active, kind, objectId: o.id, text: `${o.kind} ${o.code}`, at });
      } else {
        const fields: any[] = [{ key: 'text', label: kind === 'point' ? 'Label / description' : 'Description', type: kind === 'point' ? 'text' : 'textarea' }];
        if (kind === 'damage') fields.push({ key: 'severity', label: 'Severity', type: 'select', value: 'medium', options: ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v })) });
        if (kind === 'inspection') fields.push({ key: 'result', label: 'Result', type: 'select', value: 'ok', options: [{ value: 'ok', label: 'OK' }, { value: 'issue', label: 'Issue found' }] });
        if (kind === 'installation') fields.push({ key: 'status', label: 'Installation status', type: 'select', value: 'installed', options: ['not started', 'in progress', 'installed', 'tested', 'blocked'].map((v) => ({ value: v, label: v })) });
        const near = at ? nearestObjects(at, 1)[0] : undefined;
        if (near) fields.push({ key: 'obj', label: `Link to nearest object (${near.o.code})`, type: 'select', value: near.d / app.unitsPerMeter() < 15 ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] });
        const r = await ask(ITEM_KINDS.find((k) => k.id === kind)!.label, fields);
        if (!r) return;
        const objectId = r.obj === 'yes' ? near?.o.id : undefined;
        await addSurveyItem({ surveyId: active, kind, text: r.text, payload: { severity: r.severity, result: r.result, status: r.status }, objectId, at });
        if (kind === 'damage' && objectId) await saveFault({ objectId, description: r.text || 'Damage', severity: r.severity });
        if (kind === 'note') await saveNote({ title: (r.text || 'Survey note').slice(0, 60), text: r.text, objectId, objectCode: objectId ? getObject(objectId)?.code : undefined, x: at?.x, y: at?.y });
      }
      toast('Saved to survey', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div>
      {!cur ? (
        <button className="btn primary" disabled={!can('field.edit')} onClick={async () => { const r = await ask('New survey session', [{ key: 'name', label: 'Name', value: `Survey ${new Date().toLocaleDateString()}` }]); if (r) await startSurvey(r.name); }}><Icon name="play" />Start survey session</button>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="row"><span className="gps-dot ok" /><b className="grow">{cur.name}</b><button className="btn sm danger" onClick={() => endSurvey(cur.id)}><Icon name="stop" />End</button></div>
            <div className="small muted">Started {new Date(cur.startedAt).toLocaleString()} · {curItems.length} items · each item is stamped with GPS position & time</div>
          </div>
          <div className="tool-grid">
            {ITEM_KINDS.map((k) => <button key={k.id} className={`tool-btn ${k.id === 'voice' && recording ? 'on' : ''}`} onClick={() => add(k.id)}><Icon name={k.id === 'voice' && recording ? 'stop' : k.icon} />{k.id === 'voice' && recording ? 'Stop recording' : k.label}</button>)}
          </div>
          <div className="section">Items</div>
          <div className="list">
            {curItems.map((i) => (
              <div key={i.id} className="list-item" onClick={() => i.x !== undefined && app.view?.centerOn(i.x, i.y!)}>
                <Icon name={ITEM_KINDS.find((k) => k.id === i.kind)?.icon ?? 'pin'} />
                <div className="grow"><div dir="auto">{i.text || i.kind}</div><div className="small muted">{i.kind} · {new Date(i.createdAt).toLocaleTimeString()}{i.acc ? ` · ±${i.acc.toFixed(1)} m` : ''}</div></div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="section">Previous sessions</div>
      <div className="list">
        {surveys.filter((s) => s.id !== active).map((s) => <div key={s.id} className="list-item"><Icon name="survey" /><div className="grow">{s.name}<div className="small muted">{new Date(s.startedAt).toLocaleString()} · {items.filter((i) => i.surveyId === s.id).length} items · {s.userName}</div></div></div>)}
      </div>
    </div>
  );
}

export function NotesPanel() {
  const notes = useRows<NoteRow>('notes');
  const [filter, setFilter] = useState<'all' | 'open' | 'pending' | 'resolved'>('all');
  const list = notes.filter((n) => filter === 'all' || n.status === filter).sort((a, b) => b.createdAt - a.createdAt);
  const add = async () => {
    const at = await locate();
    if (!at) return;
    const near = nearestObjects(at, 1)[0];
    const r = await ask('New field note', [
      { key: 'issue', label: 'Issue / title' }, { key: 'text', label: 'Details', type: 'textarea' },
      { key: 'status', label: 'Status', type: 'select', value: 'open', options: [{ value: 'open', label: 'Open' }, { value: 'pending', label: 'Pending' }, { value: 'resolved', label: 'Resolved' }] },
      { key: 'priority', label: 'Priority', type: 'select', value: 'normal', options: [{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }] },
      ...(near && near.d / app.unitsPerMeter() < 25 ? [{ key: 'obj', label: `Attach to ${near.o.kind} ${near.o.code}?`, type: 'select' as const, value: 'yes', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }] : []),
    ]);
    if (!r) return;
    const o = r.obj === 'yes' ? near?.o : undefined;
    await saveNote({ title: r.issue || 'Note', issue: r.issue, text: r.text, status: r.status, priority: r.priority, objectId: o?.id, objectCode: o?.code, x: at.x, y: at.y });
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!can('field.edit')} onClick={add}><Icon name="plus" />Note here</button>
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)}><option value="all">All</option><option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option></select>
      </div>
      {list.length === 0 && <div className="empty small">No notes. Notes are pinned to the drawing location (GPS or tapped point).</div>}
      {list.map((n) => (
        <div key={n.id} className="card small" style={{ marginBottom: 8 }}>
          <div className="row">
            <b className="grow" dir="auto">{n.objectCode ? `${n.objectCode} — ` : ''}{n.issue || n.title}</b>
            <select value={n.status} style={{ minHeight: 26, padding: '1px 4px' }} onChange={(e) => saveNote({ ...n, status: e.target.value as any })}><option value="open">open</option><option value="pending">pending</option><option value="resolved">resolved</option></select>
          </div>
          {n.text && <div dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>}
          <div className="row muted" style={{ marginTop: 4 }}>
            <span className="grow">{n.userName} · {new Date(n.createdAt).toLocaleString()}{n.priority === 'high' ? ' · HIGH' : ''}</span>
            {n.x !== undefined && <button className="btn sm" onClick={() => app.view?.centerOn(n.x!, n.y!, Math.max(app.view.cam.scale, 2))}>Show</button>}
            {n.objectId && <button className="btn sm" onClick={() => openCard({ type: 'object', id: n.objectId! })}>Object</button>}
            {can('field.edit') && <button className="icon-btn" onClick={async () => { if (await confirmDialog('Delete note', n.title, true)) deleteNote(n.id); }}><Icon name="trash" /></button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PhotosPanel() {
  const photos = useRows<PhotoRow>('photos');
  const [kind, setKind] = useState('all');
  const list = photos.filter((p) => kind === 'all' || p.kind === kind).sort((a, b) => b.takenAt - a.takenAt);
  const byObject = useMemo(() => {
    const m = new Map<string, PhotoRow[]>();
    for (const p of list) { const k = p.objectId ? (getObject(p.objectId)?.code ?? 'object') : 'Unlinked'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p); }
    return [...m.entries()];
  }, [list]);
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!can('field.edit')} onClick={async () => {
          const f = await pickFile('image/*', 'environment'); if (!f) return;
          const at = useGps.getState().cad ?? undefined;
          const near = at ? nearestObjects(at, 1)[0] : undefined;
          const link = near && near.d / app.unitsPerMeter() < 15 ? near.o.id : undefined;
          const r = await addPhoto(f, { objectId: link, at });
          toast(`${r.name} saved${link ? ` → ${getObject(link)?.code}` : ''}`, 'success');
        }}><Icon name="camera" />Take photo</button>
        <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All media</option><option value="photo">Photos</option><option value="video">Videos</option><option value="audio">Voice</option></select>
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>{list.length} items · every photo stores GPS, CAD position, time and the linked object</div>
      {byObject.map(([k, ps]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <div className="section" style={{ marginTop: 4 }}>{k} ({ps.length})</div>
          <Thumbs photos={ps} />
        </div>
      ))}
    </div>
  );
}

export function MaintenancePanel() {
  const faults = useRows<FaultRow>('faults');
  const maint = useRows<MaintenanceRow>('maintenance');
  const [tab, setTab] = useState<'faults' | 'log'>('faults');
  const [impact, setImpact] = useState<{ fault: FaultRow; affected: number; customers: string[]; suspects: string[] } | null>(null);
  const analyze = (f: FaultRow) => {
    const id = f.objectId ?? f.customerId;
    if (!id) return;
    const r = faultImpact(id);
    setImpact({ fault: f, affected: r.affected.objectIds.length, customers: r.affected.customers.map((c) => c.code), suspects: r.suspects.objectIds.map((x) => `${getObject(x)?.kind} ${getObject(x)?.code}`) });
    app.selection?.setHighlight('trace', { ids: [...r.suspects.entityIds], color: '#ff3b30', width: 6 });
    app.selection?.setHighlight('impact', { ids: r.affected.entityIds, color: '#ffb000', width: 4, dash: [8, 6] });
  };
  return (
    <div>
      <div className="tabs"><button className={tab === 'faults' ? 'on' : ''} onClick={() => setTab('faults')}>Faults ({faults.filter((f) => f.status !== 'resolved').length})</button><button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Maintenance log ({maint.length})</button></div>
      {tab === 'faults' && <>
        <button className="btn primary" disabled={!can('field.edit')} onClick={async () => {
          const r = await ask('Report a fault', [
            { key: 'code', label: 'Object / customer ID (e.g. FAT-027)' }, { key: 'description', label: 'Description', type: 'textarea' },
            { key: 'severity', label: 'Severity', type: 'select', value: 'high', options: ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v })) },
          ]);
          if (!r) return;
          const { findByCode } = await import('../../ftth/store');
          const o = r.code ? findByCode(r.code) : undefined;
          const f = await saveFault({ description: r.description || 'Fault', severity: r.severity, objectId: o && 'kind' in o ? o.id : undefined });
          if (f.objectId) analyze(f);
        }}><Icon name="warning" />Report fault</button>
        {impact && (
          <div className="card small" style={{ margin: '10px 0' }}>
            <b>Fault analysis</b>
            <div>Probable path (red): {impact.suspects.join(' → ')}</div>
            <div>Affected downstream (amber): {impact.affected} elements, {impact.customers.length} customers{impact.customers.length ? `: ${impact.customers.slice(0, 20).join(', ')}` : ''}</div>
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => { setImpact(null); app.selection?.setHighlight('trace', null); app.selection?.setHighlight('impact', null); }}>Clear</button>
          </div>
        )}
        <div className="list" style={{ marginTop: 8 }}>
          {faults.sort((a, b) => b.openedAt - a.openedAt).map((f) => (
            <div key={f.id} className="card small" style={{ marginBottom: 6 }}>
              <div className="row"><span className={`badge ${f.severity === 'critical' || f.severity === 'high' ? 'err' : 'warn'}`}>{f.severity}</span><b className="grow" dir="auto">{f.objectId ? `${getObject(f.objectId)?.code ?? '?'} — ` : ''}{f.description}</b></div>
              <div className="row muted" style={{ marginTop: 4 }}>
                <span className="grow">opened {new Date(f.openedAt).toLocaleString()}{f.closedAt ? ` · closed ${new Date(f.closedAt).toLocaleString()}` : ''}</span>
                {f.objectId && <button className="btn sm" onClick={() => analyze(f)}>Trace</button>}
                <select value={f.status} style={{ minHeight: 26, padding: '1px 4px' }} onChange={async (e) => { const v = e.target.value as any; let resolution = f.resolution; if (v === 'resolved') { const r = await ask('Resolution', [{ key: 'r', label: 'What was done?', type: 'textarea' }]); resolution = r?.r; } saveFault({ ...f, status: v, resolution }); }}>
                  <option value="open">open</option><option value="in-progress">in progress</option><option value="resolved">resolved</option>
                </select>
              </div>
              {f.resolution && <div className="muted">✔ {f.resolution}</div>}
            </div>
          ))}
        </div>
      </>}
      {tab === 'log' && (
        <div className="list">
          {maint.sort((a, b) => b.date - a.date).map((m) => (
            <div key={m.id} className="list-item" onClick={() => openCard({ type: 'object', id: m.objectId })}>
              <Icon name="wrench" /><div className="grow"><b>{getObject(m.objectId)?.code ?? '?'}</b> · {m.action} · {m.status}<div className="small muted" dir="auto">{m.technician} · {new Date(m.date).toLocaleString()} · {m.notes}</div></div>
            </div>
          ))}
          {!maint.length && <div className="empty small">Open an FTTH object card → “Log maintenance”.</div>}
        </div>
      )}
    </div>
  );
}

export { fmt };
