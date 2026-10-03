import { create } from 'zustand';
import { Tool, type ToolEvent, type ToolOption, parsePointInput } from './types';
import type { Camera } from '../render/camera';
import type { Vec2, Entity } from '../model/types';
import { drawLabel } from './preview';
import { polylineLength, polygonArea, angleAt, entityLength, entityArea } from '../edit/measure';
import { distToSeg, dist } from '../geom/vec';

export interface MeasureResult { kind: string; text: string; value: number; meters?: number; at: number; pts?: Vec2[] }
export const useMeasure = create<{ results: MeasureResult[]; add: (r: MeasureResult) => void; clear: () => void }>((set, get) => ({
  results: [],
  add: (r) => set({ results: [r, ...get().results].slice(0, 50) }),
  clear: () => set({ results: [] }),
}));

const upm = (): number => (window as any).fiberlens?.unitsPerMeter?.() ?? 1;
const fmtLen = (d: number) => { const u = upm(); return u !== 1 ? `${(d / u).toFixed(2)} m (${d.toFixed(3)} du)` : `${d.toFixed(2)} m`; };
const fmtArea = (a: number) => { const u = upm(); return `${(a / u / u).toFixed(2)} m²`; };

function strokePts(ctx: CanvasRenderingContext2D, cam: Camera, pts: Vec2[], closed: boolean, fill = false) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#ffcf33'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(255,207,51,0.15)';
  ctx.beginPath();
  pts.forEach((p, i) => { const s = cam.worldToScreen(p.x, p.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
  if (closed) ctx.closePath();
  if (fill) ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffcf33';
  for (const p of pts) { const s = cam.worldToScreen(p.x, p.y); ctx.fillRect(s.x - 3, s.y - 3, 6, 6); }
  ctx.restore();
}

abstract class PtsMeasure extends Tool {
  pts: Vec2[] = [];
  last: MeasureResult | null = null;
  reset() { this.pts = []; this.basePoint = null; }
  click(e: ToolEvent) { this.add(e.p); }
  input(t: string) { const p = parsePointInput(t, this.basePoint, this.cursor); if (!p) return false; this.add(p); return true; }
  add(p: Vec2) { this.pts.push(p); this.basePoint = p; this.after(); this.host.view.invalidateOverlay(); }
  abstract after(): void;
  escape() { if (this.pts.length) { this.reset(); this.last = null; this.setPrompt(this.prompt); } else this.host.finish(); }
  key(k: KeyboardEvent) { if (k.key === 'Backspace' && this.pts.length) { this.pts.pop(); this.basePoint = this.pts[this.pts.length - 1] ?? null; this.host.view.invalidateOverlay(); return true; } return false; }
}

export class DistanceTool extends PtsMeasure {
  readonly id = 'mdist'; readonly label = 'Measure Distance';
  protected onActivate() { this.setPrompt('Pick points along the path · Enter = finish'); }
  after() {
    if (this.pts.length >= 2) this.setPrompt(`Total ${fmtLen(polylineLength(this.pts))} · Enter = save`);
  }
  enter() {
    if (this.pts.length >= 2) {
      const L = polylineLength(this.pts);
      useMeasure.getState().add({ kind: 'Distance', text: fmtLen(L), value: L, meters: L / upm(), at: Date.now(), pts: this.pts.slice() });
      this.host.notify(`Distance: ${fmtLen(L)}`, 'success');
      this.reset();
    } else this.host.finish();
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    const pts = this.cursor ? [...this.pts, this.cursor] : this.pts;
    strokePts(ctx, cam, pts, false);
    if (pts.length >= 2) {
      const s = cam.worldToScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const seg = dist(pts[pts.length - 2], pts[pts.length - 1]);
      drawLabel(ctx, s.x, s.y, `Segment ${fmtLen(seg)}\nTotal ${fmtLen(polylineLength(pts))}`, 'rgba(60,45,0,0.9)');
    }
  }
}

export class AreaTool extends PtsMeasure {
  readonly id = 'marea'; readonly label = 'Measure Area';
  protected onActivate() { this.setPrompt('Pick polygon vertices · Enter = finish · or tap inside a closed object with Ctrl'); }
  after() { if (this.pts.length >= 3) this.setPrompt(`Area ${fmtArea(polygonArea(this.pts))}`); }
  click(e: ToolEvent) {
    if (e.ctrl || (this.pts.length === 0 && e.pointerType === 'touch' && false)) {
      const id = this.host.doc.pick(e.raw, this.host.pickTol(10));
      const en = id !== null ? this.host.doc.get(id) : null;
      const a = en ? entityArea(en) : null;
      if (en && a !== null) {
        const L = entityLength(en) ?? 0;
        useMeasure.getState().add({ kind: 'Area', text: `${fmtArea(a)} · perimeter ${fmtLen(L)}`, value: a, at: Date.now() });
        this.host.notify(`Area: ${fmtArea(a)}`, 'success');
        return;
      }
    }
    super.click(e);
  }
  enter() {
    if (this.pts.length >= 3) {
      const a = polygonArea(this.pts);
      const per = polylineLength([...this.pts, this.pts[0]]);
      useMeasure.getState().add({ kind: 'Area', text: `${fmtArea(a)} · perimeter ${fmtLen(per)}`, value: a, at: Date.now(), pts: this.pts.slice() });
      this.host.notify(`Area: ${fmtArea(a)}`, 'success');
      this.reset();
    } else this.host.finish();
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    const pts = this.cursor ? [...this.pts, this.cursor] : this.pts;
    strokePts(ctx, cam, pts, true, true);
    if (pts.length >= 3) {
      const c = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
      const s = cam.worldToScreen(c.x, c.y);
      drawLabel(ctx, s.x - 40, s.y - 20, `Area ${fmtArea(polygonArea(pts))}\nPerimeter ${fmtLen(polylineLength([...pts, pts[0]]))}`, 'rgba(60,45,0,0.9)');
    }
  }
}

export class AngleTool extends PtsMeasure {
  readonly id = 'mangle'; readonly label = 'Measure Angle';
  protected onActivate() { this.setPrompt('Pick the vertex, then two points on the arms'); }
  after() {
    if (this.pts.length === 3) {
      const a = angleAt(this.pts[1], this.pts[0], this.pts[2]);
      useMeasure.getState().add({ kind: 'Angle', text: `${a.toFixed(3)}°`, value: a, at: Date.now(), pts: this.pts.slice() });
      this.host.notify(`Angle: ${a.toFixed(3)}°`, 'success');
      this.last = { kind: 'Angle', text: `${a.toFixed(3)}°`, value: a, at: Date.now(), pts: this.pts.slice() };
      this.reset();
    } else this.setPrompt(this.pts.length === 1 ? 'Pick a point on the first arm' : 'Pick a point on the second arm');
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    const pts = this.cursor ? [...this.pts, this.cursor] : this.pts;
    if (pts.length >= 2) strokePts(ctx, cam, [pts[1], pts[0], ...(pts[2] ? [pts[2]] : [])], false);
    if (pts.length === 3) {
      const s = cam.worldToScreen(pts[0].x, pts[0].y);
      drawLabel(ctx, s.x, s.y, `${angleAt(pts[1], pts[0], pts[2]).toFixed(2)}°`, 'rgba(60,45,0,0.9)');
    }
    if (this.last?.pts && !this.pts.length) strokePts(ctx, cam, [this.last.pts[1], this.last.pts[0], this.last.pts[2]], false);
  }
}

/** Length of an object (cable / duct / any curve) or area of closed objects */
export class ObjectLengthTool extends Tool {
  readonly id = 'mobject'; readonly label = 'Object Length';
  wantsSnap = false;
  private picked: number[] = [];
  protected onActivate() { this.setPrompt('Tap cables / ducts / polylines to sum their lengths (Enter = save)'); }
  reset() { this.picked = []; }
  click(e: ToolEvent) {
    const id = this.host.doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
    if (id === null) return;
    const en = this.host.doc.get(id)!;
    const L = entityLength(en);
    if (L === null) { this.host.notify('Not a curve'); return; }
    if (this.picked.includes(id)) this.picked = this.picked.filter((x) => x !== id); else this.picked.push(id);
    this.host.selection.set(this.picked);
    this.setPrompt(`${this.picked.length} objects · total ${fmtLen(this.total())}`);
  }
  total() { return this.picked.reduce((s, id) => s + (entityLength(this.host.doc.get(id)!) ?? 0), 0); }
  enter() {
    if (this.picked.length) {
      const T = this.total();
      const layer = this.host.doc.get(this.picked[0])?.layer;
      useMeasure.getState().add({ kind: 'Cable/duct length', text: `${this.picked.length} obj (${layer}) · ${fmtLen(T)}`, value: T, meters: T / upm(), at: Date.now() });
      this.picked = []; this.host.selection.clear();
      this.setPrompt('Saved. Tap more objects or Enter to finish');
    } else this.host.finish();
  }
}

/** Minimum distance between two objects */
export class ObjDistanceTool extends Tool {
  readonly id = 'mobjdist'; readonly label = 'Distance Between Objects';
  wantsSnap = false;
  private a: number | null = null;
  private line: [Vec2, Vec2] | null = null;
  options(): ToolOption[] { return []; }
  protected onActivate() { this.setPrompt('Tap the first object'); }
  reset() { this.a = null; this.line = null; }
  click(e: ToolEvent) {
    const doc = this.host.doc;
    const id = doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 14 : 6));
    if (id === null) return;
    if (this.a === null) { this.a = id; this.host.selection.set([id]); this.setPrompt('Tap the second object'); return; }
    const r = minDistance(doc.geometry(this.a)!, doc.geometry(id)!);
    if (r) {
      this.line = [r.a, r.b];
      useMeasure.getState().add({ kind: 'Object distance', text: fmtLen(r.d), value: r.d, meters: r.d / upm(), at: Date.now(), pts: [r.a, r.b] });
      this.host.notify(`Distance: ${fmtLen(r.d)}`, 'success');
    }
    this.a = null; this.host.selection.clear();
    this.setPrompt('Tap the first object');
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.line) {
      strokePts(ctx, cam, this.line, false);
      const s = cam.worldToScreen((this.line[0].x + this.line[1].x) / 2, (this.line[0].y + this.line[1].y) / 2);
      drawLabel(ctx, s.x, s.y, fmtLen(dist(this.line[0], this.line[1])), 'rgba(60,45,0,0.9)');
    }
  }
}

