import type { Camera } from './camera';
import { type Scene, type Chunk, SEG_STRIDE, TRI_STRIDE, F_COLOR_BYLAYER, F_ALPHA_BYLAYER, F_FG, F_POINT, F_MASK, LW_BYLAYER } from './scene';
import type { RenderOptions } from './glRenderer';
import { aciToRgb } from '../model/color';

interface Views { f32: Float32Array; u8: Uint8Array; u16: Uint16Array; tf32: Float32Array; tu8: Uint8Array; tu16: Uint16Array; mf32: Float32Array; mu8: Uint8Array; mu16: Uint16Array; version: number }

/**
 * Compatibility renderer (Canvas 2D) used when WebGL2 is missing or misbehaves on a device
 * (driver bugs, context loss). It draws the same chunk buffers as the GPU renderer. During
 * gestures it reuses the last frame (transformed) and redraws fully when the view settles.
 */
export class CanvasRenderer {
  readonly kind = 'canvas';
  ctx: CanvasRenderingContext2D;
  gpuBytes = 0;
  lastDrawStats = { chunks: 0, segments: 0, triangles: 0 };
  private cache: HTMLCanvasElement = document.createElement('canvas');
  private cacheCam: { cx: number; cy: number; scale: number; rotation: number } | null = null;
  /** set by the view: true while the user is panning / zooming */
  interacting = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  clear(bg: number) {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#' + bg.toString(16).padStart(6, '0');
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private views(c: Chunk): Views {
    let v = (c as any).__cv as Views | undefined;
    if (!v || v.version !== c.version) {
      const sb = c.segData ?? new ArrayBuffer(0), tb = c.triData ?? new ArrayBuffer(0), mb = c.maskData ?? new ArrayBuffer(0);
      v = {
        f32: new Float32Array(sb), u8: new Uint8Array(sb), u16: new Uint16Array(sb),
        tf32: new Float32Array(tb), tu8: new Uint8Array(tb), tu16: new Uint16Array(tb),
        mf32: new Float32Array(mb), mu8: new Uint8Array(mb), mu16: new Uint16Array(mb), version: c.version,
      };
      (c as any).__cv = v;
    }
    return v;
  }

  releaseChunk(c: Chunk) { (c as any).__cv = undefined; }
  dispose(scene?: Scene) { if (scene) for (const c of scene.chunks.values()) this.releaseChunk(c); }

  render(scene: Scene, cam: Camera, opts: RenderOptions, pass: { clear?: boolean; scissor?: [number, number, number, number]; viewBox?: { minX: number; minY: number; maxX: number; maxY: number } } = {}) {
    const W = Math.round(cam.width * cam.dpr), H = Math.round(cam.height * cam.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.cacheCam = null; }
    const ctx = this.ctx;
    const full = pass.clear !== false && !pass.scissor;
    // fast path during gestures: reuse the last full frame
    if (full && this.interacting && this.cacheCam && Math.abs(this.cacheCam.rotation - cam.rotation) < 1e-9) {
      const k = cam.scale / this.cacheCam.scale;
      const a = cam.worldToScreen(this.cacheCam.cx, this.cacheCam.cy);
      this.clear(opts.background);
      ctx.setTransform(k, 0, 0, k, a.x * cam.dpr - (W / 2) * k, a.y * cam.dpr - (H / 2) * k);
      ctx.drawImage(this.cache, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (pass.scissor) {
      const [x, y, w, h] = pass.scissor;
      ctx.beginPath(); ctx.rect(x, H - y - h, w, h); ctx.clip();
    }
    if (pass.clear !== false) {
      ctx.fillStyle = '#' + opts.background.toString(16).padStart(6, '0');
      ctx.fillRect(0, 0, W, H);
    }
    const layers = scene.styles.layers;
    const fg = opts.dark ? 0xffffff : 0x000000;
    const layerRgb: number[] = [], layerVis: boolean[] = [], layerAlpha: number[] = [], layerLw: number[] = [];
    for (const [, i] of scene.styles.layerIndex) {
      const l = layers[i];
      if (!l) { layerVis[i] = true; layerRgb[i] = fg; layerAlpha[i] = 1; layerLw[i] = 0; continue; }
      layerVis[i] = l.on && !l.frozen;
      const aci = l.aci ?? 7;
      layerRgb[i] = l.rgb ?? (aci === 7 || aci === 0 || aci === 256 ? fg : aciToRgb(aci));
      layerAlpha[i] = 1 - (l.transparency || 0);
      layerLw[i] = l.lineWeight > 0 ? l.lineWeight : 0;
    }
    const view = pass.viewBox ?? cam.viewBox(8);
    const chunks = scene.visibleChunks(view);
    const k = cam.scale * cam.dpr;
    const c0 = Math.cos(-cam.rotation), s0 = Math.sin(-cam.rotation);
    const hw = W / 2, hh = H / 2;
    const bgHex = '#' + opts.background.toString(16).padStart(6, '0');
    let segs = 0, tris = 0;
    const colorKey = (rgb: number, a: number) => `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${(a * (opts.alpha ?? 1)).toFixed(3)})`;
    const resolve = (u8: Uint8Array, o: number, layer: number, flags: number): [number, number] => {
      let rgb = (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];
      if (flags & F_COLOR_BYLAYER) rgb = layerRgb[layer] ?? fg;
      if (flags & F_FG) rgb = fg;
      const a = flags & F_ALPHA_BYLAYER ? layerAlpha[layer] ?? 1 : u8[o + 3] / 255;
      return [rgb, a];
    };
    // fills: original polygons (far fewer path operations than triangles)
    const fillBuckets = new Map<number, { p: Path2D; style: string }>();
    for (const c of chunks) {
      if (!c.polys.length) continue;
      const ox = c.ox - cam.cx, oy = c.oy - cam.cy;
      for (const poly of c.polys) {
        if (layerVis[poly.layer] === false) continue;
        let rgb = poly.color;
        if (poly.flags & F_COLOR_BYLAYER) rgb = layerRgb[poly.layer] ?? fg;
        if (poly.flags & F_FG) rgb = fg;
        const a8 = poly.flags & F_ALPHA_BYLAYER ? Math.round((layerAlpha[poly.layer] ?? 1) * 255) : poly.alpha;
        const path = new Path2D();
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
        for (const l of poly.loops) {
          for (let i = 0; i < l.length; i += 2) {
            const wx = l[i] + ox, wy = l[i + 1] + oy;
            const sx = hw + (wx * c0 - wy * s0) * k, sy = hh - (wx * s0 + wy * c0) * k;
            if (i === 0) path.moveTo(sx, sy); else path.lineTo(sx, sy);
            if (sx < minx) minx = sx; if (sx > maxx) maxx = sx; if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
          }
          path.closePath();
        }
        if (maxx < 0 || maxy < 0 || minx > W || miny > H || (maxx - minx < 0.5 && maxy - miny < 0.5)) continue;
        tris++;
        const style = `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${((a8 / 255) * (opts.alpha ?? 1)).toFixed(3)})`;
        if (poly.loops.length > 1) { ctx.fillStyle = style; ctx.fill(path, 'evenodd'); continue; } // holes: own even-odd fill
        const key = rgb * 256 + a8;
        let b = fillBuckets.get(key);
        if (!b) { b = { p: new Path2D(), style }; fillBuckets.set(key, b); }
        b.p.addPath(path);
      }
    }
    for (const b of fillBuckets.values()) { ctx.fillStyle = b.style; ctx.fill(b.p); }
    // lines, batched by colour + width (numeric bucket keys, polylines kept continuous)
    interface Bucket { p: Path2D; style: string; w: number; lx: number; ly: number }
    const buckets = new Map<number, Bucket>();
    const dots: { style: string; x: number; y: number }[] = [];
    const alphaMul = opts.alpha ?? 1;
    const minLen = 0.75; // sub-pixel segments are skipped (level of detail)
    for (const c of chunks) {
      if (!c.segCount) continue;
      const v = this.views(c);
      const ox = c.ox - cam.cx, oy = c.oy - cam.cy;
      const f32 = v.f32, u8 = v.u8, u16 = v.u16;
      for (let i = 0; i < c.segCount; i++) {
        const o = i * SEG_STRIDE, fo = o >> 2, h16 = o >> 1;
        const layer = u16[h16 + 14];
        if (layerVis[layer] === false) continue;
        const flags = u16[h16 + 17];
        const ax = f32[fo] + ox, ay = f32[fo + 1] + oy, bx = f32[fo + 2] + ox, by = f32[fo + 3] + oy;
        const x1 = hw + (ax * c0 - ay * s0) * k, y1 = hh - (ax * s0 + ay * c0) * k;
        const x2 = hw + (bx * c0 - by * s0) * k, y2 = hh - (bx * s0 + by * c0) * k;
        if ((x1 < 0 && x2 < 0) || (y1 < 0 && y2 < 0) || (x1 > W && x2 > W) || (y1 > H && y2 > H)) continue;
        const isPoint = (flags & F_POINT) !== 0;
        if (!isPoint && Math.abs(x2 - x1) < minLen && Math.abs(y2 - y1) < minLen) continue;
        let rgb: number;
        if (flags & F_FG) rgb = fg;
        else if (flags & F_COLOR_BYLAYER) rgb = layerRgb[layer] ?? fg;
        else rgb = (u8[o + 24] << 16) | (u8[o + 25] << 8) | u8[o + 26];
        const a8 = flags & F_ALPHA_BYLAYER ? Math.round((layerAlpha[layer] ?? 1) * 255) : u8[o + 27];
        let lwi = 1;
        if (opts.lineweights) {
          let w = u16[h16 + 16];
          if (w === LW_BYLAYER) w = layerLw[layer] ?? 0;
          if (w > 0 && w < 65534) lwi = Math.max(1, Math.round((w / 100) * 3.78 * cam.dpr * 0.75 * 2) / 2);
        }
        const key = (rgb * 256 + a8) * 64 + Math.min(63, Math.round(lwi * 2));
        let b = buckets.get(key);
        if (!b) {
          b = { p: new Path2D(), style: `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${((a8 / 255) * alphaMul).toFixed(3)})`, w: lwi, lx: NaN, ly: NaN };
          buckets.set(key, b);
        }
        if (isPoint) { dots.push({ style: b.style, x: x1, y: y1 }); continue; }
        if (Math.abs(b.lx - x1) > 0.01 || Math.abs(b.ly - y1) > 0.01) b.p.moveTo(x1, y1);
        b.p.lineTo(x2, y2);
        b.lx = x2; b.ly = y2;
        segs++;
      }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of buckets.values()) { ctx.strokeStyle = b.style; ctx.lineWidth = b.w; ctx.stroke(b.p); }
    for (const d of dots) { ctx.fillStyle = d.style; ctx.fillRect(d.x - 1.5 * cam.dpr, d.y - 1.5 * cam.dpr, 3 * cam.dpr, 3 * cam.dpr); }
    // masks (wipeouts / text backgrounds)
    for (const c of chunks) {
      if (!c.maskCount) continue;
      const v = this.views(c);
      const ox = c.ox - cam.cx, oy = c.oy - cam.cy;
      const p = new Path2D();
      for (let t = 0; t < c.maskCount; t += 3) {
        const o = t * TRI_STRIDE, h16 = o >> 1;
        const layer = v.mu16[h16 + 6], flags = v.mu16[h16 + 7];
        if (layerVis[layer] === false || !(flags & F_MASK)) continue;
        for (let j = 0; j < 3; j++) {
          const f = (o + j * TRI_STRIDE) >> 2;
          const wx = v.mf32[f] + ox, wy = v.mf32[f + 1] + oy;
          const sx = hw + (wx * c0 - wy * s0) * k, sy = hh - (wx * s0 + wy * c0) * k;
          if (j === 0) p.moveTo(sx, sy); else p.lineTo(sx, sy);
        }
        p.closePath();
      }
      ctx.fillStyle = bgHex; ctx.fill(p);
    }
    ctx.restore();
    if (full) {
      // remember this frame for fast gestures
      if (this.cache.width !== W || this.cache.height !== H) { this.cache.width = W; this.cache.height = H; }
      const cc = this.cache.getContext('2d')!;
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.drawImage(this.canvas, 0, 0);
      this.cacheCam = { cx: cam.cx, cy: cam.cy, scale: cam.scale, rotation: cam.rotation };
    }
    this.lastDrawStats = { chunks: chunks.length, segments: segs, triangles: tris };
  }
}
