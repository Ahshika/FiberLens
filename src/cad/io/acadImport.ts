/**
 * acad-ts CadDocument → FiberLens Drawing.
 * Runs inside the CAD worker. Every entity keeps its original handle so edits can be
 * merged back into the source DWG/DXF on export.
 */
import * as A from '@node-projects/acad-ts';
import type {
  Drawing, Entity, Layer, LineTypeDef, TextStyleDef, BlockDef, Vec2, HAlign, VAlign,
  HatchLoop, HatchPatternLine, AttribEnt, LayoutDef, GeoInfo, ColorProps,
} from '../model/types';
import { emptyDrawing } from '../model/types';
import { repairAttributes } from './repair';
export { repairAttributes };

type AnyObj = any;

const H_ALIGN: HAlign[] = ['left', 'center', 'right', 'aligned', 'middle', 'fit'];
const V_ALIGN: VAlign[] = ['baseline', 'bottom', 'middle', 'top'];

function hex(h: number | bigint | undefined): string | undefined {
  if (h === undefined || h === null) return undefined;
  return h.toString(16).toUpperCase();
}

function colorOf(c: AnyObj): ColorProps {
  if (!c) return { aci: 256 };
  try {
    if (c.isByLayer) return { aci: 256 };
    if (c.isByBlock) return { aci: 0 };
    if (c.isTrueColor) {
      const [r, g, b] = c.getTrueColorRgb ? c.getTrueColorRgb() : c.getRgb();
      return { aci: c.getApproxIndex ? c.getApproxIndex() : 7, rgb: (r << 16) | (g << 8) | b };
    }
    return { aci: c.index };
  } catch {
    return { aci: 256 };
  }
}

function transparencyOf(t: AnyObj): number | undefined {
  if (!t) return undefined;
  if (t.isByLayer) return undefined;
  if (t.isByBlock) return undefined;
  const v = t.value;
  if (typeof v !== 'number' || v < 0) return undefined;
  return Math.min(0.9, v / 100);
}

/** OCS → WCS for 2D entities with extrusion (0,0,-1): mirror X */
function ocsFlip(normal: AnyObj): boolean {
  return !!normal && normal.z < -0.5;
}

const P = (p: AnyObj, flip = false): Vec2 => ({ x: flip ? -(p?.x ?? 0) : (p?.x ?? 0), y: p?.y ?? 0 });

export interface ImportContext {
  nextId: number;
  notes: string[];
  textStyles: Map<string, TextStyleDef>;
}

function base(e: AnyObj, ctx: ImportContext) {
  const lt = e.lineType?.name as string | undefined;
  const out: AnyObj = {
    id: ctx.nextId++,
    layer: e.layer?.name ?? '0',
    ...colorOf(e.color),
    handle: hex(e.handle),
  };
  if (lt && lt.toLowerCase() !== 'bylayer') out.lineType = lt;
  if (e.lineTypeScale && e.lineTypeScale !== 1) out.ltScale = e.lineTypeScale;
  if (typeof e.lineWeight === 'number' && e.lineWeight !== -1) out.lineWeight = e.lineWeight;
  const tr = transparencyOf(e.transparency);
  if (tr !== undefined) out.transparency = tr;
  if (e.isInvisible) out.invisible = true;
  return out;
}

function fontOf(style: AnyObj, ctx: ImportContext): { style?: string; font?: string } {
  if (!style) return {};
  const name = style.name as string;
  const s = ctx.textStyles.get(name);
  return { style: name, font: s?.font };
}

function textFields(e: AnyObj, ctx: ImportContext) {
  const flip = ocsFlip(e.normal);
  const ha = H_ALIGN[e.horizontalAlignment ?? 0] ?? 'left';
  const va = V_ALIGN[e.verticalAlignment ?? 0] ?? 'baseline';
  const sf = fontOf(e.style, ctx);
  return {
    p: P(e.insertPoint, flip),
    p2: e.alignmentPoint ? P(e.alignmentPoint, flip) : undefined,
    h: e.height || 1,
    rot: flip ? Math.PI - (e.rotation || 0) : (e.rotation || 0),
    value: decodeUnicode(e.value ?? ''),
    halign: ha,
    valign: va,
    widthFactor: e.widthFactor && e.widthFactor > 0 ? e.widthFactor : undefined,
    oblique: e.obliqueAngle || undefined,
    ...sf,
    mirrorX: ((e.mirror ?? 0) & 2) !== 0 ? true : undefined,
  };
}

