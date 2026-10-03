import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { db, type PhotoRow, type NoteRow, type MaintenanceRow, type FaultRow } from '../../data/db';
import { useField, addPhoto, addMedia, pickFile, saveNote, saveMaintenance, saveFault, VoiceRecorder, deleteMedia } from '../../field/fieldData';
import { Icon } from '../icons';
import { ask } from '../../app/dialogs';
import { useApp } from '../../app/store';
import { can } from '../../auth/session';
import { downloadBytes } from '../../reports/download';
import { getObject } from '../../ftth/store';

/** full-screen media viewer */
export const useViewer = create<{ photo: PhotoRow | null; set: (p: PhotoRow | null) => void }>((set) => ({ photo: null, set: (photo) => set({ photo }) }));

export function MediaViewer() {
  const p = useViewer((s) => s.photo);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!p) { setUrl(null); return; }
    const u = URL.createObjectURL(new Blob([p.data as BlobPart], { type: p.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [p]);
  if (!p || !url) return null;
  return (
    <div className="modal-back" onClick={() => useViewer.getState().set(null)}>
      <div className="modal" style={{ width: 'min(900px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h3 className="row"><span className="grow">{p.name}</span><button className="icon-btn" onClick={() => useViewer.getState().set(null)}><Icon name="close" /></button></h3>
        {p.kind === 'photo' && <img src={url} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 8 }} />}
        {p.kind === 'video' && <video src={url} controls style={{ maxWidth: '100%', maxHeight: '70vh' }} />}
        {p.kind === 'audio' && <audio src={url} controls style={{ width: '100%' }} />}
        <div className="small muted" style={{ marginTop: 8 }}>
          {new Date(p.takenAt).toLocaleString()}{p.lat !== undefined ? ` · ${p.lat.toFixed(6)}, ${p.lon!.toFixed(6)}` : ''}{p.x !== undefined ? ` · CAD ${p.x.toFixed(2)}, ${p.y!.toFixed(2)}` : ''}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => downloadBytes(p.name, p.data, p.mime)}>Save</button>
          {p.x !== undefined && <button className="btn" onClick={() => { (window as any).fiberlens.view.centerOn(p.x, p.y); useViewer.getState().set(null); }}>Show on drawing</button>}
          {can('field.edit') && <button className="btn danger" onClick={async () => { await deleteMedia(p.id); useViewer.getState().set(null); }}>Delete</button>}
        </div>
      </div>
    </div>
  );
}

export function Thumbs({ photos }: { photos: PhotoRow[] }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {photos.map((p) => (
        <div key={p.id} onClick={() => useViewer.getState().set(p)} title={p.name} style={{ width: 64, height: 64, borderRadius: 8, overflow: 'hidden', background: 'var(--bg4)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', fontSize: 10 }}>
          {p.thumb ? <img src={p.thumb} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <><Icon name={p.kind === 'video' ? 'video' : p.kind === 'audio' ? 'mic' : 'photo'} />{p.name.slice(0, 10)}</>}
        </div>
      ))}
    </div>
  );
}

let recorder: VoiceRecorder | null = null;

export function MediaButtons({ link }: { link: Parameters<typeof addPhoto>[1] }) {
  const [rec, setRec] = useState(false);
  const toast = useApp.getState().toast;
  const ok = can('field.edit');
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <button className="btn sm" disabled={!ok} onClick={async () => { const f = await pickFile('image/*', 'environment'); if (f) { const r = await addPhoto(f, link); toast(`${r.name} saved`, 'success'); } }}><Icon name="camera" />Photo</button>
      <button className="btn sm" disabled={!ok} onClick={async () => { const f = await pickFile('image/*'); if (f) await addPhoto(f, link); }}><Icon name="photo" />Gallery</button>
      <button className="btn sm" disabled={!ok} onClick={async () => { const f = await pickFile('video/*', 'environment'); if (f) await addMedia(f, 'video', link); }}><Icon name="video" />Video</button>
      <button className={`btn sm ${rec ? 'danger' : ''}`} disabled={!ok} onClick={async () => {
        try {
          if (!rec) { recorder = new VoiceRecorder(); await recorder.start(); setRec(true); }
          else { const b = await recorder!.stop(); setRec(false); await addMedia(b, 'audio', link); toast('Voice note saved', 'success'); }
        } catch (e) { setRec(false); toast('Microphone: ' + (e as Error).message, 'error'); }
      }}><Icon name={rec ? 'stop' : 'mic'} />{rec ? 'Stop' : 'Voice'}</button>
    </div>
  );
}

