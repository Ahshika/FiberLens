import React, { useState } from 'react';
import { useApp, type PanelId } from '../app/store';
import { app } from '../app/controller';
import { Icon, Logo } from './icons';
import { CadCanvas } from './CadCanvas';
import { PanelHost } from './panels/PanelHost';
import { PromptBar } from './PromptBar';
import { CanvasControls } from './CanvasControls';
import { GpsPill } from './gps/GpsPill';
import { InfoCard } from './InfoCard';
import { fmt } from './common';
import './panels/register';
import { NavHud } from './ftth/integration';
import { LayoutTabs } from './LayoutTabs';
import { useT } from '../app/i18n';

const DOCK: { id: PanelId; label: string; icon: string }[] = [
  { id: 'layers', label: 'Layers', icon: 'layers' },
  { id: 'draw', label: 'Draw', icon: 'draw' },
  { id: 'edit', label: 'Edit', icon: 'edit' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'ftth', label: 'FTTH', icon: 'fiber' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'measure', label: 'Measure', icon: 'measure' },
  { id: 'gps', label: 'GPS', icon: 'gps' },
  { id: 'survey', label: 'Survey', icon: 'survey' },
  { id: 'notes', label: 'Notes', icon: 'note' },
  { id: 'photos', label: 'Photos', icon: 'photo' },
  { id: 'more', label: 'More', icon: 'more' },
];

function TopBar() {
  const s = useApp();
  const t = useT();
  return (
    <div className="topbar">
      <div className="brand" onClick={() => s.set({ panel: s.panel === 'project' ? null : 'project' })} title="Project">
        <Logo />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.15 }}>
          <span className="pname">{s.projectName || 'FiberLens'}</span>
          <span className="dname">{s.drawingName}{s.dirty ? ' •' : ''}</span>
        </div>
      </div>
      <span className={`mode-badge ${s.mode}`} title="Design / As-Built mode">{s.mode === 'design' ? t('DESIGN') : t('AS-BUILT')}</span>
      <div className="top-sep hide-sm" />
      <GpsPill />
      <div className="coords hide-sm" title="Cursor (drawing coordinates)">
        {s.cursor ? `X ${fmt(s.cursor.x, 3)}  Y ${fmt(s.cursor.y, 3)}` : ''}
      </div>
      <div className="spacer" />
      <button className="icon-btn" disabled={!s.canUndo} onClick={() => app.undo()} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
      <button className="icon-btn" disabled={!s.canRedo} onClick={() => app.redo()} title="Redo (Ctrl+Y)"><Icon name="redo" /></button>
      <button className="icon-btn hide-sm" onClick={() => app.saveVersionQuick?.()} title="Save version"><Icon name="save" /></button>
      <button className={`icon-btn ${s.panel === 'props' ? 'on' : ''}`} onClick={() => s.set({ panel: s.panel === 'props' ? null : 'props' })} title="Properties">
        <Icon name="props" />{s.selectionCount ? <span className="badge info">{s.selectionCount}</span> : null}
      </button>
    </div>
  );
}

export function CadScreen() {
  const t = useT();
  const panel = useApp((s) => s.panel);
  const set = useApp((s) => s.set);
  const [moreOpen] = useState(false);
  void moreOpen;
  return (
    <>
      <TopBar />
      <div className="main">
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          <CadCanvas />
          <PromptBar />
          <CanvasControls />
          <LayoutTabs />
          <InfoCard />
          <NavHud />
        </div>
        {panel && <PanelHost id={panel} onClose={() => set({ panel: null })} />}
      </div>
      <div className="dock">
        {DOCK.map((d) => (
          <button key={d.id} className={panel === d.id ? 'on' : ''} onClick={() => set({ panel: panel === d.id ? null : d.id })}>
            <Icon name={d.icon} />
            {t(d.label)}
          </button>
        ))}
      </div>
    </>
  );
}