function hatchLoops(h: AnyObj, flip: boolean): HatchLoop[] {
  const loops: HatchLoop[] = [];
  for (const path of h.paths ?? []) {
    const pts: number[] = [];
    const bulges: number[] = [];
    let hasBulge = false;
    const push = (x: number, y: number, b = 0) => {
      const n = pts.length;
      if (n >= 2 && Math.abs(pts[n - 2] - x) < 1e-9 && Math.abs(pts[n - 1] - y) < 1e-9) {
        bulges[bulges.length - 1] = b || bulges[bulges.length - 1];
        return;
      }
      pts.push(flip ? -x : x, y); bulges.push(flip ? -b : b);
      if (b) hasBulge = true;
    };
    for (const edge of path.edges ?? []) {
      const name = edge.constructor?.name;
      try {
        if (name === 'HatchBoundaryPathPolyline') {
          const bl = edge.bulges ?? [];
          edge.vertices.forEach((v: AnyObj, i: number) => push(v.x, v.y, bl[i] || (v.z && Math.abs(v.z) < 10 && edge.hasBulge ? v.z : 0)));
        } else if (name === 'HatchBoundaryPathLine') {
          push(edge.start.x, edge.start.y);
          push(edge.end.x, edge.end.y);
        } else if (edge.polygonalVertexes) {
          const vs = edge.polygonalVertexes(48);
          for (const v of vs) push(v.x, v.y);
        }
      } catch {
        /* skip broken edge */
      }
    }
    // drop closing duplicate
    if (pts.length >= 4) {
      const n = pts.length;
      if (Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) { pts.length -= 2; bulges.length -= 1; }
    }
    if (pts.length >= 6 || (pts.length >= 4 && hasBulge)) loops.push(hasBulge ? { pts, bulges } : { pts });
  }
  return loops;
}

function patternLines(h: AnyObj): HatchPatternLine[] | undefined {
  const lines = h.pattern?.lines;
  if (!lines || !lines.length) return undefined;
  return lines.map((l: AnyObj) => ({
    angle: l.angle ?? 0,
    base: { x: l.basePoint?.x ?? 0, y: l.basePoint?.y ?? 0 },
    offset: { x: l.offset?.x ?? 0, y: l.offset?.y ?? 0 },
    dashes: [...(l.dashLengths ?? [])],
  }));
}

const DIM_TYPES: Record<string, any> = {
  DimensionLinear: 'linear', DimensionAligned: 'aligned', DimensionAngular2Line: 'angular', DimensionAngular3Pt: 'angular',
  DimensionRadius: 'radius', DimensionDiameter: 'diameter', DimensionOrdinate: 'ordinate', DimensionArc: 'arc',
};

