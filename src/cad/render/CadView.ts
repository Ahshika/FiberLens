import { Camera } from './camera';
import { Scene } from './scene';
import { GlRenderer } from './glRenderer';
import { CanvasRenderer } from './canvasRenderer';
import { glSelfTest } from './selfTest';
import { TextLayer } from './textLayer';
import { CadDoc } from '../doc/CadDoc';
import type { LayoutDef } from '../model/types';
import { boxValid, type BBox, emptyBox, boxUnion } from '../geom/bbox';
import { setTessTolerance } from '../geom/bulge';

export interface ViewOptions {
  dark: boolean;
  lineweights: boolean;
  grid: boolean;
  gridSpacing: number;
  /** dim the drawing (0..1) e.g. while comparing versions */
  drawingAlpha: number;
  showText: boolean;
}

export type OverlayDrawer = (ctx: CanvasRenderingContext2D, cam: Camera, view: CadView) => void;

/**
 * Owns the canvases and the render loop. Rendering is demand-driven: nothing is redrawn
 * unless the camera, the document or an overlay changed.
 */
export class CadView {
  cam = new Camera();
  scene: Scene | null = null;
  doc: CadDoc | null = null;
  gl: GlRenderer | CanvasRenderer;
  /** which renderer is active and why */
  rendererInfo: { kind: 'webgl' | 'canvas'; reason?: string } = { kind: 'webgl' };
  private contextLosses = 0;
  onRendererChange: ((info: { kind: string; reason?: string }) => void) | null = null;
  text: TextLayer;
  overlayCtx: CanvasRenderingContext2D;
  opts: ViewOptions = { dark: true, lineweights: false, grid: false, gridSpacing: 10, drawingAlpha: 1, showText: true };
  private overlays = new Map<string, { z: number; draw: OverlayDrawer }>();
  private needScene = true;
  private needText = true;
  private needOverlay = true;
  private raf = 0;
  private viewListeners = new Set<(cam: Camera) => void>();
  private unsub: (() => void) | null = null;
  interacting = false;
  private interactTimer: any = 0;
  private resizeObs: ResizeObserver;
  stats = { fps: 0, frameMs: 0, textMs: 0, texts: 0, segments: 0, chunks: 0, gpuMB: 0 };
  private disposed = false;
  /** paper-space layout being viewed (read-only) */
  layout: { def: LayoutDef; doc: CadDoc; scene: Scene; savedCam: Camera } | null = null;
  layoutListeners = new Set<() => void>();

