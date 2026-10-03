import React from 'react';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { ColorPicker, LINEWEIGHTS, lwLabel, fmt, useDocRev } from '../common';
import type { Entity } from '../../cad/model/types';
import { entityLength, entityArea } from '../../cad/edit/measure';
import { editEntityText } from '../../cad/tools/textTools';
import { Icon } from '../icons';
import { can } from '../../auth/session';

const VARIES = '*varies*';
function common<T>(ents: Entity[], f: (e: Entity) => T): T | typeof VARIES {
  const v = f(ents[0]);
  for (const e of ents) if (JSON.stringify(f(e)) !== JSON.stringify(v)) return VARIES;
  return v;
}

function Num({ label, value, onChange, step = 'any' }: { label: string; value: number; onChange: (v: number) => void; step?: string }) {
  return (
    <div className="field"><label>{label}</label>
      <input type="number" step={step} defaultValue={+value.toFixed(6)} key={value} onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v !== value) onChange(v); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </div>
  );
}

export function PropertiesPanel() {
  useDocRev();
  useApp((s) => s.selRev);
  const doc = app.doc;
  const sel = app.selection;
  if (!doc || !sel) return null;
  const ents = sel.list.map((id) => doc.get(id)).filter(Boolean) as Entity[];
  if (!ents.length) return <div className="empty">Select objects to see and edit their properties.<br /><br /><span className="small">Tap an object, or drag a window with the mouse / long-press on touch.</span></div>;
  const editable = can('cad.edit') && ents.every((e) => doc.isEditable(e));
  const apply = (patch: (e: Entity) => Partial<Entity>, label: string) => {
    if (!editable) { useApp.getState().toast('Read-only (locked layer or role)', 'error'); return; }
    doc.modify(ents.map((e) => ({ ...e, ...patch(e) } as Entity)), label);
  };
  const types = common(ents, (e) => e.type);
  const layer = common(ents, (e) => e.layer);
  const aci = common(ents, (e) => e.aci);
  const rgb = common(ents, (e) => e.rgb);
  const lt = common(ents, (e) => e.lineType ?? 'ByLayer');
  const lw = common(ents, (e) => e.lineWeight ?? -1);
  const tr = common(ents, (e) => e.transparency);
  const ltScale = common(ents, (e) => e.ltScale ?? 1);
  const one = ents.length === 1 ? ents[0] : null;
  const upm = app.unitsPerMeter();
  const totalLen = ents.reduce((s, e) => s + (entityLength(e) ?? 0), 0);
  const totalArea = ents.reduce((s, e) => s + (entityArea(e) ?? 0), 0);

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="badge info">{ents.length} × {types === VARIES ? 'mixed' : types}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => app.zoomToEntities(sel.list)}><Icon name="zoomin" />Zoom</button>
        {editable && <button className="btn sm danger" onClick={() => app.deleteSelection()}><Icon name="trash" />Delete</button>}
      </div>
      {!editable && <div className="badge warn" style={{ marginBottom: 8 }}>Read-only: locked layer or insufficient role</div>}
      <div className="section">General</div>
      <div className="field"><label>Layer</label>
        <select value={layer === VARIES ? '' : layer} onChange={(e) => apply(() => ({ layer: e.target.value }), 'Change layer')}>
          {layer === VARIES && <option value="">{VARIES}</option>}
          {doc.drawing.layers.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Colour {aci === VARIES || rgb === VARIES ? `(${VARIES})` : ''}</label>
        <ColorPicker aci={aci === VARIES ? undefined : (aci as number | undefined) ?? 256} rgb={rgb === VARIES ? undefined : (rgb as number | undefined)} onChange={(c) => apply(() => ({ aci: c.aci ?? 256, rgb: c.rgb }), 'Change colour')} />
      </div>
      <div className="grid2">
        <div className="field"><label>Linetype</label>
          <select value={lt === VARIES ? '' : lt} onChange={(e) => apply(() => ({ lineType: e.target.value === 'ByLayer' ? undefined : e.target.value }), 'Change linetype')}>
            {lt === VARIES && <option value="">{VARIES}</option>}
            <option value="ByLayer">ByLayer</option><option value="ByBlock">ByBlock</option>
            {doc.drawing.lineTypes.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Lineweight</label>
          <select value={lw === VARIES ? '' : lw} onChange={(e) => apply(() => ({ lineWeight: +e.target.value === -1 ? undefined : +e.target.value }), 'Change lineweight')}>
            {lw === VARIES && <option value="">{VARIES}</option>}
            {LINEWEIGHTS.map((w) => <option key={w} value={w}>{lwLabel(w)}</option>)}
          </select>
        </div>
      </div>
      <div className="grid2">
        <Num label="Linetype scale" value={ltScale === VARIES ? 1 : (ltScale as number)} onChange={(v) => apply(() => ({ ltScale: v === 1 ? undefined : v }), 'Linetype scale')} />
        <div className="field"><label>Transparency {tr === VARIES ? VARIES : tr === undefined ? 'ByLayer' : `${Math.round((tr as number) * 100)}%`}</label>
          <div className="row">
            <input className="grow" type="range" min={0} max={90} value={tr === VARIES || tr === undefined ? 0 : Math.round((tr as number) * 100)} onChange={(e) => apply(() => ({ transparency: +e.target.value / 100 }), 'Transparency')} />
            <button className="btn sm" onClick={() => apply(() => ({ transparency: undefined }), 'Transparency ByLayer')}>ByLayer</button>
          </div>
        </div>
      </div>
      {(totalLen > 0 || totalArea > 0) && (
        <>
          <div className="section">Measurements</div>
          <div className="kv">
            {totalLen > 0 && <><div>Length</div><div>{fmt(totalLen / upm, 2)} m <span className="muted">({fmt(totalLen, 3)} du)</span></div></>}
            {totalArea > 0 && <><div>Area</div><div>{fmt(totalArea / upm / upm, 2)} m²</div></>}
          </div>
        </>
      )}
      {one && <Specific e={one} apply={(p, l) => apply(() => p, l)} />}
    </div>
  );
}

