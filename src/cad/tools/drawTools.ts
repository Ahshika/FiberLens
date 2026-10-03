import { Tool, type ToolEvent, type ToolOption, parsePointInput } from './types';
import type { Camera } from '../render/camera';
import type { Entity, Vec2, HatchEnt } from '../model/types';
import { drawPreview, drawRubber, drawLabel } from './preview';
import { dist, angleOf, TAU } from '../geom/vec';
import { arcToBulge } from '../geom/bulge';
import { catmullRom } from '../geom/spline';
import { entityLength } from '../edit/measure';
import { geometryOf } from '../geom/tessellate';

/**
 * Base for point-collecting draw tools. Subclasses build an entity (or list) from the
 * collected points plus the live cursor; `need` = points required to finish (0 = until Enter).
 */
abstract class PointsTool extends Tool {
  pts: Vec2[] = [];
  abstract need: number;
  abstract prompts: string[];
  reset() { this.pts = []; this.basePoint = null; }
  protected onActivate() { this.updatePrompt(); }
  updatePrompt() { this.setPrompt(this.prompts[Math.min(this.pts.length, this.prompts.length - 1)]); }
  abstract build(pts: Vec2[], final: boolean): Entity[] | null;

  protected base(): any { return { id: 0, ...this.host.baseProps() }; }

  addPoint(p: Vec2) {
    this.pts.push(p);
    this.basePoint = p;
    if (this.need && this.pts.length >= this.need) this.commit();
    else this.updatePrompt();
    this.host.view.invalidateOverlay();
  }

  click(e: ToolEvent) { this.addPoint(e.p); }

  input(text: string): boolean {
    const p = parsePointInput(text, this.basePoint, this.cursor);
    if (!p) return this.inputValue(text);
    this.addPoint(p);
    return true;
  }
  /** numeric input that is not a point (e.g. radius) */
  inputValue(_t: string): boolean { return false; }

  commit() {
    const ents = this.build(this.pts, true);
    if (ents && ents.length) {
      const doc = this.host.doc;
      for (const e of ents) e.id = doc.newId();
      const withFill = this.withFill(ents);
      doc.add(withFill, `Draw ${this.label}`);
      this.host.notify(`${this.label} created`, 'success');
    }
    this.pts = [];
    this.basePoint = null;
    this.updatePrompt();
  }

  /** optional solid fill (as a HATCH with transparency) for closed shapes */
  withFill(ents: Entity[]): Entity[] {
    const st = this.host.style();
    if (!st.fill) return ents;
    const out = [...ents];
    for (const e of ents) {
      let loop: { pts: number[]; bulges?: number[] } | null = null;
      if (e.type === 'polyline' && e.closed) loop = { pts: e.pts.slice(), bulges: e.bulges?.slice() };
      else if (e.type === 'circle' || e.type === 'ellipse') { const g = geometryOf(e); loop = { pts: g.paths[0].pts }; }
      if (!loop) continue;
      const h: HatchEnt = { ...(this.base() as any), id: this.host.doc.newId(), type: 'hatch', loops: [loop], solid: true, pattern: 'SOLID', transparency: 1 - st.fillAlpha };
      out.unshift(h);
    }
    return out;
  }

  enter() {
    if (!this.need && this.pts.length >= 2) { this.commit(); return; }
    if (this.pts.length === 0) this.host.finish();
    else this.reset(), this.updatePrompt();
  }
  escape() { if (this.pts.length) { this.reset(); this.updatePrompt(); } else this.host.finish(); }

