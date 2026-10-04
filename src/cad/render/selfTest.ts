import { GlRenderer } from './glRenderer';
import { Scene } from './scene';
import { Camera } from './camera';
import { CadDoc } from '../doc/CadDoc';
import { emptyDrawing, type Entity } from '../model/types';

/**
 * Draw a red line and a green filled square through the real GPU pipeline and read the
 * pixels back. Some phone GPU drivers accept every WebGL call but draw nothing — this
 * catches them so the view can fall back to the Canvas renderer.
 */
export function glSelfTest(r: GlRenderer): { ok: boolean; reason?: string } {
  try {
    const d = emptyDrawing('selftest');
    d.entities = [
      { id: 1, type: 'line', layer: '0', aci: 1, p1: { x: -10, y: -6 }, p2: { x: 10, y: -6 } } as Entity,
      { id: 2, type: 'solid', layer: '0', aci: 3, pts: [-10, 2, 10, 2, -10, 10, 10, 10] } as Entity,
    ];
    d.nextId = 3;
    d.meta.extMin = { x: -12, y: -12 };
    d.meta.extMax = { x: 12, y: 12 };
    const doc = new CadDoc(d);
    const scene = new Scene(doc);
    scene.buildAllSync();
    const cam = new Camera();
    cam.setSize(64, 64, 1);
    cam.fit({ minX: -12, minY: -12, maxX: 12, maxY: 12 }, 0);
    r.render(scene, cam, { dark: true, background: 0x000000, lineweights: false });
    const gl = r.gl;
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const err = gl.getError();
    r.dispose(scene);
    let red = 0, green = 0;
    for (let i = 0; i < px.length; i += 4) {
      // antialiased 1px lines come out at ~50% intensity, so compare channels instead of absolute levels
      const r0 = px[i], g0 = px[i + 1], b0 = px[i + 2];
      if (r0 > 60 && r0 > 2 * g0 + 20 && r0 > 2 * b0 + 20) red++;
      if (g0 > 60 && g0 > 2 * r0 + 20 && g0 > 2 * b0 + 20) green++;
    }
    if (gl.isContextLost()) return { ok: false, reason: 'context lost' };
    if (err) return { ok: false, reason: 'GL error ' + err };
    if (red < 10) return { ok: false, reason: 'lines not drawn' };
    if (green < 50) return { ok: false, reason: 'fills not drawn' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
