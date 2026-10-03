import React from 'react';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { Icon } from '../icons';
import { ColorPicker, LINEWEIGHTS, lwLabel, useDocRev } from '../common';
import { TOOL_INFO } from '../../cad/tools/registry';
import { useMeasure } from '../../cad/tools/measureTools';
import { can } from '../../auth/session';
import { useT } from '../../app/i18n';

function ToolGrid({ group }: { group: 'draw' | 'edit' | 'text' | 'measure' }) {
  const toolId = useApp((s) => s.toolId);
  const tr = useT();
  const allowed = group === 'measure' || can('cad.edit');
  return (
    <div className="tool-grid">
      {TOOL_INFO.filter((t) => t.group === group).map((t) => (
        <button key={t.id} className={`tool-btn ${toolId === t.id ? 'on' : ''}`} disabled={!allowed}
          onClick={() => app.setTool(toolId === t.id ? 'select' : t.id)}>
          <Icon name={t.icon} />{tr(t.label)}
        </button>
      ))}
    </div>
  );
}

export function StyleBar({ text = false }: { text?: boolean }) {
  useDocRev();
  const style = useApp((s) => s.style);
  const set = (p: Partial<typeof style>) => useApp.getState().set({ style: { ...style, ...p } });
  const doc = app.doc;
  return (
    <div>
      <div className="section">New object style</div>
      <div className="field"><label>Layer</label>
        <select value={style.layer} onChange={(e) => set({ layer: e.target.value })}>
          {doc?.drawing.layers.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Colour (any colour via the rainbow swatch)</label>
        <ColorPicker aci={style.aci} rgb={style.rgb} onChange={(c) => set({ aci: c.aci, rgb: c.rgb })} />
      </div>
      {!text && <div className="grid2">
        <div className="field"><label>Linetype</label>
          <select value={style.lineType ?? 'ByLayer'} onChange={(e) => set({ lineType: e.target.value === 'ByLayer' ? undefined : e.target.value })}>
            <option value="ByLayer">ByLayer</option>
            {doc?.drawing.lineTypes.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Line width</label>
          <select value={style.lineWeight ?? -1} onChange={(e) => set({ lineWeight: +e.target.value === -1 ? undefined : +e.target.value })}>
            {LINEWEIGHTS.filter((w) => w !== -2).map((w) => <option key={w} value={w}>{lwLabel(w)}</option>)}
          </select>
        </div>
      </div>}
      <div className="field"><label>Transparency {style.transparency === undefined ? 'ByLayer' : `${Math.round(style.transparency * 100)}%`}</label>
        <input type="range" min={0} max={90} value={Math.round((style.transparency ?? 0) * 100)} onChange={(e) => set({ transparency: +e.target.value ? +e.target.value / 100 : undefined })} />
      </div>
      {!text && <div className="grid2">
        <label className="row"><input type="checkbox" checked={style.fill} onChange={(e) => set({ fill: e.target.checked })} /> Fill closed shapes</label>
        {style.fill && <div className="field"><label>Fill opacity {Math.round(style.fillAlpha * 100)}%</label><input type="range" min={5} max={100} value={Math.round(style.fillAlpha * 100)} onChange={(e) => set({ fillAlpha: +e.target.value / 100 })} /></div>}
      </div>}
      <div className="grid2">
        <div className="field"><label>Rotation (°)</label><input type="number" value={style.rotation} onChange={(e) => set({ rotation: +e.target.value || 0 })} /></div>
        <div className="field"><label>{text ? 'Text height' : 'Size / text height'}</label><input type="number" step="any" value={style.textHeight} onChange={(e) => set({ textHeight: Math.max(0.001, +e.target.value || 1) })} /></div>
      </div>
      {text && <>
        <div className="grid2">
          <div className="field"><label>Font</label>
            <select value={style.font} onChange={(e) => set({ font: e.target.value })}>
              {['Arial', 'Tahoma', 'Times New Roman', 'Courier New', 'Segoe UI', 'Noto Sans Arabic', 'Calibri', 'Verdana'].map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          <div className="field"><label>Alignment</label>
            <select value={style.halign} onChange={(e) => set({ halign: e.target.value as any })}>
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
            </select>
          </div>
        </div>
        <div className="row wrap">
          <button className={`btn sm ${style.bold ? 'primary' : ''}`} onClick={() => set({ bold: !style.bold })}><b>Bold</b></button>
          <button className={`btn sm ${style.italic ? 'primary' : ''}`} onClick={() => set({ italic: !style.italic })}><i>Italic</i></button>
          <label className="row small"><input type="checkbox" checked={style.bgMask} onChange={(e) => set({ bgMask: e.target.checked })} /> Background mask</label>
        </div>
      </>}
    </div>
  );
}

export function DrawPanel() {
  return <div><ToolGrid group="draw" /><StyleBar /></div>;
}

export function EditPanel() {
  const count = useApp((s) => s.selectionCount);
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <span className="badge info">{count} selected</span>
        <button className="btn sm" onClick={() => app.selection?.clear()}>Clear</button>
        <button className="btn sm" onClick={() => useApp.getState().set({ panel: 'props' })}><Icon name="props" />Properties</button>
      </div>
      <ToolGrid group="edit" />
      <p className="small muted">Tip: select first, then pick a command — or pick the command and select objects (Enter to continue). Grips: tap a selected object's blue square and then the new location.</p>
    </div>
  );
}

export function TextPanel() {
  return <div><ToolGrid group="text" /><p className="small muted">Tap any existing text in the DWG with <b>Edit text</b> to change it directly — block attributes too.</p><StyleBar text /></div>;
}

export function MeasurePanel() {
  const results = useMeasure((s) => s.results);
  const clear = useMeasure((s) => s.clear);
  return (
    <div>
      <ToolGrid group="measure" />
      <div className="row" style={{ marginTop: 12 }}><div className="section grow" style={{ margin: 0 }}>Results</div>{results.length > 0 && <button className="btn sm" onClick={clear}>Clear</button>}</div>
      {results.length === 0 ? <div className="empty small">No measurements yet. Distances use drawing coordinates converted to metres via the GPS calibration (or drawing units).</div> : (
        <div className="list">
          {results.map((r, i) => (
            <div className="list-item" key={i} style={{ cursor: 'default' }}>
              <span className="badge">{r.kind}</span>
              <span className="grow mono small">{r.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