/** Convert a single acad-ts entity. Returns null for unsupported/irrelevant entities. */
export function convertEntity(e: AnyObj, ctx: ImportContext): Entity | Entity[] | null {
  const name = e.constructor?.name as string;
  try {
    switch (name) {
      case 'Line':
        return { ...base(e, ctx), type: 'line', p1: P(e.startPoint), p2: P(e.endPoint) };
      case 'LwPolyline': {
        const flip = ocsFlip(e.normal);
        const pts: number[] = [];
        const bulges: number[] = [];
        const widths: number[] = [];
        let hasB = false, hasW = false;
        for (const vx of e.vertices) {
          pts.push(flip ? -vx.location.x : vx.location.x, vx.location.y);
          const b = flip ? -(vx.bulge || 0) : (vx.bulge || 0);
          bulges.push(b); if (b) hasB = true;
          widths.push(vx.startWidth || 0, vx.endWidth || 0);
          if (vx.startWidth || vx.endWidth) hasW = true;
        }
        if (pts.length < 2) return null;
        return {
          ...base(e, ctx), type: 'polyline', pts, closed: !!e.isClosed,
          bulges: hasB ? bulges : undefined,
          width: e.constantWidth || undefined,
          widths: hasW ? widths : undefined,
        };
      }
      case 'Polyline2D':
      case 'Polyline3D':
      case 'Polyline': {
        const flip = name === 'Polyline2D' && ocsFlip(e.normal);
        const pts: number[] = [];
        const bulges: number[] = [];
        let hasB = false;
        for (const vx of e.vertices) {
          const l = vx.location;
          if (!l) continue;
          // skip spline frame control points (flag 16)
          if ((vx.flags ?? 0) & 16) continue;
          pts.push(flip ? -l.x : l.x, l.y);
          const b = flip ? -(vx.bulge || 0) : (vx.bulge || 0);
          bulges.push(b); if (b) hasB = true;
        }
        if (pts.length < 2) return null;
        return { ...base(e, ctx), type: 'polyline', pts, closed: !!e.isClosed, bulges: hasB ? bulges : undefined, width: e.startWidth || undefined };
      }
      case 'Circle': {
        const flip = ocsFlip(e.normal);
        return { ...base(e, ctx), type: 'circle', c: P(e.center, flip), r: e.radius };
      }
      case 'Arc': {
        const flip = ocsFlip(e.normal);
        let a0 = e.startAngle, a1 = e.endAngle;
        if (flip) { const t = Math.PI - a1; a1 = Math.PI - a0; a0 = t; }
        return { ...base(e, ctx), type: 'arc', c: P(e.center, flip), r: e.radius, a0, a1 };
      }
      case 'Ellipse': {
        return {
          ...base(e, ctx), type: 'ellipse', c: P(e.center), major: P(e.majorAxisEndPoint),
          ratio: e.radiusRatio, t0: e.startParameter ?? 0, t1: e.endParameter ?? Math.PI * 2,
        };
      }
      case 'Spline': {
        const ctrl: number[] = [];
        for (const p of e.controlPoints ?? []) ctrl.push(p.x, p.y);
        const fit: number[] = [];
        for (const p of e.fitPoints ?? []) fit.push(p.x, p.y);
        return {
          ...base(e, ctx), type: 'spline', degree: e.degree || 3, ctrl, knots: [...(e.knots ?? [])],
          weights: e.weights?.length ? [...e.weights] : undefined, fit: fit.length ? fit : undefined, closed: !!e.isClosed,
        };
      }
      case 'TextEntity':
        return { ...base(e, ctx), type: 'text', ...textFields(e, ctx) };
      case 'MText': {
        const flip = ocsFlip(e.normal);
        const sf = fontOf(e.style, ctx);
        const bgOn = ((e.backgroundFillFlags ?? 0) & 1) !== 0;
        const bgUseCanvas = ((e.backgroundFillFlags ?? 0) & 2) !== 0;
        let bgFill: number | undefined;
        if (bgOn) {
          if (bgUseCanvas) bgFill = -1;
          else { const c = colorOf(e.backgroundColor); bgFill = c.rgb ?? -1; }
        }
        return {
          ...base(e, ctx), type: 'mtext', p: P(e.insertPoint, flip), h: e.height || 1,
          rot: e.rotation || 0, width: e.rectangleWidth || 0, attach: e.attachmentPoint || 1,
          value: e.value ?? '', lineSpacing: e.lineSpacing || undefined, ...sf,
          bgFill, bgScale: bgOn ? e.backgroundScale || 1.5 : undefined,
        };
      }
      case 'Insert': {
        const flip = ocsFlip(e.normal);
        const attribs: AttribEnt[] = [];
        for (const a of e.attributes ?? []) {
          const hidden = ((a.flags ?? 0) & 1) !== 0;
          if (hidden) continue;
          const tf = textFields(a, ctx);
          attribs.push({ ...base(a, ctx), type: 'text', ...tf, tag: a.tag ?? '' } as AttribEnt);
        }
        const blockName = e.block?.name;
        if (!blockName) return null;
        return {
          ...base(e, ctx), type: 'insert', block: blockName, p: P(e.insertPoint, flip),
          sx: (flip ? -1 : 1) * (e.xScale ?? 1), sy: e.yScale ?? 1, rot: flip ? -(e.rotation || 0) : (e.rotation || 0),
          attribs: attribs.length ? attribs : undefined,
          cols: e.columnCount > 1 ? e.columnCount : undefined, rows: e.rowCount > 1 ? e.rowCount : undefined,
          colSpacing: e.columnCount > 1 ? e.columnSpacing : undefined, rowSpacing: e.rowCount > 1 ? e.rowSpacing : undefined,
        };
      }
      case 'Hatch': {
        const flip = ocsFlip(e.normal);
        const loops = hatchLoops(e, flip);
        if (!loops.length) return null;
        const solid = !!e.isSolid || e.pattern?.name?.toUpperCase() === 'SOLID';
        return {
          ...base(e, ctx), type: 'hatch', loops, solid, pattern: e.pattern?.name,
          patternAngle: e.patternAngle, patternScale: e.patternScale,
          patternLines: solid ? undefined : patternLines(e),
        };
      }
      case 'Point':
        return { ...base(e, ctx), type: 'point', p: P(e.location) };
      case 'Solid':
      case 'Face3D': {
        const c = name === 'Solid'
          ? [e.firstCorner, e.secondCorner, e.thirdCorner, e.fourthCorner]
          : [e.firstCorner, e.secondCorner, e.fourthCorner, e.thirdCorner];
        const flip = name === 'Solid' && ocsFlip(e.normal);
        const pts: number[] = [];
        for (const p of c) if (p) pts.push(flip ? -p.x : p.x, p.y);
        if (name === 'Face3D') {
          // render 3D faces as outlines
          return { ...base(e, ctx), type: 'polyline', pts: [pts[0], pts[1], pts[2], pts[3], pts[6], pts[7], pts[4], pts[5]], closed: true };
        }
        return { ...base(e, ctx), type: 'solid', pts };
      }
      case 'Leader': {
        const pts: number[] = [];
        for (const p of e.vertices ?? []) pts.push(p.x, p.y);
        if (pts.length < 4) return null;
        return { ...base(e, ctx), type: 'leader', pts, arrow: e.arrowHeadEnabled !== false, arrowSize: e.style?.arrowSize ? e.style.arrowSize * (e.style.scaleFactor || 1) : undefined };
      }
      case 'MultiLeader': {
        const cd = e.contextData;
        const out: Entity[] = [];
        const b = base(e, ctx);
        if (cd?.leaderRoots) {
          for (const root of cd.leaderRoots) {
            for (const line of root.lines ?? []) {
              const pts: number[] = [];
              for (const p of line.points ?? []) pts.push(p.x, p.y);
              if (root.connectionPoint) pts.push(root.connectionPoint.x, root.connectionPoint.y);
              if (pts.length >= 4) out.push({ ...b, id: ctx.nextId++, type: 'leader', pts, arrow: true, arrowSize: (cd.arrowheadSize || e.arrowheadSize || 2.5) });
            }
          }
        }
        if (cd?.hasTextContents && cd.textLabel) {
          out.push({
            ...b, id: ctx.nextId++, type: 'mtext', p: P(cd.textLocation), h: cd.textHeight || 2.5, rot: cd.textRotation || 0,
            width: cd.boundaryWidth || 0, attach: cd.textAttachmentPoint || 1, value: cd.textLabel,
          });
        }
        if (out.length) out[0].handle = b.handle; // first child keeps the handle
        for (let i = 1; i < out.length; i++) delete out[i].handle;
        return out.length ? out : null;
      }
      case 'RasterImage':
      case 'Wipeout': {
        const o = e.insertPoint, u = e.uVector, vv = e.vVector, s = e.size;
        if (!o || !u || !vv || !s) return null;
        const corner = (fx: number, fy: number) => [o.x + u.x * s.x * fx + vv.x * s.y * fy, o.y + u.y * s.x * fx + vv.y * s.y * fy];
        let pts: number[];
        const clip = e.clipBoundaryVertices as AnyObj[] | undefined;
        if (clip && clip.length >= 3) {
          pts = [];
          for (const c of clip) {
            // clip vertices are in pixel space (origin at -0.5,-0.5)
            const fx = (c.x + 0.5) / s.x, fy = (c.y + 0.5) / s.y;
            pts.push(...corner(fx, fy));
          }
        } else {
          pts = [...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 1)];
        }
        return { ...base(e, ctx), type: name === 'Wipeout' ? 'wipeout' : 'image', pts, name: e.definition?.fileName };
      }
      case 'MLine': {
        const pts: number[] = [];
        for (const v of e.vertices ?? []) pts.push(v.position?.x ?? v.location?.x, v.position?.y ?? v.location?.y);
        if (pts.length < 4) return null;
        return { ...base(e, ctx), type: 'polyline', pts, closed: false };
      }
      case 'XLine':
      case 'Ray': {
        const p = e.firstPoint, d = e.direction;
        if (!p || !d) return null;
        const L = 1e5;
        const s = name === 'XLine' ? -L : 0;
        return { ...base(e, ctx), type: 'line', p1: { x: p.x + d.x * s, y: p.y + d.y * s }, p2: { x: p.x + d.x * L, y: p.y + d.y * L } };
      }
      default:
        if (name && name.startsWith('Dimension')) {
          const dt = DIM_TYPES[name] ?? 'linear';
          const defPts: number[] = [];
          for (const k of ['firstPoint', 'secondPoint', 'definitionPoint', 'angleVertex', 'firstPoint2', 'leaderEndPoint', 'featureLocation']) {
            const p = e[k];
            if (p && typeof p.x === 'number') defPts.push(p.x, p.y);
          }
          let measurement = 0;
          try { measurement = e.measurement ?? 0; } catch { /* ignore */ }
          return {
            ...base(e, ctx), type: 'dimension', dimType: dt, block: e.block?.name, defPts,
            textPos: P(e.textMiddlePoint), text: e.text ?? '', measurement,
            textHeight: e.style?.textHeight ? e.style.textHeight * (e.style.scaleFactor || 1) : undefined,
          };
        }
        return null;
    }
  } catch (err) {
    ctx.notes.push(`Failed to convert ${name}: ${(err as Error).message}`);
    return null;
  }
}

