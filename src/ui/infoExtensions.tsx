import React from 'react';

type Ext = (props: { entityId: number }) => React.ReactElement | null;
const exts: Ext[] = [];

/** feature modules (FTTH, notes, photos) register sections shown in the entity info card */
export function registerInfoExtension(e: Ext) { exts.push(e); }

export function InfoExtensions({ entityId }: { entityId: number }) {
  return <>{exts.map((E, i) => <E key={i} entityId={entityId} />)}</>;
}
