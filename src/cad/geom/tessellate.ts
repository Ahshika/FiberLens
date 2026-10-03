import type {
  Entity, Vec2, TextEnt, MTextEnt, HatchEnt, HatchLoop, DimensionEnt, LeaderEnt, PolylineEnt, HAlign, VAlign,
} from '../model/types';
import { expandBulges, pushArcPoints } from './bulge';
import { tessellateSpline, catmullRom } from './spline';
import { parseMText, decodeText, wrapLines } from './mtext';
import { ccwSweep, TAU, type Mat2D, matApply, matDet, matRotation } from './vec';

export interface Path { pts: number[]; closed: boolean }
export interface TextItem {
  x: number; y: number; h: number; rot: number;
  lines: string[];
  halign: 'left' | 'center' | 'right';
  valign: 'baseline' | 'bottom' | 'middle' | 'top';
  widthFactor: number; oblique: number;
  font?: string; bold?: boolean; italic?: boolean;
  mirrorX?: boolean;
  lineSpacing: number;
  /** background mask colour (rgb) or -1 for canvas background */
  bg?: number;
  bgScale?: number;
  /** for 'fit'/'aligned' texts: target width */
  fitWidth?: number;
}
export interface Geometry {
  paths: Path[];
  /** filled regions, each a list of loops (first outer, rest holes, even-odd) */
  fills: number[][][];
  texts: TextItem[];
  /** fills that paint the background colour (wipeout / text mask) */
  masks?: number[][][];
}

export const emptyGeom = (): Geometry => ({ paths: [], fills: [], texts: [] });

/** approximate text block width (drawing units) */
export function textWidth(t: TextItem): number {
  let m = 0;
  for (const l of t.lines) m = Math.max(m, l.length);
  return m * t.h * 0.62 * t.widthFactor;
}

/** text bbox corners in world coords */
export function textCorners(t: TextItem): number[] {
  const w = t.fitWidth ?? textWidth(t);
  const n = t.lines.length;
  const totalH = t.h * (1 + (n - 1) * 1.66 * t.lineSpacing);
  let x0 = 0;
  if (t.halign === 'center') x0 = -w / 2; else if (t.halign === 'right') x0 = -w;
  let yTop: number;
  switch (t.valign) {
    case 'top': yTop = 0; break;
    case 'middle': yTop = totalH / 2; break;
    case 'bottom': yTop = totalH; break;
    default: yTop = t.h; // baseline of first line
  }
  const yBot = yTop - totalH - (t.valign === 'baseline' ? t.h * 0.25 : 0);
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  const pts = [x0, yBot, x0 + w, yBot, x0 + w, yTop, x0, yTop];
  const out: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    out.push(t.x + pts[i] * c - pts[i + 1] * s, t.y + pts[i] * s + pts[i + 1] * c);
  }
  return out;
}

function mapHAlign(h?: HAlign): TextItem['halign'] {
  if (h === 'center' || h === 'middle') return 'center';
  if (h === 'right') return 'right';
  return 'left';
}
function mapVAlign(h: HAlign | undefined, v?: VAlign): TextItem['valign'] {
  if (h === 'middle') return 'middle';
  return v ?? 'baseline';
}

export function textItemOf(t: TextEnt): TextItem {
  const aligned = t.halign === 'aligned' || t.halign === 'fit';
  const useP2 = t.p2 && ((t.halign && t.halign !== 'left') || (t.valign && t.valign !== 'baseline'));
  let x = useP2 && !aligned ? t.p2!.x : t.p.x;
  let y = useP2 && !aligned ? t.p2!.y : t.p.y;
  let rot = t.rot;
  let fitWidth: number | undefined;
  let h = t.h;
  const value = decodeText(t.value);
  if (aligned && t.p2) {
    fitWidth = Math.hypot(t.p2.x - t.p.x, t.p2.y - t.p.y);
    rot = Math.atan2(t.p2.y - t.p.y, t.p2.x - t.p.x);
    if (t.halign === 'aligned' && value.length) h = Math.min(h || 1e9, fitWidth / (value.length * 0.62));
  }
  return {
    x, y, h, rot, lines: [value],
    halign: aligned ? 'left' : mapHAlign(t.halign),
    valign: aligned ? 'baseline' : mapVAlign(t.halign, t.valign),
    widthFactor: t.widthFactor || 1, oblique: t.oblique || 0,
    font: t.font, bold: t.bold, italic: t.italic, mirrorX: t.mirrorX, lineSpacing: 1, fitWidth,
  };
}

const ATTACH_H: TextItem['halign'][] = ['left', 'center', 'right'];
const ATTACH_V: TextItem['valign'][] = ['top', 'middle', 'bottom'];

