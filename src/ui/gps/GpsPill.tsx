import React from 'react';
import { useGps } from '../../gps/gpsStore';
import { SEARCHING } from '../../gps/sources';
import { useApp } from '../../app/store';

export function GpsPill() {
  const g = useGps();
  const setPanel = (p: any) => useApp.getState().set({ panel: p });
  let cls = '', text = 'GPS off';
  if (g.running) {
    if (g.error && !g.fix && g.error !== SEARCHING) { cls = 'err'; text = 'GPS error'; }
    else if (!g.fix) { cls = 'warn'; text = 'Searching…'; }
    else {
      const acc = g.fix.accuracy;
      cls = acc <= 5 ? 'ok' : acc <= 15 ? 'warn' : 'err';
      const ft = g.fix.fixType === 'rtk-fixed' ? 'RTK' : g.fix.fixType === 'rtk-float' ? 'FLOAT' : g.fix.fixType === 'dgps' ? 'DGPS' : '';
      text = `${ft ? ft + ' ' : ''}±${acc < 1 ? acc.toFixed(2) : acc.toFixed(1)} m${g.fix.satellites ? ` · ${g.fix.satellites} sat` : ''}`;
      if (!g.calibrated) text += ' · not calibrated';
    }
  }
  return (
    <div className="gps-pill" onClick={() => setPanel('gps')} title="GPS status">
      <span className={`gps-dot ${cls}`} />
      {text}
      {g.tracking && <span className="badge err">REC</span>}
    </div>
  );
}
