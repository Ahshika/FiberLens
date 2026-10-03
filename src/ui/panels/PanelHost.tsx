import React from 'react';
import type { PanelId } from '../../app/store';
import { PanelFrame } from '../common';

export interface PanelDef { title: string; component: React.ComponentType<{ onClose: () => void }>; tall?: boolean }
const registry = new Map<string, PanelDef>();

/** feature modules register their panels here */
export function registerPanel(id: Exclude<PanelId, null>, def: PanelDef) { registry.set(id, def); }

export function PanelHost({ id, onClose }: { id: Exclude<PanelId, null>; onClose: () => void }) {
  const def = registry.get(id);
  if (!def) return <PanelFrame title={id} onClose={onClose}><div className="empty">Coming up…</div></PanelFrame>;
  const C = def.component;
  return <PanelFrame title={def.title} onClose={onClose} tall={def.tall}><C onClose={onClose} /></PanelFrame>;
}