export function mtextItemOf(t: MTextEnt): TextItem {
  const parsed = parseMText(t.value);
  const h = t.h * (parsed.heightFactor ?? 1);
  const a = Math.max(1, Math.min(9, t.attach || 1)) - 1;
  const lines = wrapLines(parsed.lines, t.width, h);
  return {
    x: t.p.x, y: t.p.y, h, rot: t.rot, lines,
    halign: ATTACH_H[a % 3], valign: ATTACH_V[Math.floor(a / 3)],
    widthFactor: 1, oblique: 0,
    font: t.font ?? parsed.font, bold: t.bold ?? parsed.bold, italic: t.italic ?? parsed.italic,
    lineSpacing: t.lineSpacing || 1,
    bg: t.bgFill, bgScale: t.bgScale,
  };
}

export function loopPoints(l: HatchLoop): number[] {
  return l.bulges && l.bulges.some((b) => b) ? expandBulges(l.pts, l.bulges, true) : l.pts.slice();
}

/** generate hatch pattern line segments clipped (even-odd) to the boundary loops */
export function hatchPatternPaths(h: HatchEnt, maxLines = 4000): Path[] | null {
  if (!h.patternLines || !h.patternLines.length) return null;
  const loops = h.loops.map(loopPoints).filter((l) => l.length >= 6);
  if (!loops.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    if (l[i] < minX) minX = l[i]; if (l[i] > maxX) maxX = l[i];
    if (l[i + 1] < minY) minY = l[i + 1]; if (l[i + 1] > maxY) maxY = l[i + 1];
  }
  const out: Path[] = [];
  let lineBudget = maxLines;
  for (const pl of h.patternLines) {
    const dx = Math.cos(pl.angle), dy = Math.sin(pl.angle);
    // perpendicular spacing between lines
    const nx = -dy, ny = dx;
    const spacing = pl.offset.x * nx + pl.offset.y * ny;
    const shift = pl.offset.x * dx + pl.offset.y * dy;
    if (Math.abs(spacing) < 1e-9) continue;
    // project bbox corners on normal relative to base
    const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    let dmin = Infinity, dmax = -Infinity;
    for (const [cx, cy] of corners) {
      const d = (cx - pl.base.x) * nx + (cy - pl.base.y) * ny;
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
    }
    const s = Math.abs(spacing);
    const k0 = Math.ceil(dmin / s), k1 = Math.floor(dmax / s);
    if (k1 - k0 + 1 > lineBudget) return null;
    lineBudget -= k1 - k0 + 1;
    const sign = Math.sign(spacing);
    const patLen = pl.dashes.reduce((a, b) => a + Math.abs(b), 0);
    for (let k = k0; k <= k1; k++) {
      const kk = k * sign;
      const ox = pl.base.x + pl.offset.x * kk, oy = pl.base.y + pl.offset.y * kk;
      // intersect line (ox,oy)+t(dx,dy) with loop edges
      const ts: number[] = [];
      for (const l of loops) {
        const n = l.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = l[i * 2], ay = l[i * 2 + 1], bx = l[j * 2], by = l[j * 2 + 1];
          const ex = bx - ax, ey = by - ay;
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-14) continue;
          const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
          const u = ((ax - ox) * dy - (ay - oy) * dx) / den;
          if (u >= 0 && u < 1) ts.push(t);
        }
      }
      ts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i], t1 = ts[i + 1];
        if (!pl.dashes.length || patLen < 1e-12) {
          out.push({ pts: [ox + dx * t0, oy + dy * t0, ox + dx * t1, oy + dy * t1], closed: false });
          continue;
        }
        // dash phase: pattern starts at base + shift*k along the line
        const phase0 = shift * kk;
        let t = t0;
        // find position in pattern
        let pos = ((t - phase0) % patLen + patLen) % patLen;
        let di = 0;
        while (pos >= Math.abs(pl.dashes[di]) && Math.abs(pl.dashes[di]) > 0) { pos -= Math.abs(pl.dashes[di]); di = (di + 1) % pl.dashes.length; }
        let guard = 0;
        while (t < t1 && guard++ < 10000) {
          const dl = pl.dashes[di];
          const segLen = Math.abs(dl) - pos;
          const te = Math.min(t1, t + Math.max(segLen, 0));
          if (dl > 0) out.push({ pts: [ox + dx * t, oy + dy * t, ox + dx * te, oy + dy * te], closed: false });
          else if (dl === 0) out.push({ pts: [ox + dx * t, oy + dy * t, ox + dx * t, oy + dy * t], closed: false });
          t = te + (segLen <= 0 ? 1e-9 : 0);
          pos = 0;
          di = (di + 1) % pl.dashes.length;
        }
      }
    }
  }
  return out;
}