function vertsOf(g: { paths: { pts: number[] }[]; texts: { x: number; y: number }[] }): number[][] {
  const out = g.paths.map((p) => p.pts);
  for (const t of g.texts) out.push([t.x, t.y]);
  return out;
}

/** approximate min distance between two tessellated geometries (vertex-to-segment both ways) */
export function minDistance(ga: any, gb: any): { d: number; a: Vec2; b: Vec2 } | null {
  let best: { d: number; a: Vec2; b: Vec2 } | null = null;
  const test = (P: number[][], Q: number[][], swap: boolean) => {
    for (const p of P) for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      for (const q of Q) {
        if (q.length === 2) {
          const d = Math.hypot(q[0] - x, q[1] - y);
          if (!best || d < best.d) best = { d, a: swap ? { x: q[0], y: q[1] } : { x, y }, b: swap ? { x, y } : { x: q[0], y: q[1] } };
          continue;
        }
        for (let k = 0; k + 3 < q.length; k += 2) {
          const d = distToSeg(x, y, q[k], q[k + 1], q[k + 2], q[k + 3]);
          if (!best || d < best.d) {
            const dx = q[k + 2] - q[k], dy = q[k + 3] - q[k + 1], l2 = dx * dx + dy * dy;
            const t = l2 ? Math.max(0, Math.min(1, ((x - q[k]) * dx + (y - q[k + 1]) * dy) / l2)) : 0;
            const c = { x: q[k] + t * dx, y: q[k + 1] + t * dy };
            best = { d, a: swap ? c : { x, y }, b: swap ? { x, y } : c };
          }
        }
      }
    }
  };
  const A = vertsOf(ga), B = vertsOf(gb);
  test(A, B, false); test(B, A, true);
  return best;
}

export type { Entity };
