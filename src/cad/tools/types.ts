import type { Vec2, Entity } from '../model/types';
import type { CadView } from '../render/CadView';
import type { CadDoc } from '../doc/CadDoc';
import type { Camera } from '../render/camera';
import type { SelectionManager } from './selection';
import type { SnapResult } from './snap';

export interface ToolEvent {
  sx: number;
  sy: number;
  /** raw world position under the pointer */
  raw: Vec2;
  /** snapped / ortho-constrained world position */
  p: Vec2;
  snap: SnapResult | null;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  pointerType: string;
}

/** Style applied to newly created entities (from the draw style bar). */
export interface NewEntityStyle {
  layer: string;
  aci?: number;
  rgb?: number;
  lineType?: string;
  lineWeight?: number;
  transparency?: number;
  fill: boolean;
  fillAlpha: number;
  textHeight: number;
  font: string;
  bold: boolean;
  italic: boolean;
  rotation: number;
  halign: 'left' | 'center' | 'right';
  bgMask: boolean;
}

export interface ToolOption {
  key: string;
  label: string;
  type: 'number' | 'select' | 'toggle' | 'text' | 'action';
  value?: any;
  choices?: { value: any; label: string }[];
}

export interface ToolHost {
  view: CadView;
  doc: CadDoc;
  selection: SelectionManager;
  style(): NewEntityStyle;
  setPrompt(text: string): void;
  /** ask the UI to re-render tool state (options, prompt) */
  refresh(): void;
  /** end the current tool and return to selection */
  finish(): void;
  notify(msg: string, kind?: 'info' | 'error' | 'success'): void;
  /** world tolerance for picking (CSS px → world) */
  pickTol(px?: number): number;
  /** entity base properties from the current style */
  baseProps(): Pick<Entity, 'layer' | 'aci' | 'rgb' | 'lineType' | 'lineWeight' | 'transparency'>;
  /** prompt the user for free text (async dialog) */
  askText(title: string, initial?: string, multiline?: boolean): Promise<string | null>;
  ortho(): boolean;
}

export abstract class Tool {
  abstract readonly id: string;
  abstract readonly label: string;
  host!: ToolHost;
  /** touch drags go to the tool instead of panning */
  wantsDrag = false;
  wantsSnap = true;
  /** reference point for ortho / perpendicular snapping */
  basePoint: Vec2 | null = null;
  prompt = '';
  /** last pointer position (world, snapped) for previews */
  cursor: Vec2 | null = null;

  activate(host: ToolHost) { this.host = host; this.reset(); this.onActivate(); this.setPrompt(this.prompt); }
  deactivate() { this.onDeactivate(); }
  protected onActivate() {}
  protected onDeactivate() {}
  reset() {}

  setPrompt(p: string) { this.prompt = p; this.host?.setPrompt(p); }

  down(_e: ToolEvent): void {}
  move(e: ToolEvent): void { this.cursor = e.p; this.host.view.invalidateOverlay(); }
  up(_e: ToolEvent): void {}
  /** click / tap (no drag) */
  click(_e: ToolEvent): void {}
  /** drag in progress (only when wantsDrag or mouse-left drag) */
  drag(_e: ToolEvent, _start: ToolEvent): void {}
  dragEnd(_e: ToolEvent, _start: ToolEvent): void {}
  enter(): void { this.host.finish(); }
  escape(): void { this.host.finish(); }
  key(_k: KeyboardEvent): boolean { return false; }
  /** typed value from the command line (number, x,y, @dx,dy, @d<a) */
  input(_text: string): boolean { return false; }
  options(): ToolOption[] { return []; }
  setOption(_key: string, _value: any): void {}
  overlay(_ctx: CanvasRenderingContext2D, _cam: Camera): void {}
}

/** Parse command-line point input relative to a base point. */
export function parsePointInput(text: string, base: Vec2 | null, cursor: Vec2 | null): Vec2 | null {
  const t = text.trim();
  let m = /^@?(-?[\d.]+)\s*<\s*(-?[\d.]+)$/.exec(t);
  if (m && base) {
    const d = parseFloat(m[1]), a = (parseFloat(m[2]) * Math.PI) / 180;
    return { x: base.x + Math.cos(a) * d, y: base.y + Math.sin(a) * d };
  }
  m = /^(@)?\s*(-?[\d.]+)\s*[,;]\s*(-?[\d.]+)$/.exec(t);
  if (m) {
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    if (m[1] && base) return { x: base.x + x, y: base.y + y };
    return { x, y };
  }
  m = /^(-?[\d.]+)$/.exec(t);
  if (m && base && cursor) {
    // distance along the cursor direction
    const d = parseFloat(m[1]);
    const dx = cursor.x - base.x, dy = cursor.y - base.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: base.x + (dx / L) * d, y: base.y + (dy / L) * d };
  }
  return null;
}
