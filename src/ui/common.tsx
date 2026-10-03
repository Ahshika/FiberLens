import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/store';
import { useDialog } from '../app/dialogs';
import { Icon } from './icons';
import { aciToRgb, rgbToHex, hexToRgb } from '../cad/model/color';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

export function Loading() {
  const loading = useApp((s) => s.loading);
  const progress = useApp((s) => s.progress);
  if (!loading) return null;
  return (
    <div className="loading">
      <div className="spinner" />
      <div>{loading}{progress !== null ? ` ${Math.round(progress * 100)}%` : ''}</div>
    </div>
  );
}

export function DialogHost() {
  const req = useDialog((s) => s.req);
  const [vals, setVals] = useState<Record<string, any>>({});
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!req) return;
    const v: Record<string, any> = {};
    for (const f of req.fields ?? []) v[f.key] = f.value ?? '';
    setVals(v);
    setTimeout(() => firstRef.current?.focus(), 30);
  }, [req]);
  if (!req) return null;
  const ok = () => req.resolve(vals);
  const cancel = () => req.resolve(null);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="modal" onKeyDown={(e) => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter' && !(e.target as HTMLElement).matches('textarea')) ok(); }}>
        <h3>{req.title}</h3>
        {req.message && <p style={{ whiteSpace: 'pre-wrap', color: 'var(--fg2)' }}>{req.message}</p>}
        {(req.fields ?? []).map((f, i) => (
          <div className="field" key={f.key}>
            {f.label && <label>{f.label}</label>}
            {f.type === 'textarea' ? (
              <textarea ref={i === 0 ? (firstRef as any) : undefined} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} dir="auto" />
            ) : f.type === 'select' ? (
              <select value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input ref={i === 0 ? (firstRef as any) : undefined} type={f.type ?? 'text'} value={vals[f.key] ?? ''} dir="auto"
                onChange={(e) => setVals({ ...vals, [f.key]: f.type === 'number' ? e.target.value : e.target.value })} />
            )}
          </div>
        ))}
        <div className="actions">
          {req.cancelLabel !== null && <button className="btn" onClick={cancel}>{req.cancelLabel ?? 'Cancel'}</button>}
          <button className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={ok}>{req.okLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  );
}

export function PanelFrame({ title, onClose, children, tall, actions }: { title: string; onClose: () => void; children: React.ReactNode; tall?: boolean; actions?: React.ReactNode }) {
  // phone bottom sheet: half → full → minimised (tap the handle / title)
  const size = useApp((s) => s.sheet);
  const setSize = (v: 'half' | 'full' | 'min') => useApp.getState().set({ sheet: v });
  const cycle = () => setSize(size === 'half' ? 'full' : size === 'full' ? 'min' : 'half');
  return (
    <div className={`panel ${tall ? 'tall' : ''} sheet-${size}`}>
      <div className="sheet-handle" onClick={cycle}><span /></div>
      <div className="panel-head">
        <h3 onClick={cycle}>{title}</h3>
        <button className="icon-btn sheet-toggle" onClick={cycle} title="Expand / collapse">{size === 'full' ? '▾' : '▴'}</button>
        {actions}
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="close" /></button>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

const QUICK_ACI = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 40, 140, 160, 200, 220, 250];

/** colour picker: ByLayer / ByBlock / ACI swatches / free RGB */
export function ColorPicker({ aci, rgb, onChange, allowBy = true }: { aci?: number; rgb?: number; onChange: (c: { aci?: number; rgb?: number }) => void; allowBy?: boolean }) {
  const cur = rgb !== undefined ? rgbToHex(rgb) : aci !== undefined && aci > 0 && aci < 256 ? rgbToHex(aciToRgb(aci)) : '#ffffff';
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="color-row">
        {allowBy && <button className={`btn sm ${aci === 256 && rgb === undefined ? 'primary' : ''}`} onClick={() => onChange({ aci: 256 })}>ByLayer</button>}
        {allowBy && <button className={`btn sm ${aci === 0 && rgb === undefined ? 'primary' : ''}`} onClick={() => onChange({ aci: 0 })}>ByBlock</button>}
      </div>
      <div className="color-row">
        {QUICK_ACI.map((i) => (
          <div key={i} title={`ACI ${i}`} className={`swatch ${rgb === undefined && aci === i ? 'on' : ''}`} style={{ background: i === 7 ? 'linear-gradient(135deg,#fff 50%,#000 50%)' : rgbToHex(aciToRgb(i)) }} onClick={() => onChange({ aci: i })} />
        ))}
        <label className="swatch" title="Any colour" style={{ background: 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)', position: 'relative' }}>
          <input type="color" value={cur} onChange={(e) => onChange({ rgb: hexToRgb(e.target.value) })} style={{ opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
        </label>
      </div>
      <div className="row small muted">
        <span className="swatch" style={{ background: cur }} />
        {rgb !== undefined ? `RGB ${cur}` : aci === 256 ? 'ByLayer' : aci === 0 ? 'ByBlock' : `ACI ${aci}`}
        <input type="text" style={{ width: 92, minHeight: 28, padding: '2px 6px' }} placeholder="#RRGGBB" defaultValue={rgb !== undefined ? cur : ''} key={cur}
          onBlur={(e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) onChange({ rgb: hexToRgb(v) }); }} />
      </div>
    </div>
  );
}

export const LINEWEIGHTS = [-1, -2, -3, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
export const lwLabel = (w: number | undefined) => w === undefined || w === -1 ? 'ByLayer' : w === -2 ? 'ByBlock' : w === -3 ? 'Default' : `${(w / 100).toFixed(2)} mm`;

export function useDocRev() { return useApp((s) => s.docRev); }

export function fmt(n: number | undefined | null, d = 3) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
