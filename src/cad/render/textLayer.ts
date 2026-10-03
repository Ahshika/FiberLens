import type { Camera } from './camera';
import { type Scene, type TextRec, F_COLOR_BYLAYER, F_FG, F_ALPHA_BYLAYER } from './scene';
import { aciToRgb, rgbToHex } from '../model/color';

/** SHX / CAD font names → web font stacks (SHX glyphs are not redistributable). */
export function fontFamilyFor(font?: string): string {
  const f = (font || '').toLowerCase();
  if (!f || /^(txt|simplex|romans|romand|romant|isocp|iso|isoct|gdt|amgdt|complex|italic|scripts|greeks)/.test(f)) return 'Arial, "Noto Sans Arabic", sans-serif';
  if (/mono/.test(f)) return '"Courier New", monospace';
  if (/gothic|bold/.test(f)) return '"Arial Black", Arial, sans-serif';
  if (/times|roman/.test(f)) return '"Times New Roman", serif';
  if (/arial|helvet|swiss/.test(f)) return 'Arial, sans-serif';
  if (/tahoma|arab|simplified|traditional|naskh|kufi/.test(f)) return `"${font}", Tahoma, "Noto Sans Arabic", sans-serif`;
  return `"${font}", Arial, sans-serif`;
}

const CAP = 0.72;

export class TextLayer {
  ctx: CanvasRenderingContext2D;
  lastMs = 0;
  lastCount = 0;
  maxTexts = 4000;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  clear(cam: Camera) {
    const W = Math.round(cam.width * cam.dpr), H = Math.round(cam.height * cam.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, W, H);
  }

  render(scene: Scene, cam: Camera, dark: boolean, alphaMul = 1) {
    const t0 = performance.now();
    this.clear(cam);
    const ctx = this.ctx;
    const view = cam.viewBox(20);
    let recs = scene.textTree.search(view);
    const layers = scene.styles.layers;
    const fg = dark ? 0xffffff : 0x000000;
    const minPx = 1.6;
    // filter + LOD
    const vis: { r: TextRec; px: number }[] = [];
    for (const r of recs) {
      if (scene.hidden.has(r.entityId)) continue;
      const l = layers[r.layer];
      if (l && (!l.on || l.frozen)) continue;
      const px = r.item.h * cam.scale;
      if (px < minPx) continue;
      vis.push({ r, px });
    }
    recs = [];
    if (vis.length > this.maxTexts) { vis.sort((a, b) => b.px - a.px); vis.length = this.maxTexts; }
    const dpr = cam.dpr;
    for (const { r, px } of vis) {
      const it = r.item;
      const l = layers[r.layer];
      let rgb = r.color;
      if (r.flags & F_COLOR_BYLAYER) rgb = l ? (l.rgb ?? ((l.aci ?? 7) === 7 ? fg : aciToRgb(l.aci ?? 7))) : fg;
      if (r.flags & F_FG) rgb = fg;
      let alpha = r.flags & F_ALPHA_BYLAYER ? 1 - (l?.transparency ?? 0) : r.alpha / 255;
      alpha *= alphaMul;
      const s = cam.worldToScreen(it.x, it.y);
      const ang = it.rot - cam.rotation;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(s.x, s.y);
      ctx.rotate(-ang);
      if (it.mirrorX) ctx.scale(-1, 1);
      if (it.oblique) ctx.transform(1, 0, -Math.tan(it.oblique), 1, 0, 0);
      ctx.globalAlpha = alpha;
      const color = rgbToHex(rgb);
      const n = it.lines.length;
      const gap = px * 1.666 * (it.lineSpacing || 1);
      let firstBase: number; // screen y (down) of first baseline relative to anchor
      switch (it.valign) {
        case 'top': firstBase = px; break;
        case 'middle': firstBase = px - ((n - 1) * gap + px) / 2; break;
        case 'bottom': firstBase = -(n - 1) * gap - px * 0.25; break;
        default: firstBase = 0;
      }
      if (px < 4) {
        // greeking: draw a bar
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * 0.45;
        for (let i = 0; i < n; i++) {
          const w = it.lines[i].length * px * 0.62 * it.widthFactor;
          const x0 = it.halign === 'center' ? -w / 2 : it.halign === 'right' ? -w : 0;
          ctx.fillRect(x0, firstBase + i * gap - px, w, px);
        }
        continue;
      }
      const fpx = px / CAP;
      ctx.font = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${fpx.toFixed(2)}px ${fontFamilyFor(it.font)}`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = it.halign;
      if (it.widthFactor !== 1 || it.fitWidth) {
        let sx = it.widthFactor;
        if (it.fitWidth && n === 1) {
          const m = ctx.measureText(it.lines[0]).width;
          if (m > 0) sx = (it.fitWidth * cam.scale) / m;
        }
        ctx.scale(sx, 1);
      }
      for (let i = 0; i < n; i++) {
        const line = it.lines[i];
        if (line) ctx.fillText(line, 0, firstBase + i * gap);
      }
    }
    ctx.globalAlpha = 1;
    this.lastCount = vis.length;
    this.lastMs = performance.now() - t0;
  }
}
