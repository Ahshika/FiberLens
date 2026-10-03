/**
 * Rule-based recognition of FTTH network elements in ordinary DWG content
 * (layer names, block names, attributes, nearby text). Turns a "dumb" drawing into
 * smart FTTH objects and cables without redrawing it.
 */
import RBush from 'rbush';
import { db, uid, type FtthKind, type CableCategory, type FtthObjectRow, type CableRow, type DetectRuleRow } from '../data/db';
import type { CadDoc } from '../cad/doc/CadDoc';
import type { Entity, Vec2, InsertEnt } from '../cad/model/types';
import { kindMeta } from './model';
import { entityLength } from '../cad/edit/measure';
import { pointInLoops } from '../cad/doc/CadDoc';
import { geometryOf } from '../cad/geom/tessellate';

export interface NodeRule { kind: FtthKind; pattern: string; on: ('insert' | 'polyline' | 'text' | 'circle')[]; enabled: boolean }
export interface CableRule { category: CableCategory | 'auto'; pattern: string; enabled: boolean }

export const DEFAULT_NODE_RULES: NodeRule[] = [
  { kind: 'OLT', pattern: '\\bOLT\\b|^CO$|central ?office|\\bPON\\b(?!port)', on: ['insert'], enabled: true },
  { kind: 'ODF', pattern: '\\bODF', on: ['insert'], enabled: true },
  { kind: 'FTB', pattern: '\\bFTB', on: ['insert'], enabled: true },
  { kind: 'FDT', pattern: 'x-?box|\\bFDT|cross ?connect|\\bFDB\\b', on: ['insert'], enabled: true },
  { kind: 'FDH', pattern: 'hub ?box|\\bFDH|\\bFDC\\b', on: ['insert'], enabled: true },
  { kind: 'Splitter', pattern: 'splitter|\\bSPL\\b', on: ['insert'], enabled: true },
  { kind: 'Closure', pattern: 'closure|branch ?box|\\bjoint|splice ?(box|enclosure)|\\bFOSC\\b', on: ['insert'], enabled: true },
  { kind: 'FAT', pattern: '\\bFAT|sub ?box|end ?box|quick ?odn|\\bNAP\\b|terminal ?box|\\bMST\\b', on: ['insert'], enabled: true },
  { kind: 'Cabinet', pattern: 'cabinet|\\bcab\\b|outdoor', on: ['insert'], enabled: true },
  { kind: 'Manhole', pattern: '\\bMH\\b|man ?hole|chamber', on: ['insert', 'polyline', 'circle'], enabled: true },
  { kind: 'Handhole', pattern: '\\bHH\\b|hand ?hole|\\bCH\\b', on: ['insert', 'polyline', 'circle'], enabled: true },
  { kind: 'Pole', pattern: '\\bpoles?\\b', on: ['insert', 'circle'], enabled: true },
  { kind: 'Building', pattern: 'building ?(id|no|number)?', on: ['text'], enabled: false },
  { kind: 'Customer', pattern: 'customer|subscriber|\\bONT\\b|\\busers?\\b', on: ['insert', 'text'], enabled: false },
];

export const DEFAULT_CABLE_RULES: CableRule[] = [
  { category: 'auto', pattern: '\\bFC\\s?\\d+|\\d+\\s?(F|FO|FC|C|core)\\b|ADSS|ABF|cable|\\bCBL|fib(er|re)|drop|feeder|fast ?connect|\\bOFC\\b', enabled: true },
  { category: 'duct', pattern: 'duct|pipe|conduit|micro ?duct|\\d+ ?way', enabled: true },
];

const CODE_ATTR_PRIORITY = [/^2?NAME$/i, /^3NAME$/i, /^(BOX)?NAME$/i, /^(ID|CODE|TAG|NO|NUMBER|LABEL)$/i, /^CO$/i, /^1NAME$/i];
const PARENT_ATTR = /^(1NAME|PARENT|FROM|UPSTREAM|FEED(ER)?|XBOX|X-BOX)$/i;
const CODE_TEXT = /^[A-Z]{1,5}[-_ ]?\d{1,5}[A-Z]?$|^[A-Z]\d+[A-Z]\d+[A-Z]\d+$/i;

