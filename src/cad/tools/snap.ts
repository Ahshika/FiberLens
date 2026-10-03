import type { Entity, Vec2 } from '../model/types';
import type { CadDoc } from '../doc/CadDoc';
import { bulgeToArc } from '../geom/bulge';
import { closestOnSeg, ccwSweep } from '../geom/vec';
import { segSegIntersect } from '../geom/intersect';

export type SnapKind = 'end' | 'mid' | 'center' | 'quadrant' | 'node' | 'insert' | 'intersection' | 'perpendicular' | 'nearest' | 'gps' | 'grid';

export interface SnapResult { p: Vec2; kind: SnapKind; entityId?: number }

export interface SnapSettings {
  enabled: boolean;
  kinds: Record<SnapKind, boolean>;
  gridSpacing: number;
}

export const defaultSnapSettings = (): SnapSettings => ({
  enabled: true,
  kinds: { end: true, mid: true, center: true, quadrant: true, node: true, insert: true, intersection: true, perpendicular: true, nearest: false, gps: true, grid: false },
  gridSpacing: 1,
});

const PRIORITY: Record<SnapKind, number> = { gps: 0, end: 1, intersection: 1, center: 2, node: 2, insert: 2, mid: 3, quadrant: 3, perpendicular: 4, grid: 5, nearest: 6 };

/** characteristic points of an entity (used for snapping and grips) */
export function snapPointsOf(e: Entity): { p: Vec2; kind: SnapKind }[] {
  const out: { p: Vec2; kind: SnapKind }[] = [];
  switch (e.type) {
    case 'line':
      out.push({ p: e.p1, kind: 'end' }, { p: e.p2, kind: 'end' }, { p: { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 }, kind: 'mid' });
      break;
    case 'polyline': {
      const n = e.pts.length / 2;
      for (let i = 0; i < n; i++) out.push({ p: { x: e.pts[i * 2], y: e.pts[i * 2 + 1] }, kind: 'end' });
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs && n < 400; i++) {
        const j = (i + 1) % n;
        const b = e.bulges?.[i] ?? 0;
        const x1 = e.pts[i * 2], y1 = e.pts[i * 2 + 1], x2 = e.pts[j * 2], y2 = e.pts[j * 2 + 1];
        if (b) {
          const a = bulgeToArc(x1, y1, x2, y2, b);
          const am = a.a0 + a.sweep / 2;
          out.push({ p: { x: a.c.x + Math.cos(am) * a.r, y: a.c.y + Math.sin(am) * a.r }, kind: 'mid' }, { p: a.c, kind: 'center' });
        } else out.push({ p: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, kind: 'mid' });
      }
      break;
    }
    case 'circle':
      out.push({ p: e.c, kind: 'center' });
      for (let k = 0; k < 4; k++) out.push({ p: { x: e.c.x + Math.cos((k * Math.PI) / 2) * e.r, y: e.c.y + Math.sin((k * Math.PI) / 2) * e.r }, kind: 'quadrant' });
      break;
    case 'arc': {
      const sw = ccwSweep(e.a0, e.a1);
      const pt = (a: number) => ({ x: e.c.x + Math.cos(a) * e.r, y: e.c.y + Math.sin(a) * e.r });
      out.push({ p: pt(e.a0), kind: 'end' }, { p: pt(e.a0 + sw), kind: 'end' }, { p: pt(e.a0 + sw / 2), kind: 'mid' }, { p: e.c, kind: 'center' });
      break;
    }
    case 'ellipse': {
      out.push({ p: e.c, kind: 'center' });
      const mb = { x: -e.major.y * e.ratio, y: e.major.x * e.ratio };
      out.push({ p: { x: e.c.x + e.major.x, y: e.c.y + e.major.y }, kind: 'quadrant' }, { p: { x: e.c.x - e.major.x, y: e.c.y - e.major.y }, kind: 'quadrant' },
        { p: { x: e.c.x + mb.x, y: e.c.y + mb.y }, kind: 'quadrant' }, { p: { x: e.c.x - mb.x, y: e.c.y - mb.y }, kind: 'quadrant' });
      break;
    }
    case 'spline': {
      const src = e.fit && e.fit.length >= 4 ? e.fit : e.ctrl;
      if (src.length >= 4) {
        out.push({ p: { x: src[0], y: src[1] }, kind: 'end' }, { p: { x: src[src.length - 2], y: src[src.length - 1] }, kind: 'end' });
      }
      break;
    }
    case 'text': case 'mtext':
      out.push({ p: e.p, kind: 'insert' });
      break;
    case 'insert':
      out.push({ p: e.p, kind: 'insert' });
      break;
    case 'point':
      out.push({ p: e.p, kind: 'node' });
      break;
    case 'solid': case 'image': case 'wipeout':
      for (let i = 0; i < e.pts.length; i += 2) out.push({ p: { x: e.pts[i], y: e.pts[i + 1] }, kind: 'end' });
      break;
    case 'leader':
      for (let i = 0; i < e.pts.length; i += 2) out.push({ p: { x: e.pts[i], y: e.pts[i + 1] }, kind: 'end' });
      break;
    case 'hatch':
      for (const l of e.loops) if (l.pts.length <= 200) for (let i = 0; i < l.pts.length; i += 2) out.push({ p: { x: l.pts[i], y: l.pts[i + 1] }, kind: 'end' });
      break;
    case 'dimension':
      for (let i = 0; i < e.defPts.length; i += 2) out.push({ p: { x: e.defPts[i], y: e.defPts[i + 1] }, kind: 'node' });
      break;
  }
  return out;
}

