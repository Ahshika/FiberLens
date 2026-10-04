import type { Camera } from './camera';
import { type Scene, type Chunk, SEG_STRIDE, TRI_STRIDE } from './scene';
import { aciToRgb } from '../model/color';

const SEG_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_seg;
layout(location=2) in vec2 a_dist;
layout(location=3) in vec4 a_color;
layout(location=4) in uvec4 a_props;
uniform vec2 u_offset;
uniform vec2 u_rot;
uniform float u_scale;
uniform vec2 u_vp;
uniform float u_dpr;
uniform sampler2D u_layerColor;
uniform highp usampler2D u_layerProps;
uniform vec3 u_fg;
uniform float u_lwOn;
uniform float u_lwDefault;
out vec4 v_color;
out float v_along;
out float v_across;
out float v_halfw;
flat out int v_lt;
out float v_ltScale;
flat out int v_point;

ivec2 texAt(uint i) { return ivec2(int(i % 1024u), int(i / 1024u)); }

void main() {
  uint layer = a_props.x;
  uint flags = a_props.w;
  vec4 lc = texelFetch(u_layerColor, texAt(layer), 0);
  uvec4 lp = texelFetch(u_layerProps, texAt(layer), 0);
  bool visible = lp.b == 1u;
  if (!visible) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 rgb = a_color.rgb;
  if ((flags & 1u) != 0u) rgb = lc.rgb;
  if ((flags & 4u) != 0u) rgb = u_fg;
  float alpha = ((flags & 2u) != 0u) ? lc.a : a_color.a;
  v_color = vec4(rgb, alpha);
  uint lt = a_props.y;
  if ((flags & 8u) != 0u) lt = lp.g;
  v_lt = int(lt);
  v_ltScale = a_dist.y;
  uint lw = a_props.z;
  if (lw == 65535u) lw = lp.r;
  float lwmm = (lw >= 65534u) ? u_lwDefault : float(lw) / 100.0;
  float wpx = 1.0;
  if (u_lwOn > 0.5) wpx = max(1.0, lwmm * 3.78 * u_dpr * 0.75);
  bool isPoint = (flags & 16u) != 0u;
  v_point = isPoint ? 1 : 0;
  if (isPoint) wpx = max(wpx, 3.0 * u_dpr);

  vec2 w1 = a_seg.xy + u_offset;
  vec2 w2 = a_seg.zw + u_offset;
  vec2 r1 = vec2(w1.x * u_rot.x - w1.y * u_rot.y, w1.x * u_rot.y + w1.y * u_rot.x);
  vec2 r2 = vec2(w2.x * u_rot.x - w2.y * u_rot.y, w2.x * u_rot.y + w2.y * u_rot.x);
  float k = u_scale * u_dpr;
  vec2 p1 = r1 * k;
  vec2 p2 = r2 * k;
  vec2 d = p2 - p1;
  float L = length(d);
  vec2 dir = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = wpx * 0.5 + 0.5;
  v_halfw = hw;
  vec2 pos = mix(p1, p2, a_corner.x) + dir * (a_corner.x * 2.0 - 1.0) * hw + nrm * a_corner.y * hw;
  v_across = a_corner.y * hw;
  v_along = a_dist.x + dot(pos - p1, dir) / k;
  gl_Position = vec4(pos / (u_vp * 0.5), 0.0, 1.0);
}`;

const SEG_FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 v_color;
in float v_along;
in float v_across;
in float v_halfw;
flat in int v_lt;
in float v_ltScale;
flat in int v_point;
uniform sampler2D u_lt;
uniform float u_scale;
uniform float u_dpr;
uniform float u_alphaMul;
out vec4 o;
void main() {
  if (v_lt > 0 && v_point == 0) {
    float L = texelFetch(u_lt, ivec2(0, v_lt), 0).r;
    int n = int(texelFetch(u_lt, ivec2(1, v_lt), 0).r);
    float ppu = u_scale * u_dpr * v_ltScale;
    if (L > 0.0 && n > 0 && L * ppu > 6.0) {
      float s = v_along / v_ltScale;
      float pos = mod(s, L);
      float acc = 0.0;
      bool on = true;
      for (int i = 0; i < 12; i++) {
        if (i >= n) break;
        float el = texelFetch(u_lt, ivec2(2 + i, v_lt), 0).r;
        float len = abs(el);
        if (el == 0.0) len = 1.5 / ppu;
        if (pos < acc + len) { on = el >= 0.0; break; }
        acc += len;
      }
      if (!on) discard;
    }
  }
  float cov = clamp(v_halfw - abs(v_across), 0.0, 1.0);
  o = vec4(v_color.rgb, v_color.a * cov * u_alphaMul);
}`;

