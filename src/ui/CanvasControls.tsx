import React from 'react';
import { useApp } from '../app/store';
import { app } from '../app/controller';
import { Icon } from './icons';
import { useGps } from '../gps/gpsStore';
import { gpsController } from '../gps/controller';

export function CanvasControls() {
  const s = useApp();
  const gps = useGps();
  const stats = s.stats;
  return (
    <>
      <div className="chips">
        <button className={`chip ${s.snap.enabled ? 'on' : ''}`} onClick={() => s.set({ snap: { ...s.snap, enabled: !s.snap.enabled } })} title="Object snap (F3)">OSNAP</button>
        <button className={`chip ${s.ortho ? 'on' : ''}`} onClick={() => s.set({ ortho: !s.ortho })} title="Ortho (F8)">ORTHO</button>
        <button className={`chip ${s.grid ? 'on' : ''}`} onClick={() => app.setOption('grid', !s.grid)} title="Grid (F7)">GRID</button>
        <button className={`chip ${s.lineweights ? 'on' : ''}`} onClick={() => app.setOption('lineweights', !s.lineweights)} title="Show lineweights">LWT</button>
        {gps.calibrated && <button className={`chip ${gps.headingUp ? 'on' : ''}`} onClick={() => gpsController.setHeadingUp(!gps.headingUp)} title="North-up / Heading-up">{gps.headingUp ? 'HEADING ▲' : 'NORTH ▲'}</button>}
      </div>
      <div className="fab-col">
        <button className="fab" onClick={() => app.view?.fitExtents()} title="Fit drawing"><Icon name="fit" /></button>
        <button className={`fab ${gps.follow ? 'follow' : gps.running ? 'on' : ''}`} title="Locate me / Follow me"
          onClick={() => gpsController.locateOrFollow()}>
          <Icon name={gps.follow ? 'follow' : 'locate'} />
        </button>
      </div>
      {stats && <div className="statusbar">{stats}</div>}
    </>
  );
}