function Specific({ e, apply }: { e: Entity; apply: (p: Partial<any>, label: string) => void }) {
  const P = (label: string, v: { x: number; y: number }, key: string) => (
    <div className="grid2" key={key}>
      <Num label={`${label} X`} value={v.x} onChange={(x) => apply({ [key]: { ...v, x } }, `Edit ${label}`)} />
      <Num label={`${label} Y`} value={v.y} onChange={(y) => apply({ [key]: { ...v, y } }, `Edit ${label}`)} />
    </div>
  );
  const deg = (r: number) => (r * 180) / Math.PI, rad = (d: number) => (d * Math.PI) / 180;
  const host = app.tools!.host as any;
  switch (e.type) {
    case 'line': return <><div className="section">Line</div>{P('Start', e.p1, 'p1')}{P('End', e.p2, 'p2')}</>;
    case 'circle': return <><div className="section">Circle</div>{P('Center', e.c, 'c')}<Num label="Radius" value={e.r} onChange={(r) => r > 0 && apply({ r }, 'Radius')} /></>;
    case 'arc': return <><div className="section">Arc</div>{P('Center', e.c, 'c')}<Num label="Radius" value={e.r} onChange={(r) => r > 0 && apply({ r }, 'Radius')} />
      <div className="grid2"><Num label="Start angle°" value={deg(e.a0)} onChange={(v) => apply({ a0: rad(v) }, 'Arc angle')} /><Num label="End angle°" value={deg(e.a1)} onChange={(v) => apply({ a1: rad(v) }, 'Arc angle')} /></div></>;
    case 'polyline': return <><div className="section">Polyline</div>
      <div className="kv"><div>Vertices</div><div>{e.pts.length / 2}</div></div>
      <label className="row" style={{ margin: '8px 0' }}><input type="checkbox" checked={e.closed} onChange={(ev) => apply({ closed: ev.target.checked }, 'Close polyline')} /> Closed</label>
      <Num label="Global width" value={e.width ?? 0} onChange={(w) => apply({ width: w || undefined, widths: undefined }, 'Polyline width')} />
      <button className="btn sm" onClick={() => app.setTool('pedit')}>Edit vertices…</button></>;
    case 'text': case 'mtext': return <><div className="section">{e.type === 'text' ? 'Text' : 'MText'}</div>
      <div className="card" dir="auto" style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{e.value.replace(/\\P/g, '\n')}</div>
      <button className="btn sm primary" onClick={() => editEntityText(host, e.id)}><Icon name="edit" />Edit text…</button>
      {P('Position', e.p, 'p')}
      <div className="grid2"><Num label="Height" value={e.h} onChange={(h) => h > 0 && apply({ h }, 'Text height')} /><Num label="Rotation°" value={deg(e.rot)} onChange={(v) => apply({ rot: rad(v) }, 'Text rotation')} /></div>
      <div className="grid2">
        <div className="field"><label>Font</label><input defaultValue={e.font ?? ''} onBlur={(ev) => apply({ font: ev.target.value || undefined }, 'Font')} /></div>
        <div className="field"><label>Style</label><div className="row">
          <button className={`btn sm ${e.bold ? 'primary' : ''}`} onClick={() => apply({ bold: !e.bold || undefined }, 'Bold')}><b>B</b></button>
          <button className={`btn sm ${e.italic ? 'primary' : ''}`} onClick={() => apply({ italic: !e.italic || undefined }, 'Italic')}><i>I</i></button>
        </div></div>
      </div>
      {e.type === 'text' && <div className="field"><label>Alignment</label>
        <select value={e.halign ?? 'left'} onChange={(ev) => apply({ halign: ev.target.value === 'left' ? undefined : ev.target.value, p2: e.p2 ?? e.p }, 'Alignment')}>
          {['left', 'center', 'right', 'middle', 'aligned', 'fit'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select></div>}
      {e.type === 'mtext' && <><Num label="Box width" value={e.width} onChange={(w) => apply({ width: Math.max(0, w) }, 'MText width')} />
        <label className="row"><input type="checkbox" checked={e.bgFill !== undefined} onChange={(ev) => apply({ bgFill: ev.target.checked ? -1 : undefined, bgScale: ev.target.checked ? 1.4 : undefined }, 'Background mask')} /> Background mask</label></>}
    </>;
    case 'insert': return <><div className="section">Block reference</div>
      <div className="kv"><div>Block</div><div>{e.block}</div></div>
      {P('Insertion', e.p, 'p')}
      <div className="grid3"><Num label="Scale X" value={e.sx} onChange={(sx) => apply({ sx }, 'Block scale')} /><Num label="Scale Y" value={e.sy} onChange={(sy) => apply({ sy }, 'Block scale')} /><Num label="Rotation°" value={deg(e.rot)} onChange={(v) => apply({ rot: rad(v) }, 'Block rotation')} /></div>
      {e.attribs?.length ? <><div className="section">Attributes</div>
        {e.attribs.map((a, i) => (
          <div className="field" key={a.tag}><label>{a.tag}</label>
            <input defaultValue={a.value} dir="auto" onBlur={(ev) => { if (ev.target.value !== a.value) apply({ attribs: e.attribs!.map((x, k) => (k === i ? { ...x, value: ev.target.value } : x)) }, 'Edit attribute'); }} />
          </div>
        ))}</> : null}
    </>;
    case 'hatch': return <><div className="section">Hatch</div>
      <div className="kv"><div>Pattern</div><div>{e.solid ? 'SOLID' : e.pattern}</div><div>Loops</div><div>{e.loops.length}</div></div></>;
    case 'ellipse': return <><div className="section">Ellipse</div>{P('Center', e.c, 'c')}<Num label="Ratio" value={e.ratio} onChange={(r) => r > 0 && r <= 1 && apply({ ratio: r }, 'Ellipse ratio')} /></>;
    case 'point': return <><div className="section">Point</div>{P('Location', e.p, 'p')}</>;
    case 'leader': return <><div className="section">Leader</div><button className="btn sm" onClick={() => editEntityText(host, e.id)}>Edit text…</button></>;
    case 'dimension': return <><div className="section">Dimension</div><div className="kv"><div>Type</div><div>{e.dimType}</div><div>Measurement</div><div>{fmt(e.measurement, 3)}</div></div>
      <button className="btn sm" onClick={() => editEntityText(host, e.id)}>Override text…</button></>;
    default: return null;
  }
}