/** photos, notes, maintenance & faults attached to an FTTH object */
export function ObjectMediaSection({ objectId, objectCode, compact }: { objectId: string; objectCode: string; compact?: boolean }) {
  const rev = useField((s) => s.rev);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [maint, setMaint] = useState<MaintenanceRow[]>([]);
  const [faults, setFaults] = useState<FaultRow[]>([]);
  useEffect(() => {
    db.photos.where('objectId').equals(objectId).toArray().then((r) => setPhotos(r.sort((a, b) => b.takenAt - a.takenAt)));
    db.notes.where('objectId').equals(objectId).toArray().then((r) => setNotes(r.sort((a, b) => b.createdAt - a.createdAt)));
    db.maintenance.where('objectId').equals(objectId).toArray().then((r) => setMaint(r.sort((a, b) => b.date - a.date)));
    db.faults.where('objectId').equals(objectId).toArray().then((r) => setFaults(r.sort((a, b) => b.openedAt - a.openedAt)));
  }, [objectId, rev]);
  const obj = getObject(objectId);
  const at = obj ? { x: obj.cad.x, y: obj.cad.y } : undefined;
  const addNote = async () => {
    const r = await ask(`Note — ${objectCode}`, [
      { key: 'issue', label: 'Issue', value: '' },
      { key: 'text', label: 'Details', type: 'textarea' },
      { key: 'status', label: 'Status', type: 'select', value: 'pending', options: [{ value: 'open', label: 'Open' }, { value: 'pending', label: 'Pending' }, { value: 'resolved', label: 'Resolved' }] },
    ]);
    if (r) await saveNote({ title: r.issue || 'Note', issue: r.issue, text: r.text, status: r.status, objectId, objectCode, x: at?.x, y: at?.y });
  };
  const addMaint = async () => {
    const r = await ask(`Maintenance — ${objectCode}`, [
      { key: 'action', label: 'Action', type: 'select', value: 'inspection', options: ['inspection', 'repair', 'replace', 'install', 'clean', 'other'].map((v) => ({ value: v, label: v })) },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'status', label: 'Result', type: 'select', value: 'done', options: [{ value: 'done', label: 'Done' }, { value: 'pending', label: 'Pending' }, { value: 'failed', label: 'Needs follow-up' }] },
    ]);
    if (r) await saveMaintenance({ objectId, action: r.action, notes: r.notes, status: r.status });
  };
  const addFault = async () => {
    const r = await ask(`Report fault — ${objectCode}`, [
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'severity', label: 'Severity', type: 'select', value: 'medium', options: ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v })) },
    ]);
    if (r?.description) await saveFault({ objectId, description: r.description, severity: r.severity });
  };
  return (
    <div>
      <div className="section">Photos & media ({photos.length})</div>
      <Thumbs photos={photos.slice(0, compact ? 6 : 50)} />
      <div style={{ marginTop: 6 }}><MediaButtons link={{ objectId, at }} /></div>
      <div className="section">Notes ({notes.length})</div>
      {notes.slice(0, compact ? 2 : 20).map((n) => (
        <div key={n.id} className="card small" style={{ marginBottom: 6 }}>
          <div className="row"><b className="grow" dir="auto">{n.issue || n.title}</b><span className={`badge ${n.status === 'resolved' ? 'ok' : n.status === 'pending' ? 'warn' : 'err'}`}>{n.status}</span></div>
          {n.text && <div dir="auto">{n.text}</div>}
          <div className="muted">{n.userName} · {new Date(n.createdAt).toLocaleString()}</div>
        </div>
      ))}
      <button className="btn sm" disabled={!can('field.edit')} onClick={addNote}><Icon name="note" />Add note</button>
      {!compact && <>
        <div className="section">Maintenance history ({maint.length})</div>
        {maint.map((m) => <div key={m.id} className="small" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}><b>{m.action}</b> · {m.status} · {m.technician} · {new Date(m.date).toLocaleDateString()}<div dir="auto">{m.notes}</div></div>)}
        <div className="section">Faults ({faults.filter((f) => f.status !== 'resolved').length} open)</div>
        {faults.map((f) => <div key={f.id} className="small" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}><span className={`badge ${f.status === 'resolved' ? 'ok' : 'err'}`}>{f.severity} · {f.status}</span> <span dir="auto">{f.description}</span></div>)}
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn sm" disabled={!can('field.edit')} onClick={addMaint}><Icon name="wrench" />Log maintenance</button>
          <button className="btn sm danger" disabled={!can('field.edit')} onClick={addFault}><Icon name="warning" />Report fault</button>
        </div>
      </>}
    </div>
  );
}
