import React, { useState } from 'react';
import { app } from '../../app/controller';
import { useApp } from '../../app/store';
import { Icon } from '../icons';
import { listXrefs, bindXref } from '../../cad/io/xref';
import { readCadFile } from '../../cad/io/cadClient';
import { db, uid } from '../../data/db';
import { currentProjectId } from '../../data/projects';
import { can } from '../../auth/session';
import { sha256 } from '../../data/compress';

/** External references: attach the referenced DWG/DXF so its content is displayed. */
export function XrefSection() {
  useApp((s) => s.docRev);
  const [, force] = useState(0);
  const doc = app.doc;
  if (!doc) return null;
  const xrefs = listXrefs(doc.drawing);
  if (!xrefs.length) return null;
  const attach = (name: string) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.dwg,.dxf';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      useApp.setState({ loading: `Loading xref ${name}…` });
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const { drawing } = await readCadFile(bytes, f.name);
        bindXref(doc, name, drawing);
        const pid = currentProjectId();
        if (pid) await db.files.add({ id: uid(), projectId: pid, kind: 'attachment', name: f.name, mime: 'image/vnd.dwg', size: bytes.length, sha256: await sha256(bytes), data: bytes, createdAt: Date.now() });
        useApp.getState().toast(`Xref ${name} loaded (${drawing.entities.length} objects)`, 'success');
        force((x) => x + 1);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
      useApp.setState({ loading: null });
    };
    inp.click();
  };
  return (
    <>
      <div className="section">External references (Xrefs)</div>
      {xrefs.map((x) => (
        <div key={x.name} className="list-item" style={{ cursor: 'default' }}>
          <Icon name="file" />
          <div className="grow" style={{ minWidth: 0 }}>
            <b>{x.name}</b>
            <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.path} · {x.inserts} insert(s)</div>
          </div>
          <span className={`badge ${x.loaded ? 'ok' : 'warn'}`}>{x.loaded ? 'loaded' : 'missing'}</span>
          <button className="btn sm" disabled={!can('cad.edit')} onClick={() => attach(x.name)}>{x.loaded ? 'Reload' : 'Attach file'}</button>
        </div>
      ))}
    </>
  );
}