const TRI_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
layout(location=2) in uvec2 a_props;
uniform vec2 u_offset;
uniform vec2 u_rot;
uniform float u_scale;
uniform vec2 u_vp;
uniform float u_dpr;
uniform sampler2D u_layerColor;
uniform highp usampler2D u_layerProps;
uniform vec3 u_fg;
uniform vec3 u_bg;
out vec4 v_color;
ivec2 texAt(uint i) { return ivec2(int(i % 1024u), int(i / 1024u)); }
void main() {
  uint layer = a_props.x;
  uint flags = a_props.y;
  vec4 lc = texelFetch(u_layerColor, texAt(layer), 0);
  uvec4 lp = texelFetch(u_layerProps, texAt(layer), 0);
  if (lp.b != 1u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 rgb = a_color.rgb;
  if ((flags & 1u) != 0u) rgb = lc.rgb;
  if ((flags & 4u) != 0u) rgb = u_fg;
  if ((flags & 32u) != 0u) rgb = u_bg;
  float alpha = ((flags & 2u) != 0u) ? lc.a : a_color.a;
  if ((flags & 32u) != 0u) alpha = 1.0;
  v_color = vec4(rgb, alpha);
  vec2 w = a_pos + u_offset;
  vec2 r = vec2(w.x * u_rot.x - w.y * u_rot.y, w.x * u_rot.y + w.y * u_rot.x);
  vec2 p = r * u_scale * u_dpr;
  gl_Position = vec4(p / (u_vp * 0.5), 0.0, 1.0);
}`;

const TRI_FS = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_alphaMul;
out vec4 o;
void main() { o = vec4(v_color.rgb, v_color.a * u_alphaMul); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  return p;
}

interface ChunkGpu {
  segVao: WebGLVertexArrayObject | null; segBuf: WebGLBuffer | null; segCount: number;
  triVao: WebGLVertexArrayObject | null; triBuf: WebGLBuffer | null; triCount: number;
  maskVao: WebGLVertexArrayObject | null; maskBuf: WebGLBuffer | null; maskCount: number;
}

export interface RenderOptions {
  dark: boolean;
  background: number;
  lineweights: boolean;
  /** global alpha multiplier (used e.g. to dim the drawing in compare mode) */
  alpha?: number;
}

export class GlRenderer {
  readonly kind = 'webgl';
  gl: WebGL2RenderingContext;
  interacting = false;
  private segProg: WebGLProgram;
  private triProg: WebGLProgram;
  private cornerBuf: WebGLBuffer;
  private layerColorTex: WebGLTexture;
  private layerPropsTex: WebGLTexture;
  private ltTex: WebGLTexture;
  private styleVersion = -1;
  private styleScene: Scene | null = null;
  private themeKey = '';
  private segU: Record<string, WebGLUniformLocation | null> = {};
  private triU: Record<string, WebGLUniformLocation | null> = {};
  gpuBytes = 0;
  lastDrawStats = { chunks: 0, segments: 0, triangles: 0 };

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available on this device');
    this.gl = gl;
    this.segProg = compile(gl, SEG_VS, SEG_FS);
    this.triProg = compile(gl, TRI_VS, TRI_FS);
    for (const n of ['u_offset', 'u_rot', 'u_scale', 'u_vp', 'u_dpr', 'u_layerColor', 'u_layerProps', 'u_fg', 'u_lwOn', 'u_lwDefault', 'u_lt', 'u_alphaMul'])
      this.segU[n] = gl.getUniformLocation(this.segProg, n);
    for (const n of ['u_offset', 'u_rot', 'u_scale', 'u_vp', 'u_dpr', 'u_layerColor', 'u_layerProps', 'u_fg', 'u_bg', 'u_alphaMul'])
      this.triU[n] = gl.getUniformLocation(this.triProg, n);
    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.layerColorTex = gl.createTexture()!;
    this.layerPropsTex = gl.createTexture()!;
    this.ltTex = gl.createTexture()!;
  }

  private updateStyleTextures(scene: Scene, opts: RenderOptions) {
    const theme = `${opts.dark}`;
    // keyed by scene too: versions of different scenes (e.g. the GPU self-test) can collide
    if (this.styleScene === scene && this.styleVersion === scene.styles.version && this.themeKey === theme) return;
    this.styleScene = scene;
    this.styleVersion = scene.styles.version;
    this.themeKey = theme;
    const gl = this.gl;
    const st = scene.styles;
    const n = Math.max(1, st.layerIndex.size);
    const w = 1024, h = Math.ceil(n / w);
    const colors = new Uint8Array(w * h * 4);
    const props = new Uint16Array(w * h * 4);
    const fg = opts.dark ? 0xffffff : 0x000000;
    for (const [name, i] of st.layerIndex) {
      const l = st.layers[i];
      let rgb = 0xffffff, alpha = 255, lw = 0xfffe, lt = 0, visible = 1;
      if (l) {
        const aci = l.aci ?? 7;
        rgb = l.rgb ?? (aci === 7 || aci === 0 || aci === 256 ? fg : aciToRgb(aci));
        alpha = Math.round((1 - (l.transparency || 0)) * 255);
        lw = l.lineWeight === undefined || l.lineWeight < 0 ? 0xfffe : l.lineWeight;
        lt = st.ltIdx(l.lineType || 'Continuous');
        visible = l.on && !l.frozen ? 1 : 0;
      } else if (name === undefined) visible = 0;
      colors.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha], i * 4);
      props.set([lw, lt, visible, 0], i * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.layerColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, colors);
    this.texParams();
    gl.bindTexture(gl.TEXTURE_2D, this.layerPropsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, w, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, props);
    this.texParams();
    // linetypes
    const ltN = Math.max(1, st.ltIndex.size);
    const lt = new Float32Array(32 * ltN);
    for (const [, i] of st.ltIndex) {
      const def = st.lineTypes[i];
      if (!def || !def.pattern.length || i === 0) continue;
      const pat = def.pattern.slice(0, 12);
      lt[i * 32] = pat.reduce((a, b) => a + Math.abs(b), 0);
      lt[i * 32 + 1] = pat.length;
      pat.forEach((v, k) => (lt[i * 32 + 2 + k] = v));
    }
    gl.bindTexture(gl.TEXTURE_2D, this.ltTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 32, ltN, 0, gl.RED, gl.FLOAT, lt);
    this.texParams();
  }

  private texParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private upload(c: Chunk) {
    const gl = this.gl;
    let g = c.gpu as ChunkGpu | undefined;
    if (!g) {
      g = { segVao: null, segBuf: null, segCount: 0, triVao: null, triBuf: null, triCount: 0, maskVao: null, maskBuf: null, maskCount: 0 };
      c.gpu = g;
    }
    this.gpuBytes -= g.segCount * SEG_STRIDE + (g.triCount + g.maskCount) * TRI_STRIDE;
    // segments
    if (c.segCount) {
      if (!g.segVao) {
        g.segVao = gl.createVertexArray();
        g.segBuf = gl.createBuffer();
        gl.bindVertexArray(g.segVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.segBuf);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEG_STRIDE, 0); gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, SEG_STRIDE, 16); gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, SEG_STRIDE, 24); gl.vertexAttribDivisor(3, 1);
        gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_SHORT, SEG_STRIDE, 28); gl.vertexAttribDivisor(4, 1);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.segBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.segData!, gl.STATIC_DRAW);
    }
    g.segCount = c.segCount;
    const triSetup = (vaoKey: 'triVao' | 'maskVao', bufKey: 'triBuf' | 'maskBuf', data: ArrayBuffer | null, count: number) => {
      if (!count) return;
      if (!g![vaoKey]) {
        g![vaoKey] = gl.createVertexArray();
        g![bufKey] = gl.createBuffer();
        gl.bindVertexArray(g![vaoKey]);
        gl.bindBuffer(gl.ARRAY_BUFFER, g![bufKey]);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TRI_STRIDE, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, TRI_STRIDE, 8);
        gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_SHORT, TRI_STRIDE, 12);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g![bufKey]);
      gl.bufferData(gl.ARRAY_BUFFER, data!, gl.STATIC_DRAW);
    };
    triSetup('triVao', 'triBuf', c.triData, c.triCount);
    g.triCount = c.triCount;
    triSetup('maskVao', 'maskBuf', c.maskData, c.maskCount);
    g.maskCount = c.maskCount;
    gl.bindVertexArray(null);
    this.gpuBytes += g.segCount * SEG_STRIDE + (g.triCount + g.maskCount) * TRI_STRIDE;
    c.gpuVersion = c.version;
  }

  releaseChunk(c: Chunk) {
    const g = c.gpu as ChunkGpu | undefined;
    if (!g) return;
    const gl = this.gl;
    for (const v of [g.segVao, g.triVao, g.maskVao]) if (v) gl.deleteVertexArray(v);
    for (const b of [g.segBuf, g.triBuf, g.maskBuf]) if (b) gl.deleteBuffer(b);
    this.gpuBytes -= g.segCount * SEG_STRIDE + (g.triCount + g.maskCount) * TRI_STRIDE;
    c.gpu = undefined;
    c.gpuVersion = -1;
  }

  /**
   * Draw a scene. pass.clear=false draws on top of the previous pass; pass.scissor (device px,
   * GL origin bottom-left) clips the pass — used for paper-space viewports.
   */
  render(scene: Scene, cam: Camera, opts: RenderOptions, pass: { clear?: boolean; scissor?: [number, number, number, number]; viewBox?: { minX: number; minY: number; maxX: number; maxY: number } } = {}) {
    const gl = this.gl;
    const W = Math.round(cam.width * cam.dpr), H = Math.round(cam.height * cam.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    const bg = opts.background;
    if (pass.scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...pass.scissor); } else gl.disable(gl.SCISSOR_TEST);
    if (pass.clear !== false) {
      gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.updateStyleTextures(scene, opts);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const view = pass.viewBox ?? cam.viewBox(8);
    const chunks = scene.visibleChunks(view);
    for (const c of chunks) if (c.gpuVersion !== c.version) this.upload(c);
    const rot: [number, number] = [Math.cos(-cam.rotation), Math.sin(-cam.rotation)];
    const fg = opts.dark ? [1, 1, 1] : [0, 0, 0];
    const bgv = [((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255];
    const alphaMul = opts.alpha ?? 1;
    let segs = 0, tris = 0;

    const bindCommon = (U: Record<string, WebGLUniformLocation | null>) => {
      gl.uniform2f(U.u_rot, rot[0], rot[1]);
      gl.uniform1f(U.u_scale, cam.scale);
      gl.uniform2f(U.u_vp, W, H);
      gl.uniform1f(U.u_dpr, cam.dpr);
      gl.uniform3f(U.u_fg, fg[0], fg[1], fg[2]);
      gl.uniform1f(U.u_alphaMul, alphaMul);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.layerColorTex); gl.uniform1i(U.u_layerColor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.layerPropsTex); gl.uniform1i(U.u_layerProps, 1);
    };

    // pass 1: fills
    gl.useProgram(this.triProg);
    bindCommon(this.triU);
    gl.uniform3f(this.triU.u_bg, bgv[0], bgv[1], bgv[2]);
    for (const c of chunks) {
      const g = c.gpu as ChunkGpu;
      if (!g?.triCount) continue;
      gl.uniform2f(this.triU.u_offset, c.ox - cam.cx, c.oy - cam.cy);
      gl.bindVertexArray(g.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, g.triCount);
      tris += g.triCount / 3;
    }
    // pass 2: lines
    gl.useProgram(this.segProg);
    bindCommon(this.segU);
    gl.uniform1f(this.segU.u_lwOn, opts.lineweights ? 1 : 0);
    gl.uniform1f(this.segU.u_lwDefault, 0.25);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.ltTex); gl.uniform1i(this.segU.u_lt, 2);
    for (const c of chunks) {
      const g = c.gpu as ChunkGpu;
      if (!g?.segCount) continue;
      gl.uniform2f(this.segU.u_offset, c.ox - cam.cx, c.oy - cam.cy);
      gl.bindVertexArray(g.segVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.segCount);
      segs += g.segCount;
    }
    // pass 3: masks (wipeouts / text background)
    gl.useProgram(this.triProg);
    bindCommon(this.triU);
    gl.uniform3f(this.triU.u_bg, bgv[0], bgv[1], bgv[2]);
    for (const c of chunks) {
      const g = c.gpu as ChunkGpu;
      if (!g?.maskCount) continue;
      gl.uniform2f(this.triU.u_offset, c.ox - cam.cx, c.oy - cam.cy);
      gl.bindVertexArray(g.maskVao);
      gl.drawArrays(gl.TRIANGLES, 0, g.maskCount);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    this.lastDrawStats = { chunks: chunks.length, segments: segs, triangles: tris };
  }

  dispose(scene?: Scene) {
    if (scene) for (const c of scene.chunks.values()) this.releaseChunk(c);
    if (scene && scene === this.styleScene) this.styleScene = null;
  }

  clear(bg: number) {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** forget GPU objects of every chunk (after a context loss) */
  forgetChunks(scene: Scene) { for (const c of scene.chunks.values()) { c.gpu = undefined; c.gpuVersion = -1; } this.gpuBytes = 0; }
}