function arrowHead(tip: Vec2, from: Vec2, size: number): number[] {
  const ang = Math.atan2(from.y - tip.y, from.x - tip.x);
  const w = size / 3;
  const bx = tip.x + Math.cos(ang) * size, by = tip.y + Math.sin(ang) * size;
  const nx = -Math.sin(ang) * w, ny = Math.cos(ang) * w;
  return [tip.x, tip.y, bx + nx, by + ny, bx - nx, by - ny];
}

function polylineWidthFills(e: PolylineEnt): number[][][] {
  const w = e.width ?? 0;
  if (!(w > 0) && !e.widths) return [];
  const pts = e.bulges && e.bulges.some((b) => b) ? expandBulges(e.pts, e.bulges, e.closed) : (e.closed ? [...e.pts, e.pts[0], e.pts[1]] : e.pts);
  const fills: number[][][] = [];
  const hw = w / 2;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x1 = pts[i], y1 = pts[i + 1], x2 = pts[i + 2], y2 = pts[i + 3];
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (L === 0) continue;
    let w0 = hw, w1 = hw;
    if (e.widths && !e.bulges?.some((b) => b)) {
      const vi = i / 2;
      w0 = (e.widths[vi * 2] ?? w) / 2; w1 = (e.widths[vi * 2 + 1] ?? w) / 2;
    }
    if (w0 <= 0 && w1 <= 0) continue;
    const nx = -(y2 - y1) / L, ny = (x2 - x1) / L;
    fills.push([[x1 + nx * w0, y1 + ny * w0, x2 + nx * w1, y2 + ny * w1, x2 - nx * w1, y2 - ny * w1, x1 - nx * w0, y1 - ny * w0]]);
  }
  return fills;
}

/** Geometry of a primitive entity in WCS. INSERT/DIMENSION-with-block are expanded by the caller. */
export function geometryOf(e: Entity): Geometry {
  const g = emptyGeom();
  switch (e.type) {
    case 'line':
      g.paths.push({ pts: [e.p1.x, e.p1.y, e.p2.x, e.p2.y], closed: false });
      break;
    case 'polyline': {
      const pts = e.bulges && e.bulges.some((b) => b) ? expandBulges(e.pts, e.bulges, e.closed) : e.pts.slice();
      const closedBulged = e.bulges && e.bulges.some((b) => b) && e.closed;
      if (pts.length >= 2) g.paths.push({ pts: closedBulged ? pts.slice(0, -2) : pts, closed: e.closed });
      const wf = polylineWidthFills(e);
      if (wf.length) g.fills.push(...wf);
      break;
    }
    case 'circle': {
      const pts: number[] = [];
      pushArcPoints(pts, e.c, e.r, 0, TAU, true);
      pts.length -= 2;
      g.paths.push({ pts, closed: true });
      break;
    }
    case 'arc': {
      const pts: number[] = [];
      pushArcPoints(pts, e.c, e.r, e.a0, ccwSweep(e.a0, e.a1), true);
      g.paths.push({ pts, closed: false });
      break;
    }
    case 'ellipse': {
      const pts: number[] = [];
      const ma = Math.hypot(e.major.x, e.major.y);
      const rot = Math.atan2(e.major.y, e.major.x);
      const mb = ma * e.ratio;
      let t0 = e.t0, t1 = e.t1;
      const full = Math.abs(normalizeSweep(t0, t1) - TAU) < 1e-9;
      const sweep = full ? TAU : ccwSweep(t0, t1);
      const n = Math.max(16, Math.min(360, Math.ceil(sweep / (TAU / 96))));
      const c = Math.cos(rot), s = Math.sin(rot);
      for (let i = 0; i <= (full ? n - 1 : n); i++) {
        const t = t0 + (sweep * i) / n;
        const x = Math.cos(t) * ma, y = Math.sin(t) * mb;
        pts.push(e.c.x + x * c - y * s, e.c.y + x * s + y * c);
      }
      g.paths.push({ pts, closed: full });
      break;
    }
    case 'spline': {
      let pts = e.ctrl.length >= 4 ? tessellateSpline(e.degree, e.ctrl, e.knots, e.weights, e.fit) : (e.fit ? catmullRom(e.fit) : []);
      if (pts.length >= 4) g.paths.push({ pts, closed: e.closed });
      break;
    }
    case 'text':
      if (e.value) g.texts.push(textItemOf(e));
      break;
    case 'mtext':
      if (e.value) g.texts.push(mtextItemOf(e));
      break;
    case 'hatch': {
      const loops = e.loops.map(loopPoints).filter((l) => l.length >= 6);
      if (e.solid || !e.patternLines?.length) {
        if (loops.length) g.fills.push(loops);
      } else {
        const pp = hatchPatternPaths(e);
        if (pp === null) { if (loops.length) g.fills.push(loops); }
        else g.paths.push(...pp);
      }
      break;
    }
    case 'point':
      g.paths.push({ pts: [e.p.x, e.p.y, e.p.x, e.p.y], closed: false });
      break;
    case 'solid': {
      const p = e.pts;
      // DXF SOLID order: 1,2,4,3
      if (p.length >= 8) g.fills.push([[p[0], p[1], p[2], p[3], p[6], p[7], p[4], p[5]]]);
      else if (p.length >= 6) g.fills.push([[p[0], p[1], p[2], p[3], p[4], p[5]]]);
      break;
    }
    case 'dimension':
      dimensionFallback(e, g);
      break;
    case 'leader':
      leaderGeom(e, g);
      break;
    case 'image':
      g.paths.push({ pts: e.pts.slice(), closed: true });
      break;
    case 'wipeout':
      if (e.pts.length >= 6) (g.masks ??= []).push([e.pts.slice()]);
      break;
    case 'insert':
      break;
  }
  return g;
}