function pushConverted(list: Entity[], c: Entity | Entity[] | null) {
  if (!c) return;
  if (Array.isArray(c)) list.push(...c); else list.push(c);
}

const SKIP = new Set(['AttributeDefinition', 'Viewport', 'Seqend', 'Block', 'BlockEnd', 'Vertex2D', 'Vertex3D']);

function convertList(entities: Iterable<AnyObj>, ctx: ImportContext, counts?: Record<string, number>): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    const n = e.constructor?.name;
    if (SKIP.has(n)) continue;
    const c = convertEntity(e, ctx);
    if (!c && counts) counts[n] = (counts[n] ?? 0) + 1;
    pushConverted(out, c);
  }
  return out;
}

function findGeoData(doc: AnyObj): GeoInfo | undefined {
  try {
    const xd = doc.modelSpace?.xDictionary ?? doc.modelSpace?._xdictionary;
    if (!xd) return undefined;
    const entries: AnyObj[] = [];
    if (typeof xd.entries === 'function') for (const e of xd.entries()) entries.push(Array.isArray(e) ? e[1] : e);
    else if (xd._entries) for (const v of xd._entries.values()) entries.push(v);
    for (const o of entries) {
      if (o?.constructor?.name === 'GeoData') {
        return {
          designPoint: P(o.designPoint), referencePoint: P(o.referencePoint),
          northDirection: P(o.northDirection), unitScale: o.horizontalUnitScale || 1,
          csDefinition: o.coordinateSystemDefinition || undefined, coordinatesType: o.coordinatesType ?? 0,
        };
      }
    }
  } catch { /* none */ }
  return undefined;
}