  key(k: KeyboardEvent): boolean {
    if (k.key === 'Backspace' && this.pts.length) { this.pts.pop(); this.basePoint = this.pts[this.pts.length - 1] ?? null; this.updatePrompt(); this.host.view.invalidateOverlay(); return true; }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    const cur = this.cursor;
    const pts = cur ? [...this.pts, cur] : this.pts;
    if (!pts.length) return;
    const ents = this.build(pts, false);
    if (ents) for (const e of ents) drawPreview(ctx, cam, e, undefined, this.host.style().fill);
    if (cur && this.basePoint) {
      const s = cam.worldToScreen(cur.x, cur.y);
      const d = dist(this.basePoint, cur);
      const a = (angleOf(this.basePoint, cur) * 180) / Math.PI;
      const upm = (window as any).fiberlens?.unitsPerMeter?.() ?? 1;
      drawLabel(ctx, s.x, s.y, `${d.toFixed(3)}${upm !== 1 ? ` (${(d / upm).toFixed(2)} m)` : ''}  ∠${((a + 360) % 360).toFixed(1)}°`);
    }
  }
}

export class LineTool extends PointsTool {
  readonly id = 'line'; readonly label = 'Line';
  need = 0;
  prompts = ['Specify first point', 'Specify next point (Enter to finish, Backspace to undo)'];
  // each click adds a segment as a separate LINE (AutoCAD behaviour)
  addPoint(p: Vec2) {
    if (this.pts.length >= 1) {
      const a = this.pts[this.pts.length - 1];
      const e: Entity = { ...this.base(), id: this.host.doc.newId(), type: 'line', p1: a, p2: p };
      this.host.doc.add([e], 'Line');
    }
    this.pts.push(p);
    this.basePoint = p;
    this.updatePrompt();
  }
  enter() { this.reset(); this.updatePrompt(); if (!this.pts.length) this.host.finish(); }
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    return [{ ...this.base(), type: 'line', p1: a, p2: b }];
  }
  commit() { /* lines are committed per segment */ }
}

export class PolylineTool extends PointsTool {
  readonly id = 'polyline'; readonly label = 'Polyline';
  need = 0;
  closed = false;
  arcMode = false;
  bulges: number[] = [];
  prompts = ['Specify start point', 'Next point · Enter = finish · options: Close, Arc'];
  reset() { super.reset(); this.bulges = []; }
  options(): ToolOption[] {
    return [
      { key: 'arc', label: 'Arc segment', type: 'toggle', value: this.arcMode },
      { key: 'close', label: 'Close', type: 'action' },
      { key: 'width', label: 'Width', type: 'number', value: this.width },
    ];
  }
  width = 0;
  setOption(k: string, v: any) {
    if (k === 'arc') this.arcMode = !!v;
    if (k === 'close' && this.pts.length >= 3) { this.closed = true; this.commit(); this.closed = false; }
    if (k === 'width') this.width = Math.max(0, +v || 0);
  }
  addPoint(p: Vec2) {
    if (this.pts.length && this.arcMode) {
      // tangent-continuation arc: bulge from previous direction
      const n = this.pts.length;
      const a = this.pts[n - 1];
      const prevDir = n >= 2 ? angleOf(this.pts[n - 2], a) : 0;
      const chordDir = angleOf(a, p);
      const sweep = 2 * (chordDir - prevDir);
      const s = ((sweep + Math.PI * 3) % TAU) - Math.PI;
      this.bulges[n - 1] = arcToBulge(s);
    } else if (this.pts.length) this.bulges[this.pts.length - 1] = 0;
    super.addPoint(p);
  }
  build(pts: Vec2[], final: boolean): Entity[] | null {
    if (pts.length < 2) return null;
    const flat = pts.flatMap((p) => [p.x, p.y]);
    const bulges = pts.map((_, i) => this.bulges[i] ?? 0);
    if (!final && this.arcMode && pts.length >= 2) {
      const n = pts.length - 1;
      const a = pts[n - 1], p = pts[n];
      const prevDir = n >= 2 ? angleOf(pts[n - 2], a) : 0;
      const sweep = 2 * (angleOf(a, p) - prevDir);
      bulges[n - 1] = arcToBulge(((sweep + Math.PI * 3) % TAU) - Math.PI);
    }
    return [{ ...this.base(), type: 'polyline', pts: flat, closed: this.closed, bulges: bulges.some((b) => b) ? bulges : undefined, width: this.width || undefined }];
  }
}

