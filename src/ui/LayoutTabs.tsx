import React, { useEffect, useState } from 'react';
import { app } from '../app/controller';
import { useApp } from '../app/store';

/** Model / paper-space layout switcher (layouts are view-only; editing happens in model space). */
export function LayoutTabs() {
  useApp((s) => s.docRev);
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const v = app.view;
    if (!v) return;
    const l = () => force((x) => x + 1);
    v.layoutListeners.add(l);
    return () => { v.layoutListeners.delete(l); };
  }, [app.view]);
  const layouts = app.doc?.drawing.layouts ?? [];
  if (!layouts.length) return null;
  const cur = app.view?.layout?.def.name ?? 'Model';
  return (
    <div style={{ position: 'absolute', left: 10, bottom: 52, zIndex: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
      <button className={`chip ${cur === 'Model' ? 'on' : ''}`} onClick={() => { app.view?.setLayout(null); setOpen(false); }}>Model</button>
      <div style={{ position: 'relative' }}>
        <button className={`chip ${cur !== 'Model' ? 'on' : ''}`} onClick={() => setOpen(!open)}>{cur !== 'Model' ? cur : `Layouts (${layouts.length})`} ▾</button>
        {open && (
          <div className="card" style={{ position: 'absolute', bottom: 36, left: 0, maxHeight: 300, overflow: 'auto', minWidth: 160, padding: 4, boxShadow: 'var(--shadow)' }}>
            {layouts.map((l) => (
              <div key={l.name} className={`list-item ${cur === l.name ? 'active' : ''}`} style={{ minHeight: 34, padding: '4px 8px' }}
                onClick={() => { app.setTool('select'); app.view?.setLayout(l); setOpen(false); }}>
                {l.name} <span className="small muted">· {l.viewports.length} vp</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {cur !== 'Model' && <span className="badge info">Paper space · view only</span>}
    </div>
  );
}