export function importCadDocument(doc: AnyObj, fileName: string, format: 'dwg' | 'dxf'): Drawing {
  const d = emptyDrawing(fileName);
  d.meta.sourceFormat = format;
  const ctx: ImportContext = { nextId: 1, notes: [], textStyles: new Map() };

  // text styles
  d.textStyles = [];
  for (const s of doc.textStyles ?? []) {
    const file: string = s.filename || '';
    const font = file.replace(/\.(shx|ttf|ttc|otf)$/i, '') || 'Arial';
    const def: TextStyleDef = { name: s.name, font, bigFont: s.bigFontFilename || undefined, widthFactor: s.width || 1, oblique: s.obliqueAngle || 0, height: s.height || 0 };
    d.textStyles.push(def);
    ctx.textStyles.set(s.name, def);
  }

  // line types
  d.lineTypes = [];
  for (const lt of doc.lineTypes ?? []) {
    const name = lt.name as string;
    if (/^by(layer|block)$/i.test(name)) continue;
    const pattern: number[] = [];
    for (const s of lt.segments ?? []) pattern.push(s.length);
    d.lineTypes.push({ name, description: lt.description ?? undefined, pattern });
  }

  // layers
  d.layers = [];
  for (const l of doc.layers ?? []) {
    const flags = l.layerFlags ?? 0;
    const layer: Layer = {
      name: l.name, ...colorOf(l.color),
      lineType: l.lineType?.name ?? 'Continuous',
      lineWeight: typeof l.lineWeight === 'number' ? l.lineWeight : -3,
      transparency: 0,
      on: l.isOn !== false && !(l.color?.index < 0),
      frozen: (flags & 1) !== 0,
      locked: (flags & 4) !== 0,
      plot: l.plotFlag !== false,
      handle: hex(l.handle),
    };
    if (layer.aci === 256 || layer.aci === 0) layer.aci = 7;
    d.layers.push(layer);
  }
  if (!d.layers.find((l) => l.name === '0')) d.layers.unshift(emptyDrawing().layers[0]);

  // blocks
  const unconverted: Record<string, number> = {};
  const modelName = doc.modelSpace?.name;
  for (const br of doc.blockRecords ?? []) {
    const name = br.name as string;
    if (name === modelName || /^\*paper_space/i.test(name) || /^\*model_space/i.test(name)) continue;
    if (br.layout && br.layout.name !== 'Model' && br.layout.isPaperSpace) continue;
    const be = br.blockEntity;
    const block: BlockDef = {
      name,
      base: P(be?.basePoint),
      entities: convertList(br.entities, ctx, unconverted),
      anonymous: !!br.isAnonymous || name.startsWith('*'),
      // only real external references (block flags XRef=4 / Overlay=8); acad-ts fills a placeholder path otherwise
      xref: ((br.blockFlags ?? br.flags ?? 0) & 12) && be?.xRefPath && be.xRefPath !== 'Acad:XRef' ? be.xRefPath : undefined,
    };
    try {
      const atts = br.attributeDefinitions as AnyObj[];
      if (atts?.length) block.attdefs = atts.map((a) => ({ tag: a.tag, prompt: a.prompt, value: a.value, p: P(a.insertPoint), p2: a.alignmentPoint ? P(a.alignmentPoint) : undefined, h: a.height, rot: a.rotation || 0, halign: H_ALIGN[a.horizontalAlignment ?? 0], valign: V_ALIGN[a.verticalAlignment ?? 0] }));
    } catch { /* ignore */ }
    d.blocks[name] = block;
  }

  // model space
  d.entities = convertList(doc.modelSpace?.entities ?? [], ctx, unconverted);
  const fixed = repairAttributes(d);
  if (fixed) ctx.notes.push(`${fixed} block attribute positions corrected (reader double-transform)`);

  // layouts (paper space) — basic support
  try {
    for (const lay of doc.layouts ?? []) {
      if (lay.name === 'Model') continue;
      const blk = lay.associatedBlock;
      if (!blk) continue;
      const vps = [] as LayoutDef['viewports'];
      for (const vp of lay.viewports ?? []) {
        if (vp.representsPaper) continue;
        vps.push({ center: P(vp.center), width: vp.width, height: vp.height, viewCenter: P(vp.viewCenter), viewHeight: vp.viewHeight, twist: vp.twistAngle || 0 });
      }
      d.layouts.push({ name: lay.name, tabOrder: lay.tabOrder ?? 0, entities: convertList(blk.entities, ctx), viewports: vps });
    }
    d.layouts.sort((a, b) => a.tabOrder - b.tabOrder);
  } catch (err) {
    ctx.notes.push('Layouts: ' + (err as Error).message);
  }

  // header
  const h = doc.header ?? {};
  d.meta.version = h.version !== undefined ? (A as AnyObj).ACadVersion?.[h.version] ?? String(h.version) : 'unknown';
  d.meta.units = typeof h.insUnits === 'number' ? h.insUnits : 0;
  d.meta.ltScale = h.lineTypeScale || 1;
  d.meta.pdMode = h.pointDisplayMode || 0;
  d.meta.pdSize = h.pointDisplaySize || 0;
  d.meta.codePage = h.codePage;
  d.geo = findGeoData(doc);

  for (const [k, n] of Object.entries(unconverted)) ctx.notes.push(`${n} × ${k} not rendered`);
  d.meta.notes.push(...ctx.notes.slice(0, 200));
  d.nextId = ctx.nextId;
  return d;
}

/** \U+XXXX escapes (older DXF / non-Unicode code pages) → characters */
export function decodeUnicode(s: string): string {
  return s.indexOf('\\U+') < 0 ? s : s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
