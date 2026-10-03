import { create } from 'zustand';
import type { NewEntityStyle } from '../cad/tools/types';
import { defaultSnapSettings, type SnapSettings } from '../cad/tools/snap';

export type PanelId =
  | 'layers' | 'draw' | 'edit' | 'text' | 'props' | 'ftth' | 'search' | 'measure' | 'gps' | 'calib'
  | 'survey' | 'notes' | 'photos' | 'project' | 'versions' | 'export' | 'reports' | 'maintenance'
  | 'users' | 'sync' | 'settings' | 'more' | 'compare' | 'qr' | 'info' | null;

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success' }

export interface AppState {
  screen: 'start' | 'cad';
  loading: string | null;
  progress: number | null;
  panel: PanelId;
  toolId: string;
  prompt: string;
  toolRev: number;
  docRev: number;
  selRev: number;
  selectionCount: number;
  cursor: { x: number; y: number } | null;
  dark: boolean;
  lineweights: boolean;
  grid: boolean;
  ortho: boolean;
  snap: SnapSettings;
  style: NewEntityStyle;
  toasts: Toast[];
  canUndo: boolean;
  canRedo: boolean;
  drawingName: string;
  projectName: string;
  projectId: string | null;
  drawingId: string | null;
  mode: 'design' | 'asbuilt';
  dirty: boolean;
  infoEntity: number | null;
  stats: string;
  /** phone bottom-sheet size */
  sheet: 'half' | 'full' | 'min';
  set: (p: Partial<AppState>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  screen: 'start',
  loading: null,
  progress: null,
  panel: null,
  toolId: 'select',
  prompt: '',
  toolRev: 0,
  docRev: 0,
  selRev: 0,
  selectionCount: 0,
  cursor: null,
  dark: true,
  lineweights: false,
  grid: false,
  ortho: false,
  snap: defaultSnapSettings(),
  style: {
    layer: '0', aci: 256, lineType: undefined, lineWeight: undefined, transparency: undefined,
    fill: false, fillAlpha: 0.35, textHeight: 2.5, font: 'Arial', bold: false, italic: false, rotation: 0, halign: 'left', bgMask: false,
  },
  toasts: [],
  canUndo: false,
  canRedo: false,
  drawingName: '',
  projectName: '',
  projectId: null,
  drawingId: null,
  mode: 'design',
  dirty: false,
  infoEntity: null,
  stats: '',
  sheet: 'half',
  set: (p) => set(p),
  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 3200);
  },
}));