export class CircleTool extends PointsTool {
  readonly id = 'circle'; readonly label = 'Circle';
  need = 2;
  prompts = ['Specify center point', 'Specify radius (or type a value)'];
  inputValue(t: string) { const r = parseFloat(t); if (this.pts.length === 1 && r > 0) { this.pts.push({ x: this.pts[0].x + r, y: this.pts[0].y }); this.commit(); return true; } return false; }
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const r = dist(pts[0], pts[1]);
    return r > 0 ? [{ ...this.base(), type: 'circle', c: pts[0], r }] : null;
  }
}

/** 3-point arc */
export class ArcTool extends PointsTool {
  readonly id = 'arc'; readonly label = 'Arc';
  need = 3;
  prompts = ['Specify start point', 'Specify second point', 'Specify end point'];
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    if (pts.length === 2) return [{ ...this.base(), type: 'line', p1: pts[0], p2: pts[1] }];
    const c = circumcenter(pts[0], pts[1], pts[2]);
    if (!c) return null;
    const r = dist(c, pts[0]);
    let a0 = angleOf(c, pts[0]), a2 = angleOf(c, pts[2]);
    const a1 = angleOf(c, pts[1]);
    const ccw = ((a1 - a0 + TAU) % TAU) < ((a2 - a0 + TAU) % TAU);
    if (!ccw) [a0, a2] = [a2, a0];
    return [{ ...this.base(), type: 'arc', c, r, a0, a1: a2 }];
  }
}

export function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

export class RectangleTool extends PointsTool {
  readonly id = 'rectangle'; readonly label = 'Rectangle';
  need = 2;
  prompts = ['Specify first corner', 'Specify opposite corner (or @width,height)'];
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const [a, b] = pts;
    const rot = this.host.style().rotation * Math.PI / 180;
    let corners: Vec2[];
    if (rot) {
      // rectangle aligned to rotation, diagonal a→b
      const c = Math.cos(rot), s = Math.sin(rot);
      const dx = b.x - a.x, dy = b.y - a.y;
      const u = dx * c + dy * s, w = -dx * s + dy * c;
      corners = [a, { x: a.x + u * c, y: a.y + u * s }, b, { x: a.x - w * s, y: a.y + w * c }];
    } else corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    return [{ ...this.base(), type: 'polyline', pts: corners.flatMap((p) => [p.x, p.y]), closed: true }];
  }
}

export class TriangleTool extends PointsTool {
  readonly id = 'triangle'; readonly label = 'Triangle';
  need = 3;
  mode: 'free' | 'equilateral' = 'free';
  get prompts() { return this.mode === 'free' ? ['Specify first vertex', 'Specify second vertex', 'Specify third vertex'] : ['Specify base start', 'Specify base end']; }
  set prompts(_v: string[]) { /* computed */ }
  options(): ToolOption[] { return [{ key: 'mode', label: 'Type', type: 'select', value: this.mode, choices: [{ value: 'free', label: '3 points' }, { value: 'equilateral', label: 'Equilateral' }] }]; }
  setOption(k: string, v: any) { if (k === 'mode') { this.mode = v; this.need = v === 'free' ? 3 : 2; this.reset(); this.updatePrompt(); } }
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    let v: Vec2[];
    if (this.mode === 'equilateral') {
      const [a, b] = pts;
      const ang = angleOf(a, b) + Math.PI / 3, L = dist(a, b);
      v = [a, b, { x: a.x + Math.cos(ang) * L, y: a.y + Math.sin(ang) * L }];
    } else v = pts.slice(0, 3);
    return [{ ...this.base(), type: 'polyline', pts: v.flatMap((p) => [p.x, p.y]), closed: v.length === 3 }];
  }
}

