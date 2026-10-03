import type { Drawing, Entity, BlockDef, Layer } from '../model/types';
import type { CadDoc } from '../doc/CadDoc';

/** blocks that are external references */
export function listXrefs(d: Drawing): { name: string; path: string; loaded: boolean; inserts: number }[] {
  const out: { name: string; path: string; loaded: boolean; inserts: number }[] = [];
  for (const b of Object.values(d.blocks)) {
    if (!b.xref) continue;
    const inserts = d.entities.filter((e) => e.type === 'insert' && e.block === b.name).length;
    out.push({ name: b.name, path: b.xref, loaded: b.entities.length > 0, inserts });
  }
  return out;
}

/**
 * Bind an external drawing into an xref block (AutoCAD "Bind/Insert" semantics):
 * its layers become "XREF|layer", nested blocks become "XREF|block".
 */
export function bindXref(doc: CadDoc, xrefName: string, ext: Drawing) {
  const d = doc.drawing;
  const prefix = (n: string) => `${xrefName}|${n}`;
  let nextId = d.nextId;
  const remap = (e: Entity): Entity => {
    const c: any = structuredClone(e);
    c.id = nextId++;
    c.handle = undefined;
    c.layer = c.layer === '0' ? '0' : prefix(c.layer);
    if (c.type === 'insert' || (c.type === 'dimension' && c.block)) c.block = prefix(c.block);
    if (c.attribs) c.attribs = c.attribs.map((a: any) => ({ ...a, id: nextId++, layer: a.layer === '0' ? '0' : prefix(a.layer), handle: undefined }));
    return c;
  };
  const blocks: { name: string; before: BlockDef | null; after: BlockDef | null }[] = [];
  const target = d.blocks[xrefName];
  blocks.push({ name: xrefName, before: target ?? null, after: { ...(target ?? { name: xrefName, base: { x: 0, y: 0 } }), entities: ext.entities.map(remap), xref: target?.xref } as BlockDef });
  for (const b of Object.values(ext.blocks)) {
    const n = prefix(b.name);
    blocks.push({ name: n, before: d.blocks[n] ?? null, after: { ...b, name: n, entities: b.entities.map(remap) } });
  }
  const layersAfter: Layer[] = [...d.layers];
  const have = new Set(d.layers.map((l) => l.name));
  for (const l of ext.layers) {
    if (l.name === '0') continue;
    const n = prefix(l.name);
    if (!have.has(n)) layersAfter.push({ ...l, name: n, handle: undefined });
  }
  d.nextId = nextId;
  return doc.commit({ label: `Load xref ${xrefName}`, added: [], removed: [], modified: [], blocks, layers: { before: d.layers, after: layersAfter } });
}
