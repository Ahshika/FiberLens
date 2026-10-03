import { app } from './controller';
import type { Entity } from '../cad/model/types';
import { parseMText } from '../cad/geom/mtext';

export interface SearchHit {
  key: string;
  title: string;
  subtitle: string;
  kind: string;
  /** CAD entities to zoom/select */
  entityIds: number[];
  /** fallback location */
  x?: number; y?: number;
  score: number;
  /** custom action (e.g. open FTTH object card) */
  open?: () => void;
}

export type SearchProvider = (q: string, limit: number) => Promise<SearchHit[]> | SearchHit[];
const providers: { name: string; fn: SearchProvider }[] = [];
export function registerSearchProvider(name: string, fn: SearchProvider) { providers.push({ name, fn }); }

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');

/** score: exact > prefix > contains (on normalised strings, so "FTB-023" ≈ "ftb 023" ≈ "FTB023") */
export function matchScore(text: string, q: string): number {
  if (!text) return 0;
  const t = norm(text), n = norm(q);
  if (!n) return 0;
  if (t === n) return 100;
  if (t.startsWith(n)) return 80 - Math.min(20, t.length - n.length);
  const i = t.indexOf(n);
  if (i >= 0) return 50 - Math.min(30, i);
  return 0;
}

/** CAD text, MText, block attributes, block names, layers */
registerSearchProvider('cad', (q, limit) => {
  const doc = app.doc;
  if (!doc) return [];
  const hits: SearchHit[] = [];
  const push = (e: Entity, title: string, sub: string, kind: string, s: number) => {
    hits.push({ key: `e${e.id}:${title}`, title, subtitle: sub, kind, entityIds: [e.id], score: s });
  };
  for (const e of doc.all()) {
    if (e.type === 'text') { const s = matchScore(e.value, q); if (s) push(e, e.value, `Text · ${e.layer}`, 'Text', s); }
    else if (e.type === 'mtext') { const v = parseMText(e.value).lines.join(' '); const s = matchScore(v, q); if (s) push(e, v.slice(0, 80), `MText · ${e.layer}`, 'Text', s); }
    else if (e.type === 'insert') {
      const sb = matchScore(e.block, q);
      if (sb) push(e, e.block, `Block · ${e.layer}`, 'Block', sb - 5);
      for (const a of e.attribs ?? []) { const s = matchScore(a.value, q); if (s) push(e, a.value, `${a.tag} · ${e.block} · ${e.layer}`, 'Attribute', s + 5); }
    } else if (e.type === 'leader' && e.text) { const s = matchScore(e.text, q); if (s) push(e, e.text, `Leader · ${e.layer}`, 'Text', s); }
    if (hits.length > limit * 6) break;
  }
  for (const l of doc.drawing.layers) {
    const s = matchScore(l.name, q);
    if (s) hits.push({ key: 'L' + l.name, title: l.name, subtitle: 'Layer', kind: 'Layer', entityIds: [], score: s - 10, open: () => { const ids: number[] = []; for (const e of doc.all()) if (e.layer === l.name) ids.push(e.id); app.selection?.set(ids); app.zoomToEntities(ids); } });
  }
  return hits;
});

export async function searchAll(q: string, limit = 60): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  const all: SearchHit[] = [];
  for (const p of providers) {
    try { all.push(...(await p.fn(q, limit))); } catch (e) { console.warn('search provider', p.name, e); }
  }
  const seen = new Set<string>();
  return all.sort((a, b) => b.score - a.score).filter((h) => (seen.has(h.key) ? false : (seen.add(h.key), true))).slice(0, limit);
}

/** zoom + select + flash a hit */
export function openHit(h: SearchHit) {
  if (h.open) { h.open(); return; }
  if (h.entityIds.length) {
    app.selection?.set(h.entityIds);
    app.zoomToEntities(h.entityIds);
    app.selection?.setHighlight('search', { ids: h.entityIds, color: '#ffd400', width: 6 });
    setTimeout(() => app.selection?.setHighlight('search', null), 2500);
  } else if (h.x !== undefined && h.y !== undefined) {
    app.view?.centerOn(h.x, h.y, Math.max(app.view.cam.scale, 2));
  }
}