export class PolygonTool extends PointsTool {
  readonly id = 'polygon'; readonly label = 'Polygon';
  need = 2;
  sides = 6;
  inscribed = true;
  prompts = ['Specify center', 'Specify radius / vertex'];
  options(): ToolOption[] {
    return [
      { key: 'sides', label: 'Sides', type: 'number', value: this.sides },
      { key: 'insc', label: 'Inscribed', type: 'toggle', value: this.inscribed },
    ];
  }
  setOption(k: string, v: any) { if (k === 'sides') this.sides = Math.max(3, Math.min(64, Math.round(+v || 6))); if (k === 'insc') this.inscribed = !!v; }
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const [c, p] = pts;
    let r = dist(c, p);
    let a0 = angleOf(c, p);
    if (!this.inscribed) { r = r / Math.cos(Math.PI / this.sides); a0 += Math.PI / this.sides; }
    const v: number[] = [];
    for (let i = 0; i < this.sides; i++) { const a = a0 + (i * TAU) / this.sides; v.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r); }
    return [{ ...this.base(), type: 'polyline', pts: v, closed: true }];
  }
}

export class EllipseTool extends PointsTool {
  readonly id = 'ellipse'; readonly label = 'Ellipse';
  need = 3;
  prompts = ['Specify center', 'Specify major axis end point', 'Specify minor axis distance'];
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const [c, m] = pts;
    const major = { x: m.x - c.x, y: m.y - c.y };
    const L = Math.hypot(major.x, major.y);
    if (!L) return null;
    let ratio = 0.5;
    if (pts.length >= 3) {
      const p = pts[2];
      const d = Math.abs((p.x - c.x) * -major.y / L + (p.y - c.y) * major.x / L);
      ratio = Math.max(0.01, Math.min(1, d / L));
      if (d > L) return [{ ...this.base(), type: 'ellipse', c, major: { x: -major.y * d / L, y: major.x * d / L }, ratio: L / d, t0: 0, t1: TAU }];
    }
    return [{ ...this.base(), type: 'ellipse', c, major, ratio, t0: 0, t1: TAU }];
  }
}

/** Revision cloud around a rectangle or polygon */
export class CloudTool extends PointsTool {
  readonly id = 'cloud'; readonly label = 'Revision Cloud';
  need = 2;
  arc = 0;
  shape: 'rect' | 'polygon' = 'rect';
  get prompts() { return this.shape === 'rect' ? ['Specify first corner', 'Specify opposite corner'] : ['Specify first point', 'Next point · Enter to close']; }
  set prompts(_v: string[]) { /* computed */ }
  options(): ToolOption[] {
    return [
      { key: 'shape', label: 'Shape', type: 'select', value: this.shape, choices: [{ value: 'rect', label: 'Rectangle' }, { value: 'polygon', label: 'Polygon' }] },
      { key: 'arc', label: 'Arc length', type: 'number', value: this.arc || '' },
    ];
  }
  setOption(k: string, v: any) { if (k === 'shape') { this.shape = v; this.need = v === 'rect' ? 2 : 0; this.reset(); this.updatePrompt(); } if (k === 'arc') this.arc = +v || 0; }
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    let poly: Vec2[];
    if (this.shape === 'rect') { const [a, b] = pts; poly = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; }
    else poly = pts;
    if (poly.length < 2) return null;
    let per = 0;
    for (let i = 0; i < poly.length; i++) per += dist(poly[i], poly[(i + 1) % poly.length]);
    const arcLen = this.arc > 0 ? this.arc : Math.max(per / 40, 1e-6);
    const out: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = dist(a, b);
      const n = Math.max(1, Math.round(L / arcLen));
      for (let k = 0; k < n; k++) out.push(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
    }
    // detect orientation so arcs bulge outward
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p.x * q.y - q.x * p.y; }
    const b = area > 0 ? -0.6 : 0.6;
    return [{ ...this.base(), type: 'polyline', pts: out, bulges: out.filter((_, i) => i % 2 === 0).map(() => b), closed: true }];
  }
}

