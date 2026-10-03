/**
 * FiberLens Drawing → DWG/DXF.
 *
 * When the original file is available the export is a *delta merge*: the original is re-read,
 * deleted entities are removed, modified entities are updated (in place when only properties
 * changed, otherwise replaced) and new entities are appended. Everything FiberLens does not model
 * (xdata, dictionaries, layouts, dimension styles, proxies…) survives untouched.
 */
import * as A from '@node-projects/acad-ts';
import type { Drawing, Entity, Layer as FLayer, BlockDef } from '../model/types';
import { readAcad } from './engine';
import { importCadDocument } from './acadImport';
import { geometryOf } from '../geom/tessellate';

export type ExportFormat = 'dwg' | 'dxf';
export interface ExportResult {
  bytes: Uint8Array;
  stats: { kept: number; modified: number; added: number; deleted: number; layers: number };
  warnings: string[];
}

const AA: any = A;

const xyz = (x: number, y: number, z = 0) => new AA.XYZ(x, y, z);
const xy = (x: number, y: number) => new AA.XY(x, y);

function mkColor(aci?: number, rgb?: number): any {
  if (rgb !== undefined) return new AA.Color((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
  if (aci === undefined || aci === 256) return AA.Color.byLayer;
  if (aci === 0) return AA.Color.byBlock;
  return new AA.Color(aci);
}

class Ctx {
  warnings: string[] = [];
  constructor(public doc: any) {}

  layer(name: string): any {
    let l = this.doc.layers.tryGetValue(name);
    if (!l) { l = new AA.Layer(name); this.doc.layers.add(l); }
    return l;
  }
  lineType(name: string | undefined): any {
    if (!name) return null;
    if (/^bylayer$/i.test(name)) return AA.LineType.byLayer ? this.doc.lineTypes.tryGetValue('ByLayer') : null;
    const lt = this.doc.lineTypes.tryGetValue(name);
    return lt ?? null;
  }
  block(name: string): any {
    return this.doc.blockRecords.tryGetValue(name) ?? null;
  }
}

function applyCommon(target: any, e: Entity, ctx: Ctx) {
  target.layer = ctx.layer(e.layer || '0');
  target.color = mkColor(e.aci, e.rgb);
  const lt = ctx.lineType(e.lineType);
  if (lt) target.lineType = lt;
  if (e.ltScale) target.lineTypeScale = e.ltScale;
  target.lineWeight = e.lineWeight ?? -1;
  if (e.transparency !== undefined) target.transparency = new AA.Transparency(Math.round(e.transparency * 100));
  if (e.invisible) target.isInvisible = true;
}

const HA: Record<string, number> = { left: 0, center: 1, right: 2, aligned: 3, middle: 4, fit: 5 };
const VA: Record<string, number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };

function textStyle(ctx: Ctx, name?: string) {
  if (!name) return null;
  return ctx.doc.textStyles?.tryGetValue(name) ?? null;
}

function fillText(t: any, e: any, ctx: Ctx) {
  t.value = e.value ?? '';
  t.insertPoint = xyz(e.p.x, e.p.y);
  t.alignmentPoint = xyz((e.p2 ?? e.p).x, (e.p2 ?? e.p).y);
  t.height = e.h;
  t.rotation = e.rot || 0;
  t.horizontalAlignment = HA[e.halign ?? 'left'] ?? 0;
  t.verticalAlignment = VA[e.valign ?? 'baseline'] ?? 0;
  if (e.widthFactor) t.widthFactor = e.widthFactor;
  if (e.oblique) t.obliqueAngle = e.oblique;
  const st = textStyle(ctx, e.style);
  if (st) t.style = st;
}

/** Create a new acad-ts entity (or several) from a FiberLens entity. */
export function toAcad(e: Entity, ctx: Ctx): any[] {
  const out: any[] = [];
  const push = (x: any) => { applyCommon(x, e, ctx); out.push(x); };
  switch (e.type) {
    case 'line': push(new AA.Line(xyz(e.p1.x, e.p1.y), xyz(e.p2.x, e.p2.y))); break;
    case 'polyline': {
      const pl = new AA.LwPolyline();
      const n = e.pts.length / 2;
      const verts: any[] = [];
      for (let i = 0; i < n; i++) {
        const v = new AA.LwPolylineVertex(xy(e.pts[i * 2], e.pts[i * 2 + 1]));
        v.bulge = e.bulges?.[i] ?? 0;
        if (e.widths) { v.startWidth = e.widths[i * 2] ?? 0; v.endWidth = e.widths[i * 2 + 1] ?? 0; }
        verts.push(v);
      }
      pl.vertices = verts;
      pl.isClosed = e.closed;
      if (e.width) pl.constantWidth = e.width;
      push(pl);
      break;
    }
    case 'circle': push(new AA.Circle(xyz(e.c.x, e.c.y), e.r)); break;
    case 'arc': push(new AA.Arc(xyz(e.c.x, e.c.y), e.r, e.a0, e.a1)); break;
    case 'ellipse': {
      const el = new AA.Ellipse();
      el.center = xyz(e.c.x, e.c.y); el.majorAxisEndPoint = xyz(e.major.x, e.major.y); el.radiusRatio = e.ratio;
      el.startParameter = e.t0; el.endParameter = e.t1;
      push(el);
      break;
    }
    case 'spline': {
      const sp = new AA.Spline();
      sp.degree = e.degree;
      const cp: any[] = [];
      for (let i = 0; i < e.ctrl.length; i += 2) cp.push(xyz(e.ctrl[i], e.ctrl[i + 1]));
      sp.controlPoints = cp;
      sp.knots = e.knots.slice();
      if (e.weights) sp.weights = e.weights.slice();
      if (e.fit) { const fp: any[] = []; for (let i = 0; i < e.fit.length; i += 2) fp.push(xyz(e.fit[i], e.fit[i + 1])); sp.fitPoints = fp; }
      if (e.closed) sp.isClosed = true;
      push(sp);
      break;
    }
    case 'text': { const t = new AA.TextEntity(); fillText(t, e, ctx); push(t); break; }
    case 'mtext': {
      const t = new AA.MText();
      t.value = e.value; t.insertPoint = xyz(e.p.x, e.p.y); t.height = e.h; t.rotation = e.rot || 0;
      t.rectangleWidth = e.width || 0; t.attachmentPoint = e.attach || 1;
      if (e.lineSpacing) t.lineSpacing = e.lineSpacing;
      const st = textStyle(ctx, e.style); if (st) t.style = st;
      if (e.bgFill !== undefined) {
        t.backgroundFillFlags = e.bgFill === -1 ? 3 : 1;
        if (e.bgFill !== -1) t.backgroundColor = mkColor(undefined, e.bgFill);
        t.backgroundScale = e.bgScale ?? 1.5;
      }
      push(t);
      break;
    }
    case 'insert': {
      const br = ctx.block(e.block);
      if (!br) { ctx.warnings.push(`Block "${e.block}" missing — insert skipped`); break; }
      const ins = new AA.Insert(br);
      ins.insertPoint = xyz(e.p.x, e.p.y); ins.xScale = e.sx; ins.yScale = e.sy; ins.rotation = e.rot;
      if (e.cols) { ins.columnCount = e.cols; ins.columnSpacing = e.colSpacing ?? 0; }
      if (e.rows) { ins.rowCount = e.rows; ins.rowSpacing = e.rowSpacing ?? 0; }
      push(ins);
      if (e.attribs?.length) {
        for (const a of e.attribs) {
          try {
            const at = new AA.AttributeEntity();
            fillText(at, a, ctx);
            at.tag = a.tag;
            applyCommon(at, a, ctx);
            ins.attributes.add(at);
          } catch (err) { ctx.warnings.push('Attribute: ' + (err as Error).message); }
        }
      }
      break;
    }
    case 'hatch': {
      const h = new AA.Hatch();
      const paths: any[] = [];
      for (const l of e.loops) {
        const pe = new AA.HatchBoundaryPathPolyline();
        const vs: any[] = [];
        for (let i = 0; i < l.pts.length; i += 2) vs.push(xyz(l.pts[i], l.pts[i + 1], l.bulges?.[i / 2] ?? 0));
        pe.vertices = vs;
        pe.isClosed = true;
        const bp = new AA.HatchBoundaryPath([pe]);
        try { bp.flags = 2 | 1; } catch { /* readonly in some versions */ }
        paths.push(bp);
      }
      h.paths = paths;
      if (e.solid || !e.pattern) { h.isSolid = true; h.pattern = AA.HatchPattern.solid; }
      else {
        h.isSolid = false;
        const pat = new AA.HatchPattern(e.pattern);
        pat.lines = (e.patternLines ?? []).map((pl) => {
          const L = new AA.HatchPatternLine();
          L.angle = pl.angle; L.basePoint = xy(pl.base.x, pl.base.y); L.offset = xy(pl.offset.x, pl.offset.y); L.dashLengths = pl.dashes.slice();
          return L;
        });
        h.pattern = pat;
        if (e.patternAngle !== undefined) h.patternAngle = e.patternAngle;
        if (e.patternScale !== undefined) h.patternScale = e.patternScale;
      }
      push(h);
      break;
    }
    case 'point': push(new AA.Point(xyz(e.p.x, e.p.y))); break;
    case 'solid': {
      const p = e.pts;
      const s = new AA.Solid(xyz(p[0], p[1]), xyz(p[2], p[3]), xyz(p[4], p[5]), xyz(p[6] ?? p[4], p[7] ?? p[5]));
      push(s);
      break;
    }
    default: {
      // leader / dimension / image / wipeout created in FiberLens: export their visual geometry
      const g = geometryOf(e);
      for (const p of g.paths) {
        if (p.pts.length < 4) continue;
        const pl = new AA.LwPolyline();
        const verts: any[] = [];
        for (let i = 0; i < p.pts.length; i += 2) verts.push(new AA.LwPolylineVertex(xy(p.pts[i], p.pts[i + 1])));
        pl.vertices = verts; pl.isClosed = p.closed;
        push(pl);
      }
      for (const f of g.fills) {
        const l = f[0];
        if (l.length >= 6) push(new AA.Solid(xyz(l[0], l[1]), xyz(l[2], l[3]), xyz(l[4], l[5]), xyz(l[4], l[5])));
      }
      for (const t of g.texts) {
        const m = new AA.MText();
        m.value = t.lines.join('\\P'); m.insertPoint = xyz(t.x, t.y); m.height = t.h; m.rotation = t.rot;
        m.attachmentPoint = t.halign === 'right' ? 6 : 4;
        push(m);
      }
    }
  }
  return out;
}

const stripId = (e: Entity) => { const { id, ...rest } = e as any; void id; return JSON.stringify(rest); };
const PROP_KEYS = ['layer', 'aci', 'rgb', 'lineType', 'ltScale', 'lineWeight', 'transparency', 'invisible'];
function geomKey(e: Entity) {
  const o: any = { ...e };
  delete o.id;
  for (const k of PROP_KEYS) delete o[k];
  if (o.attribs) o.attribs = o.attribs.map((a: any) => ({ ...a, id: 0 }));
  return JSON.stringify(o);
}

function syncLayer(l: any, fl: FLayer, ctx: Ctx) {
  l.color = mkColor(fl.aci ?? 7, fl.rgb);
  l.isOn = fl.on;
  let flags = l.layerFlags ?? 0;
  flags = fl.frozen ? flags | 1 : flags & ~1;
  flags = fl.locked ? flags | 4 : flags & ~4;
  l.layerFlags = flags;
  const lt = ctx.lineType(fl.lineType);
  if (lt) l.lineType = lt;
  l.lineWeight = fl.lineWeight;
  try { l.plotFlag = fl.plot; } catch { /* ignore */ }
}

function syncLineTypes(d: Drawing, ctx: Ctx) {
  for (const lt of d.lineTypes) {
    if (ctx.doc.lineTypes.tryGetValue(lt.name)) continue;
    try {
      const n = new AA.LineType(lt.name);
      n.description = lt.description ?? '';
      for (const len of lt.pattern) { const s = new AA.LineTypeSegment(); s.length = len; n.addSegment(s); }
      ctx.doc.lineTypes.add(n);
    } catch (err) { ctx.warnings.push('Linetype ' + lt.name + ': ' + (err as Error).message); }
  }
}

function createBlock(def: BlockDef, ctx: Ctx) {
  if (ctx.block(def.name) || def.name.startsWith('*')) return;
  try {
    const br = new AA.BlockRecord(def.name);
    br.blockEntity.basePoint = xyz(def.base.x, def.base.y);
    ctx.doc.blockRecords.add(br);
    for (const e of def.entities) for (const a of toAcad(e, ctx)) br.entities.add(a);
  } catch (err) { ctx.warnings.push('Block ' + def.name + ': ' + (err as Error).message); }
}

function updateInPlace(target: any, before: Entity, after: Entity, ctx: Ctx): boolean {
  // only property changes (+ text value / attribute values) are applied in place
  if (geomKey({ ...before, ...(before.type === 'text' || before.type === 'mtext' ? { value: '' } : {}) } as Entity) !==
      geomKey({ ...after, ...(after.type === 'text' || after.type === 'mtext' ? { value: '' } : {}) } as Entity)) {
    if (before.type === 'insert' && after.type === 'insert') {
      const strip = (e: any) => geomKey({ ...e, attribs: e.attribs?.map((a: any) => ({ ...a, value: '' })) });
      if (strip(before) !== strip(after)) return false;
    } else return false;
  }
  applyCommon(target, after, ctx);
  if ((after.type === 'text' || after.type === 'mtext') && 'value' in target) target.value = after.value;
  if (after.type === 'insert' && after.attribs && target.attributes) {
    const byTag = new Map(after.attribs.map((a) => [a.tag, a.value]));
    for (const a of target.attributes) if (byTag.has(a.tag)) a.value = byTag.get(a.tag);
  }
  return true;
}

function serialize(doc: any, format: ExportFormat): Uint8Array {
  if (format === 'dwg') return AA.DwgWriter.writeToBuffer(doc);
  const chunks: string[] = [];
  const target = { write: (s: string) => { chunks.push(s); } };
  const w = new AA.DxfWriter(target, doc, false);
  w.write();
  return new TextEncoder().encode(chunks.join(''));
}

export function exportDrawing(d: Drawing, original: Uint8Array | null, format: ExportFormat, version?: string): ExportResult {
  const stats = { kept: 0, modified: 0, added: 0, deleted: 0, layers: 0 };
  let doc: any;
  let ctx: Ctx;
  if (original) {
    doc = readAcad(original);
    ctx = new Ctx(doc);
    const fmt = /^AC\d{4}/.test(String.fromCharCode(...original.slice(0, 6))) ? 'dwg' : 'dxf';
    const origDrawing = importCadDocument(doc, 'orig', fmt);
    const origByHandle = new Map<string, Entity>();
    for (const e of origDrawing.entities) if (e.handle) origByHandle.set(e.handle, e);
    const acadByHandle = new Map<string, any>();
    for (const e of doc.modelSpace.entities) acadByHandle.set(e.handle?.toString(16).toUpperCase(), e);
    const current = new Map<string, Entity>();
    for (const e of d.entities) if (e.handle) current.set(e.handle, e);

    syncLineTypes(d, ctx);
    // layers
    const layerByHandle = new Map<string, any>();
    for (const l of doc.layers) layerByHandle.set(l.handle?.toString(16).toUpperCase(), l);
    for (const fl of d.layers) {
      let l = fl.handle ? layerByHandle.get(fl.handle) : undefined;
      if (l && l.name !== fl.name && fl.name !== '0') {
        try { l.name = fl.name; } catch { ctx.warnings.push('Cannot rename layer ' + l.name); }
      }
      if (!l) l = ctx.layer(fl.name);
      syncLayer(l, fl, ctx);
      stats.layers++;
    }
    for (const def of Object.values(d.blocks)) createBlock(def, ctx);

    // deletions
    for (const [h, ae] of acadByHandle) {
      if (!origByHandle.has(h)) continue; // entity type we do not model: keep untouched
      if (!current.has(h)) { doc.modelSpace.entities.remove(ae); stats.deleted++; }
    }
    // modifications + additions
    for (const e of d.entities) {
      const orig = e.handle ? origByHandle.get(e.handle) : undefined;
      const ae = e.handle ? acadByHandle.get(e.handle) : undefined;
      if (orig && ae) {
        if (stripId(orig) === stripId({ ...e, id: orig.id } as Entity)) { stats.kept++; continue; }
        if (updateInPlace(ae, orig, e, ctx)) { stats.modified++; continue; }
        doc.modelSpace.entities.remove(ae);
        for (const n of toAcad(e, ctx)) doc.modelSpace.entities.add(n);
        stats.modified++;
      } else {
        for (const n of toAcad(e, ctx)) doc.modelSpace.entities.add(n);
        stats.added++;
      }
    }
  } else {
    doc = new AA.CadDocument();
    ctx = new Ctx(doc);
    syncLineTypes(d, ctx);
    for (const fl of d.layers) { syncLayer(ctx.layer(fl.name), fl, ctx); stats.layers++; }
    for (const def of Object.values(d.blocks)) createBlock(def, ctx);
    for (const e of d.entities) { for (const n of toAcad(e, ctx)) doc.modelSpace.entities.add(n); stats.added++; }
  }
  if (version && AA.ACadVersion[version] !== undefined) doc.header.version = AA.ACadVersion[version];
  try { doc.header.insUnits = d.meta.units; } catch { /* ignore */ }
  const bytes = serialize(doc, format);
  return { bytes, stats, warnings: ctx.warnings.slice(0, 100) };
}
