import { CadView } from '../cad/render/CadView';
import { CadDoc } from '../cad/doc/CadDoc';
import { SelectionManager } from '../cad/tools/selection';
import { ToolManager } from '../cad/tools/ToolManager';
import type { ToolHost, NewEntityStyle } from '../cad/tools/types';
import type { Drawing, Entity, Vec2 } from '../cad/model/types';
import { readCadFile } from '../cad/io/cadClient';
import { registerTools } from '../cad/tools/registry';
import { SelectTool } from '../cad/tools/SelectTool';
import { useApp } from './store';
import { askText } from './dialogs';
import { useGps } from '../gps/gpsStore';
import { isUsable } from '../geo/calibration';
import { guessProjectedFromExtents } from '../geo/crs';
import { INSUNITS } from '../cad/model/types';
import { can, audit } from '../auth/session';

type Hook = () => void;

/**
 * Application controller: owns the CAD view, document, tools and selection and
 * bridges them to the React UI (zustand store). Feature modules (GPS, FTTH, project
 * persistence) attach through the hooks below.
 */
export class AppController {
  view: CadView | null = null;
  tools: ToolManager | null = null;
  selection: SelectionManager | null = null;
  doc: CadDoc | null = null;
  /** bytes of the original file (never modified) */
  original: Uint8Array | null = null;
  originalName = '';
  private docUnsubs: (() => void)[] = [];
  /** extra hooks fired when a new document is loaded */
  docLoadedHooks: ((doc: CadDoc) => void)[] = [];
  viewMountedHooks: ((view: CadView) => void)[] = [];
  gpsCadPosition: () => Vec2 | null = () => null;

  get store() { return useApp.getState(); }

  mount(host: HTMLElement, gl: HTMLCanvasElement, text: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    const view = new CadView(host, gl, text, overlay);
    const st = this.store;
    view.opts.dark = st.dark;
    view.opts.lineweights = st.lineweights;
    view.opts.grid = st.grid;
    this.view = view;
    this.selection = new SelectionManager(view, () => this.doc);
    this.selection.onChange(() => useApp.setState((s) => ({ selRev: s.selRev + 1, selectionCount: this.selection!.size })));
    const host2: Omit<ToolHost, 'finish'> = {
      view,
      get doc() { return app.doc!; },
      selection: this.selection,
      style: () => useApp.getState().style,
      setPrompt: (t) => useApp.setState({ prompt: t }),
      refresh: () => useApp.setState((s) => ({ toolRev: s.toolRev + 1 })),
      notify: (m, k) => useApp.getState().toast(m, k),
      pickTol: (px = 8) => px / view.cam.scale,
      baseProps: () => this.baseProps(),
      askText: (title, initial, multiline) => askText(title, initial, multiline),
      ortho: () => useApp.getState().ortho,
    };
    const tm = new ToolManager(view, host, host2, {
      get snap() { return useApp.getState().snap; },
      get ortho() { return useApp.getState().ortho; },
      gps: () => this.gpsCadPosition(),
    } as any);
    registerTools(tm);
    tm.onToolChange = (t) => useApp.setState((s) => ({ toolId: t?.id ?? 'select', toolRev: s.toolRev + 1 }));
    let lastCursor = 0;
    tm.onCursor = (p) => {
      const now = performance.now();
      if (now - lastCursor > 60) { lastCursor = now; useApp.setState({ cursor: { x: p.x, y: p.y } }); }
    };
    tm.keyHandlers.push((e) => this.onKey(e));
    this.tools = tm;
    SelectTool.onPick = (id) => useApp.setState({ infoEntity: id });
    if (this.doc) view.setDoc(this.doc);
    tm.setTool('select');
    for (const h of this.viewMountedHooks) h(view);
  }

  unmount() {
    this.tools?.dispose();
    this.view?.dispose();
    this.tools = null;
    this.view = null;
    this.selection = null;
  }

  baseProps(): Pick<Entity, 'layer' | 'aci' | 'rgb' | 'lineType' | 'lineWeight' | 'transparency'> {
    const s: NewEntityStyle = this.store.style;
    const layer = this.doc?.layer(s.layer) ? s.layer : (this.doc?.currentLayer ?? '0');
    const o: any = { layer, aci: s.rgb !== undefined ? undefined : (s.aci ?? 256) };
    if (s.rgb !== undefined) o.rgb = s.rgb;
    if (s.lineType) o.lineType = s.lineType;
    if (s.lineWeight !== undefined) o.lineWeight = s.lineWeight;
    if (s.transparency !== undefined) o.transparency = s.transparency;
    return o;
  }

