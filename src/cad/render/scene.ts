import earcut from 'earcut';
import RBush from 'rbush';
import type { Entity, Layer, LineTypeDef } from '../model/types';
import type { CadDoc, ChangeSet } from '../doc/CadDoc';
import { geometryOf, transformGeom, textCorners, type Geometry, type TextItem } from '../geom/tessellate';
import { walkInsert, resolveStyle, type InheritedStyle } from '../geom/blocks';
import { aciToRgb } from '../model/color';
import { boxAddPts, boxValid, emptyBox, type BBox } from '../geom/bbox';
import { IDENTITY } from '../geom/vec';

/** Segment instance layout (36 bytes) */
export const SEG_STRIDE = 36;
/** Triangle vertex layout (16 bytes) */
export const TRI_STRIDE = 16;

export const F_COLOR_BYLAYER = 1;
export const F_ALPHA_BYLAYER = 2;
export const F_FG = 4; // ACI 7: foreground colour (white on dark, black on light)
export const F_LT_BYLAYER = 8;
export const F_POINT = 16;
export const F_MASK = 32; // paint background colour
export const LW_BYLAYER = 0xffff;
export const LW_DEFAULT = 0xfffe;

export interface TextRec extends BBox {
  item: TextItem;
  color: number;
  flags: number;
  alpha: number;
  layer: number;
  entityId: number;
  chunk: string;
}

export interface FillPoly { loops: Float32Array[]; color: number; alpha: number; flags: number; layer: number }

export interface Chunk {
  key: string;
  ox: number;
  oy: number;
  ids: Set<number>;
  bbox: BBox;
  dirty: boolean;
  segData: ArrayBuffer | null;
  segCount: number;
  triData: ArrayBuffer | null;
  triCount: number;
  maskData: ArrayBuffer | null;
  maskCount: number;
  texts: TextRec[];
  /** fill polygons (chunk-relative) for the Canvas fallback renderer */
  polys: FillPoly[];
  /** renderer-owned GPU resources */
  gpu?: any;
  gpuVersion: number;
  version: number;
}

class GrowBuf {
  buf: ArrayBuffer;
  f32: Float32Array;
  u8: Uint8Array;
  u16: Uint16Array;
  len = 0; // bytes
  constructor(bytes = 1 << 16) { this.buf = new ArrayBuffer(bytes); this.f32 = new Float32Array(this.buf); this.u8 = new Uint8Array(this.buf); this.u16 = new Uint16Array(this.buf); }
  ensure(extra: number) {
    if (this.len + extra <= this.buf.byteLength) return;
    let n = this.buf.byteLength * 2;
    while (n < this.len + extra) n *= 2;
    const nb = new ArrayBuffer(n);
    new Uint8Array(nb).set(this.u8.subarray(0, this.len));
    this.buf = nb; this.f32 = new Float32Array(nb); this.u8 = new Uint8Array(nb); this.u16 = new Uint16Array(nb);
  }
  take(): ArrayBuffer { return this.buf.slice(0, this.len); }
}

interface PrimStyle { color: number; flags: number; alpha: number; layer: number; lt: number; ltScale: number; lw: number }

/** Name → index tables for layers and linetypes (mirrored into GPU textures). */
export class StyleTables {
  layerIndex = new Map<string, number>();
  layers: Layer[] = [];
  ltIndex = new Map<string, number>();
  lineTypes: LineTypeDef[] = [];
  version = 0;

  sync(layers: Layer[], lineTypes: LineTypeDef[]) {
    // keep existing indices stable, append new names
    for (const l of layers) if (!this.layerIndex.has(l.name)) this.layerIndex.set(l.name, this.layerIndex.size);
    this.layers = [];
    for (const l of layers) this.layers[this.layerIndex.get(l.name)!] = l;
    if (!this.ltIndex.size) this.ltIndex.set('continuous', 0);
    for (const lt of lineTypes) {
      const k = lt.name.toLowerCase();
      if (!this.ltIndex.has(k)) this.ltIndex.set(k, this.ltIndex.size);
    }
    this.lineTypes = [];
    for (const lt of lineTypes) this.lineTypes[this.ltIndex.get(lt.name.toLowerCase())!] = lt;
    this.version++;
  }
  layerIdx(name: string): number {
    let i = this.layerIndex.get(name);
    if (i === undefined) { i = this.layerIndex.size; this.layerIndex.set(name, i); }
    return i;
  }
  ltIdx(name: string): number {
    return this.ltIndex.get(name.toLowerCase()) ?? 0;
  }
}