export interface DetectOptions {
  scope: 'all' | 'view' | 'boundary';
  view?: { minX: number; minY: number; maxX: number; maxY: number };
  boundaryId?: number;
  nodeRules: NodeRule[];
  cableRules: CableRule[];
  /** connection tolerance in drawing units */
  tol: number;
  unitsPerMeter: number;
  projectId: string;
  mode: 'design' | 'asbuilt';
}

export interface DetectResult {
  objects: FtthObjectRow[];
  cables: CableRow[];
  counts: Record<string, number>;
  cableLengths: Record<string, number>;
  connected: number;
}

function fiberCountOf(name: string): number | null {
  const m = /FC\s?(\d+)|(\d+)\s*(?:F\b|FO\b|FC\b|C\b|-?\s*core)/i.exec(name);
  if (!m) return null;
  const n = parseInt(m[1] ?? m[2], 10);
  return n > 0 && n <= 1728 ? n : null;
}

function categoryOf(layer: string, fibers: number): CableCategory {
  if (/drop|fast ?connect|\b1 ?core|\b2 ?core/i.test(layer) || fibers <= 2) return 'drop';
  if (/feeder|\bF1\b/i.test(layer) || fibers >= 96) return 'feeder';
  return 'distribution';
}

function codeFromInsert(e: InsertEnt): { code?: string; parentRef?: string; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  for (const a of e.attribs ?? []) if (a.value?.trim()) attrs[a.tag] = a.value.trim();
  let code: string | undefined;
  for (const re of CODE_ATTR_PRIORITY) {
    const k = Object.keys(attrs).find((t) => re.test(t));
    if (k) { code = attrs[k]; break; }
  }
  if (!code) { const v = Object.values(attrs).find((x) => CODE_TEXT.test(x)); if (v) code = v; }
  const pk = Object.keys(attrs).find((t) => PARENT_ATTR.test(t) && attrs[t] !== code);
  return { code, parentRef: pk ? attrs[pk] : undefined, attrs };
}

function centroid(e: Entity): Vec2 | null {
  if ('p' in e && (e as any).p) return (e as any).p;
  if (e.type === 'circle') return e.c;
  if (e.type === 'polyline') {
    let x = 0, y = 0; const n = e.pts.length / 2;
    for (let i = 0; i < e.pts.length; i += 2) { x += e.pts[i]; y += e.pts[i + 1]; }
    return { x: x / n, y: y / n };
  }
  return null;
}

function endpoints(e: Entity): [Vec2, Vec2] | null {
  if (e.type === 'line') return [e.p1, e.p2];
  if (e.type === 'polyline' && !e.closed && e.pts.length >= 4) return [{ x: e.pts[0], y: e.pts[1] }, { x: e.pts[e.pts.length - 2], y: e.pts[e.pts.length - 1] }];
  if (e.type === 'arc') return [{ x: e.c.x + Math.cos(e.a0) * e.r, y: e.c.y + Math.sin(e.a0) * e.r }, { x: e.c.x + Math.cos(e.a1) * e.r, y: e.c.y + Math.sin(e.a1) * e.r }];
  return null;
}

