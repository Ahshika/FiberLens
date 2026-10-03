import { create } from 'zustand';
import type { TraceResult } from '../../ftth/topology';
import { traceUpstream, traceDownstream } from '../../ftth/topology';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { getObject, getCable, linkedEntity } from '../../ftth/store';
import { useFtthView } from '../../ftth/overlay';

export type Card = { type: 'object' | 'cable' | 'splitter'; id: string } | null;
export type FtthTab = 'overview' | 'objects' | 'cables' | 'splitters' | 'trace' | 'detect';

interface UiState {
  tab: FtthTab;
  card: Card;
  history: Card[];
  trace: { dir: 'up' | 'down'; startId: string; result: TraceResult } | null;
  set: (p: Partial<UiState>) => void;
}
export const useFtthUi = create<UiState>((set) => ({ tab: 'overview', card: null, history: [], trace: null, set: (p) => set(p) }));

export function openCard(card: Card, focus = true) {
  const st = useFtthUi.getState();
  st.set({ card, history: st.card ? [...st.history.slice(-10), st.card] : st.history });
  useApp.getState().set({ panel: 'ftth' });
  if (card?.type === 'object') {
    useFtthView.getState().set({ selected: card.id });
    const o = getObject(card.id);
    if (o && focus) {
      const e = linkedEntity(o.cad);
      if (e) { app.selection?.set([e.id]); }
      app.view?.centerOn(o.cad.x, o.cad.y, Math.max(app.view.cam.scale, 3 / app.unitsPerMeter()));
    }
  } else if (card?.type === 'cable') {
    const c = getCable(card.id);
    const e = c && linkedEntity(c.cad);
    if (e && focus) { app.selection?.set([e.id]); app.zoomToEntities([e.id]); }
  }
}

export function backCard() {
  const st = useFtthUi.getState();
  const prev = st.history[st.history.length - 1] ?? null;
  st.set({ card: prev, history: st.history.slice(0, -1) });
}

export function runTrace(objectId: string, dir: 'up' | 'down') {
  const result = dir === 'up' ? traceUpstream(objectId) : traceDownstream(objectId);
  useFtthUi.getState().set({ trace: { dir, startId: objectId, result }, tab: 'trace', card: null });
  app.selection?.setHighlight('trace', { ids: result.entityIds, color: dir === 'up' ? '#00e5ff' : '#ff4fd8', width: 6 });
  if (result.entityIds.length) app.zoomToEntities(result.entityIds);
  useApp.getState().set({ panel: 'ftth' });
  return result;
}

export function clearTrace() {
  useFtthUi.getState().set({ trace: null });
  app.selection?.setHighlight('trace', null);
}
