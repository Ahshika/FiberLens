import React from 'react';
import { useApp } from '../app/store';
import { app } from '../app/controller';
import { Icon } from './icons';
import { fmt } from './common';
import { entityLength, entityArea } from '../cad/edit/measure';
import { InfoExtensions } from './infoExtensions';

/** Quick info for the tapped entity (FTTH modules add their own sections). */
export function InfoCard() {
  const id = useApp((s) => s.infoEntity);
  useApp((s) => s.docRev);
  const toolId = useApp((s) => s.toolId);
  if (id === null || toolId !== 'select') return null;
  const doc = app.doc;
  const e = doc?.get(id);
  if (!e) return null;
  const len = entityLength(e);
  const area = entityArea(e);
  const upm = app.unitsPerMeter();
  const close = () => useApp.setState({ infoEntity: null });
  return (
    <div className="info-card">
      <h4>
        <span className="grow">{e.type === 'insert' ? `Block: ${e.block}` : e.type.toUpperCase()}</span>
        <button className="icon-btn" style={{ minWidth: 32, height: 32 }} onClick={() => app.zoomToEntities([id])} title="Zoom to"><Icon name="zoomin" /></button>
        <button className="icon-btn" style={{ minWidth: 32, height: 32 }} onClick={() => useApp.setState({ panel: 'props' })} title="Properties"><Icon name="props" /></button>
        <button className="icon-btn" style={{ minWidth: 32, height: 32 }} onClick={close}><Icon name="close" /></button>
      </h4>
      <div className="kv">
        <div>Layer</div><div>{e.layer}</div>
        {e.handle && <><div>Handle</div><div className="mono">{e.handle}</div></>}
        {len !== null && <><div>Length</div><div>{fmt(len, 3)} du{upm !== 1 ? ` · ${fmt(len / upm, 2)} m` : ''}</div></>}
        {area !== null && <><div>Area</div><div>{fmt(area, 3)} du²{upm !== 1 ? ` · ${fmt(area / upm / upm, 2)} m²` : ''}</div></>}
        {(e.type === 'text' || e.type === 'mtext') && <><div>Text</div><div dir="auto">{e.value}</div></>}
        {e.type === 'insert' && e.attribs?.map((a) => <React.Fragment key={a.tag}><div>{a.tag}</div><div dir="auto">{a.value}</div></React.Fragment>)}
      </div>
      <InfoExtensions entityId={id} />
    </div>
  );
}
