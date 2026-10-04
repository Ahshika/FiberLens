import RBush from 'rbush';
import type { Drawing, Entity, Layer, BlockDef, Vec2, LineTypeDef } from '../model/types';
import { BoxCache, boxValid, type BBox } from '../geom/bbox';
import { worldGeometry } from '../geom/bbox';
import type { Geometry } from '../geom/tessellate';
import { textCorners } from '../geom/tessellate';
import { distToSeg } from '../geom/vec';

interface IndexItem extends BBox { id: number }

export interface Transaction {
  label: string;
  added: Entity[];
  removed: Entity[];
  modified: { before: Entity; after: Entity }[];
  layers?: { before: Layer[]; after: Layer[] };
  blocks?: { name: string; before: BlockDef | null; after: BlockDef | null }[];
  lineTypes?: { before: LineTypeDef[]; after: LineTypeDef[] };
  at: number;
}

export interface ChangeSet {
  added: number[];
  removed: number[];
  modified: number[];
  /** bboxes (old and new) that need re-rendering */
  dirty: BBox[];
  layers: boolean;
  blocks: boolean;
  full?: boolean;
}

type Listener = (c: ChangeSet) => void;

const clone = <T,>(o: T): T => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/**
 * Live, editable drawing. All mutations go through transactions so they can be
 * undone, journaled, synced and rendered incrementally.
 */
export class CadDoc {
  drawing: Drawing;
  private ents = new Map<number, Entity>();
  private boxes = new Map<number, BBox>();
  private geoms = new Map<number, Geometry>();
  private tree = new RBush<IndexItem>(16);
  private items = new Map<number, IndexItem>();
  boxCache: BoxCache;
  layerMap = new Map<string, Layer>();
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private listeners = new Set<Listener>();
  private commitListeners = new Set<(t: Transaction, kind: 'do' | 'undo' | 'redo') => void>();
  /** permission hook: return an error message to refuse a transaction */
  guard: ((t: Omit<Transaction, 'at'>) => string | null) | null = null;
  onRefused: ((msg: string) => void) | null = null;
  /** layer used for new entities */
  currentLayer = '0';
  dirty = false;

  constructor(drawing: Drawing) {
    this.drawing = drawing;
    this.boxCache = new BoxCache(drawing.blocks);
    this.rebuild();
  }

  private rebuild() {
    this.ents.clear(); this.boxes.clear(); this.geoms.clear(); this.items.clear();
    this.layerMap = new Map(this.drawing.layers.map((l) => [l.name, l]));
    const items: IndexItem[] = [];
    for (const e of this.drawing.entities) {
      this.ents.set(e.id, e);
      const b = this.boxCache.entityBox(e);
      if (!boxValid(b)) continue;
      this.boxes.set(e.id, b);
      const it = { ...b, id: e.id };
      items.push(it);
      this.items.set(e.id, it);
    }
    this.tree.clear();
    this.tree.load(items);
  }

  // ---------- queries ----------
  get size() { return this.ents.size; }
  get(id: number) { return this.ents.get(id); }
  all(): IterableIterator<Entity> { return this.ents.values(); }
  ids(): number[] { return [...this.ents.keys()]; }
  box(id: number) { return this.boxes.get(id); }
  layer(name: string) { return this.layerMap.get(name); }
  get blocks() { return this.drawing.blocks; }

  geometry(id: number): Geometry | undefined {
    let g = this.geoms.get(id);
    if (!g) {
      const e = this.ents.get(id);
      if (!e) return undefined;
      g = worldGeometry(e, this.drawing.blocks);
      if (this.geoms.size > 20000) this.geoms.clear();
      this.geoms.set(id, g);
    }
    return g;
  }

  isEditable(e: Entity): boolean {
    const l = this.layerMap.get(e.layer);
    return !l || (!l.locked);
  }
  isVisible(e: Entity): boolean {
    const l = this.layerMap.get(e.layer);
    return !e.invisible && (!l || (l.on && !l.frozen));
  }

  search(b: BBox): number[] { return this.tree.search(b).map((i) => i.id); }

