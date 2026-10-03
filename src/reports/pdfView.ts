import { jsPDF } from 'jspdf';
import type { CadView } from '../cad/render/CadView';
import { geometryOf, transformGeom } from '../cad/geom/tessellate';
import { walkInsert, resolveStyle, type InheritedStyle } from '../cad/geom/blocks';
import { aciToRgb } from '../cad/model/color';
import type { Entity } from '../cad/model/types';

export interface PdfOptions { title: string; subtitle?: string; paper: 'a4' | 'a3' | 'a2' | 'a1' | 'a0'; landscape: boolean; mode: 'raster' | 'vector'; author?: string; unitsPerMeter?: number; northAngle?: number }

/** Render the current view at a higher pixel density and return a data URL. */
export function renderHighRes(view: CadView, scale: number, type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.92): string {
  const dpr = view.cam.dpr;
  view.cam.dpr = Math.min(4, dpr * scale);
  const prevMax = view.text.maxTexts;
  view.text.maxTexts = 20000;
  try { return view.snapshot(type, quality); }
  finally { view.cam.dpr = dpr; view.text.maxTexts = prevMax; view.invalidate(); }
}

function styleRgb(st: InheritedStyle, view: CadView): number {
  const layer = view.doc?.layer(st.layer);
  const dark = false; // PDFs are printed on white
  if (st.rgb !== undefined) return st.rgb;
  let aci = st.aci ?? 256;
  if (aci === 256) { if (layer?.rgb !== undefined) return layer.rgb; aci = layer?.aci ?? 7; }
  if (aci === 7 || aci === 0) return dark ? 0xffffff : 0x000000;
  const c = aciToRgb(aci);
  // very light colours are unreadable on paper: darken yellow/white-ish
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 200 ? (((r * 0.6) << 16) | ((g * 0.6) << 8) | (b * 0.6)) : c;
}

export function exportViewPdf(view: CadView, o: PdfOptions): Uint8Array {
  const doc = new jsPDF({ orientation: o.landscape ? 'landscape' : 'portrait', unit: 'mm', format: o.paper, compress: true });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const margin = 8, titleH = 18;
  const mapW = W - margin * 2, mapH = H - margin * 2 - titleH;
  const cam = view.cam;
  // frame
  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.rect(margin, margin, mapW, mapH);
  const k = Math.min(mapW / cam.width, mapH / cam.height); // mm per CSS px
  const ox = margin + (mapW - cam.width * k) / 2, oy = margin + (mapH - cam.height * k) / 2;
  if (o.mode === 'raster') {
    const img = renderHighRes(view, 3, 'image/jpeg', 0.92);
    doc.addImage(img, 'JPEG', ox, oy, cam.width * k, cam.height * k, undefined, 'FAST');
  } else {
    const cad = view.doc!;
    const vb = cam.viewBox();
    const toP = (x: number, y: number) => { const s = cam.worldToScreen(x, y); return [ox + s.x * k, oy + s.y * k]; };
    const ids = cad.search(vb);
    let prims = 0;
    const draw = (g: ReturnType<typeof geometryOf>, st: InheritedStyle) => {
      const rgb = styleRgb(st, view);
      doc.setDrawColor((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
      doc.setFillColor((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
      const lw = st.lineWeight !== undefined && st.lineWeight > 0 ? st.lineWeight / 100 : 0.13;
      doc.setLineWidth(lw);
      for (const p of g.paths) {
        if (prims++ > 150000) return;
        const a = p.pts;
        if (a.length < 4) continue;
        const pts: number[][] = [];
        for (let i = 0; i < a.length; i += 2) pts.push(toP(a[i], a[i + 1]));
        const deltas = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
        doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'S', p.closed);
      }
      for (const f of g.fills) for (const l of f.slice(0, 1)) {
        const pts: number[][] = [];
        for (let i = 0; i < l.length; i += 2) pts.push(toP(l[i], l[i + 1]));
        if (pts.length < 3) continue;
        const deltas = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
        doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'F', true);
      }
      for (const t of g.texts) {
        const hmm = t.h * cam.scale * k;
        if (hmm < 0.6) continue;
        const [x, y] = toP(t.x, t.y);
        doc.setFontSize(Math.max(2, hmm / 0.3528 / 0.72));
        doc.setTextColor((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        const ang = ((t.rot - cam.rotation) * 180) / Math.PI;
        const ascii = t.lines.join(' ').replace(/[^\x20-\x7e°±Ø]/g, '?');
        doc.text(ascii, x, y, { angle: ang, align: t.halign, baseline: t.valign === 'top' ? 'top' : t.valign === 'middle' ? 'middle' : 'alphabetic' } as any);
      }
    };
    for (const id of ids) {
      const e = cad.get(id) as Entity;
      if (!e || !cad.isVisible(e)) continue;
      const base = resolveStyle(e, null);
      if (e.type === 'insert' || (e.type === 'dimension' && e.block && cad.blocks[e.block])) {
        walkInsert(e, cad.blocks, (child, m, st) => {
          const l = cad.layer(st.layer);
          if (l && (!l.on || l.frozen)) return;
          draw(transformGeom(geometryOf(child), m), st);
        });
        if (e.type === 'insert') for (const a of e.attribs ?? []) draw(geometryOf(a), resolveStyle(a, base));
      } else draw(geometryOf(e), base);
    }
  }
  // title block
  const ty = H - margin - titleH + 2;
  doc.setDrawColor(0); doc.setLineWidth(0.3);
  doc.rect(margin, ty - 2, mapW, titleH);
  doc.setTextColor(0);
  doc.setFontSize(12); doc.text(o.title.replace(/[^\x20-\x7e]/g, '?'), margin + 3, ty + 5);
  doc.setFontSize(8);
  doc.text(`${(o.subtitle ?? '').replace(/[^\x20-\x7e]/g, '?')}`, margin + 3, ty + 10);
  doc.text(`FiberLens · ${new Date().toLocaleString()}${o.author ? ' · ' + o.author : ''}`, margin + 3, ty + 14);
  // scale bar (metres) when the drawing is calibrated or metric
  const upm = o.unitsPerMeter ?? 1;
  const mmPerMeter = cam.scale * k * upm;
  if (mmPerMeter > 0) {
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const target = 40 / mmPerMeter;
    const len = nice.find((n) => n >= target) ?? nice[nice.length - 1];
    const bw = len * mmPerMeter;
    const bx = W - margin - bw - 30, by = ty + 8;
    doc.setFillColor(0, 0, 0); doc.rect(bx, by, bw / 2, 1.5, 'F'); doc.rect(bx + bw / 2, by, bw / 2, 1.5, 'S');
    doc.text('0', bx, by + 5); doc.text(len + ' m', bx + bw, by + 5, { align: 'center' } as any);
  }
  // north arrow
  if (o.northAngle !== undefined) {
    const cx = W - margin - 12, cy = ty + 7;
    const a = o.northAngle - cam.rotation;
    const dx = Math.cos(a), dy = -Math.sin(a);
    doc.setFillColor(0, 0, 0);
    doc.triangle(cx + dx * 6, cy + dy * 6, cx - dy * 2, cy + dx * 2, cx + dy * 2, cy - dx * 2, 'F');
    doc.text('N', cx + dx * 9, cy + dy * 9, { align: 'center' } as any);
  }
  return new Uint8Array(doc.output('arraybuffer'));
}