  constructor(public host: HTMLElement, public glCanvas: HTMLCanvasElement, public textCanvas: HTMLCanvasElement, public overlayCanvas: HTMLCanvasElement) {
    this.gl = this.createRenderer();
    this.text = new TextLayer(textCanvas);
    this.overlayCtx = overlayCanvas.getContext('2d')!;
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** renderer preference: 'auto' (WebGL2 + self-test, Canvas fallback) | 'webgl' | 'canvas' */
  static preference(): 'auto' | 'webgl' | 'canvas' {
    try { return (localStorage.getItem('fl.renderer') as any) || 'auto'; } catch { return 'auto'; }
  }

  private createRenderer(): GlRenderer | CanvasRenderer {
    const pref = CadView.preference();
    if (pref !== 'canvas') {
      try {
        const r = new GlRenderer(this.glCanvas);
        const test = pref === 'webgl' ? { ok: true } : glSelfTest(r);
        if (test.ok) {
          this.glCanvas.addEventListener('webglcontextlost', this.onContextLost);
          this.glCanvas.addEventListener('webglcontextrestored', this.onContextRestored);
          this.rendererInfo = { kind: 'webgl' };
          return r;
        }
        this.rendererInfo = { kind: 'canvas', reason: 'GPU self-test failed: ' + test.reason };
      } catch (e) {
        this.rendererInfo = { kind: 'canvas', reason: 'WebGL2 unavailable: ' + (e as Error).message };
      }
    } else this.rendererInfo = { kind: 'canvas', reason: 'selected in settings' };
    return this.makeCanvasRenderer();
  }

  /** a canvas that already has a WebGL context cannot give a 2D one: swap in a fresh element */
  private makeCanvasRenderer(): CanvasRenderer {
    const fresh = document.createElement('canvas');
    fresh.className = this.glCanvas.className;
    this.glCanvas.replaceWith(fresh);
    this.glCanvas = fresh;
    return new CanvasRenderer(fresh);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLosses++;
    if (this.contextLosses >= 2) this.switchToCanvas('GPU context lost repeatedly');
  };

  private onContextRestored = () => {
    if (this.gl.kind !== 'webgl') return;
    try {
      this.gl = new GlRenderer(this.glCanvas);
      if (this.scene) (this.gl as GlRenderer).forgetChunks(this.scene);
      if (this.layout) (this.gl as GlRenderer).forgetChunks(this.layout.scene);
      this.invalidate();
    } catch (err) { this.switchToCanvas('GPU restore failed: ' + (err as Error).message); }
  };

  switchToCanvas(reason: string) {
    if (this.gl.kind === 'canvas') return;
    this.glCanvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.glCanvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.gl = this.makeCanvasRenderer();
    this.rendererInfo = { kind: 'canvas', reason };
    this.onRendererChange?.(this.rendererInfo);
    this.invalidate();
  }

  get background() { return this.opts.dark ? 0x0d1117 : 0xffffff; }

  /** true once the user (or a feature) moved the camera; until then resizes re-fit the drawing */
  userMoved = false;
  private autoFitting = false;

  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const changed = Math.abs(r.width - this.cam.width) > 8 || Math.abs(r.height - this.cam.height) > 8;
    this.cam.setSize(Math.max(1, r.width), Math.max(1, r.height), dpr);
    if (changed && !this.userMoved && this.doc && !this.layout && r.width > 10 && r.height > 10) {
      this.autoFitting = true;
      this.fitExtents();
      this.autoFitting = false;
    }
    for (const c of [this.overlayCanvas]) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    }
    this.invalidate();
  }

  setDoc(doc: CadDoc | null, fit = true) {
    this.unsub?.();
    if (this.layout) { this.gl.dispose(this.layout.scene); this.layout = null; for (const l of this.layoutListeners) l(); }
    if (this.scene) this.gl.dispose(this.scene);
    this.doc = doc;
    this.scene = null;
    if (doc) {
      const m = doc.drawing.meta;
      const size = Math.max(m.extMax.x - m.extMin.x, m.extMax.y - m.extMin.y, 1);
      setTessTolerance(size * 2e-6);
      this.scene = new Scene(doc);
      this.unsub = doc.onChange((cs) => {
        this.scene?.applyChange(cs);
        // release GPU memory of chunks that became empty
        if (this.scene) for (const c of this.scene.chunks.values()) if (!c.ids.size && c.gpu) this.gl.releaseChunk(c);
        this.invalidate();
      });
      if (fit) { this.autoFitting = true; this.fitExtents(); this.autoFitting = false; this.userMoved = false; }
    }
    this.invalidate();
  }

  /** switch to a paper-space layout (null = model space) */
  setLayout(def: LayoutDef | null) {
    if (this.layout) { this.gl.dispose(this.layout.scene); Object.assign(this.cam, this.layout.savedCam, { width: this.cam.width, height: this.cam.height, dpr: this.cam.dpr }); this.layout = null; }
    if (def && this.doc && this.scene) {
      const d = this.doc.drawing;
      const paper = new CadDoc({ ...d, entities: def.entities.map((e) => ({ ...e })), layouts: [], nextId: d.nextId });
      const m = paper.drawing.meta;
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      if (!def.viewports.length) for (const e of paper.all()) { const eb = paper.box(e.id); if (eb) { b.minX = Math.min(b.minX, eb.minX); b.minY = Math.min(b.minY, eb.minY); b.maxX = Math.max(b.maxX, eb.maxX); b.maxY = Math.max(b.maxY, eb.maxY); } }
      for (const v of def.viewports) { b.minX = Math.min(b.minX, v.center.x - v.width / 2); b.maxX = Math.max(b.maxX, v.center.x + v.width / 2); b.minY = Math.min(b.minY, v.center.y - v.height / 2); b.maxY = Math.max(b.maxY, v.center.y + v.height / 2); }
      if (!Number.isFinite(b.minX)) { b.minX = 0; b.minY = 0; b.maxX = 420; b.maxY = 297; }
      paper.drawing.meta = { ...m, extMin: { x: b.minX, y: b.minY }, extMax: { x: b.maxX, y: b.maxY } };
      const scene = new Scene(paper);
      scene.styles = this.scene.styles; // share layer/linetype tables with model space
      this.layout = { def, doc: paper, scene, savedCam: this.cam.clone() };
      this.cam.rotation = 0;
      this.cam.fit(b, 0.04);
    }
    for (const l of this.layoutListeners) l();
    this.viewChanged();
  }

  /** model-space camera + clip rectangle for a paper viewport */
  private viewportCam(v: LayoutDef['viewports'][number]) {
    const cam = this.cam;
    const s = cam.worldToScreen(v.center.x, v.center.y);
    const wpx = v.width * cam.scale, hpx = v.height * cam.scale;
    const mc = cam.clone();
    mc.scale = cam.scale * (v.height / (v.viewHeight || v.height));
    mc.rotation = v.twist || 0;
    // place viewCenter at the viewport's screen centre
    mc.cx = v.viewCenter.x; mc.cy = v.viewCenter.y;
    const off = mc.screenToWorld(cam.width / 2 - (s.x - cam.width / 2), cam.height / 2 - (s.y - cam.height / 2));
    mc.cx = off.x; mc.cy = off.y;
    const clip: [number, number, number, number] = [s.x - wpx / 2, s.y - hpx / 2, wpx, hpx];
    const vw = (v.width * (v.viewHeight || v.height)) / v.height, vh = v.viewHeight || v.height;
    const box = { minX: v.viewCenter.x - vw, maxX: v.viewCenter.x + vw, minY: v.viewCenter.y - vh, maxY: v.viewCenter.y + vh };
    return { mc, clip, box, wpx, hpx };
  }

  addOverlay(key: string, draw: OverlayDrawer, z = 0) { this.overlays.set(key, { z, draw }); this.needOverlay = true; }
  removeOverlay(key: string) { this.overlays.delete(key); this.needOverlay = true; }
  onView(l: (cam: Camera) => void) { this.viewListeners.add(l); return () => this.viewListeners.delete(l); }

  invalidate() { this.needScene = true; this.needText = true; this.needOverlay = true; }
  invalidateOverlay() { this.needOverlay = true; }
  invalidateStyles() { if (this.scene) { this.scene.styles.sync(this.doc!.drawing.layers, this.doc!.drawing.lineTypes); } this.invalidate(); }

  /** called by interaction code whenever the camera moves */
  viewChanged() {
    if (!this.autoFitting) this.userMoved = true;
    this.invalidate();
    this.interacting = true;
    clearTimeout(this.interactTimer);
    this.interactTimer = setTimeout(() => { this.interacting = false; this.needText = true; this.needScene = true; }, 140);
    for (const l of this.viewListeners) l(this.cam);
  }

  fitExtents() {
    if (!this.doc) return;
    const d = this.layout?.doc ?? this.doc;
    const m = d.drawing.meta;
    if (this.layout) {
      this.cam.fit({ minX: m.extMin.x, minY: m.extMin.y, maxX: m.extMax.x, maxY: m.extMax.y });
      this.viewChanged();
      return;
    }
    const r = this.robustExtents();
    if (r) this.cam.fit(r, 0.08);
    else this.cam.fit({ minX: m.extMin.x, minY: m.extMin.y, maxX: m.extMax.x, maxY: m.extMax.y });
    this.viewChanged();
  }

  /** extents of the visible model geometry, ignoring stray objects far from the drawing (1–99 % quantiles) */
  robustExtents(): BBox | null {
    const d = this.doc;
    if (!d) return null;
    const xs: number[] = [], ys: number[] = [];
    const step = Math.max(1, Math.floor(d.size / 30000));
    let i = 0;
    for (const e of d.all()) {
      if (i++ % step) continue;
      if (!d.isVisible(e)) continue;
      const b = d.box(e.id);
      if (!b) continue;
      xs.push((b.minX + b.maxX) / 2); ys.push((b.minY + b.maxY) / 2);
    }
    if (xs.length < 10) return null;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (a: number[], f: number) => a[Math.floor((a.length - 1) * f)];
    return { minX: q(xs, 0.01), minY: q(ys, 0.01), maxX: q(xs, 0.99), maxY: q(ys, 0.99) };
  }

  zoomToBox(b: BBox, minSize = 0) {
    if (!boxValid(b)) return;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (minSize > 0 && Math.max(w, h) < minSize) {
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      b = { minX: cx - minSize / 2, maxX: cx + minSize / 2, minY: cy - minSize / 2, maxY: cy + minSize / 2 };
    }
    this.cam.fit(b, 0.15);
    this.viewChanged();
  }

  zoomToEntities(ids: number[], minSize = 20) {
    if (!this.doc) return;
    const boxes = ids.map((id) => this.doc!.box(id)).filter(Boolean) as BBox[];
    const b = emptyBox();
    if (boxes.length > 4) {
      // robust: ignore statistical outliers (stray geometry far from the rest)
      const cx = boxes.map((x) => (x.minX + x.maxX) / 2).sort((p, q) => p - q);
      const cy = boxes.map((x) => (x.minY + x.maxY) / 2).sort((p, q) => p - q);
      const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * f)))];
      const x1 = q(cx, 0.03), x2 = q(cx, 0.97), y1 = q(cy, 0.03), y2 = q(cy, 0.97);
      const padX = (x2 - x1) * 0.5 + minSize, padY = (y2 - y1) * 0.5 + minSize;
      for (const x of boxes) {
        const mx = (x.minX + x.maxX) / 2, my = (x.minY + x.maxY) / 2;
        if (mx < x1 - padX || mx > x2 + padX || my < y1 - padY || my > y2 + padY) continue;
        // also clip individual huge boxes to the robust window
        boxUnion(b, { minX: Math.max(x.minX, x1 - padX), minY: Math.max(x.minY, y1 - padY), maxX: Math.min(x.maxX, x2 + padX), maxY: Math.min(x.maxY, y2 + padY) });
      }
    } else for (const x of boxes) boxUnion(b, x);
    this.zoomToBox(b, minSize);
  }

  centerOn(x: number, y: number, scale?: number) {
    this.cam.cx = x; this.cam.cy = y;
    if (scale) this.cam.scale = scale;
    this.viewChanged();
  }

  /** world size of n CSS pixels */
  px(n = 1) { return n / this.cam.scale; }

  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    const scene = this.scene;
    this.gl.interacting = this.interacting;
    if (scene && scene.pending) {
      scene.buildDirty(this.cam.viewBox(), this.interacting ? 6 : 14);
      this.needScene = true;
      this.needText = true;
    }
    if (this.layout && this.layout.scene.pending) { this.layout.scene.buildDirty(this.cam.viewBox(), 14); this.needScene = true; this.needText = true; }
    if (this.needScene && this.layout && scene) {
      this.needScene = false;
      const ro = { dark: this.opts.dark, background: this.background, lineweights: this.opts.lineweights };
      this.gl.render(this.layout.scene, this.cam, ro);
      const dpr = this.cam.dpr, Hc = this.cam.height;
      for (const v of this.layout.def.viewports) {
        const { mc, clip, box, wpx, hpx } = this.viewportCam(v);
        if (wpx < 2 || hpx < 2) continue;
        if (clip[0] > this.cam.width || clip[1] > Hc || clip[0] + clip[2] < 0 || clip[1] + clip[3] < 0) continue;
        if (scene.pending) scene.buildDirty(box, 20);
        const sc: [number, number, number, number] = [Math.round(clip[0] * dpr), Math.round((Hc - clip[1] - clip[3]) * dpr), Math.round(clip[2] * dpr), Math.round(clip[3] * dpr)];
        this.gl.render(scene, mc, ro, { clear: false, scissor: sc, viewBox: box });
      }
    } else if (this.needScene) {
      this.needScene = false;
      if (scene) {
        this.gl.render(scene, this.cam, { dark: this.opts.dark, background: this.background, lineweights: this.opts.lineweights, alpha: this.opts.drawingAlpha });
        this.stats.segments = this.gl.lastDrawStats.segments;
        this.stats.chunks = this.gl.lastDrawStats.chunks;
        this.stats.gpuMB = this.gl.gpuBytes / 1048576;
      } else {
        this.gl.clear(this.background);
      }
    }
    if (this.needText) {
      // skip expensive text passes during gestures if they are slow; redraw when idle
      const slow = this.text.lastMs > 22;
      if (!(this.interacting && slow)) {
        this.needText = false;
        this.text.clear(this.cam);
        if (this.opts.grid) this.drawGrid(this.text.ctx);
        if (this.layout && scene && this.opts.showText) {
          this.text.render(this.layout.scene, this.cam, this.opts.dark, 1, { clear: false });
          for (const v of this.layout.def.viewports) {
            const { mc, clip, box } = this.viewportCam(v);
            if (clip[2] > 4 && clip[3] > 4) this.text.render(scene, mc, this.opts.dark, 1, { clear: false, clip, viewBox: box });
          }
        } else if (scene && this.opts.showText) this.text.render(scene, this.cam, this.opts.dark, this.opts.drawingAlpha);
        this.stats.textMs = this.text.lastMs;
        this.stats.texts = this.text.lastCount;
      } else {
        this.text.clear(this.cam);
        if (this.opts.grid) this.drawGrid(this.text.ctx);
      }
    }
    if (this.needOverlay) {
      this.needOverlay = false;
      const ctx = this.overlayCtx;
      const W = Math.round(this.cam.width * this.cam.dpr), H = Math.round(this.cam.height * this.cam.dpr);
      if (this.overlayCanvas.width !== W || this.overlayCanvas.height !== H) { this.overlayCanvas.width = W; this.overlayCanvas.height = H; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const list = this.layout ? [] : [...this.overlays.values()].sort((a, b) => a.z - b.z);
      if (this.layout) {
        // viewport frames
        ctx.save(); ctx.setTransform(this.cam.dpr, 0, 0, this.cam.dpr, 0, 0);
        ctx.strokeStyle = 'rgba(46,168,255,0.6)'; ctx.setLineDash([6, 4]);
        for (const v of this.layout.def.viewports) { const { clip } = this.viewportCam(v); ctx.strokeRect(...clip); }
        ctx.restore();
      }
      for (const o of list) {
        ctx.save();
        ctx.setTransform(this.cam.dpr, 0, 0, this.cam.dpr, 0, 0);
        try { o.draw(ctx, this.cam, this); } catch (err) { console.error('overlay', err); }
        ctx.restore();
      }
    }
    const dt = performance.now() - t0;
    this.stats.frameMs = dt;
    void now;
  }

  private drawGrid(ctx: CanvasRenderingContext2D) {
    const cam = this.cam;
    let sp = this.opts.gridSpacing;
    while (sp * cam.scale < 12) sp *= 5;
    while (sp * cam.scale > 120) sp /= 5;
    const vb = cam.viewBox();
    const x0 = Math.floor(vb.minX / sp) * sp, y0 = Math.floor(vb.minY / sp) * sp;
    ctx.save();
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.strokeStyle = this.opts.dark ? 'rgba(120,140,170,0.16)' : 'rgba(60,80,120,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let count = 0;
    for (let x = x0; x <= vb.maxX && count < 400; x += sp, count++) {
      const a = cam.worldToScreen(x, vb.minY), b = cam.worldToScreen(x, vb.maxY);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    count = 0;
    for (let y = y0; y <= vb.maxY && count < 400; y += sp, count++) {
      const a = cam.worldToScreen(vb.minX, y), b = cam.worldToScreen(vb.maxX, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** render the current view into a PNG/JPEG data URL (drawing + text + overlays) */
  snapshot(type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.92): string {
    this.needScene = true; this.needText = true; this.needOverlay = true;
    this.interacting = false;
    this.loop(performance.now());
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
    const out = document.createElement('canvas');
    out.width = this.glCanvas.width; out.height = this.glCanvas.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.drawImage(this.textCanvas, 0, 0);
    ctx.drawImage(this.overlayCanvas, 0, 0);
    return out.toDataURL(type, quality);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.unsub?.();
    if (this.scene) this.gl.dispose(this.scene);
  }
}