export function detectFtth(doc: CadDoc, o: DetectOptions): DetectResult {
  const nodeRules = o.nodeRules.filter((r) => r.enabled).map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
  const cableRules = o.cableRules.filter((r) => r.enabled).map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
  let inScope: (p: Vec2) => boolean = () => true;
  if (o.scope === 'view' && o.view) { const v = o.view; inScope = (p) => p.x >= v.minX && p.x <= v.maxX && p.y >= v.minY && p.y <= v.maxY; }
  if (o.scope === 'boundary' && o.boundaryId !== undefined) {
    const b = doc.get(o.boundaryId);
    const loop = b ? geometryOf(b).paths[0]?.pts : null;
    if (loop) inScope = (p) => pointInLoops(p, [loop]);
  }
  const objects: FtthObjectRow[] = [];
  const cables: CableRow[] = [];
  const counts: Record<string, number> = {};
  const cableLengths: Record<string, number> = {};
  const seq: Record<string, number> = {};
  const now = Date.now();
  const texts: { p: Vec2; v: string; layer: string }[] = [];

  for (const e of doc.all()) {
    if (!doc.isVisible(e)) continue;
    if (e.type === 'text' || e.type === 'mtext') { const v = e.value.replace(/\\P/g, ' ').replace(/\{[^}]*;|[{}]/g, '').trim(); if (v) texts.push({ p: e.p, v, layer: e.layer }); }
    // ---- nodes ----
    const kindKey = e.type === 'insert' ? 'insert' : e.type === 'polyline' && e.closed ? 'polyline' : e.type === 'text' || e.type === 'mtext' ? 'text' : e.type === 'circle' ? 'circle' : null;
    if (kindKey) {
      const rule = nodeRules.find((r) => r.on.includes(kindKey as any) && (r.re.test(e.layer) || (e.type === 'insert' && r.re.test(e.block))));
      if (rule) {
        const c = centroid(e);
        if (c && inScope(c)) {
          let code: string | undefined, parentRef: string | undefined, attrs: Record<string, string> = {};
          if (e.type === 'insert') ({ code, parentRef, attrs } = codeFromInsert(e));
          if ((e.type === 'text' || e.type === 'mtext')) code = e.value.trim().slice(0, 40);
          objects.push({
            id: uid(), projectId: o.projectId, kind: rule.kind, code: code ?? '', status: 'installed',
            props: { auto: true, source: e.type === 'insert' ? e.block : e.layer, layer: e.layer, ...attrs, ...(parentRef ? { parentRef } : {}) },
            cad: { entityId: e.id, handle: e.handle, x: c.x, y: c.y }, mode: o.mode, createdAt: now, updatedAt: now,
          });
          counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
          continue;
        }
      }
    }
    // ---- cables / ducts ----
    if (e.type === 'polyline' || e.type === 'line' || e.type === 'arc' || e.type === 'spline') {
      if (e.type === 'polyline' && e.closed) continue;
      const rule = cableRules.find((r) => r.re.test(e.layer));
      if (!rule) continue;
      const ends = endpoints(e);
      const c = ends ? { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 } : centroid(e);
      if (!c || !inScope(ends?.[0] ?? c)) continue;
      const len = (entityLength(e) ?? 0) / o.unitsPerMeter;
      if (len < 0.2) continue;
      const fibers = fiberCountOf(e.layer) ?? (rule.category === 'duct' ? 0 : 12);
      const category: CableCategory = rule.category === 'auto' ? categoryOf(e.layer, fibers) : rule.category;
      const prefix = category === 'duct' || category === 'conduit' ? 'D' : category === 'drop' ? 'DR' : 'F';
      seq[prefix] = (seq[prefix] ?? 0) + 1;
      cables.push({
        id: uid(), projectId: o.projectId, code: `${prefix}-${String(seq[prefix]).padStart(4, '0')}`, category, fiberCount: fibers,
        cad: { entityId: e.id, handle: e.handle }, lengthMode: 'auto', length: +len.toFixed(2), slack: 0, status: 'installed',
        props: { auto: true, layer: e.layer, fiberAssumed: fiberCountOf(e.layer) === null && category !== 'duct' }, mode: o.mode, createdAt: now, updatedAt: now,
      });
      const key = category === 'duct' || category === 'conduit' ? category : `${fibers}F ${category}`;
      cableLengths[key] = (cableLengths[key] ?? 0) + len;
    }
  }

  // ---- codes for objects without attributes: nearest short text ----
  const ttree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; i: number }>();
  ttree.load(texts.map((t, i) => ({ minX: t.p.x, minY: t.p.y, maxX: t.p.x, maxY: t.p.y, i })));
  const r = 6 * o.unitsPerMeter;
  for (const ob of objects) {
    if (ob.code) continue;
    const near = ttree.search({ minX: ob.cad.x - r, minY: ob.cad.y - r, maxX: ob.cad.x + r, maxY: ob.cad.y + r })
      .map((h) => texts[h.i]).filter((t) => CODE_TEXT.test(t.v))
      .sort((a, b) => Math.hypot(a.p.x - ob.cad.x, a.p.y - ob.cad.y) - Math.hypot(b.p.x - ob.cad.x, b.p.y - ob.cad.y));
    if (near[0]) ob.code = near[0].v;
  }
  // unique / auto codes
  const used = new Map<string, number>();
  for (const ob of objects) {
    const prefix = kindMeta(ob.kind).prefix;
    if (!ob.code) { seq[prefix] = (seq[prefix] ?? 0) + 1; ob.code = `${prefix}-${String(seq[prefix]).padStart(3, '0')}`; }
    const k = ob.kind + '|' + ob.code;
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    if (n > 0) { ob.props.duplicateOf = ob.code; ob.code = `${ob.code}#${n + 1}`; }
  }

  // ---- parents by attribute reference (e.g. FAT.1NAME = X25 → X-BOX X25) ----
  const byCode = new Map<string, FtthObjectRow>();
  for (const ob of objects) if (!byCode.has(ob.code.toLowerCase())) byCode.set(ob.code.toLowerCase(), ob);
  for (const ob of objects) {
    const ref = ob.props.parentRef as string | undefined;
    if (!ref) continue;
    const p = byCode.get(ref.toLowerCase());
    if (p && p.id !== ob.id && kindMeta(p.kind).level <= kindMeta(ob.kind).level) ob.parentId = p.id;
  }

  // ---- connect cable ends to nodes ----
  const ntree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; ob: FtthObjectRow }>();
  ntree.load(objects.filter((x) => x.kind !== 'Building').map((ob) => ({ minX: ob.cad.x, minY: ob.cad.y, maxX: ob.cad.x, maxY: ob.cad.y, ob })));
  let connected = 0;
  const nearestNode = (p: Vec2): FtthObjectRow | null => {
    let best: FtthObjectRow | null = null, bd = Infinity;
    for (const h of ntree.search({ minX: p.x - o.tol, minY: p.y - o.tol, maxX: p.x + o.tol, maxY: p.y + o.tol })) {
      const d = Math.hypot(h.ob.cad.x - p.x, h.ob.cad.y - p.y);
      if (d < bd) { bd = d; best = h.ob; }
    }
    return best;
  };
  for (const c of cables) {
    if (c.category === 'duct' || c.category === 'conduit') continue;
    const e = doc.get(c.cad.entityId!);
    const ends = e ? endpoints(e) : null;
    if (!ends) continue;
    const a = nearestNode(ends[0]), b = nearestNode(ends[1]);
    if (a && b && a.id === b.id) continue;
    // upstream = lower hierarchy level
    let from = a, to = b;
    if (a && b && kindMeta(b.kind).level < kindMeta(a.kind).level) { from = b; to = a; }
    if (!a && b) { from = null; to = b; }
    c.fromId = from?.id; c.toId = to?.id;
    if (c.fromId || c.toId) connected++;
  }
  return { objects, cables, counts, cableLengths, connected };
}

