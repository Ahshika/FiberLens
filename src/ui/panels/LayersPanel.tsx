import React, { useMemo, useState } from 'react';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { Icon } from '../icons';
import { ColorPicker, LINEWEIGHTS, lwLabel, useDocRev } from '../common';
import { aciToRgb, rgbToHex } from '../../cad/model/color';
import type { Layer } from '../../cad/model/types';
import { ask, confirmDialog } from '../../app/dialogs';
import { can } from '../../auth/session';

export function layerColorCss(l: Layer, dark = true) {
  if (l.rgb !== undefined) return rgbToHex(l.rgb);
  const a = l.aci ?? 7;
  return a === 7 ? (dark ? '#ffffff' : '#000000') : rgbToHex(aciToRgb(a));
}

export function LayersPanel() {
  const rev = useDocRev();
  const dark = useApp((s) => s.dark);
  const style = useApp((s) => s.style);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const doc = app.doc;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (doc) for (const e of doc.all()) m.set(e.layer, (m.get(e.layer) ?? 0) + 1);
    return m;
  }, [rev, doc]);
  if (!doc) return null;
  const layers = doc.drawing.layers.filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const editable = can('cad.edit');

  const update = (name: string, patch: Partial<Layer>, label = 'Layer change') => {
    const next = doc.drawing.layers.map((l) => (l.name === name ? { ...l, ...patch } : l));
    doc.setLayers(next, label);
  };
  const setAll = (patch: Partial<Layer>, filter: (l: Layer) => boolean = () => true) => {
    doc.setLayers(doc.drawing.layers.map((l) => (filter(l) ? { ...l, ...patch } : l)), 'Layers');
  };
  const isolate = (name: string) => setAll({ on: false }, (l) => l.name !== name), unisolate = () => setAll({ on: true });

  const zoomLayer = (name: string) => {
    const ids: number[] = [];
    for (const e of doc.all()) if (e.layer === name) ids.push(e.id);
    if (ids.length) app.zoomToEntities(ids);
  };
  const selectLayer = (name: string) => {
    const ids: number[] = [];
    for (const e of doc.all()) if (e.layer === name) ids.push(e.id);
    app.selection?.set(ids);
  };

  const newLayer = async () => {
    const r = await ask('New layer', [{ key: 'name', label: 'Name', value: 'New Layer' }]);
    if (!r?.name) return;
    if (doc.layer(r.name)) { useApp.getState().toast('Layer already exists', 'error'); return; }
    doc.setLayers([...doc.drawing.layers, { name: r.name, aci: 7, lineType: 'Continuous', lineWeight: -3, transparency: 0, on: true, frozen: false, locked: false, plot: true }], 'New layer');
    useApp.getState().set({ style: { ...style, layer: r.name } });
  };

  const rename = async (l: Layer) => {
    if (l.name === '0' || l.name.toLowerCase() === 'defpoints') { useApp.getState().toast('This layer cannot be renamed', 'error'); return; }
    const r = await ask('Rename layer', [{ key: 'name', label: 'New name', value: l.name }]);
    if (!r?.name || r.name === l.name) return;
    if (doc.layer(r.name)) { useApp.getState().toast('Name already used', 'error'); return; }
    // rename layer and move every entity (incl. nested block content stays as is)
    const layersNext = doc.drawing.layers.map((x) => (x.name === l.name ? { ...x, name: r.name } : x));
    const modified = [];
    for (const e of doc.all()) if (e.layer === l.name) modified.push({ before: e, after: { ...e, layer: r.name } });
    doc.commit({ label: 'Rename layer', added: [], removed: [], modified, layers: { before: doc.drawing.layers, after: layersNext } });
    if (style.layer === l.name) useApp.getState().set({ style: { ...style, layer: r.name } });
  };

  const del = async (l: Layer) => {
    if (l.name === '0') return;
    if (counts.get(l.name)) { useApp.getState().toast(`Layer has ${counts.get(l.name)} objects. Move them first.`, 'error'); return; }
    const usedInBlocks = Object.values(doc.blocks).some((b) => b.entities.some((e) => e.layer === l.name));
    if (usedInBlocks) { useApp.getState().toast('Layer is used inside block definitions', 'error'); return; }
    if (!(await confirmDialog('Delete layer', `Delete empty layer "${l.name}"?`, true, 'Delete'))) return;
    doc.setLayers(doc.drawing.layers.filter((x) => x.name !== l.name), 'Delete layer');
  };

  const moveSelectionTo = (name: string) => {
    const sel = app.selection?.list ?? [];
    const ents = sel.map((id) => doc.get(id)!).filter((e) => e && doc.isEditable(e));
    if (!ents.length) { useApp.getState().toast('Select objects first'); return; }
    doc.modify(ents.map((e) => ({ ...e, layer: name })), `Move to layer ${name}`);
    useApp.getState().toast(`${ents.length} objects moved to "${name}"`, 'success');
  };

  void rev;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="grow" placeholder={`Search ${doc.drawing.layers.length} layers…`} value={q} onChange={(e) => setQ(e.target.value)} />
        {editable && <button className="btn" onClick={newLayer} title="New layer"><Icon name="plus" /></button>}
      </div>
      <div className="row wrap" style={{ marginBottom: 8, gap: 6 }}>
        <button className="btn sm" onClick={() => setAll({ on: true, frozen: false })}>All on</button>
        <button className="btn sm" onClick={unisolate}>Unisolate</button>
        <button className="btn sm" onClick={() => setAll({ locked: false })}>Unlock all</button>
        <span className="muted small">Current: <b>{style.layer}</b></span>
      </div>
      <div className="list">
        {layers.map((l) => (
          <React.Fragment key={l.name}>
            <div className={`list-item ${style.layer === l.name ? 'active' : ''}`} style={{ padding: '4px 2px', minHeight: 40 }}>
              <button className="icon-btn" style={{ minWidth: 34, height: 34 }} title={l.on ? 'Hide' : 'Show'} onClick={() => update(l.name, { on: !l.on }, l.on ? 'Hide layer' : 'Show layer')}>
                <Icon name={l.on ? 'eye' : 'eyeoff'} style={{ opacity: l.on ? 1 : 0.4 }} />
              </button>
              <button className="icon-btn" style={{ minWidth: 34, height: 34, color: l.frozen ? '#5fc3ff' : undefined }} title={l.frozen ? 'Thaw' : 'Freeze'} onClick={() => update(l.name, { frozen: !l.frozen }, 'Freeze layer')}>
                <Icon name={l.frozen ? 'snow' : 'sun'} style={{ opacity: l.frozen ? 1 : 0.45 }} />
              </button>
              <button className="icon-btn" style={{ minWidth: 34, height: 34, color: l.locked ? 'var(--warn)' : undefined }} title={l.locked ? 'Unlock' : 'Lock'} onClick={() => update(l.name, { locked: !l.locked }, 'Lock layer')}>
                <Icon name={l.locked ? 'lock' : 'unlock'} style={{ opacity: l.locked ? 1 : 0.45 }} />
              </button>
              <span className="swatch" style={{ background: layerColorCss(l, dark) }} onClick={() => setOpen(open === l.name ? null : l.name)} />
              <div className="grow" style={{ overflow: 'hidden' }} onClick={() => setOpen(open === l.name ? null : l.name)} onDoubleClick={() => useApp.getState().set({ style: { ...style, layer: l.name } })}>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: l.on && !l.frozen ? 1 : 0.5 }} dir="auto">{l.name}</div>
                <div className="small muted">{counts.get(l.name) ?? 0} obj · {l.lineType} · {lwLabel(l.lineWeight)}{l.transparency ? ` · ${Math.round(l.transparency * 100)}%` : ''}</div>
              </div>
              <button className="icon-btn" style={{ minWidth: 34, height: 34 }} title="Zoom to layer" onClick={() => zoomLayer(l.name)}><Icon name="zoomin" /></button>
            </div>
            {open === l.name && (
              <div className="card" style={{ margin: '6px 0 10px' }}>
                <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
                  <button className="btn sm primary" onClick={() => useApp.getState().set({ style: { ...style, layer: l.name } })}>Set current</button>
                  <button className="btn sm" onClick={() => isolate(l.name)}>Isolate</button>
                  <button className="btn sm" onClick={() => selectLayer(l.name)}>Select objects</button>
                  {editable && <button className="btn sm" onClick={() => moveSelectionTo(l.name)}>Move selection here</button>}
                  {editable && <button className="btn sm" onClick={() => rename(l)}>Rename</button>}
                  {editable && <button className="btn sm danger" onClick={() => del(l)}>Delete</button>}
                </div>
                <div className="field"><label>Colour</label>
                  <ColorPicker aci={l.aci} rgb={l.rgb} allowBy={false} onChange={(c) => update(l.name, { aci: c.aci ?? l.aci, rgb: c.rgb }, 'Layer colour')} />
                </div>
                <div className="grid2">
                  <div className="field"><label>Linetype</label>
                    <select value={l.lineType} onChange={(e) => update(l.name, { lineType: e.target.value }, 'Layer linetype')}>
                      {doc.drawing.lineTypes.map((lt) => <option key={lt.name} value={lt.name}>{lt.name}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>Lineweight</label>
                    <select value={l.lineWeight} onChange={(e) => update(l.name, { lineWeight: +e.target.value }, 'Layer lineweight')}>
                      {LINEWEIGHTS.filter((w) => w !== -1 && w !== -2).map((w) => <option key={w} value={w}>{lwLabel(w)}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field"><label>Transparency {Math.round(l.transparency * 100)}%</label>
                  <input type="range" min={0} max={90} value={Math.round(l.transparency * 100)} onChange={(e) => update(l.name, { transparency: +e.target.value / 100 }, 'Layer transparency')} />
                </div>
                <label className="row small"><input type="checkbox" checked={l.plot} onChange={(e) => update(l.name, { plot: e.target.checked })} /> Plot</label>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
