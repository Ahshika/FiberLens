import React, { useEffect, useMemo, useState } from 'react';
import { useFtth, saveObject, deleteObject, saveCable, deleteCable, getCores, updateCores, saveSplitter, deleteSplitter, getObject, getCable, nearestObjects, ensureCores, cableGeometryLength } from '../../ftth/store';
import { KINDS, kindMeta, STATUSES, STATUS_COLOR, CABLE_CATEGORIES, FIBER_COUNTS, SPLITTER_RATIOS, TIA598, CORE_STATUSES, CORE_STATUS_COLOR, cableTypeLabel, coreColor } from '../../ftth/model';
import { useFtthUi, openCard, backCard, runTrace, clearTrace, type FtthTab } from './ftthUi';
import { useFtthView } from '../../ftth/overlay';
import { detectFtth, applyDetection, loadRules, saveRules, type NodeRule, type CableRule, type DetectResult } from '../../ftth/detect';
import { traceCore } from '../../ftth/topology';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { useGps } from '../../gps/gpsStore';
import { gpsController } from '../../gps/controller';
import { Icon } from '../icons';
import { fmt } from '../common';
import { ask, confirmDialog } from '../../app/dialogs';
import { can } from '../../auth/session';
import { currentProjectId } from '../../data/projects';
import type { FtthObjectRow, CableRow, CoreRow, SplitterRow, FtthKind } from '../../data/db';
import { db } from '../../data/db';
import { ObjectMediaSection } from '../field/ObjectMedia';
import { SpliceEditor } from './SpliceEditor';
import { isPhone } from '../useDevice';
import { useT } from '../../app/i18n';

const toast = (m: string, k: 'info' | 'error' | 'success' = 'info') => useApp.getState().toast(m, k);
const err = (e: unknown) => toast((e as Error).message, 'error');

export function KindDot({ kind, size = 12 }: { kind: FtthKind; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: kindMeta(kind).color, display: 'inline-block', flex: 'none' }} />;
}
export function StatusBadge({ s }: { s: string }) {
  return <span className="badge" style={{ background: (STATUS_COLOR as any)[s] + '33', color: (STATUS_COLOR as any)[s] }}>{s}</span>;
}

export function FtthPanel() {
  const ui = useFtthUi();
  const tr = useT();
  useFtth((s) => s.rev);
  if (ui.card) {
    return (
      <div>
        <button className="btn sm" onClick={backCard} style={{ marginBottom: 8 }}>← Back</button>
        {ui.card.type === 'object' && <ObjectCard id={ui.card.id} />}
        {ui.card.type === 'cable' && <CableCard id={ui.card.id} />}
        {ui.card.type === 'splitter' && <SplitterCard id={ui.card.id} />}
      </div>
    );
  }
  const tabs: [FtthTab, string][] = [['overview', 'Overview'], ['objects', 'Objects'], ['cables', 'Cables'], ['splitters', 'Splitters'], ['trace', 'Trace'], ['detect', 'Detect']];
  return (
    <div>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={ui.tab === k ? 'on' : ''} onClick={() => ui.set({ tab: k })}>{tr(l)}</button>)}</div>
      {ui.tab === 'overview' && <Overview />}
      {ui.tab === 'objects' && <ObjectsList />}
      {ui.tab === 'cables' && <CablesList />}
      {ui.tab === 'splitters' && <SplittersList />}
      {ui.tab === 'trace' && <TraceView />}
      {ui.tab === 'detect' && <DetectView />}
    </div>
  );
}