function normalizeSweep(t0: number, t1: number) {
  const d = t1 - t0;
  if (Math.abs(d) >= TAU - 1e-9) return TAU;
  return ccwSweep(t0, t1);
}

function dimensionFallback(e: DimensionEnt, g: Geometry) {
  const d = e.defPts;
  if (d.length >= 4) {
    for (let i = 0; i + 3 < d.length; i += 2) g.paths.push({ pts: [d[i], d[i + 1], d[i + 2], d[i + 3]], closed: false });
  }
  if (e.text || e.measurement) {
    const txt = e.text && e.text !== '<>' ? e.text.replace('<>', e.measurement.toFixed(2)) : e.measurement.toFixed(2);
    g.texts.push({
      x: e.textPos.x, y: e.textPos.y, h: e.textHeight || 2.5, rot: 0, lines: [decodeText(txt)],
      halign: 'center', valign: 'middle', widthFactor: 1, oblique: 0, lineSpacing: 1,
    });
  }
}

function leaderGeom(e: LeaderEnt, g: Geometry) {
  if (e.pts.length >= 4) {
    g.paths.push({ pts: e.pts.slice(), closed: false });
    if (e.arrow) {
      const tip = { x: e.pts[0], y: e.pts[1] }, from = { x: e.pts[2], y: e.pts[3] };
      const L = Math.hypot(from.x - tip.x, from.y - tip.y);
      const size = Math.min(e.arrowSize ?? 2.5, L * 0.5);
      g.fills.push([arrowHead(tip, from, size)]);
    }
  }
  if (e.text && e.textPos) {
    const last = { x: e.pts[e.pts.length - 2], y: e.pts[e.pts.length - 1] };
    const left = e.pts.length >= 4 && e.pts[e.pts.length - 4] > last.x;
    g.texts.push({
      x: e.textPos.x, y: e.textPos.y, h: e.textHeight || 2.5, rot: 0,
      lines: parseMText(e.text).lines, halign: left ? 'right' : 'left', valign: 'middle',
      widthFactor: 1, oblique: 0, lineSpacing: 1,
    });
  }
}

/** transform geometry by an affine matrix (inserts) */
export function transformGeom(g: Geometry, m: Mat2D): Geometry {
  const tp = (pts: number[]) => {
    const o = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      o[i] = m.a * x + m.c * y + m.e;
      o[i + 1] = m.b * x + m.d * y + m.f;
    }
    return o;
  };
  const det = matDet(m);
  const sy = Math.hypot(m.c, m.d);
  const rot = matRotation(m);
  return {
    paths: g.paths.map((p) => ({ pts: tp(p.pts), closed: p.closed })),
    fills: g.fills.map((f) => f.map(tp)),
    masks: g.masks?.map((f) => f.map(tp)),
    texts: g.texts.map((t) => {
      const p = matApply(m, { x: t.x, y: t.y });
      return { ...t, x: p.x, y: p.y, h: t.h * sy, rot: t.rot + rot, mirrorX: det < 0 ? !t.mirrorX : t.mirrorX, fitWidth: t.fitWidth !== undefined ? t.fitWidth * Math.hypot(m.a, m.b) : undefined };
    }),
  };
}

/** polyline length of a path */
export function pathLength(p: Path): number {
  let L = 0;
  const a = p.pts;
  for (let i = 0; i + 3 < a.length; i += 2) L += Math.hypot(a[i + 2] - a[i], a[i + 3] - a[i + 1]);
  if (p.closed && a.length >= 4) L += Math.hypot(a[0] - a[a.length - 2], a[1] - a[a.length - 1]);
  return L;
}
