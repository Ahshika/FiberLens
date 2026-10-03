import React, { useEffect, useState } from 'react';
import { db, type SpliceRow, type CableRow } from '../../data/db';
import { useFtth, saveSplice, getCable, assignCore } from '../../ftth/store';
import { currentProjectId } from '../../data/projects';
import { recordChange } from '../../data/sync';
import { Icon } from '../icons';
import { ask } from '../../app/dialogs';
import { can } from '../../auth/session';
import { coreColor } from '../../ftth/model';

/** Splice tray for a closure / joint / distribution point: core ↔ core connections. */
export function SpliceEditor({ objectId }: { objectId: string }) {
  const rev = useFtth((s) => s.rev);
  const [rows, setRows] = useState<SpliceRow[]>([]);
  const load = () => db.splices.where('closureId').equals(objectId).toArray().then(setRows);
  useEffect(() => { load(); }, [objectId, rev]);
  const cables: CableRow[] = [...useFtth.getState().cables.values()].filter((c) => (c.fromId === objectId || c.toId === objectId) && c.fiberCount > 0);
  const label = (cableId: string, core: number) => {
    const c = getCable(cableId);
    const cc = coreColor(core, c?.tubeSize ?? ((c?.fiberCount ?? 12) <= 12 ? (c?.fiberCount ?? 12) : 12));
    return `${c?.code ?? '?'} #${core} (${cc.tube.name}/${cc.fiber.name})`;
  };
  const add = async () => {
    if (cables.length < 1) return;
    const opts = cables.map((c) => ({ value: c.id, label: `${c.code} (${c.fiberCount}F)` }));
    const r = await ask('New splice', [
      { key: 'a', label: 'Cable A (incoming)', type: 'select', value: cables[0].id, options: opts },
      { key: 'ac', label: 'Core A (number, or range 1-12)', value: '1' },
      { key: 'b', label: 'Cable B (outgoing)', type: 'select', value: (cables[1] ?? cables[0]).id, options: opts },
      { key: 'bc', label: 'Core B (start number)', value: '1' },
      { key: 'loss', label: 'Loss (dB, optional)', value: '' },
    ], { okLabel: 'Splice' });
    if (!r) return;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(r.ac).trim());
    if (!m) return;
    const a0 = +m[1], a1 = m[2] ? +m[2] : a0, b0 = +r.bc || 1;
    for (let k = 0; a0 + k <= a1; k++) {
      await saveSplice({ closureId: objectId, a: { cableId: r.a, core: a0 + k }, b: { cableId: r.b, core: b0 + k }, loss: r.loss ? +r.loss : undefined, projectId: currentProjectId()! } as any);
      await assignCore(r.a, a0 + k, 'used', { kind: 'cable', id: r.b, label: `→ ${getCable(r.b)?.code}#${b0 + k}` });
      await assignCore(r.b, b0 + k, 'used', { kind: 'cable', id: r.a, label: `← ${getCable(r.a)?.code}#${a0 + k}` });
    }
    load();
  };
  const del = async (s: SpliceRow) => { await db.splices.delete(s.id); recordChange('splices', s.id, 'delete', s.projectId); load(); };
  return (
    <div>
      <div className="section">Splice tray ({rows.length})</div>
      {cables.length === 0 && <div className="small muted">Connect cables to this element (cable From/To) to splice their cores.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap" style={{ maxHeight: 220 }}>
          <table className="tbl"><thead><tr><th>A</th><th></th><th>B</th><th>dB</th><th></th></tr></thead>
            <tbody>{rows.sort((x, y) => x.a.core - y.a.core).map((s) => (
              <tr key={s.id}><td>{label(s.a.cableId, s.a.core)}</td><td>⟷</td><td>{label(s.b.cableId, s.b.core)}</td><td>{s.loss ?? ''}</td>
                <td>{can('ftth.edit') && <button className="icon-btn" style={{ minWidth: 28, height: 28 }} onClick={() => del(s)}><Icon name="trash" /></button>}</td></tr>
            ))}</tbody></table>
        </div>
      )}
      {cables.length > 0 && <button className="btn sm" style={{ marginTop: 6 }} disabled={!can('ftth.edit')} onClick={add}><Icon name="plus" />Add splice(s)</button>}
    </div>
  );
}