export class ArrowTool extends PointsTool {
  readonly id = 'arrow'; readonly label = 'Arrow';
  need = 2;
  prompts = ['Specify arrow tail', 'Specify arrow head'];
  build(pts: Vec2[]): Entity[] | null {
    if (pts.length < 2) return null;
    const [a, b] = pts;
    const L = dist(a, b);
    return [{ ...this.base(), type: 'leader', pts: [b.x, b.y, a.x, a.y], arrow: true, arrowSize: Math.max(L * 0.12, this.host.style().textHeight) }];
  }
}

export class PointTool extends PointsTool {
  readonly id = 'point'; readonly label = 'Point';
  need = 1;
  prompts = ['Specify point location (Enter to finish)'];
  build(pts: Vec2[]): Entity[] | null { return pts.length ? [{ ...this.base(), type: 'point', p: pts[0] }] : null; }
}

export class LeaderTool extends PointsTool {
  readonly id = 'leader'; readonly label = 'Leader';
  need = 0;
  prompts = ['Specify arrow point', 'Next point · Enter to type the text'];
  async commit() {
    const pts = this.pts.slice();
    this.reset(); this.updatePrompt();
    if (pts.length < 2) return;
    const text = await this.host.askText('Leader text', '', true);
    const st = this.host.style();
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const dir = last.x >= prev.x ? 1 : -1;
    const e: Entity = {
      ...this.base(), id: this.host.doc.newId(), type: 'leader', pts: pts.flatMap((p) => [p.x, p.y]), arrow: true,
      arrowSize: st.textHeight, text: text || undefined, textHeight: st.textHeight,
      textPos: text ? { x: last.x + dir * st.textHeight * 0.5, y: last.y } : undefined,
    };
    this.host.doc.add([e], 'Leader');
  }
  build(pts: Vec2[]): Entity[] | null {
    return pts.length >= 2 ? [{ ...this.base(), type: 'leader', pts: pts.flatMap((p) => [p.x, p.y]), arrow: true, arrowSize: this.host.style().textHeight }] : null;
  }
}

/** Freehand sketch: drag to draw (smoothed polyline) */
export class FreehandTool extends Tool {
  readonly id = 'freehand'; readonly label = 'Freehand';
  wantsDrag = true;
  wantsSnap = false;
  private stroke: Vec2[] = [];
  protected onActivate() { this.setPrompt('Drag to sketch · release to commit'); }
  drag(e: ToolEvent, start: ToolEvent) {
    if (!this.stroke.length) this.stroke.push(start.raw);
    const last = this.stroke[this.stroke.length - 1];
    if (dist(last, e.raw) > this.host.pickTol(3)) this.stroke.push(e.raw);
  }
  dragEnd() {
    if (this.stroke.length >= 2) {
      const tol = this.host.pickTol(1.5);
      const simp = simplify(this.stroke, tol);
      const flat = simp.flatMap((p) => [p.x, p.y]);
      const smooth = simp.length >= 3 ? catmullRom(flat, 4) : flat;
      this.host.doc.add([{ id: this.host.doc.newId(), ...this.host.baseProps(), type: 'polyline', pts: smooth, closed: false } as Entity], 'Freehand');
    }
    this.stroke = [];
  }
  escape() { this.stroke = []; this.host.finish(); }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) { drawRubber(ctx, cam, this.stroke, false, '#7fd4ff'); }
}

/** Douglas-Peucker simplification */
export function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1, bd = tol;
    const a = pts[i], b = pts[j];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k].x - a.x) * dy - (pts[k].y - a.y) * dx) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Hatch: pick boundary points, or tap inside a closed entity */
