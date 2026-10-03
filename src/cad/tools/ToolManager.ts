import type { CadView } from '../render/CadView';
import type { CadDoc } from '../doc/CadDoc';
import type { Vec2 } from '../model/types';
import { Tool, type ToolEvent, type ToolHost } from './types';
import { findSnap, applyOrtho, drawSnapMarker, type SnapSettings, type SnapResult } from './snap';

export interface InteractionSettings {
  snap: SnapSettings;
  ortho: boolean;
  /** current GPS position in drawing coordinates (for GPS snap) */
  gps: () => Vec2 | null;
}

type ToolFactory = () => Tool;

/**
 * Routes pointer/keyboard input to the active tool and drives camera gestures
 * (wheel zoom, pinch zoom, pan). Works with mouse, pen and touch.
 */
export class ToolManager {
  private factories = new Map<string, ToolFactory>();
  active: Tool | null = null;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private down: { ev: ToolEvent; x: number; y: number; t: number; button: number; moved: boolean; mode: 'none' | 'pan' | 'drag' | 'pinch' } | null = null;
  private pinch: { d: number; cx: number; cy: number } | null = null;
  private longPressTimer: any = 0;
  private longPressArmed = false;
  lastEvent: ToolEvent | null = null;
  lastSnap: SnapResult | null = null;
  private mouseInside = false;
  onCursor: ((p: Vec2) => void) | null = null;
  onToolChange: ((t: Tool | null) => void) | null = null;
  lastPointerType = 'mouse';

