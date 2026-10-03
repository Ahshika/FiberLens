import { Tool, type ToolEvent, parsePointInput } from './types';
import type { Camera } from '../render/camera';
import type { Entity, Vec2, TextEnt, MTextEnt, InsertEnt } from '../model/types';
import { drawPreview, drawRubber } from './preview';
import { ask } from '../../app/dialogs';

function styleFields(host: Tool['host']) {
  const st = host.style();
  return { h: st.textHeight, rot: (st.rotation * Math.PI) / 180, font: st.font, bold: st.bold || undefined, italic: st.italic || undefined };
}

export class TextTool extends Tool {
  readonly id = 'text'; readonly label = 'Text';
  protected onActivate() { this.setPrompt('Tap the text insertion point'); }
  async click(e: ToolEvent) { await this.place(e.p); }
  input(t: string) { const p = parsePointInput(t, null, null); if (p) { this.place(p); return true; } return false; }
  async place(p: Vec2) {
    const value = await this.host.askText('New text', '');
    if (!value) return;
    const st = this.host.style();
    const sf = styleFields(this.host);
    const e: TextEnt = {
      id: this.host.doc.newId(), ...this.host.baseProps(), type: 'text', p, p2: p, value, ...sf,
      halign: st.halign === 'left' ? undefined : st.halign,
    } as TextEnt;
    const ents: Entity[] = [e];
    if (st.bgMask) {
      // emulate a background mask with an MTEXT instead
      const m: MTextEnt = { id: e.id, ...this.host.baseProps(), type: 'mtext', p, h: sf.h, rot: sf.rot, width: 0, attach: st.halign === 'center' ? 8 : st.halign === 'right' ? 9 : 7, value, font: sf.font, bold: sf.bold, italic: sf.italic, bgFill: -1, bgScale: 1.4 } as MTextEnt;
      ents[0] = m;
    }
    this.host.doc.add(ents, 'Text');
  }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.cursor) return;
    const sf = styleFields(this.host);
    drawPreview(ctx, cam, { id: 0, layer: '0', type: 'text', p: this.cursor, value: 'Text', ...sf } as any, '#7fd4ff');
  }
}

export class MTextTool extends Tool {
  readonly id = 'mtext'; readonly label = 'MText';
  private a: Vec2 | null = null;
  protected onActivate() { this.setPrompt('Specify first corner of the text box'); }
  reset() { this.a = null; this.basePoint = null; }
  async click(e: ToolEvent) {
    if (!this.a) { this.a = e.p; this.basePoint = e.p; this.setPrompt('Specify opposite corner'); return; }
    const b = e.p, a = this.a;
    this.reset(); this.setPrompt('Specify first corner of the text box');
    const value = await this.host.askText('Multiline text (Enter = new line)', '', true);
    if (!value) return;
    const st = this.host.style();
    const sf = styleFields(this.host);
    const tl = { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) };
    const m: MTextEnt = {
      id: this.host.doc.newId(), ...this.host.baseProps(), type: 'mtext', p: tl, h: sf.h, rot: sf.rot, width: Math.abs(b.x - a.x),
      attach: st.halign === 'center' ? 2 : st.halign === 'right' ? 3 : 1, value: value.replace(/\r?\n/g, '\\P'),
      font: sf.font, bold: sf.bold, italic: sf.italic, bgFill: st.bgMask ? -1 : undefined, bgScale: st.bgMask ? 1.4 : undefined,
    } as MTextEnt;
    if (m.attach === 2) m.p = { x: (a.x + b.x) / 2, y: tl.y };
    if (m.attach === 3) m.p = { x: Math.max(a.x, b.x), y: tl.y };
    this.host.doc.add([m], 'MText');
  }
  escape() { if (this.a) { this.reset(); this.setPrompt('Specify first corner of the text box'); } else this.host.finish(); }
  overlay(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.a && this.cursor) {
      const a = this.a, b = this.cursor;
      drawRubber(ctx, cam, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], true, '#7fd4ff');
    }
  }
}