  /** load a drawing into a live document */
  loadDrawing(d: Drawing, opts: { original?: Uint8Array | null; originalName?: string; fit?: boolean } = {}) {
    for (const u of this.docUnsubs) u();
    this.docUnsubs = [];
    this.doc = new CadDoc(d);
    this.doc.guard = (t) => {
      if (can('cad.edit')) return null;
      // layer visibility (on / freeze / lock) is a display preference, allowed for every role
      if (!t.added.length && !t.removed.length && !t.modified.length && !t.blocks && !t.lineTypes && t.layers) {
        const strip = (ls: any[]) => JSON.stringify(ls.map(({ on, frozen, locked, ...rest }) => rest));
        if (strip(t.layers.before) === strip(t.layers.after)) return null;
      }
      if (can('field.edit') && useApp.getState().mode === 'asbuilt') return null;
      return can('field.edit') ? 'Switch the project to As-Built mode to record field changes on the drawing (Project → As-Built).' : 'Your role is read-only for drawing edits.';
    };
    this.doc.onRefused = (m) => useApp.getState().toast(m, 'error');
    this.docUnsubs.push(this.doc.onCommit((tx, kind) => { if (kind === 'do') audit('cad.' + tx.label.toLowerCase().replace(/\s+/g, '-'), `${tx.added.length}+ ${tx.modified.length}~ ${tx.removed.length}-`); }));
    if (opts.original !== undefined) { this.original = opts.original; this.originalName = opts.originalName ?? ''; }
    this.selection?.clear();
    this.docUnsubs.push(this.doc.onChange(() => {
      this.selection?.prune();
      useApp.setState((s) => ({ docRev: s.docRev + 1, canUndo: !!this.doc?.canUndo, canRedo: !!this.doc?.canRedo, dirty: true }));
    }));
    const style = { ...this.store.style };
    if (!this.doc.layer(style.layer)) style.layer = '0';
    useApp.setState((s) => ({ screen: 'cad', drawingName: d.meta.name, docRev: s.docRev + 1, canUndo: false, canRedo: false, style, infoEntity: null }));
    this.view?.setDoc(this.doc, opts.fit !== false);
    for (const h of this.docLoadedHooks) h(this.doc);
  }

  /** read a DWG/DXF in the worker */
  async readFile(name: string, bytes: Uint8Array): Promise<Drawing> {
    useApp.setState({ loading: `Reading ${name}…` });
    try {
      const t0 = performance.now();
      const { drawing, ms } = await readCadFile(bytes, name);
      const st = useApp.getState();
      st.toast(`${name}: ${drawing.entities.length.toLocaleString()} entities, ${drawing.layers.length} layers (${(ms / 1000).toFixed(1)} s parse, ${((performance.now() - t0) / 1000).toFixed(1)} s total)`, 'success');
      return drawing;
    } finally {
      useApp.setState({ loading: null });
    }
  }

  setTool(id: string) { this.tools?.setTool(id); }
  undo() { this.doc?.undo(); }
  redo() { this.doc?.redo(); }

  deleteSelection() {
    const doc = this.doc, sel = this.selection;
    if (!doc || !sel || !sel.size) return;
    const ids = sel.list.filter((id) => { const e = doc.get(id); return e && doc.isEditable(e); });
    const locked = sel.size - ids.length;
    doc.remove(ids, `Delete ${ids.length}`);
    sel.clear();
    this.store.toast(`Deleted ${ids.length}${locked ? ` (${locked} on locked layers kept)` : ''}`);
  }

  private onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.shiftKey ? this.redo() : this.undo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { this.redo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k === 'a') { this.selection?.set(this.doc?.ids().filter((id) => this.doc!.isVisible(this.doc!.get(id)!)) ?? []); return true; }
    if ((e.ctrlKey || e.metaKey) && k === 'c') { this.tools?.has('copyclip') && this.setTool('copyclip'); return true; }
    if ((e.ctrlKey || e.metaKey) && k === 'v') { this.tools?.has('paste') && this.setTool('paste'); return true; }
    if (k === 'delete' || k === 'backspace') { this.deleteSelection(); return true; }
    if (k === 'f8') { const o = !this.store.ortho; this.store.set({ ortho: o }); this.store.toast(`Ortho ${o ? 'on' : 'off'}`); return true; }
    if (k === 'f3') { const s = this.store.snap; this.store.set({ snap: { ...s, enabled: !s.enabled } }); this.store.toast(`Object snap ${!s.enabled ? 'on' : 'off'}`); return true; }
    if (k === 'f7') { this.setOption('grid', !this.store.grid); return true; }
    return false;
  }

  setOption(key: 'dark' | 'lineweights' | 'grid', v: boolean) {
    this.store.set({ [key]: v } as any);
    if (this.view) { (this.view.opts as any)[key] = v; this.view.invalidate(); }
  }

  zoomToEntities(ids: number[]) { this.view?.zoomToEntities(ids); }

  /** drawing units per metre: calibration first, then a UTM heuristic, then $INSUNITS */
  unitsPerMeter(): number {
    const cal = useGps.getState().calibration;
    if (isUsable(cal)) return cal.unitsPerMeter;
    const d = this.doc?.drawing;
    if (!d) return 1;
    if (guessProjectedFromExtents({ minX: d.meta.extMin.x, minY: d.meta.extMin.y, maxX: d.meta.extMax.x, maxY: d.meta.extMax.y })) return 1;
    const u = INSUNITS[d.meta.units];
    return u && d.meta.units !== 0 ? 1 / u.meters : 1;
  }

  /** optional hook installed by the project module */
  saveVersionQuick?: () => void;
}

export const app = new AppController();
(window as any).fiberlens = app;