  /** nearest visible entity to p within tol (world units) */
  pick(p: Vec2, tol: number, filter?: (e: Entity) => boolean): number | null {
    const cands = this.tree.search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol });
    let best: number | null = null, bestD = Infinity, bestArea = Infinity;
    for (const c of cands) {
      const e = this.ents.get(c.id);
      if (!e || !this.isVisible(e)) continue;
      if (filter && !filter(e)) continue;
      const d = this.distanceTo(c.id, p, tol);
      const area = (c.maxX - c.minX) * (c.maxY - c.minY);
      // prefer closer; ties → smaller entity (so texts/blocks win over big polylines)
      if (d <= tol && (d < bestD - tol * 0.05 || (Math.abs(d - bestD) <= tol * 0.05 && area < bestArea))) {
        best = c.id; bestD = d; bestArea = area;
      }
    }
    return best;
  }

  distanceTo(id: number, p: Vec2, tol = Infinity): number {
    const g = this.geometry(id);
    if (!g) return Infinity;
    let best = Infinity;
    for (const path of g.paths) {
      const a = path.pts;
      if (a.length === 2 || (a.length === 4 && a[0] === a[2] && a[1] === a[3])) {
        best = Math.min(best, Math.hypot(p.x - a[0], p.y - a[1]));
        continue;
      }
      for (let i = 0; i + 3 < a.length; i += 2) {
        const d = distToSeg(p.x, p.y, a[i], a[i + 1], a[i + 2], a[i + 3]);
        if (d < best) best = d;
      }
      if (path.closed && a.length >= 4) best = Math.min(best, distToSeg(p.x, p.y, a[a.length - 2], a[a.length - 1], a[0], a[1]));
    }
    for (const f of [...g.fills, ...(g.masks ?? [])]) {
      if (pointInLoops(p, f)) return 0;
      for (const l of f) for (let i = 0; i < l.length; i += 2) {
        const j = (i + 2) % l.length;
        best = Math.min(best, distToSeg(p.x, p.y, l[i], l[i + 1], l[j], l[j + 1]));
      }
    }
    for (const t of g.texts) {
      const c = textCorners(t);
      if (pointInLoops(p, [c])) return 0;
    }
    return best;
  }

  // ---------- events ----------
  onChange(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onCommit(l: (t: Transaction, kind: 'do' | 'undo' | 'redo') => void) { this.commitListeners.add(l); return () => this.commitListeners.delete(l); }
  private emit(c: ChangeSet) { for (const l of this.listeners) l(c); }

  // ---------- low-level application ----------
  private indexEntity(e: Entity, dirty: BBox[]) {
    const old = this.items.get(e.id);
    if (old) { this.tree.remove(old); dirty.push(old); this.items.delete(e.id); }
    this.geoms.delete(e.id);
    const b = this.boxCache.entityBox(e);
    if (boxValid(b)) {
      const it = { ...b, id: e.id };
      this.tree.insert(it);
      this.items.set(e.id, it);
      this.boxes.set(e.id, b);
      dirty.push(b);
    } else this.boxes.delete(e.id);
  }

  private unindexEntity(id: number, dirty: BBox[]) {
    const old = this.items.get(id);
    if (old) { this.tree.remove(old); dirty.push(old); this.items.delete(id); }
    this.boxes.delete(id);
    this.geoms.delete(id);
  }

  private apply(t: Transaction, reverse: boolean): ChangeSet {
    const cs: ChangeSet = { added: [], removed: [], modified: [], dirty: [], layers: false, blocks: false };
    const added = reverse ? t.removed : t.added;
    const removed = reverse ? t.added : t.removed;
    if (t.layers) {
      this.drawing.layers = clone(reverse ? t.layers.before : t.layers.after);
      this.layerMap = new Map(this.drawing.layers.map((l) => [l.name, l]));
      cs.layers = true;
    }
    if (t.lineTypes) {
      this.drawing.lineTypes = clone(reverse ? t.lineTypes.before : t.lineTypes.after);
      cs.layers = true;
    }
    if (t.blocks) {
      for (const b of t.blocks) {
        const v = reverse ? b.before : b.after;
        if (v) this.drawing.blocks[b.name] = clone(v); else delete this.drawing.blocks[b.name];
      }
      this.boxCache.invalidateBlocks();
      cs.blocks = true;
    }
    for (const e of removed) {
      if (!this.ents.has(e.id)) continue;
      this.ents.delete(e.id);
      this.unindexEntity(e.id, cs.dirty);
      cs.removed.push(e.id);
    }
    for (const m of t.modified) {
      const e = clone(reverse ? m.before : m.after);
      this.ents.set(e.id, e);
      this.indexEntity(e, cs.dirty);
      cs.modified.push(e.id);
    }
    for (const e0 of added) {
      const e = clone(e0);
      this.ents.set(e.id, e);
      this.indexEntity(e, cs.dirty);
      cs.added.push(e.id);
      if (e.id >= this.drawing.nextId) this.drawing.nextId = e.id + 1;
    }
    if (cs.blocks) {
      // inserts of changed blocks must be re-indexed
      const names = new Set(t.blocks!.map((b) => b.name));
      for (const e of this.ents.values()) {
        if (e.type === 'insert' && names.has(e.block)) { this.indexEntity(e, cs.dirty); cs.modified.push(e.id); }
      }
    }
    this.syncDrawingEntities();
    this.dirty = true;
    return cs;
  }

  /** keep drawing.entities in sync (draw order = map order) */
  private syncDrawingEntities() { this.drawing.entities = [...this.ents.values()]; }

  // ---------- transactions ----------
  newId(): number { return this.drawing.nextId++; }

  commit(t: Omit<Transaction, 'at'>): ChangeSet | null {
    if (!t.added.length && !t.removed.length && !t.modified.length && !t.layers && !t.blocks && !t.lineTypes) return null;
    const refusal = this.guard?.(t);
    if (refusal) { this.onRefused?.(refusal); return null; }
    const tx: Transaction = { ...clone(t), at: Date.now() };
    const cs = this.apply(tx, false);
    this.undoStack.push(tx);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit(cs);
    for (const l of this.commitListeners) l(tx, 'do');
    return cs;
  }

  add(entities: Entity[], label = 'Add') { return this.commit({ label, added: entities, removed: [], modified: [] }); }
  remove(ids: number[], label = 'Delete') {
    const removed = ids.map((id) => this.ents.get(id)).filter(Boolean) as Entity[];
    return this.commit({ label, added: [], removed, modified: [] });
  }
  /** replace entities with modified copies (same ids) */
  modify(after: Entity[], label = 'Modify') {
    const modified = after.filter((a) => this.ents.has(a.id)).map((a) => ({ before: this.ents.get(a.id)!, after: a }));
    return this.commit({ label, added: [], removed: [], modified });
  }
  setLayers(layers: Layer[], label = 'Layers', extra?: Partial<Omit<Transaction, 'at' | 'label'>>) {
    return this.commit({ label, added: [], removed: [], modified: [], ...extra, layers: { before: this.drawing.layers, after: layers } });
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }

  undo() {
    if (this.guard?.({ label: 'Undo', added: [], removed: [], modified: [] })) { this.onRefused?.('Read-only'); return; }
    const t = this.undoStack.pop();
    if (!t) return;
    const cs = this.apply(t, true);
    this.redoStack.push(t);
    this.emit(cs);
    for (const l of this.commitListeners) l(t, 'undo');
  }
  redo() {
    const t = this.redoStack.pop();
    if (!t) return;
    const cs = this.apply(t, false);
    this.undoStack.push(t);
    this.emit(cs);
    for (const l of this.commitListeners) l(t, 'redo');
  }

  /** replay journaled transactions after loading a snapshot (no undo history) */
  replay(t: Transaction, kind: 'do' | 'undo' | 'redo') {
    const cs = this.apply(t, kind === 'undo');
    this.emit(cs);
  }

  /** notify a non-transactional visual change (e.g. layer display state) */
  touchLayers() {
    this.layerMap = new Map(this.drawing.layers.map((l) => [l.name, l]));
    this.emit({ added: [], removed: [], modified: [], dirty: [], layers: true, blocks: false });
  }

  clearHistory() { this.undoStack = []; this.redoStack = []; }
  snapshot(): Drawing { this.syncDrawingEntities(); return clone(this.drawing); }
  /** the live drawing (no copy) — read-only use: serialisation, export, diff */
  live(): Drawing { this.syncDrawingEntities(); return this.drawing; }
}

export function pointInLoops(p: Vec2, loops: number[][]): boolean {
  let inside = false;
  for (const l of loops) {
    const n = l.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = l[i * 2], yi = l[i * 2 + 1], xj = l[j * 2], yj = l[j * 2 + 1];
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