export interface SnapContext {
  doc: CadDoc;
  settings: SnapSettings;
  /** world tolerance */
  tol: number;
  base?: Vec2 | null;
  gps?: Vec2 | null;
  exclude?: Set<number>;
}

/** Find the best object snap near p. */
export function findSnap(p: Vec2, ctx: SnapContext): SnapResult | null {
  const { doc, settings, tol } = ctx;
  if (!settings.enabled) return null;
  const K = settings.kinds;
  let best: SnapResult | null = null;
  let bestScore = Infinity;
  const consider = (q: Vec2, kind: SnapKind, entityId?: number) => {
    if (!K[kind]) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > tol) return;
    const score = d / tol + PRIORITY[kind] * 0.25;
    if (score < bestScore) { bestScore = score; best = { p: { x: q.x, y: q.y }, kind, entityId }; }
  };
  if (ctx.gps && K.gps) consider(ctx.gps, 'gps');
  const ids = doc.search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol });
  const cand: number[] = [];
  for (const id of ids) {
    if (ctx.exclude?.has(id)) continue;
    const e = doc.get(id);
    if (!e || !doc.isVisible(e)) continue;
    // very large entities only snap on their own points (not scanned for intersections)
    cand.push(id);
    for (const s of snapPointsOf(e)) consider(s.p, s.kind, id);
  }
  // intersections & perpendicular / nearest from tessellated geometry
  if ((K.intersection || K.perpendicular || K.nearest) && cand.length) {
    const segs: { a: Vec2; b: Vec2; id: number }[] = [];
    for (const id of cand.slice(0, 40)) {
      const g = doc.geometry(id);
      if (!g) continue;
      for (const path of g.paths) {
        const a = path.pts;
        const nv = a.length / 2;
        const segCount = path.closed ? nv : nv - 1;
        for (let k = 0; k < segCount; k++) {
          const i = k * 2, j = ((k + 1) % nv) * 2;
          const ax = a[i], ay = a[i + 1], bx = a[j], by = a[j + 1];
          // keep only segments near the cursor
          const minx = Math.min(ax, bx) - tol, maxx = Math.max(ax, bx) + tol, miny = Math.min(ay, by) - tol, maxy = Math.max(ay, by) + tol;
          if (p.x < minx || p.x > maxx || p.y < miny || p.y > maxy) continue;
          segs.push({ a: { x: ax, y: ay }, b: { x: bx, y: by }, id });
          if (segs.length > 400) break;
        }
      }
    }
    if (K.intersection) {
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].id === segs[j].id) continue;
        const x = segSegIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
        if (x) consider(x, 'intersection', segs[i].id);
      }
    }
    if (K.perpendicular && ctx.base) {
      for (const s of segs) {
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
        const l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = ((ctx.base.x - s.a.x) * dx + (ctx.base.y - s.a.y) * dy) / l2;
        if (t >= 0 && t <= 1) consider({ x: s.a.x + t * dx, y: s.a.y + t * dy }, 'perpendicular', s.id);
      }
    }
    if (K.nearest) for (const s of segs) consider(closestOnSeg(p, s.a, s.b).pt, 'nearest', s.id);
  }
  if (!best && K.grid && settings.gridSpacing > 0) {
    const g = settings.gridSpacing;
    consider({ x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }, 'grid');
  }
  return best;
}

/** constrain p to horizontal/vertical from base (relative to view rotation) */
export function applyOrtho(p: Vec2, base: Vec2, viewRotation = 0): Vec2 {
  const c = Math.cos(-viewRotation), s = Math.sin(-viewRotation);
  const dx = p.x - base.x, dy = p.y - base.y;
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  const ox = Math.abs(rx) >= Math.abs(ry) ? rx : 0, oy = Math.abs(rx) >= Math.abs(ry) ? 0 : ry;
  const c2 = Math.cos(viewRotation), s2 = Math.sin(viewRotation);
  return { x: base.x + ox * c2 - oy * s2, y: base.y + ox * s2 + oy * c2 };
}

/** draw an AutoCAD-style snap marker */
export function drawSnapMarker(ctx: CanvasRenderingContext2D, x: number, y: number, kind: SnapKind) {
  const r = 7;
  ctx.save();
  ctx.strokeStyle = '#ffd400';
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (kind) {
    case 'end': ctx.rect(x - r, y - r, r * 2, r * 2); break;
    case 'mid': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); break;
    case 'center': ctx.arc(x, y, r, 0, Math.PI * 2); break;
    case 'quadrant': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
    case 'intersection': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
    case 'perpendicular': ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r * 0.3, y + r); ctx.lineTo(x - r * 0.3, y - r); break;
    case 'node': ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
    case 'insert': ctx.rect(x - r, y - r, r, r); ctx.rect(x, y, r, r); break;
    case 'nearest': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.closePath(); break;
    case 'gps': ctx.strokeStyle = '#2ea8ff'; ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.moveTo(x - r - 5, y); ctx.lineTo(x + r + 5, y); ctx.moveTo(x, y - r - 5); ctx.lineTo(x, y + r + 5); break;
    case 'grid': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); break;
  }
  ctx.stroke();
  ctx.restore();
}