/** Edit any existing text: TEXT, MTEXT, attribute values of a block, leader text, dimension text */
export async function editEntityText(host: Tool['host'], id: number): Promise<boolean> {
  const doc = host.doc;
  const e = doc.get(id);
  if (!e) return false;
  if (!doc.isEditable(e)) { host.notify(`Layer "${e.layer}" is locked`, 'error'); return false; }
  if (e.type === 'text') {
    const r = await ask('Edit text', [
      { key: 'value', label: 'Text', value: e.value },
      { key: 'h', label: 'Height', type: 'number', value: e.h },
      { key: 'rot', label: 'Rotation (°)', type: 'number', value: +(e.rot * 180 / Math.PI).toFixed(3) },
      { key: 'font', label: 'Font', value: e.font ?? '' },
      { key: 'style', label: 'Style', type: 'select', value: `${e.bold ? 'b' : ''}${e.italic ? 'i' : ''}`, options: [{ value: '', label: 'Regular' }, { value: 'b', label: 'Bold' }, { value: 'i', label: 'Italic' }, { value: 'bi', label: 'Bold italic' }] },
    ]);
    if (!r) return false;
    doc.modify([{ ...e, value: r.value, h: +r.h || e.h, rot: (+r.rot || 0) * Math.PI / 180, font: r.font || undefined, bold: r.style.includes('b') || undefined, italic: r.style.includes('i') || undefined }], 'Edit text');
    return true;
  }
  if (e.type === 'mtext') {
    const plain = e.value.replace(/\\P/g, '\n');
    const r = await ask('Edit multiline text', [
      { key: 'value', label: 'Text (formatting codes kept)', type: 'textarea', value: plain },
      { key: 'h', label: 'Height', type: 'number', value: e.h },
      { key: 'w', label: 'Box width (0 = no wrap)', type: 'number', value: e.width },
      { key: 'rot', label: 'Rotation (°)', type: 'number', value: +(e.rot * 180 / Math.PI).toFixed(3) },
      { key: 'mask', label: 'Background mask', type: 'select', value: e.bgFill !== undefined ? 'on' : 'off', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] },
    ]);
    if (!r) return false;
    doc.modify([{ ...e, value: String(r.value).replace(/\r?\n/g, '\\P'), h: +r.h || e.h, width: +r.w || 0, rot: (+r.rot || 0) * Math.PI / 180, bgFill: r.mask === 'on' ? (e.bgFill ?? -1) : undefined, bgScale: r.mask === 'on' ? (e.bgScale ?? 1.4) : undefined }], 'Edit MText');
    return true;
  }
  if (e.type === 'insert' && e.attribs?.length) {
    const r = await ask(`Edit attributes — ${e.block}`, e.attribs.map((a) => ({ key: a.tag, label: a.tag, value: a.value })));
    if (!r) return false;
    const ins: InsertEnt = { ...e, attribs: e.attribs.map((a) => ({ ...a, value: r[a.tag] ?? a.value })) };
    doc.modify([ins], 'Edit attributes');
    return true;
  }
  if (e.type === 'leader') {
    const v = await host.askText('Leader text', e.text ?? '', true);
    if (v === null) return false;
    doc.modify([{ ...e, text: v || undefined }], 'Edit leader');
    return true;
  }
  if (e.type === 'dimension') {
    const v = await host.askText('Dimension text override (<> = measured value)', e.text || '<>');
    if (v === null) return false;
    doc.modify([{ ...e, text: v }], 'Edit dimension');
    return true;
  }
  host.notify('This object has no editable text', 'info');
  return false;
}

export class EditTextTool extends Tool {
  readonly id = 'edittext'; readonly label = 'Edit Text';
  wantsSnap = false;
  protected onActivate() { this.setPrompt('Tap any text, MText, block attribute, leader or dimension to edit it'); }
  async click(e: ToolEvent) {
    const id = this.host.doc.pick(e.raw, this.host.pickTol(e.pointerType === 'touch' ? 16 : 8), (en) => ['text', 'mtext', 'insert', 'leader', 'dimension'].includes(en.type));
    if (id === null) { this.host.notify('No text here'); return; }
    this.host.selection.set([id]);
    await editEntityText(this.host, id);
  }
}