export class HatchTool extends PointsTool {
  readonly id = 'hatch'; readonly label = 'Hatch';
  need = 0;
  pattern = 'SOLID';
  scale = 1;
  angle = 0;
  prompts = ['Tap inside a closed shape, or pick boundary points (Enter to close)', 'Next boundary point · Enter to close'];
  options(): ToolOption[] {
    return [
      { key: 'pattern', label: 'Pattern', type: 'select', value: this.pattern, choices: ['SOLID', 'ANSI31', 'ANSI37', 'NET', 'LINE', 'DOTS'].map((v) => ({ value: v, label: v })) },
      { key: 'scale', label: 'Scale', type: 'number', value: this.scale },
      { key: 'angle', label: 'Angle°', type: 'number', value: this.angle },
    ];
  }
  setOption(k: string, v: any) { if (k === 'pattern') this.pattern = v; if (k === 'scale') this.scale = +v || 1; if (k === 'angle') this.angle = +v || 0; }

  click(e: ToolEvent) {
    if (this.pts.length === 0) {
      // try "pick inside" a closed entity
      const doc = this.host.doc;
      const ids = doc.search({ minX: e.raw.x, minY: e.raw.y, maxX: e.raw.x, maxY: e.raw.y });
      let best: { loop: { pts: number[]; bulges?: number[] }; area: number } | null = null;
      for (const id of ids) {
        const en = doc.get(id);
        if (!en || !doc.isVisible(en)) continue;
        let loop: { pts: number[]; bulges?: number[] } | null = null;
        if (en.type === 'polyline' && en.closed) loop = { pts: en.pts.slice(), bulges: en.bulges?.slice() };
        else if (en.type === 'circle' || en.type === 'ellipse') loop = { pts: geometryOf(en).paths[0].pts };
        if (!loop) continue;
        const g = geometryOf({ ...en, type: 'polyline', pts: loop.pts, bulges: loop.bulges, closed: true } as any);
        const poly = g.paths[0].pts;
        if (!pip(e.raw, poly)) continue;
        const b = doc.box(id)!;
        const area = (b.maxX - b.minX) * (b.maxY - b.minY);
        if (!best || area < best.area) best = { loop, area };
      }
      if (best) { this.create([best.loop]); return; }
    }
    this.addPoint(e.p);
  }
  commit() {
    if (this.pts.length >= 3) this.create([{ pts: this.pts.flatMap((p) => [p.x, p.y]) }]);
    this.reset(); this.updatePrompt();
  }
  create(loops: { pts: number[]; bulges?: number[] }[]) {
    const solid = this.pattern === 'SOLID';
    const st = this.host.style();
    const h: HatchEnt = {
      ...(this.base() as any), id: this.host.doc.newId(), type: 'hatch', loops, solid, pattern: this.pattern,
      patternAngle: this.angle * Math.PI / 180, patternScale: this.scale,
      patternLines: solid ? undefined : patternLines(this.pattern, this.scale * st.textHeight, this.angle * Math.PI / 180),
      transparency: solid && st.fill ? 1 - st.fillAlpha : this.host.baseProps().transparency,
    };
    this.host.doc.add([h], 'Hatch');
  }
  build(pts: Vec2[]): Entity[] | null {
    return pts.length >= 2 ? [{ ...this.base(), type: 'polyline', pts: pts.flatMap((p) => [p.x, p.y]), closed: true }] : null;
  }
  withFill(e: Entity[]) { return e; }
}

function pip(p: Vec2, l: number[]) {
  let inside = false;
  const n = l.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = l[i * 2], yi = l[i * 2 + 1], xj = l[j * 2], yj = l[j * 2 + 1];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** simple built-in hatch patterns (world units) */
export function patternLines(name: string, s: number, ang: number) {
  const L = (deg: number, off: number, dashes: number[] = []) => {
    const a = ang + (deg * Math.PI) / 180;
    return { angle: a, base: { x: 0, y: 0 }, offset: { x: -Math.sin(a) * off, y: Math.cos(a) * off }, dashes };
  };
  switch (name) {
    case 'ANSI31': return [L(45, s)];
    case 'ANSI37': return [L(45, s), L(135, s)];
    case 'NET': return [L(0, s), L(90, s)];
    case 'LINE': return [L(0, s)];
    case 'DOTS': return [L(0, s, [0, -s])];
    default: return [L(45, s)];
  }
}

export { entityLength };