  constructor(
    public view: CadView,
    private el: HTMLElement,
    public host: Omit<ToolHost, 'finish'> & { finish?: () => void },
    public settings: InteractionSettings,
  ) {
    (this.host as ToolHost).finish = () => this.setTool('select');
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('pointerleave', () => { this.mouseInside = false; this.view.invalidateOverlay(); });
    el.addEventListener('pointerenter', () => { this.mouseInside = true; });
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKey);
    view.addOverlay('tool', (ctx, cam) => {
      this.active?.overlay(ctx, cam);
      const s = this.lastSnap;
      if (s) { const p = cam.worldToScreen(s.p.x, s.p.y); drawSnapMarker(ctx, p.x, p.y, s.kind); }
      // crosshair for mouse
      if (this.lastEvent && this.mouseInside && this.lastPointerType === 'mouse' && this.active && this.active.id !== 'select') {
        const p = this.lastSnap ? cam.worldToScreen(this.lastSnap.p.x, this.lastSnap.p.y) : { x: this.lastEvent.sx, y: this.lastEvent.sy };
        ctx.save();
        ctx.strokeStyle = this.view.opts.dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - 24, p.y); ctx.lineTo(p.x + 24, p.y); ctx.moveTo(p.x, p.y - 24); ctx.lineTo(p.x, p.y + 24);
        ctx.stroke();
        ctx.restore();
      }
    }, 50);
  }

  register(id: string, f: ToolFactory) { this.factories.set(id, f); }
  has(id: string) { return this.factories.has(id); }

  setTool(id: string | Tool) {
    this.active?.deactivate();
    let t: Tool | null;
    if (typeof id === 'string') {
      const f = this.factories.get(id);
      t = f ? f() : null;
    } else t = id;
    this.active = t;
    this.lastSnap = null;
    if (t) t.activate(this.host as ToolHost);
    this.view.invalidateOverlay();
    this.onToolChange?.(t);
  }

  get doc(): CadDoc | null { return this.view.doc; }

  private makeEvent(e: PointerEvent | MouseEvent, snap = true): ToolEvent {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const raw = this.view.cam.screenToWorld(sx, sy);
    let p = raw;
    let s: SnapResult | null = null;
    const tool = this.active;
    const pointerType = (e as PointerEvent).pointerType ?? 'mouse';
    const doc = this.doc;
    if (snap && tool?.wantsSnap && doc) {
      const tolPx = pointerType === 'touch' ? 26 : 12;
      s = findSnap(raw, { doc, settings: this.settings.snap, tol: tolPx / this.view.cam.scale, base: tool.basePoint, gps: this.settings.gps() });
      if (s) p = s.p;
    }
    if (!s && tool?.basePoint && (this.settings.ortho !== e.shiftKey) && tool.wantsSnap) {
      p = applyOrtho(raw, tool.basePoint, this.view.cam.rotation);
    }
    return { sx, sy, raw, p, snap: s, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, pointerType };
  }

  private onDown = (e: PointerEvent) => {
    this.el.setPointerCapture(e.pointerId);
    this.lastPointerType = e.pointerType;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pointers.size === 2) {
      // start pinch, cancel single-pointer action
      clearTimeout(this.longPressTimer);
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      if (this.down) this.down.mode = 'pinch';
      return;
    }
    if (this.pointers.size > 2) return;
    const ev = this.makeEvent(e);
    this.down = { ev, x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false, mode: 'none' };
    if (e.button === 1 || e.button === 2) { this.down.mode = 'pan'; return; }
    this.active?.down(ev);
    if (e.pointerType === 'touch' && this.active?.id === 'select') {
      this.longPressArmed = false;
      this.longPressTimer = setTimeout(() => {
        if (this.down && !this.down.moved) { this.longPressArmed = true; navigator.vibrate?.(20); this.down.mode = 'drag'; }
      }, 450);
    }
  };

  private onMove = (e: PointerEvent) => {
    this.lastPointerType = e.pointerType;
    const prev = this.pointers.get(e.pointerId);
    if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    // pinch / two-finger pan
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = this.el.getBoundingClientRect();
      this.view.cam.panPixels(cx - this.pinch.cx, cy - this.pinch.cy);
      if (this.pinch.d > 0 && d > 0) this.view.cam.zoomAt(cx - r.left, cy - r.top, d / this.pinch.d);
      this.pinch = { d, cx, cy };
      this.view.viewChanged();
      return;
    }
    const ev = this.makeEvent(e, !this.down || this.down.mode === 'none' || this.down.mode === 'drag');
    this.lastEvent = ev;
    this.lastSnap = ev.snap;
    this.onCursor?.(ev.p);
    const dn = this.down;
    if (dn && prev) {
      const dist = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
      const thresh = e.pointerType === 'touch' ? 10 : 4;
      if (!dn.moved && dist > thresh) {
        dn.moved = true;
        clearTimeout(this.longPressTimer);
        if (dn.mode === 'none') {
          const toolDrag = this.active && (this.active.wantsDrag || (e.pointerType !== 'touch' && dn.button === 0) || this.longPressArmed);
          dn.mode = toolDrag ? 'drag' : 'pan';
        }
      }
      if (dn.moved) {
        if (dn.mode === 'pan') {
          this.view.cam.panPixels(e.clientX - prev.x, e.clientY - prev.y);
          this.view.viewChanged();
          return;
        }
        if (dn.mode === 'drag') { this.active?.drag(ev, dn.ev); this.view.invalidateOverlay(); return; }
      }
    }
    this.active?.move(ev);
    this.view.invalidateOverlay();
  };

  private onUp = (e: PointerEvent) => {
    clearTimeout(this.longPressTimer);
    this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) this.down = null;
      return;
    }
    const dn = this.down;
    this.down = null;
    if (!dn) return;
    const ev = this.makeEvent(e, dn.mode !== 'pan');
    if (dn.mode === 'pan') {
      if (!dn.moved && dn.button === 2) this.active?.enter();
      return;
    }
    if (dn.mode === 'drag' && dn.moved) { this.active?.dragEnd(ev, dn.ev); this.longPressArmed = false; this.view.invalidateOverlay(); return; }
    this.longPressArmed = false;
    this.active?.up(ev);
    if (!dn.moved) this.active?.click(ev);
    this.view.invalidateOverlay();
  };

  private onCancel = (e: PointerEvent) => {
    clearTimeout(this.longPressTimer);
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    this.down = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const factor = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    this.view.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    this.view.viewChanged();
  };

  private onDblClick = (e: MouseEvent) => {
    if (e.button === 1) this.view.fitExtents();
  };

  /** keyboard handling; returns true if consumed */
  keyHandlers: ((e: KeyboardEvent) => boolean)[] = [];
  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.active?.key(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') { this.active?.escape(); e.preventDefault(); return; }
    if (e.key === 'Enter' || (e.key === ' ' && this.active?.id !== 'select')) { this.active?.enter(); e.preventDefault(); return; }
    for (const h of this.keyHandlers) if (h(e)) { e.preventDefault(); return; }
  };

  /** forward typed command-line input to the active tool */
  input(text: string): boolean { return this.active?.input(text) ?? false; }

  dispose() {
    window.removeEventListener('keydown', this.onKey);
    this.active?.deactivate();
  }
}
