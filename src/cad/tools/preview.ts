import type { Entity, Vec2 } from '../model/types';
import type { Camera } from '../render/camera';
import { geometryOf } from '../geom/tessellate';
import { aciToRgb, rgbToHex } from '../model/color';

/** stroke a temporary entity on the overlay canvas */
export function drawPreview(ctx: CanvasRenderingContext2D, cam: Camera, e: Entity, color?: string, fill = false) {
  const g = geometryOf(e);
  const c = color ?? (e.rgb !== undefined ? rgbToHex(e.rgb) : e.aci && e.aci !== 256 && e.aci !== 7 && e.aci !== 0 ? rgbToHex(aciToRgb(e.aci)) : '#7fd4ff');
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (const p of g.paths) {
    const a = p.pts;
    for (let i = 0; i < a.length; i += 2) {
      const s = cam.worldToScreen(a[i], a[i + 1]);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    }
    if (p.closed) ctx.closePath();
  }
  ctx.stroke();
  if (g.fills.length) {
    ctx.globalAlpha = fill ? 0.35 : 0.6;
    ctx.beginPath();
    for (const f of g.fills) for (const l of f) {
      for (let i = 0; i < l.length; i += 2) { const s = cam.worldToScreen(l[i], l[i + 1]); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  ctx.globalAlpha = 1;
  for (const t of g.texts) {
    const s = cam.worldToScreen(t.x, t.y);
    const px = Math.max(6, t.h * cam.scale / 0.72);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-(t.rot - cam.rotation));
    ctx.font = `${t.bold ? 'bold ' : ''}${t.italic ? 'italic ' : ''}${px}px Arial`;
    ctx.textAlign = t.halign;
    t.lines.forEach((l, i) => ctx.fillText(l, 0, i * px * 1.2));
    ctx.restore();
  }
  ctx.restore();
}

export function drawRubber(ctx: CanvasRenderingContext2D, cam: Camera, pts: Vec2[], closed = false, color = '#ffd400') {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  pts.forEach((p, i) => { const s = cam.worldToScreen(p.x, p.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
  if (closed) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg = 'rgba(10,14,20,0.85)', fg = '#fff') {
  ctx.save();
  ctx.font = '600 12px system-ui, sans-serif';
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const h = lines.length * 16 + 6;
  ctx.fillStyle = bg;
  ctx.fillRect(x + 12, y + 12, w, h);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + 18, y + 16 + i * 16));
  ctx.restore();
}
