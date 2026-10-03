import { Camera } from './camera';
import { Scene } from './scene';
import { GlRenderer } from './glRenderer';
import { TextLayer } from './textLayer';
import type { CadDoc } from '../doc/CadDoc';
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
  gl: GlRenderer;
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

  constructor(public host: HTMLElement, public glCanvas: HTMLCanvasElement, public textCanvas: HTMLCanvasElement, public overlayCanvas: HTMLCanvasElement) {
    this.gl = new GlRenderer(glCanvas);
    this.text = new TextLayer(textCanvas);
    this.overlayCtx = overlayCanvas.getContext('2d')!;
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get background() { return this.opts.dark ? 0x0d1117 : 0xffffff; }

  resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cam.setSize(Math.max(1, r.width), Math.max(1, r.height), dpr);
    for (const c of [this.overlayCanvas]) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    }
    this.invalidate();
  }

  setDoc(doc: CadDoc | null, fit = true) {
    this.unsub?.();
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
      if (fit) this.fitExtents();
    }
    this.invalidate();
  }

  addOverlay(key: string, draw: OverlayDrawer, z = 0) { this.overlays.set(key, { z, draw }); this.needOverlay = true; }
  removeOverlay(key: string) { this.overlays.delete(key); this.needOverlay = true; }
  onView(l: (cam: Camera) => void) { this.viewListeners.add(l); return () => this.viewListeners.delete(l); }

  invalidate() { this.needScene = true; this.needText = true; this.needOverlay = true; }
  invalidateOverlay() { this.needOverlay = true; }
  invalidateStyles() { if (this.scene) { this.scene.styles.sync(this.doc!.drawing.layers, this.doc!.drawing.lineTypes); } this.invalidate(); }

  /** called by interaction code whenever the camera moves */
  viewChanged() {
    this.invalidate();
    this.interacting = true;
    clearTimeout(this.interactTimer);
    this.interactTimer = setTimeout(() => { this.interacting = false; this.needText = true; }, 140);
    for (const l of this.viewListeners) l(this.cam);
  }

  fitExtents() {
    if (!this.doc) return;
    const m = this.doc.drawing.meta;
    this.cam.fit({ minX: m.extMin.x, minY: m.extMin.y, maxX: m.extMax.x, maxY: m.extMax.y });
    this.viewChanged();
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
    const b = emptyBox();
    for (const id of ids) { const eb = this.doc.box(id); if (eb) boxUnion(b, eb); }
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
    if (scene && scene.pending) {
      scene.buildDirty(this.cam.viewBox(), this.interacting ? 6 : 14);
      this.needScene = true;
      this.needText = true;
    }
    if (this.needScene) {
      this.needScene = false;
      if (scene) {
        this.gl.render(scene, this.cam, { dark: this.opts.dark, background: this.background, lineweights: this.opts.lineweights, alpha: this.opts.drawingAlpha });
        this.stats.segments = this.gl.lastDrawStats.segments;
        this.stats.chunks = this.gl.lastDrawStats.chunks;
        this.stats.gpuMB = this.gl.gpuBytes / 1048576;
      } else {
        const gl = this.gl.gl;
        const bg = this.background;
        gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    if (this.needText) {
      // skip expensive text passes during gestures if they are slow; redraw when idle
      const slow = this.text.lastMs > 22;
      if (!(this.interacting && slow)) {
        this.needText = false;
        this.text.clear(this.cam);
        if (this.opts.grid) this.drawGrid(this.text.ctx);
        if (scene && this.opts.showText) this.text.render(scene, this.cam, this.opts.dark, this.opts.drawingAlpha);
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
      const list = [...this.overlays.values()].sort((a, b) => a.z - b.z);
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
