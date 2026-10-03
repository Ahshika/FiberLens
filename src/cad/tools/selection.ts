import type { CadDoc } from '../doc/CadDoc';
import type { CadView } from '../render/CadView';
import type { Camera } from '../render/camera';
import type { Vec2 } from '../model/types';
import { snapPointsOf } from './snap';

export interface Highlight { ids: number[]; color: string; width?: number; dash?: number[]; label?: string }

/** Current selection + hover + named highlight sets (trace, search results, compare). */
export class SelectionManager {
  ids = new Set<number>();
  hover: number | null = null;
  highlights = new Map<string, Highlight>();
  private listeners = new Set<() => void>();
  showGrips = true;

  constructor(private view: CadView, private getDoc: () => CadDoc | null) {
    view.addOverlay('selection', (ctx, cam) => this.draw(ctx, cam), 10);
  }

  onChange(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit() { this.view.invalidateOverlay(); for (const l of this.listeners) l(); }

  get list() { return [...this.ids]; }
  get size() { return this.ids.size; }
  has(id: number) { return this.ids.has(id); }
  set(ids: Iterable<number>) { this.ids = new Set(ids); this.emit(); }
  add(ids: Iterable<number>) { for (const i of ids) this.ids.add(i); this.emit(); }
  toggle(id: number) { if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id); this.emit(); }
  remove(ids: Iterable<number>) { for (const i of ids) this.ids.delete(i); this.emit(); }
  clear() { if (this.ids.size) { this.ids.clear(); this.emit(); } }
  setHover(id: number | null) { if (id !== this.hover) { this.hover = id; this.view.invalidateOverlay(); } }
  /** drop ids that no longer exist */
  prune() {
    const doc = this.getDoc();
    if (!doc) return;
    let changed = false;
    for (const id of this.ids) if (!doc.get(id)) { this.ids.delete(id); changed = true; }
    if (changed) this.emit();
  }

  setHighlight(key: string, h: Highlight | null) {
    if (h) this.highlights.set(key, h); else this.highlights.delete(key);
    this.view.invalidateOverlay();
  }

  /** grips of selected entities (limited) */
  grips(): { p: Vec2; id: number; index: number }[] {
    const doc = this.getDoc();
    if (!doc || !this.showGrips || this.ids.size > 60) return [];
    const out: { p: Vec2; id: number; index: number }[] = [];
    for (const id of this.ids) {
      const e = doc.get(id);
      if (!e) continue;
      snapPointsOf(e).forEach((s, i) => out.push({ p: s.p, id, index: i }));
    }
    return out;
  }

  private strokeEntity(ctx: CanvasRenderingContext2D, cam: Camera, id: number) {
    const doc = this.getDoc();
    const g = doc?.geometry(id);
    if (!g) return;
    const vb = cam.viewBox(50);
    const b = doc!.box(id);
    if (b && (b.maxX < vb.minX || b.minX > vb.maxX || b.maxY < vb.minY || b.minY > vb.maxY)) return;
    for (const p of g.paths) {
      const a = p.pts;
      if (a.length < 2) continue;
      const s0 = cam.worldToScreen(a[0], a[1]);
      ctx.moveTo(s0.x, s0.y);
      if (a.length <= 4 && a[0] === a[2] && a[1] === a[3]) { ctx.arc(s0.x, s0.y, 3, 0, Math.PI * 2); continue; }
      for (let i = 2; i < a.length; i += 2) { const s = cam.worldToScreen(a[i], a[i + 1]); ctx.lineTo(s.x, s.y); }
      if (p.closed) ctx.closePath();
    }
    for (const f of g.fills) for (const l of f) {
      const s0 = cam.worldToScreen(l[0], l[1]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 2; i < l.length; i += 2) { const s = cam.worldToScreen(l[i], l[i + 1]); ctx.lineTo(s.x, s.y); }
      ctx.closePath();
    }
    for (const t of g.texts) {
      // text: draw its rotated box
      const w = Math.max(...t.lines.map((l) => l.length)) * t.h * 0.62 * t.widthFactor;
      const hgt = t.h * (1 + (t.lines.length - 1) * 1.66);
      let x0 = 0;
      if (t.halign === 'center') x0 = -w / 2; else if (t.halign === 'right') x0 = -w;
      const yTop = t.valign === 'top' ? 0 : t.valign === 'middle' ? hgt / 2 : t.valign === 'bottom' ? hgt : t.h;
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      const corners = [[x0, yTop - hgt], [x0 + w, yTop - hgt], [x0 + w, yTop], [x0, yTop]].map(([x, y]) => cam.worldToScreen(t.x + x * c - y * s, t.y + x * s + y * c));
      ctx.moveTo(corners[0].x, corners[0].y);
      for (const k of corners.slice(1)) ctx.lineTo(k.x, k.y);
      ctx.closePath();
    }
  }

  private draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    // named highlights (trace etc.)
    for (const h of this.highlights.values()) {
      ctx.save();
      ctx.strokeStyle = h.color;
      ctx.lineWidth = h.width ?? 4;
      ctx.globalAlpha = 0.85;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (h.dash) ctx.setLineDash(h.dash);
      ctx.beginPath();
      for (const id of h.ids.slice(0, 5000)) this.strokeEntity(ctx, cam, id);
      ctx.stroke();
      ctx.restore();
    }
    if (this.hover !== null && !this.ids.has(this.hover)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(46,168,255,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      this.strokeEntity(ctx, cam, this.hover);
      ctx.stroke();
      ctx.restore();
    }
    if (!this.ids.size) return;
    ctx.save();
    ctx.lineWidth = 2.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#2ea8ff';
    ctx.beginPath();
    let n = 0;
    for (const id of this.ids) { if (n++ > 3000) break; this.strokeEntity(ctx, cam, id); }
    ctx.stroke();
    ctx.setLineDash([]);
    // grips
    const grips = this.grips();
    ctx.fillStyle = '#1e6bff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (const g of grips) {
      const s = cam.worldToScreen(g.p.x, g.p.y);
      ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
      ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
    }
    ctx.restore();
  }
}
