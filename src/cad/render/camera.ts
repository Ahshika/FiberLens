import type { Vec2 } from '../model/types';
import type { BBox } from '../geom/bbox';

/**
 * 2D camera. World units → CSS pixels. Center is kept in float64; the GPU only ever sees
 * offsets relative to the center, so huge UTM coordinates render without jitter.
 */
export class Camera {
  cx = 0;
  cy = 0;
  /** CSS pixels per world unit */
  scale = 1;
  /** view rotation (radians): world is rotated by -rotation on screen (heading-up) */
  rotation = 0;
  width = 1;
  height = 1;
  dpr = 1;

  setSize(w: number, h: number, dpr: number) { this.width = w; this.height = h; this.dpr = dpr; }

  worldToScreen(x: number, y: number): Vec2 {
    const dx = x - this.cx, dy = y - this.cy;
    const c = Math.cos(-this.rotation), s = Math.sin(-this.rotation);
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return { x: this.width / 2 + rx * this.scale, y: this.height / 2 - ry * this.scale };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    const rx = (sx - this.width / 2) / this.scale;
    const ry = -(sy - this.height / 2) / this.scale;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return { x: this.cx + rx * c - ry * s, y: this.cy + rx * s + ry * c };
  }

  /** world bbox of the visible area (accounts for rotation) */
  viewBox(margin = 0): BBox {
    const pts = [
      this.screenToWorld(-margin, -margin), this.screenToWorld(this.width + margin, -margin),
      this.screenToWorld(this.width + margin, this.height + margin), this.screenToWorld(-margin, this.height + margin),
    ];
    return {
      minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
    };
  }

  /** zoom by factor keeping screen point (sx,sy) fixed */
  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.screenToWorld(sx, sy);
    this.scale = Math.max(1e-7, Math.min(1e7, this.scale * factor));
    const after = this.screenToWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  panPixels(dx: number, dy: number) {
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    const wx = -dx / this.scale, wy = dy / this.scale;
    this.cx += wx * c - wy * s;
    this.cy += wx * s + wy * c;
  }

  fit(b: BBox, padding = 0.06) {
    const w = Math.max(b.maxX - b.minX, 1e-9), h = Math.max(b.maxY - b.minY, 1e-9);
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    const sx = this.width / (w * (1 + padding * 2)), sy = this.height / (h * (1 + padding * 2));
    this.scale = Math.min(sx, sy);
  }

  clone(): Camera { const c = new Camera(); Object.assign(c, this); return c; }
}