/** Builds and maintains chunked GPU-ready buffers for a CadDoc. */
export class Scene {
  chunks = new Map<string, Chunk>();
  entityChunk = new Map<number, string>();
  textTree = new RBush<TextRec>(16);
  styles = new StyleTables();
  cell = 1000;
  private dirtyQueue = new Set<string>();
  version = 0;
  /** entity ids temporarily hidden from GPU buffers (e.g. while being dragged) */
  hidden = new Set<number>();

  constructor(public doc: CadDoc) {
    this.styles.sync(doc.drawing.layers, doc.drawing.lineTypes);
    const m = doc.drawing.meta;
    const w = Math.max(m.extMax.x - m.extMin.x, m.extMax.y - m.extMin.y, 1);
    // ~24 cells across the main extents → a few thousand entities per chunk on big drawings
    this.cell = w / 24;
    for (const e of doc.all()) this.assign(e.id);
  }

  private keyFor(id: number): string | null {
    const b = this.doc.box(id);
    if (!b) return null;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return `${Math.floor(cx / this.cell)},${Math.floor(cy / this.cell)}`;
  }

  private assign(id: number) {
    const key = this.keyFor(id);
    if (!key) return;
    let c = this.chunks.get(key);
    if (!c) {
      const [ix, iy] = key.split(',').map(Number);
      c = {
        key, ox: (ix + 0.5) * this.cell, oy: (iy + 0.5) * this.cell, ids: new Set(), bbox: emptyBox(), dirty: true,
        segData: null, segCount: 0, triData: null, triCount: 0, maskData: null, maskCount: 0, texts: [], polys: [], gpuVersion: -1, version: 0,
      };
      this.chunks.set(key, c);
    }
    c.ids.add(id);
    this.entityChunk.set(id, key);
    this.markDirty(key);
  }

  private markDirty(key: string) {
    const c = this.chunks.get(key);
    if (c) { c.dirty = true; this.dirtyQueue.add(key); }
  }

  applyChange(cs: ChangeSet) {
    if (cs.layers) this.styles.sync(this.doc.drawing.layers, this.doc.drawing.lineTypes);
    for (const id of cs.removed) {
      const k = this.entityChunk.get(id);
      if (k) { this.chunks.get(k)?.ids.delete(id); this.entityChunk.delete(id); this.markDirty(k); }
    }
    for (const id of [...cs.modified, ...cs.added]) {
      const old = this.entityChunk.get(id);
      if (old) { this.chunks.get(old)?.ids.delete(id); this.markDirty(old); }
      this.assign(id);
    }
    this.version++;
  }

  invalidateAll() {
    for (const k of this.chunks.keys()) this.markDirty(k);
    this.version++;
  }

  setHidden(ids: Iterable<number>) {
    const next = new Set(ids);
    const touched = new Set<string>();
    for (const id of this.hidden) if (!next.has(id)) { const k = this.entityChunk.get(id); if (k) touched.add(k); }
    for (const id of next) if (!this.hidden.has(id)) { const k = this.entityChunk.get(id); if (k) touched.add(k); }
    this.hidden = next;
    for (const k of touched) this.markDirty(k);
  }

  get pending() { return this.dirtyQueue.size; }

  /**
   * Rebuild dirty chunks, visible ones first, within a time budget (ms).
   * Returns true if anything was rebuilt.
   */
  buildDirty(view: BBox | null, budgetMs = 12): boolean {
    if (!this.dirtyQueue.size) return false;
    const t0 = performance.now();
    let keys = [...this.dirtyQueue];
    if (view) {
      const vcx = (view.minX + view.maxX) / 2, vcy = (view.minY + view.maxY) / 2;
      keys.sort((a, b) => {
        const ca = this.chunks.get(a)!, cb = this.chunks.get(b)!;
        return Math.hypot(ca.ox - vcx, ca.oy - vcy) - Math.hypot(cb.ox - vcx, cb.oy - vcy);
      });
    }
    let built = false;
    for (const k of keys) {
      const c = this.chunks.get(k);
      this.dirtyQueue.delete(k);
      if (!c) continue;
      this.buildChunk(c);
      built = true;
      if (performance.now() - t0 > budgetMs) break;
    }
    return built;
  }

  buildAllSync() { while (this.dirtyQueue.size) this.buildDirty(null, 1e9); }