/** replace previously auto-detected rows with a new detection result */
export async function applyDetection(projectId: string, r: DetectResult) {
  await db.transaction('rw', db.ftthObjects, db.cables, db.cores, async () => {
    const oldObjs = await db.ftthObjects.where('projectId').equals(projectId).filter((x) => !!x.props?.auto).primaryKeys();
    const oldCabs = await db.cables.where('projectId').equals(projectId).filter((x) => !!x.props?.auto).primaryKeys();
    await db.ftthObjects.bulkDelete(oldObjs);
    await db.cables.bulkDelete(oldCabs);
    for (const c of oldCabs) await db.cores.where('cableId').equals(c).delete();
    await db.ftthObjects.bulkPut(r.objects);
    await db.cables.bulkPut(r.cables);
  });
}

export async function loadRules(projectId: string): Promise<{ nodes: NodeRule[]; cables: CableRule[] }> {
  const row = await db.detectRules.get('rules:' + projectId) as (DetectRuleRow & { data?: any }) | undefined;
  if (row && (row as any).data) return (row as any).data;
  return { nodes: DEFAULT_NODE_RULES.map((r) => ({ ...r })), cables: DEFAULT_CABLE_RULES.map((r) => ({ ...r })) };
}

export async function saveRules(projectId: string, data: { nodes: NodeRule[]; cables: CableRule[] }) {
  await db.detectRules.put({ id: 'rules:' + projectId, projectId, kind: 'cable', enabled: true, order: 0, data } as any);
}
