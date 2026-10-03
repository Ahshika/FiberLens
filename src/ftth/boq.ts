import { useFtth } from './store';
import { KINDS, cableTypeLabel } from './model';
import { db } from '../data/db';
import { app } from '../app/controller';
import { entityLength } from '../cad/edit/measure';

export interface BoqRow { section: string; item: string; unit: string; qty: number; notes?: string }

/** Bill of quantities from the FTTH model (with a CAD-layer takeoff as a complement). */
export async function computeBoq(projectId: string, opts: { includeCad?: boolean; mode?: 'design' | 'asbuilt' | 'all' } = {}): Promise<BoqRow[]> {
  const s = useFtth.getState();
  const mode = opts.mode ?? 'all';
  const rows: BoqRow[] = [];
  const keep = (m?: string) => mode === 'all' || !m || m === mode;
  // cables & ducts
  const cab = new Map<string, { len: number; n: number; slack: number }>();
  for (const c of s.cables.values()) {
    if (!keep(c.mode) || c.status === 'removed') continue;
    const k = cableTypeLabel(c.category, c.fiberCount);
    const v = cab.get(k) ?? { len: 0, n: 0, slack: 0 };
    v.len += c.length || 0; v.slack += c.slack || 0; v.n++;
    cab.set(k, v);
  }
  for (const [k, v] of [...cab.entries()].sort()) {
    rows.push({ section: /duct|conduit/i.test(k) ? 'Ducts & conduits' : 'Fiber cables', item: k, unit: 'm', qty: +(v.len + v.slack).toFixed(1), notes: `${v.n} runs${v.slack ? `, incl. ${v.slack.toFixed(0)} m slack` : ''}` });
  }
  // nodes
  for (const km of KINDS) {
    let n = 0;
    for (const o of s.objects.values()) if (o.kind === km.kind && keep(o.mode) && o.status !== 'removed') n++;
    if (n) rows.push({ section: 'Network elements', item: km.label, unit: 'pcs', qty: n });
  }
  // splitters
  const spl = new Map<number, number>();
  for (const sp of s.splitters.values()) if (sp.status !== 'removed') spl.set(sp.ratio, (spl.get(sp.ratio) ?? 0) + 1);
  for (const [r, n] of [...spl.entries()].sort((a, b) => a[0] - b[0])) rows.push({ section: 'Splitters', item: `Splitter 1:${r}`, unit: 'pcs', qty: n });
  // splitters encoded as object props (e.g. detected closures 70:30)
  // cores
  const cores = await db.cores.where('projectId').equals(projectId).toArray();
  if (cores.length) {
    const by = new Map<string, number>();
    for (const c of cores) by.set(c.status, (by.get(c.status) ?? 0) + 1);
    for (const [st, n] of by) rows.push({ section: 'Fiber cores', item: `Cores ${st}`, unit: 'cores', qty: n });
  }
  if (opts.includeCad !== false && app.doc) rows.push(...cadTakeoff());
  return rows;
}

/** CAD-only takeoff: lengths per layer (curves) and block counts per block name */
export function cadTakeoff(): BoqRow[] {
  const doc = app.doc;
  if (!doc) return [];
  const upm = app.unitsPerMeter();
  const len = new Map<string, number>();
  const blocks = new Map<string, number>();
  for (const e of doc.all()) {
    if (!doc.isVisible(e)) continue;
    if (e.type === 'insert') { const k = `${e.block} (${e.layer})`; blocks.set(k, (blocks.get(k) ?? 0) + 1); continue; }
    const L = entityLength(e);
    if (L && e.type !== 'circle') len.set(e.layer, (len.get(e.layer) ?? 0) + L / upm);
  }
  const rows: BoqRow[] = [];
  for (const [k, v] of [...len.entries()].sort((a, b) => b[1] - a[1])) rows.push({ section: 'CAD takeoff · lengths by layer', item: k, unit: 'm', qty: +v.toFixed(1) });
  for (const [k, v] of [...blocks.entries()].sort((a, b) => b[1] - a[1])) rows.push({ section: 'CAD takeoff · blocks', item: k, unit: 'pcs', qty: v });
  return rows;
}
