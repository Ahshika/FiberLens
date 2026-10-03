import { create } from 'zustand';
import { app } from '../app/controller';
import { useFtth } from './store';
import { kindMeta, STATUS_COLOR } from './model';
import type { Camera } from '../cad/render/camera';
import type { FtthKind } from '../data/db';

export const useFtthView = create<{ markers: boolean; labels: boolean; hidden: Set<FtthKind>; selected: string | null; set: (p: any) => void }>((set) => ({
  markers: true, labels: true, hidden: new Set<FtthKind>(['Building']), selected: null, set: (p) => set(p),
}));

/** Smart-object markers drawn over the CAD (status ring + code label when zoomed in). */
function draw(ctx: CanvasRenderingContext2D, cam: Camera) {
  const v = useFtthView.getState();
  if (!v.markers) return;
  const s = useFtth.getState();
  const vb = cam.viewBox(30);
  const upm = app.unitsPerMeter();
  const pxPerM = cam.scale * upm;
  if (pxPerM < 0.25) return; // too far out: let the CAD speak
  let n = 0;
  const showLabels = v.labels && pxPerM > 2.2;
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const o of s.objects.values()) {
    if (v.hidden.has(o.kind)) continue;
    const { x, y } = o.cad;
    if (x < vb.minX || x > vb.maxX || y < vb.minY || y > vb.maxY) continue;
    if (++n > 3000) break;
    const p = cam.worldToScreen(x, y);
    const km = kindMeta(o.kind);
    const r = o.id === v.selected ? 9 : 6;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = STATUS_COLOR[o.status] ?? '#888';
    ctx.fillStyle = km.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (o.id === v.selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    if (showLabels) {
      const t = o.code;
      const w = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(8,12,18,0.78)';
      ctx.fillRect(p.x + 9, p.y - 8, w + 8, 16);
      ctx.fillStyle = km.color;
      ctx.fillText(t, p.x + 13, p.y);
    }
  }
  ctx.restore();
}

app.viewMountedHooks.push((view) => view.addOverlay('ftth', draw, 20));
useFtthView.subscribe(() => app.view?.invalidateOverlay());