  private resolvePrim(st: InheritedStyle, isPoint = false): PrimStyle {
    let color = 0xffffff, flags = 0;
    if (st.rgb !== undefined) color = st.rgb;
    else {
      const aci = st.aci ?? 256;
      if (aci === 256) flags |= F_COLOR_BYLAYER;
      else if (aci === 7 || aci === 0) flags |= F_FG;
      else color = aciToRgb(aci);
    }
    let alpha = 255;
    if (st.transparency === undefined) flags |= F_ALPHA_BYLAYER;
    else alpha = Math.round((1 - st.transparency) * 255);
    let lt = 0;
    const ltn = st.lineType;
    if (!ltn || /^bylayer$/i.test(ltn)) flags |= F_LT_BYLAYER;
    else lt = this.styles.ltIdx(ltn);
    let lw = LW_BYLAYER;
    const w = st.lineWeight;
    if (w === undefined || w === -1) lw = LW_BYLAYER;
    else if (w === -3 || w === -2 || w === -4) lw = LW_DEFAULT;
    else lw = Math.max(0, w);
    if (isPoint) flags |= F_POINT;
    return { color, flags, alpha, layer: this.styles.layerIdx(st.layer), lt, ltScale: 1, lw };
  }

  private buildChunk(c: Chunk) {
    const seg = new GrowBuf(Math.max(1024, c.ids.size * 200));
    const tri = new GrowBuf(1024);
    const mask = new GrowBuf(256);
    // remove old texts from tree
    for (const t of c.texts) this.textTree.remove(t);
    c.texts = [];
    c.polys = [];
    const bbox = emptyBox();
    const ltScaleGlobal = this.doc.drawing.meta.ltScale || 1;
    const blocks = this.doc.blocks;

    const emitGeom = (g: Geometry, ps: PrimStyle, entityId: number) => {
      for (const p of g.paths) {
        const a = p.pts;
        boxAddPts(bbox, a);
        if (a.length === 2 || (a.length === 4 && a[0] === a[2] && a[1] === a[3])) {
          this.pushSeg(seg, c, a[0], a[1], a[0], a[1], 0, { ...ps, flags: ps.flags | F_POINT });
          continue;
        }
        let dist = 0;
        const n = a.length;
        for (let i = 0; i + 3 < n; i += 2) {
          this.pushSeg(seg, c, a[i], a[i + 1], a[i + 2], a[i + 3], dist, ps);
          dist += Math.hypot(a[i + 2] - a[i], a[i + 3] - a[i + 1]);
        }
        if (p.closed && n >= 6) this.pushSeg(seg, c, a[n - 2], a[n - 1], a[0], a[1], dist, ps);
      }
      for (const f of g.fills) {
        this.pushFill(tri, c, f, ps);
        for (const l of f) boxAddPts(bbox, l);
        c.polys.push({ loops: f.map((l) => { const a = new Float32Array(l.length); for (let i = 0; i < l.length; i += 2) { a[i] = l[i] - c.ox; a[i + 1] = l[i + 1] - c.oy; } return a; }), color: ps.color, alpha: ps.alpha, flags: ps.flags, layer: ps.layer });
      }
      if (g.masks) for (const f of g.masks) { this.pushFill(mask, c, f, { ...ps, flags: ps.flags | F_MASK }); for (const l of f) boxAddPts(bbox, l); }
      for (const t of g.texts) {
        const corners = textCorners(t);
        const tb = emptyBox(); boxAddPts(tb, corners); boxAddPts(bbox, corners);
        if (t.bg !== undefined) {
          // background mask rectangle (scaled)
          const s = t.bgScale ?? 1.5;
          const cx = (corners[0] + corners[4]) / 2, cy = (corners[1] + corners[5]) / 2;
          const k = 1 + (s - 1) * 0.5;
          const loop = corners.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * k : cy + (v - cy) * k));
          this.pushFill(mask, c, [loop], { ...ps, flags: t.bg === -1 ? ps.flags | F_MASK : ps.flags & ~F_COLOR_BYLAYER & ~F_FG, color: t.bg === -1 ? 0 : t.bg, alpha: 255 });
        }
        const rec: TextRec = { ...tb, item: t, color: ps.color, flags: ps.flags, alpha: ps.alpha, layer: ps.layer, entityId, chunk: c.key };
        c.texts.push(rec);
      }
    };

    for (const id of c.ids) {
      if (this.hidden.has(id)) continue;
      const e = this.doc.get(id);
      if (!e || e.invisible) continue;
      const base = resolveStyle(e, null);
      if (e.type === 'insert' || (e.type === 'dimension' && e.block && blocks[e.block])) {
        walkInsert(e, blocks, (child, m, st) => {
          const g = m === IDENTITY ? geometryOf(child) : transformGeom(geometryOf(child), m);
          const ps = this.resolvePrim(st);
          ps.ltScale = (child.ltScale ?? 1) * (e.ltScale ?? 1) * ltScaleGlobal;
          emitGeom(g, ps, id);
        });
        if (e.type === 'insert' && e.attribs) {
          for (const a of e.attribs) {
            const ps = this.resolvePrim(resolveStyle(a, base));
            emitGeom(geometryOf(a), ps, id);
          }
        }
      } else {
        const ps = this.resolvePrim(base);
        ps.ltScale = (e.ltScale ?? 1) * ltScaleGlobal;
        emitGeom(geometryOf(e), ps, id);
      }
    }
    c.segData = seg.take(); c.segCount = seg.len / SEG_STRIDE;
    c.triData = tri.take(); c.triCount = tri.len / TRI_STRIDE;
    c.maskData = mask.take(); c.maskCount = mask.len / TRI_STRIDE;
    c.bbox = boxValid(bbox) ? bbox : emptyBox();
    if (c.texts.length) this.textTree.load(c.texts);
    c.dirty = false;
    c.version++;
  }

  private pushSeg(b: GrowBuf, c: Chunk, x1: number, y1: number, x2: number, y2: number, dist: number, ps: PrimStyle) {
    b.ensure(SEG_STRIDE);
    const o = b.len;
    const f = o >> 2, h = o >> 1;
    b.f32[f] = x1 - c.ox; b.f32[f + 1] = y1 - c.oy; b.f32[f + 2] = x2 - c.ox; b.f32[f + 3] = y2 - c.oy;
    b.f32[f + 4] = dist; b.f32[f + 5] = ps.ltScale;
    b.u8[o + 24] = (ps.color >> 16) & 255; b.u8[o + 25] = (ps.color >> 8) & 255; b.u8[o + 26] = ps.color & 255; b.u8[o + 27] = ps.alpha;
    b.u16[h + 14] = ps.layer; b.u16[h + 15] = ps.lt; b.u16[h + 16] = ps.lw; b.u16[h + 17] = ps.flags;
    b.len += SEG_STRIDE;
  }

  private pushFill(b: GrowBuf, c: Chunk, loops: number[][], ps: PrimStyle) {
    for (const poly of groupLoops(loops)) {
      const flat: number[] = [];
      const holes: number[] = [];
      poly.forEach((l, i) => {
        if (i > 0) holes.push(flat.length / 2);
        for (let k = 0; k < l.length; k += 2) flat.push(l[k] - c.ox, l[k + 1] - c.oy);
      });
      let idx: number[];
      try { idx = earcut(flat, holes.length ? holes : undefined); } catch { continue; }
      b.ensure(idx.length * TRI_STRIDE);
      for (const i of idx) {
        const o = b.len, f = o >> 2, h = o >> 1;
        b.f32[f] = flat[i * 2]; b.f32[f + 1] = flat[i * 2 + 1];
        b.u8[o + 8] = (ps.color >> 16) & 255; b.u8[o + 9] = (ps.color >> 8) & 255; b.u8[o + 10] = ps.color & 255; b.u8[o + 11] = ps.alpha;
        b.u16[h + 6] = ps.layer; b.u16[h + 7] = ps.flags;
        b.len += TRI_STRIDE;
      }
    }
  }

  /** visible chunks for a view */
  visibleChunks(view: BBox): Chunk[] {
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) {
      if (!c.segCount && !c.triCount && !c.maskCount) continue;
      const b = c.bbox;
      if (b.minX <= view.maxX && b.maxX >= view.minX && b.minY <= view.maxY && b.maxY >= view.minY) out.push(c);
    }
    return out;
  }
}