function Overview() {
  const s = useFtth();
  const tr = useT();
  const gps = useGps();
  const view = useFtthView();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of s.objects.values()) m.set(o.kind, (m.get(o.kind) ?? 0) + 1);
    return m;
  }, [s.rev]);
  const totalLen = useMemo(() => [...s.cables.values()].filter((c) => c.category !== 'duct').reduce((a, c) => a + c.length, 0), [s.rev]);
  const near = gps.cad ? nearestObjects(gps.cad, 3) : [];
  const upm = app.unitsPerMeter();
  return (
    <div>
      {gps.cad && (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="row"><Icon name="locate" /><b className="grow">Nearest FTTH objects</b></div>
          {near.length === 0 && <div className="small muted">None within range</div>}
          {near.map(({ o, d }) => (
            <div key={o.id} className="list-item" onClick={() => openCard({ type: 'object', id: o.id })}>
              <KindDot kind={o.kind} /><div className="grow"><b>{o.code}</b> <span className="muted small">{o.kind}</span></div>
              <span className="badge info">{fmt(d / upm, 1)} m</span>
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); gpsController.setNavTarget({ name: o.code, x: o.cad.x, y: o.cad.y, id: o.id }); }}><Icon name="navigate" />Go</button>
            </div>
          ))}
        </div>
      )}
      <div className="grid3">
        {KINDS.filter((k) => counts.get(k.kind)).map((k) => (
          <div key={k.kind} className="card" style={{ padding: 8, cursor: 'pointer' }} onClick={() => { useFtthUi.getState().set({ tab: 'objects' }); (window as any).__ftthKind = k.kind; }}>
            <div className="row" style={{ gap: 6 }}><KindDot kind={k.kind} /><span className="small">{k.label}</span></div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{counts.get(k.kind)}</div>
          </div>
        ))}
      </div>
      <div className="kv small" style={{ margin: '10px 0' }}>
        <div>{tr('Cables')}</div><div dir="ltr">{s.cables.size} ({fmt(totalLen, 0)} m fibre)</div>
        <div>Splitters</div><div>{s.splitters.size}</div>
      </div>
      {s.objects.size === 0 && <div className="card small" style={{ marginBottom: 10 }}>No smart objects yet. Use <b>Detect</b> to recognise FAT/FDT/closures/cables from the DWG layers & blocks, or place them manually.</div>}
      <div className="section">Tools</div>
      <div className="tool-grid">
        <button className="tool-btn" disabled={!can('ftth.edit')} onClick={() => { app.setTool('ftth-place'); if (isPhone()) useApp.getState().set({ panel: null }); }}><Icon name="pin" />{tr('Place object')}</button>
        <button className="tool-btn" disabled={!can('ftth.edit')} onClick={() => { app.setTool('ftth-cable'); if (isPhone()) useApp.getState().set({ panel: null }); }}><Icon name="cable" />{tr('Draw cable')}</button>
        <button className="tool-btn" disabled={!can('ftth.edit')} onClick={() => { app.setTool('ftth-link'); if (isPhone()) useApp.getState().set({ panel: null }); }}><Icon name="join" />{tr('Link CAD → FTTH')}</button>
        <button className="tool-btn" onClick={() => useFtthUi.getState().set({ tab: 'detect' })}><Icon name="search" />{tr('Detect')}</button>
        <button className="tool-btn" onClick={() => useApp.getState().set({ panel: 'reports' })}><Icon name="boq" />{tr('BOQ & reports')}</button>
        <button className="tool-btn" onClick={() => useApp.getState().set({ panel: 'qr' })}><Icon name="qr" />{tr('QR codes')}</button>
      </div>
      <div className="section">Display</div>
      <label className="row"><input type="checkbox" checked={view.markers} onChange={(e) => view.set({ markers: e.target.checked })} /> Smart-object markers</label>
      <label className="row"><input type="checkbox" checked={view.labels} onChange={(e) => view.set({ labels: e.target.checked })} /> Labels</label>
      <div className="row wrap small" style={{ gap: 6, marginTop: 6 }}>
        {KINDS.map((k) => (
          <label key={k.kind} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={!view.hidden.has(k.kind)} onChange={(e) => { const h = new Set(view.hidden); if (e.target.checked) h.delete(k.kind); else h.add(k.kind); view.set({ hidden: h }); }} />
            <KindDot kind={k.kind} size={9} />{k.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function ObjectsList() {
  const s = useFtth();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string>((window as any).__ftthKind ?? '');
  const list = useMemo(() => [...s.objects.values()].filter((o) => (!kind || o.kind === kind) && (!q || o.code.toLowerCase().includes(q.toLowerCase()) || (o.name ?? '').toLowerCase().includes(q.toLowerCase()))).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [s.rev, q, kind]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="grow" placeholder="Filter by ID / name" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={kind} onChange={(e) => { setKind(e.target.value); (window as any).__ftthKind = e.target.value; }}><option value="">All types</option>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
      </div>
      <div className="small muted" style={{ marginBottom: 4 }}>{list.length} objects</div>
      <div className="list">
        {list.slice(0, 400).map((o) => (
          <div key={o.id} className="list-item" onClick={() => openCard({ type: 'object', id: o.id })}>
            <KindDot kind={o.kind} />
            <div className="grow" style={{ minWidth: 0 }}><b>{o.code}</b> <span className="small muted">{o.kind}{o.name ? ` · ${o.name}` : ''}</span></div>
            <StatusBadge s={o.status} />
          </div>
        ))}
        {list.length > 400 && <div className="small muted">…{list.length - 400} more (refine the filter)</div>}
      </div>
    </div>
  );
}

function CablesList() {
  const s = useFtth();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const list = useMemo(() => [...s.cables.values()].filter((c) => (!cat || c.category === cat) && (!q || c.code.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [s.rev, q, cat]);
  const name = (id?: string) => (id ? getObject(id)?.code ?? '?' : '—');
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="grow" placeholder="Cable ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All</option>{CABLE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </div>
      <div className="small muted">{list.length} cables · {fmt(list.reduce((a, c) => a + c.length, 0), 0)} m</div>
      <div className="list">
        {list.slice(0, 400).map((c) => (
          <div key={c.id} className="list-item" onClick={() => openCard({ type: 'cable', id: c.id })}>
            <span style={{ width: 14, height: 4, background: CABLE_CATEGORIES.find((x) => x.id === c.category)?.color, borderRadius: 2 }} />
            <div className="grow" style={{ minWidth: 0 }}><b>{c.code}</b> <span className="small muted">{cableTypeLabel(c.category, c.fiberCount)} · {name(c.fromId)} → {name(c.toId)}</span></div>
            <span className="badge">{fmt(c.length, 1)} m</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SplittersList() {
  const s = useFtth();
  const add = async () => {
    const r = await ask('New splitter', [
      { key: 'code', label: 'ID', value: `SP-${String(s.splitters.size + 1).padStart(3, '0')}` },
      { key: 'ratio', label: 'Ratio', type: 'select', value: '8', options: SPLITTER_RATIOS.map((n) => ({ value: String(n), label: `1:${n}` })) },
      { key: 'parent', label: 'Installed in (device)', type: 'select', value: '', options: [{ value: '', label: '—' }, ...[...s.objects.values()].filter((o) => ['FDT', 'FDH', 'FAT', 'FTB', 'Closure', 'Cabinet', 'ODF', 'OLT'].includes(o.kind)).slice(0, 2000).map((o) => ({ value: o.id, label: `${o.kind} ${o.code}` }))] },
    ]);
    if (!r) return;
    try { const sp = await saveSplitter({ code: r.code, ratio: +r.ratio, parentId: r.parent || undefined }); openCard({ type: 'splitter', id: sp.id }, false); } catch (e) { err(e); }
  };
  return (
    <div>
      <button className="btn primary" disabled={!can('ftth.edit')} onClick={add} style={{ marginBottom: 8 }}><Icon name="plus" />New splitter</button>
      <div className="list">
        {[...s.splitters.values()].map((sp) => (
          <div key={sp.id} className="list-item" onClick={() => openCard({ type: 'splitter', id: sp.id }, false)}>
            <Icon name="splitter" /><div className="grow"><b>{sp.code}</b> <span className="small muted">1:{sp.ratio}{sp.parentId ? ` · in ${getObject(sp.parentId)?.code ?? '?'}` : ''}</span></div>
            <span className="badge">{sp.outputs.filter((o) => o.status === 'used').length}/{sp.ratio} used</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PropsEditor({ props, onChange, readOnly }: { props: Record<string, any>; onChange: (p: Record<string, any>) => void; readOnly?: boolean }) {
  const entries = Object.entries(props).filter(([k]) => !['auto', 'parentRef', 'duplicateOf'].includes(k));
  return (
    <div>
      <div className="kv small">
        {entries.map(([k, v]) => (
          <React.Fragment key={k}>
            <div>{k}</div>
            <div>{readOnly ? String(v) : <input style={{ minHeight: 28, padding: '2px 6px', width: '100%' }} defaultValue={String(v ?? '')} dir="auto" onBlur={(e) => { if (e.target.value !== String(v ?? '')) onChange({ ...props, [k]: e.target.value }); }} />}</div>
          </React.Fragment>
        ))}
      </div>
      {!readOnly && <button className="btn sm" style={{ marginTop: 6 }} onClick={async () => { const r = await ask('Add property', [{ key: 'k', label: 'Name' }, { key: 'v', label: 'Value' }]); if (r?.k) onChange({ ...props, [r.k]: r.v }); }}><Icon name="plus" />Property</button>}
    </div>
  );
}

export function ObjectCard({ id, compact = false }: { id: string; compact?: boolean }) {
  useFtth((s) => s.rev);
  const tr = useT();
  const o = getObject(id);
  const gps = useGps();
  if (!o) return <div className="empty">Object not found</div>;
  const s = useFtth.getState();
  const km = kindMeta(o.kind);
  const children = [...s.objects.values()].filter((x) => x.parentId === o.id);
  const cables = [...s.cables.values()].filter((c) => c.fromId === o.id || c.toId === o.id);
  const spl = [...s.splitters.values()].filter((x) => x.parentId === o.id);
  const parent = o.parentId ? getObject(o.parentId) : undefined;
  const upm = app.unitsPerMeter();
  const dist = gps.cad ? Math.hypot(gps.cad.x - o.cad.x, gps.cad.y - o.cad.y) / upm : null;
  const save = (patch: Partial<FtthObjectRow>) => saveObject({ ...o, ...patch }).catch(err);
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <KindDot kind={o.kind} size={16} />
        <h3 style={{ margin: 0, flex: 1 }}>{o.code} <span className="muted small">{km.label}</span></h3>
        <StatusBadge s={o.status} />
      </div>
      {o.name && <div className="small" dir="auto">{o.name}</div>}
      {dist !== null && <div className="small muted">📍 {fmt(dist, 1)} m from you</div>}
      <div className="row wrap" style={{ margin: '8px 0', gap: 6 }}>
        <button className="btn sm primary" onClick={() => runTrace(o.id, 'up')}><Icon name="trace" />{tr('Trace to OLT')}</button>
        <button className="btn sm" onClick={() => runTrace(o.id, 'down')}><Icon name="trace" />{tr('Trace downstream')}</button>
        <button className="btn sm" onClick={() => gpsController.setNavTarget({ name: o.code, x: o.cad.x, y: o.cad.y, id: o.id })}><Icon name="navigate" />Navigate</button>
        <button className="btn sm" onClick={() => app.view?.centerOn(o.cad.x, o.cad.y, Math.max(app.view.cam.scale, 3 / upm))}><Icon name="zoomin" />Zoom</button>
        <button className="btn sm" onClick={() => { (window as any).__qrObject = o.id; useApp.getState().set({ panel: 'qr' }); }}><Icon name="qr" />QR</button>
      </div>
      {!compact && <>
        <div className="grid2">
          <div className="field"><label>ID / code</label><input defaultValue={o.code} onBlur={(e) => e.target.value !== o.code && save({ code: e.target.value })} /></div>
          <div className="field"><label>Status</label><select value={o.status} onChange={(e) => save({ status: e.target.value as any })}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></div>
          <div className="field"><label>Type</label><select value={o.kind} disabled={!can('ftth.edit')} onChange={(e) => save({ kind: e.target.value as any })}>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></div>
          <div className="field"><label>Name / address</label><input defaultValue={o.name ?? ''} dir="auto" onBlur={(e) => e.target.value !== (o.name ?? '') && save({ name: e.target.value })} /></div>
        </div>
        <div className="field"><label>Parent device</label>
          <select value={o.parentId ?? ''} onChange={(e) => save({ parentId: e.target.value || undefined })}>
            <option value="">—</option>
            {parent && <option value={parent.id}>{parent.kind} {parent.code}</option>}
            {nearestObjects(o.cad, 25, (x) => x.id !== o.id && kindMeta(x.kind).level < km.level).filter((x) => x.o.id !== parent?.id).map(({ o: x, d }) => <option key={x.id} value={x.id}>{x.kind} {x.code} ({fmt(d / upm, 0)} m)</option>)}
          </select>
        </div>
        <div className="section">Properties</div>
        <PropsEditor props={o.props} onChange={(p) => save({ props: p })} readOnly={!can('field.edit')} />
        <div className="kv small" style={{ marginTop: 8 }}>
          <div>CAD X / Y</div><div className="mono">{fmt(o.cad.x, 3)} / {fmt(o.cad.y, 3)}</div>
          <div>Mode</div><div>{o.mode}</div>
          <div>Updated</div><div>{new Date(o.updatedAt).toLocaleString()}</div>
        </div>
      </>}
      {(cables.length > 0) && <><div className="section">Cables ({cables.length})</div>
        {cables.map((c) => <div key={c.id} className="list-item" onClick={() => openCard({ type: 'cable', id: c.id })}><Icon name="cable" /><div className="grow"><b>{c.code}</b> <span className="small muted">{cableTypeLabel(c.category, c.fiberCount)} · {c.fromId === o.id ? `→ ${getObject(c.toId)?.code ?? '?'}` : `← ${getObject(c.fromId)?.code ?? '?'}`}</span></div><span className="badge">{fmt(c.length, 1)} m</span></div>)}</>}
      {spl.length > 0 && <><div className="section">Splitters</div>{spl.map((x) => <div key={x.id} className="list-item" onClick={() => openCard({ type: 'splitter', id: x.id }, false)}><Icon name="splitter" /><b className="grow">{x.code}</b><span className="badge">1:{x.ratio}</span></div>)}</>}
      {parent && <><div className="section">Fed from</div><div className="list-item" onClick={() => openCard({ type: 'object', id: parent.id })}><KindDot kind={parent.kind} /><b className="grow">{parent.code}</b><span className="small muted">{parent.kind}</span></div></>}
      {children.length > 0 && <><div className="section">Connected / downstream ({children.length})</div>
        {children.slice(0, 50).map((c) => <div key={c.id} className="list-item" onClick={() => openCard({ type: 'object', id: c.id })}><KindDot kind={c.kind} /><b className="grow">{c.code}</b><span className="small muted">{c.kind}</span></div>)}</>}
      {!compact && ['Closure', 'Joint', 'FDT', 'FDH', 'ODF', 'Cabinet', 'FAT', 'FTB'].includes(o.kind) && <SpliceEditor objectId={o.id} />}
      <ObjectMediaSection objectId={o.id} objectCode={o.code} compact={compact} />
      {!compact && can('ftth.edit') && <button className="btn sm danger" style={{ marginTop: 12 }} onClick={async () => { if (await confirmDialog('Delete object', `Delete ${o.kind} ${o.code}? (CAD geometry is kept)`, true, 'Delete')) { await deleteObject(o.id); backCard(); } }}><Icon name="trash" />Delete object</button>}
    </div>
  );
}

export function CableCard({ id }: { id: string }) {
  useFtth((s) => s.rev);
  const c = getCable(id);
  const [cores, setCores] = useState<CoreRow[]>([]);
  const [coreTrace, setCoreTrace] = useState<string>('');
  useEffect(() => { if (c) ensureCores(c).then(() => getCores(c.id)).then(setCores); }, [id, c?.fiberCount, useFtth.getState().rev]);
  if (!c) return <div className="empty">Cable not found</div>;
  const s = useFtth.getState();
  const geoLen = cableGeometryLength(c);
  const save = (patch: Partial<CableRow>) => saveCable({ ...c, ...patch }).catch(err);
  const nodes = [...s.objects.values()].filter((o) => !['Manhole', 'Handhole', 'Pole', 'Building'].includes(o.kind));
  const near = (p?: string) => p ? getObject(p) : undefined;
  const setCore = async (r: CoreRow, patch: Partial<CoreRow>) => { await updateCores([{ ...r, ...patch }]); setCores(await getCores(c.id)); };
  const usage = CORE_STATUSES.map((st) => [st, cores.filter((x) => x.status === st).length] as const);
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name="cable" />
        <h3 style={{ margin: 0, flex: 1 }}>{c.code} <span className="muted small">{cableTypeLabel(c.category, c.fiberCount)}</span></h3>
        <StatusBadge s={c.status} />
      </div>
      <div className="kv small">
        <div>From</div><div>{near(c.fromId) ? <a onClick={() => openCard({ type: 'object', id: c.fromId! })} style={{ cursor: 'pointer', color: 'var(--accent)' }}>{near(c.fromId)!.kind} {near(c.fromId)!.code}</a> : '—'}</div>
        <div>To</div><div>{near(c.toId) ? <a onClick={() => openCard({ type: 'object', id: c.toId! })} style={{ cursor: 'pointer', color: 'var(--accent)' }}>{near(c.toId)!.kind} {near(c.toId)!.code}</a> : '—'}</div>
        <div>Length</div><div><b>{fmt(c.length + (c.slack || 0), 2)} m</b> {c.lengthMode === 'auto' ? '(auto from drawing)' : '(manual)'}{c.slack ? ` incl. ${c.slack} m slack` : ''}</div>
        {geoLen !== null && c.lengthMode === 'manual' && <><div>Drawing length</div><div>{fmt(geoLen, 2)} m</div></>}
      </div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <div className="field"><label>Cable ID</label><input defaultValue={c.code} onBlur={(e) => e.target.value !== c.code && save({ code: e.target.value })} /></div>
        <div className="field"><label>Status</label><select value={c.status} onChange={(e) => save({ status: e.target.value as any })}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Category</label><select value={c.category} onChange={(e) => save({ category: e.target.value as any })}>{CABLE_CATEGORIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
        <div className="field"><label>Fibres</label><select value={c.fiberCount} onChange={(e) => save({ fiberCount: +e.target.value })}>{[0, ...FIBER_COUNTS].map((n) => <option key={n} value={n}>{n}F</option>)}</select></div>
        <div className="field"><label>From</label><select value={c.fromId ?? ''} onChange={(e) => save({ fromId: e.target.value || undefined })}><option value="">—</option>{nodes.slice(0, 3000).map((o) => <option key={o.id} value={o.id}>{o.kind} {o.code}</option>)}</select></div>
        <div className="field"><label>To</label><select value={c.toId ?? ''} onChange={(e) => save({ toId: e.target.value || undefined })}><option value="">—</option>{nodes.slice(0, 3000).map((o) => <option key={o.id} value={o.id}>{o.kind} {o.code}</option>)}</select></div>
        <div className="field"><label>Length mode</label><select value={c.lengthMode} onChange={(e) => save({ lengthMode: e.target.value as any })}><option value="auto">Auto (from route)</option><option value="manual">Manual</option></select></div>
        <div className="field"><label>{c.lengthMode === 'manual' ? 'Length (m)' : 'Slack / reserve (m)'}</label>
          {c.lengthMode === 'manual' ? <input type="number" defaultValue={c.length} onBlur={(e) => save({ length: +e.target.value || 0 })} /> : <input type="number" defaultValue={c.slack} onBlur={(e) => save({ slack: +e.target.value || 0 })} />}
        </div>
      </div>
      {c.fiberCount > 0 && <>
        <div className="section">Fibre cores ({c.fiberCount})</div>
        <div className="row wrap small" style={{ gap: 6, marginBottom: 6 }}>{usage.map(([st, n]) => <span key={st} className="badge" style={{ background: CORE_STATUS_COLOR[st] + '33', color: CORE_STATUS_COLOR[st] }}>{st} {n}</span>)}</div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>#</th><th>Tube</th><th>Fibre</th><th>Status</th><th>Assigned to</th><th></th></tr></thead>
            <tbody>
              {cores.map((r) => {
                const cc = coreColor(r.index, c.tubeSize ?? (c.fiberCount <= 12 ? c.fiberCount : 12));
                return (
                  <tr key={r.index}>
                    <td>{String(r.index).padStart(2, '0')}</td>
                    <td><span className="swatch" style={{ display: 'inline-block', width: 12, height: 12, background: cc.tube.hex, verticalAlign: 'middle' }} /> {cc.tubeNo}</td>
                    <td><span className="swatch" style={{ display: 'inline-block', width: 12, height: 12, background: cc.fiber.hex, verticalAlign: 'middle' }} /> {cc.fiber.name}</td>
                    <td><select value={r.status} style={{ minHeight: 26, padding: '1px 4px', color: CORE_STATUS_COLOR[r.status] }} onChange={(e) => setCore(r, { status: e.target.value as any })}>{CORE_STATUSES.map((st) => <option key={st}>{st}</option>)}</select></td>
                    <td><input defaultValue={r.assignLabel ?? ''} placeholder="Customer / FAT / spare" style={{ minHeight: 26, padding: '1px 6px', width: 130 }} dir="auto"
                      onBlur={(e) => { if (e.target.value !== (r.assignLabel ?? '')) { const v = e.target.value.trim(); const obj = v ? [...s.objects.values()].find((o) => o.code.toLowerCase() === v.toLowerCase()) : undefined; setCore(r, { assignLabel: v || undefined, assignId: obj?.id, assignKind: obj ? (obj.kind === 'Customer' ? 'customer' : 'object') : undefined, status: v && r.status === 'available' ? 'used' : r.status }); } }} /></td>
                    <td><button className="btn sm" title="Trace this fibre" onClick={async () => { const hops = await traceCore(currentProjectId()!, c.id, r.index); setCoreTrace(hops.map((h) => `${getCable(h.cableId)?.code ?? '?'}#${h.core} (${h.via})`).join(' → ')); }}>⇢</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {coreTrace && <div className="card small" style={{ marginTop: 6 }}><b>Fibre path:</b> {coreTrace}</div>}
        <div className="small muted" style={{ marginTop: 4 }}>Colour code TIA-598: {TIA598.map((t) => t.name).join(', ')}</div>
      </>}
      {can('ftth.edit') && <button className="btn sm danger" style={{ marginTop: 12 }} onClick={async () => { if (await confirmDialog('Delete cable', `Delete cable ${c.code}? (the CAD line is kept)`, true, 'Delete')) { await deleteCable(c.id); backCard(); } }}><Icon name="trash" />Delete cable</button>}
    </div>
  );
}

function SplitterCard({ id }: { id: string }) {
  useFtth((s) => s.rev);
  const sp = useFtth.getState().splitters.get(id);
  if (!sp) return <div className="empty">Splitter not found</div>;
  const s = useFtth.getState();
  const save = (patch: Partial<SplitterRow>) => saveSplitter({ ...sp, ...patch }).catch(err);
  const cables = [...s.cables.values()].filter((c) => c.category !== 'duct').slice(0, 3000);
  const customers = [...s.objects.values()].filter((o) => ['Customer', 'FAT', 'FTB', 'Building'].includes(o.kind)).slice(0, 3000);
  return (
    <div>
      <div className="row"><Icon name="splitter" /><h3 style={{ margin: 0, flex: 1 }}>{sp.code} <span className="muted small">1:{sp.ratio}</span></h3><StatusBadge s={sp.status} /></div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <div className="field"><label>ID</label><input defaultValue={sp.code} onBlur={(e) => save({ code: e.target.value })} /></div>
        <div className="field"><label>Ratio</label><select value={sp.ratio} onChange={(e) => save({ ratio: +e.target.value })}>{SPLITTER_RATIOS.map((n) => <option key={n} value={n}>1:{n}</option>)}</select></div>
        <div className="field"><label>Status</label><select value={sp.status} onChange={(e) => save({ status: e.target.value as any })}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Level</label><select value={sp.level ?? 1} onChange={(e) => save({ level: +e.target.value })}><option value={1}>Primary (L1)</option><option value={2}>Secondary (L2)</option></select></div>
      </div>
      <div className="field"><label>Parent device / location</label>
        <select value={sp.parentId ?? ''} onChange={(e) => save({ parentId: e.target.value || undefined })}><option value="">—</option>{[...s.objects.values()].filter((o) => !['Customer', 'Building', 'Manhole', 'Handhole', 'Pole'].includes(o.kind)).slice(0, 3000).map((o) => <option key={o.id} value={o.id}>{o.kind} {o.code}</option>)}</select>
      </div>
      <div className="section">Input</div>
      <div className="grid2">
        <select value={sp.input?.cableId ?? ''} onChange={(e) => save({ input: { ...sp.input, cableId: e.target.value || undefined } })}><option value="">Input cable —</option>{cables.map((c) => <option key={c.id} value={c.id}>{c.code} ({c.fiberCount}F)</option>)}</select>
        <input type="number" placeholder="Core #" defaultValue={sp.input?.core ?? ''} onBlur={(e) => save({ input: { ...sp.input, core: +e.target.value || undefined } })} />
      </div>
      <div className="section">Outputs</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Port</th><th>Status</th><th>Cable</th><th>Core</th><th>Customer / box</th></tr></thead>
          <tbody>
            {sp.outputs.map((o, i) => (
              <tr key={o.port}>
                <td>{o.port}</td>
                <td><select value={o.status} style={{ minHeight: 26, padding: '1px 4px', color: CORE_STATUS_COLOR[o.status] }} onChange={(e) => save({ outputs: sp.outputs.map((x, k) => (k === i ? { ...x, status: e.target.value as any } : x)) })}>{CORE_STATUSES.map((st) => <option key={st}>{st}</option>)}</select></td>
                <td><select value={o.cableId ?? ''} style={{ minHeight: 26, padding: '1px 4px', maxWidth: 110 }} onChange={(e) => save({ outputs: sp.outputs.map((x, k) => (k === i ? { ...x, cableId: e.target.value || undefined } : x)) })}><option value="">—</option>{cables.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></td>
                <td><input type="number" defaultValue={o.core ?? ''} style={{ minHeight: 26, padding: '1px 4px', width: 56 }} onBlur={(e) => save({ outputs: sp.outputs.map((x, k) => (k === i ? { ...x, core: +e.target.value || undefined } : x)) })} /></td>
                <td><select value={o.customerId ?? ''} style={{ minHeight: 26, padding: '1px 4px', maxWidth: 120 }} onChange={(e) => save({ outputs: sp.outputs.map((x, k) => (k === i ? { ...x, customerId: e.target.value || undefined, status: e.target.value ? 'used' : x.status } : x)) })}><option value="">—</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.kind} {c.code}</option>)}</select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can('ftth.edit') && <button className="btn sm danger" style={{ marginTop: 12 }} onClick={async () => { if (await confirmDialog('Delete splitter', sp.code, true, 'Delete')) { await deleteSplitter(sp.id); backCard(); } }}>Delete splitter</button>}
    </div>
  );
}

function TraceView() {
  const t = useFtthUi((s) => s.trace);
  const [pick, setPick] = useState('');
  const s = useFtth();
  if (!t) {
    return (
      <div>
        <p className="small muted">Select a customer / FAT / FTB and trace the full path to the OLT — or trace an OLT port / FDT downstream to list every customer it feeds. The path is highlighted on the drawing.</p>
        <div className="row">
          <input className="grow" placeholder="Object ID (e.g. FAT-027, H3L3B12)" value={pick} onChange={(e) => setPick(e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['up', 'down'] as const).map((d) => (
            <button key={d} className="btn" onClick={() => {
              const o = [...s.objects.values()].find((x) => x.code.toLowerCase() === pick.trim().toLowerCase());
              if (!o) { toast('Object not found', 'error'); return; }
              runTrace(o.id, d);
            }}>{d === 'up' ? 'Trace to OLT' : 'Trace downstream'}</button>
          ))}
        </div>
      </div>
    );
  }
  const r = t.result;
  const start = getObject(t.startId);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <b className="grow">{t.dir === 'up' ? 'Path to head-end' : 'Downstream of'} {start?.code}</b>
        <button className="btn sm" onClick={clearTrace}>Clear</button>
      </div>
      <div className="kv small" style={{ marginBottom: 8 }}>
        <div>Elements</div><div>{r.objectIds.length}</div>
        <div>Cables</div><div>{r.cableIds.length} · {fmt(r.totalLength, 1)} m</div>
        {t.dir === 'up' && <><div>Head-end</div><div>{r.reachedHeadEnd ? <span className="badge ok">OLT reached</span> : <span className="badge warn">No OLT connected — path ends at highest upstream element</span>}</div></>}
        {t.dir === 'down' && <><div>Customers</div><div>{r.customers.length}</div></>}
      </div>
      {t.dir === 'up' ? (
        <div className="list">
          {r.steps.map((st, i) => {
            const o = getObject(st.objectId)!;
            return (
              <React.Fragment key={st.objectId}>
                <div className="list-item" onClick={() => openCard({ type: 'object', id: o.id })}><KindDot kind={o.kind} /><b className="grow">{o.code}</b><span className="small muted">{o.kind}</span></div>
                {i < r.steps.length - 1 && <div className="small muted" style={{ paddingLeft: 18 }}>↓ {st.via ? <a style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => openCard({ type: 'cable', id: st.via!.id })}>{st.via.code} · {cableTypeLabel(st.via.category, st.via.fiberCount)} · {fmt(st.via.length, 1)} m</a> : st.viaParent ? 'internal / logical link' : ''}</div>}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        <div className="list">
          {r.objectIds.map((id) => getObject(id)!).sort((a, b) => kindMeta(a.kind).level - kindMeta(b.kind).level).slice(0, 500).map((o) => (
            <div key={o.id} className="list-item" onClick={() => openCard({ type: 'object', id: o.id })}><KindDot kind={o.kind} /><b className="grow">{o.code}</b><span className="small muted">{o.kind}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetectView() {
  const pid = currentProjectId();
  const [rules, setRules] = useState<{ nodes: NodeRule[]; cables: CableRule[] } | null>(null);
  const [scope, setScope] = useState<'all' | 'view' | 'boundary'>('view');
  const [tol, setTol] = useState(3);
  const [res, setRes] = useState<DetectResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (pid) loadRules(pid).then(setRules); }, [pid]);
  if (!rules || !pid) return null;
  const run = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const upm = app.unitsPerMeter();
      const sel = app.selection?.list[0];
      const r = detectFtth(app.doc!, { scope, view: app.view!.cam.viewBox(), boundaryId: sel, nodeRules: rules.nodes, cableRules: rules.cables, tol: tol * upm, unitsPerMeter: upm, projectId: pid, mode: useApp.getState().mode });
      setRes(r);
      await saveRules(pid, rules);
    } catch (e) { err(e); }
    setBusy(false);
  };
  const apply = async () => {
    if (!res) return;
    if (!(await confirmDialog('Apply detection', `Create ${res.objects.length} objects and ${res.cables.length} cables? Previously auto-detected items are replaced; manually created items are kept.`, false, 'Apply'))) return;
    setBusy(true);
    try {
      await applyDetection(pid, res);
      const { loadFtth } = await import('../../ftth/store');
      await loadFtth(pid);
      toast(`Detected ${res.objects.length} objects, ${res.cables.length} cables (${res.connected} connected)`, 'success');
      setRes(null);
      useFtthUi.getState().set({ tab: 'overview' });
    } catch (e) { err(e); }
    setBusy(false);
  };
  return (
    <div>
      <p className="small muted">Recognises network elements from layer names, block names and attributes. Tip: limit the scope to the geographic map area (the visible area, or a selected boundary polyline) so splice diagrams and legends are not counted.</p>
      <div className="grid2">
        <div className="field"><label>Scope</label><select value={scope} onChange={(e) => setScope(e.target.value as any)}><option value="view">Visible area</option><option value="boundary">Inside selected closed polyline</option><option value="all">Whole drawing</option></select></div>
        <div className="field"><label>Connection tolerance (m)</label><input type="number" value={tol} onChange={(e) => setTol(+e.target.value || 1)} /></div>
      </div>
      <div className="section">Object rules (layer / block regex)</div>
      {rules.nodes.map((r, i) => (
        <div key={i} className="row" style={{ marginBottom: 4 }}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => setRules({ ...rules, nodes: rules.nodes.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)) })} />
          <KindDot kind={r.kind} /><span style={{ width: 70 }} className="small">{r.kind}</span>
          <input className="grow mono" style={{ minHeight: 28, padding: '2px 6px', fontSize: 11 }} value={r.pattern} onChange={(e) => setRules({ ...rules, nodes: rules.nodes.map((x, k) => (k === i ? { ...x, pattern: e.target.value } : x)) })} />
        </div>
      ))}
      <div className="section">Cable rules (layer regex)</div>
      {rules.cables.map((r, i) => (
        <div key={i} className="row" style={{ marginBottom: 4 }}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => setRules({ ...rules, cables: rules.cables.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)) })} />
          <span style={{ width: 82 }} className="small">{r.category === 'auto' ? 'Fibre (auto)' : r.category}</span>
          <input className="grow mono" style={{ minHeight: 28, padding: '2px 6px', fontSize: 11 }} value={r.pattern} onChange={(e) => setRules({ ...rules, cables: rules.cables.map((x, k) => (k === i ? { ...x, pattern: e.target.value } : x)) })} />
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !can('ftth.edit')} onClick={run}>{busy ? 'Working…' : 'Run detection'}</button>
        {res && <button className="btn" disabled={busy} onClick={apply}><Icon name="check" />Apply</button>}
      </div>
      {res && (
        <div className="card" style={{ marginTop: 10 }}>
          <b>Preview</b>
          <div className="kv small" style={{ marginTop: 6 }}>
            {Object.entries(res.counts).map(([k, n]) => <React.Fragment key={k}><div>{k}</div><div>{n}</div></React.Fragment>)}
            {Object.entries(res.cableLengths).map(([k, n]) => <React.Fragment key={k}><div>{k}</div><div>{fmt(n, 0)} m</div></React.Fragment>)}
            <div>Cables connected</div><div>{res.connected} / {res.cables.filter((c) => c.category !== 'duct').length}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export { db };
