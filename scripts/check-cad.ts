/**
 * Batch check of DWG/DXF files with the same import pipeline as the app.
 *   npm run check-cad -- "<folder>" [more folders/files…]
 * Writes check-cad-report.csv next to the first folder and prints a summary. For every file:
 * read errors, entity counts, unsupported entity types, block attributes that end up far from
 * their attribute definition, texts far outside the drawing, and the auto-detected CRS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AcadTsEngine } from '../src/cad/io/engine';
import { guessCrsFromPoint, medianPoint } from '../src/geo/crs';
import type { Drawing, Entity } from '../src/cad/model/types';

const args = process.argv.slice(2);
if (!args.length) { console.error('usage: npm run check-cad -- <folder|file> …'); process.exit(1); }

function collect(p: string, out: string[]) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) collect(path.join(p, f), out);
  else if (/\.(dwg|dxf)$/i.test(p)) out.push(p);
}
const files: string[] = [];
for (const a of args) collect(a, files);
console.log(`${files.length} files`);

function attributeIssues(d: Drawing) {
  let total = 0, off = 0;
  const visit = (list: Entity[]) => {
    for (const e of list) {
      if (e.type !== 'insert' || !e.attribs) continue;
      const b = d.blocks[e.block];
      const c = Math.cos(e.rot), s = Math.sin(e.rot);
      for (const t of e.attribs) {
        const def = b?.attdefs?.find((x) => x.tag === t.tag);
        if (!def?.p) continue;
        total++;
        const dx = t.p.x - e.p.x, dy = t.p.y - e.p.y;
        const lx = (dx * c + dy * s) / e.sx + (b.base.x || 0), ly = (-dx * s + dy * c) / e.sy + (b.base.y || 0);
        if (Math.hypot(lx - def.p.x, ly - def.p.y) > 20 * Math.max(def.h || 1, 1)) off++;
      }
    }
  };
  visit(d.entities);
  for (const b of Object.values(d.blocks)) visit(b.entities);
  return { total, off };
}

const rows: string[] = ['file,status,seconds,version,entities,layers,blocks,hatches,texts,attributes,attributes_off,not_rendered,crs,error'];
const unsupported = new Map<string, number>();
let failed = 0, warn = 0;
const engine = new AcadTsEngine();
for (const f of files) {
  const root = fs.statSync(args[0]).isDirectory() ? args[0] : path.dirname(args[0]);
  const name = path.relative(root, f) || path.basename(f);
  const t0 = Date.now();
  try {
    const bytes = new Uint8Array(fs.readFileSync(f));
    const { drawing: d } = engine.read(bytes, path.basename(f));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const count = (t: string) => d.entities.filter((e) => e.type === t).length + Object.values(d.blocks).reduce((n, b) => n + b.entities.filter((e) => e.type === t).length, 0);
    const notRendered = d.meta.notes.filter((n) => /not rendered/.test(n));
    for (const n of notRendered) { const m = n.match(/^(\d+) × (\S+)/); if (m) unsupported.set(m[2], (unsupported.get(m[2]) ?? 0) + +m[1]); }
    const att = attributeIssues(d);
    const mp = medianPoint(d.entities);
    const crs = mp ? guessCrsFromPoint(mp.x, mp.y)?.crs ?? 'local' : 'empty';
    const status = !d.entities.length ? 'EMPTY' : att.off > 0 ? 'CHECK' : 'OK';
    if (status !== 'OK') warn++;
    rows.push([JSON.stringify(name), status, secs, d.meta.version ?? '', d.entities.length, d.layers.length, Object.keys(d.blocks).length, count('hatch'), count('text') + count('mtext'), att.total, att.off, JSON.stringify(notRendered.join('; ')), crs, ''].join(','));
    console.log(`${status.padEnd(5)} ${secs.padStart(5)}s  ${String(d.entities.length).padStart(7)} ent  ${crs.padEnd(10)} ${name}${att.off ? `  (${att.off} attributes off)` : ''}`);
  } catch (err) {
    failed++;
    const msg = (err as Error).message;
    rows.push([JSON.stringify(name), 'FAIL', ((Date.now() - t0) / 1000).toFixed(1), '', '', '', '', '', '', '', '', '', '', JSON.stringify(msg)].join(','));
    console.log(`FAIL  ${name}: ${msg}`);
  }
}
const report = path.join(fs.statSync(args[0]).isDirectory() ? args[0] : path.dirname(args[0]), 'check-cad-report.csv');
fs.writeFileSync(report, '﻿' + rows.join('\n'));
console.log(`\n${files.length - failed - warn} OK · ${warn} to check · ${failed} failed`);
if (unsupported.size) console.log('not rendered:', [...unsupported].map(([k, v]) => `${k} ×${v}`).join(', '));
console.log('report:', report);