function loopArea(l: number[]) {
  let a = 0;
  const n = l.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += l[j * 2] * l[i * 2 + 1] - l[i * 2] * l[j * 2 + 1];
  return a / 2;
}

function pointIn(x: number, y: number, l: number[]) {
  let inside = false;
  const n = l.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = l[i * 2], yi = l[i * 2 + 1], xj = l[j * 2], yj = l[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** group loops into polygons-with-holes using even-odd nesting depth */
export function groupLoops(loops: number[][]): number[][][] {
  if (loops.length <= 1) return loops.length ? [loops] : [];
  const sorted = loops.map((l) => ({ l, a: Math.abs(loopArea(l)) })).sort((a, b) => b.a - a.a);
  const polys: { outer: number[]; holes: number[][]; depth: number }[] = [];
  const depthOf: number[] = [];
  sorted.forEach((s, i) => {
    let depth = 0, parent = -1;
    for (let j = 0; j < i; j++) {
      if (pointIn(s.l[0], s.l[1], sorted[j].l)) { depth++; parent = j; }
    }
    depthOf.push(depth);
    if (depth % 2 === 0) polys.push({ outer: s.l, holes: [], depth });
    else {
      const p = polys.find((pp) => pp.outer === sorted[parent].l) ?? polys[polys.length - 1];
      p?.holes.push(s.l);
    }
  });
  return polys.map((p) => [p.outer, ...p.holes]);
}
