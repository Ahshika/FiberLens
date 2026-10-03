import { create } from 'zustand';

export interface DialogField { key: string; label: string; type?: 'text' | 'number' | 'textarea' | 'select' | 'color' | 'password' | 'date'; value?: any; options?: { value: string; label: string }[] }

export interface DialogReq {
  title: string;
  message?: string;
  fields?: DialogField[];
  okLabel?: string;
  cancelLabel?: string | null;
  danger?: boolean;
  resolve: (v: Record<string, any> | null) => void;
}

export const useDialog = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

/** generic form dialog */
export function ask(title: string, fields: DialogField[], opts: Partial<Omit<DialogReq, 'title' | 'fields' | 'resolve'>> = {}): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    useDialog.getState().set({ title, fields, ...opts, resolve: (v) => { useDialog.getState().set(null); resolve(v); } });
  });
}

export async function askText(title: string, initial = '', multiline = false): Promise<string | null> {
  const r = await ask(title, [{ key: 'v', label: '', type: multiline ? 'textarea' : 'text', value: initial }]);
  return r ? String(r.v ?? '') : null;
}

export async function confirmDialog(title: string, message: string, danger = false, okLabel = 'OK'): Promise<boolean> {
  const r = await ask(title, [], { message, danger, okLabel });
  return !!r;
}
