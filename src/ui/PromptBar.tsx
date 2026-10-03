import React, { useState } from 'react';
import { useApp } from '../app/store';
import { app } from '../app/controller';
import { useT } from '../app/i18n';

/** CAD-style command prompt: current tool, instruction, typed input and tool options. */
export function PromptBar() {
  const toolId = useApp((s) => s.toolId);
  const prompt = useApp((s) => s.prompt);
  useApp((s) => s.toolRev);
  const [text, setText] = useState('');
  const t = useT();
  const tool = app.tools?.active;
  if (!tool || toolId === 'select') return null;
  const opts = tool.options();
  const submit = () => {
    if (!text.trim()) { tool.enter(); return; }
    if (!app.tools?.input(text)) useApp.getState().toast(`Invalid input "${text}" — use x,y  @dx,dy  @dist<angle  or a number`, 'error');
    setText('');
  };
  return (
    <div className="promptbar">
      <div className="prompt">
        <b>{tool.label}</b>
        <span>{prompt}</span>
        {opts.map((o) => (
          <span className="opt" key={o.key}>
            {o.type === 'action' ? (
              <button onClick={() => { tool.setOption(o.key, true); app.tools?.view.invalidateOverlay(); useApp.setState((s) => ({ toolRev: s.toolRev + 1 })); }}>{o.label}</button>
            ) : o.type === 'toggle' ? (
              <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={!!o.value} onChange={(e) => { tool.setOption(o.key, e.target.checked); useApp.setState((s) => ({ toolRev: s.toolRev + 1 })); }} />{o.label}</label>
            ) : o.type === 'select' ? (
              <>{o.label}<select value={o.value} onChange={(e) => { tool.setOption(o.key, e.target.value); useApp.setState((s) => ({ toolRev: s.toolRev + 1 })); }} style={{ minHeight: 30, padding: '2px 6px' }}>
                {o.choices!.map((c) => <option key={String(c.value)} value={c.value}>{c.label}</option>)}
              </select></>
            ) : (
              <>{o.label}<input type={o.type === 'number' ? 'number' : 'text'} value={o.value ?? ''} step="any"
                onChange={(e) => { tool.setOption(o.key, o.type === 'number' ? parseFloat(e.target.value) : e.target.value); useApp.setState((s) => ({ toolRev: s.toolRev + 1 })); }} /></>
            )}
          </span>
        ))}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="x,y | @dx,dy | len" onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') tool.escape(); e.stopPropagation(); }} />
        <button onClick={() => tool.enter()}>{t('Done')}</button>
        <button onClick={() => app.setTool('select')}>✕</button>
      </div>
    </div>
  );
}
