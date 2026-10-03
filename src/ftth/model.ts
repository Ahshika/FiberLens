import type { FtthKind, CableCategory, CoreStatus, ObjStatus } from '../data/db';

export interface KindMeta { kind: FtthKind; label: string; color: string; level: number; prefix: string; icon: string; isNode: boolean }

/** hierarchy level: 0 = head-end … higher = closer to the customer */
export const KINDS: KindMeta[] = [
  { kind: 'OLT', label: 'OLT', color: '#ff3b30', level: 0, prefix: 'OLT', icon: 'satellite', isNode: true },
  { kind: 'ODF', label: 'ODF', color: '#ff6b3d', level: 1, prefix: 'ODF', icon: 'grid', isNode: true },
  { kind: 'Cabinet', label: 'Cabinet', color: '#ff9500', level: 2, prefix: 'CAB', icon: 'rect', isNode: true },
  { kind: 'FDH', label: 'FDH', color: '#ffb000', level: 2, prefix: 'FDH', icon: 'splitter', isNode: true },
  { kind: 'FDT', label: 'FDT', color: '#ffd60a', level: 3, prefix: 'FDT', icon: 'splitter', isNode: true },
  { kind: 'Closure', label: 'Closure', color: '#bf5af2', level: 3, prefix: 'CL', icon: 'circle', isNode: true },
  { kind: 'Joint', label: 'Joint', color: '#a970ff', level: 3, prefix: 'JNT', icon: 'join', isNode: true },
  { kind: 'Splitter', label: 'Splitter', color: '#64d2ff', level: 4, prefix: 'SP', icon: 'splitter', isNode: true },
  { kind: 'FAT', label: 'FAT', color: '#30d158', level: 5, prefix: 'FAT', icon: 'pin', isNode: true },
  { kind: 'FTB', label: 'FTB', color: '#34c759', level: 5, prefix: 'FTB', icon: 'pin', isNode: true },
  { kind: 'Manhole', label: 'Manhole', color: '#8e8e93', level: 9, prefix: 'MH', icon: 'circle', isNode: true },
  { kind: 'Handhole', label: 'Handhole', color: '#aeaeb2', level: 9, prefix: 'HH', icon: 'rect', isNode: true },
  { kind: 'Pole', label: 'Pole', color: '#a2845e', level: 9, prefix: 'P', icon: 'point', isNode: true },
  { kind: 'Building', label: 'Building', color: '#5e5ce6', level: 6, prefix: 'B', icon: 'home', isNode: true },
  { kind: 'Customer', label: 'Customer', color: '#0a84ff', level: 7, prefix: 'CUST', icon: 'user', isNode: true },
];
export const KIND_META = new Map(KINDS.map((k) => [k.kind, k]));
export const kindMeta = (k: FtthKind) => KIND_META.get(k) ?? KINDS[0];
/** passive civil infrastructure does not carry fibres logically */
export const CIVIL: FtthKind[] = ['Manhole', 'Handhole', 'Pole'];

export const STATUSES: ObjStatus[] = ['planned', 'installed', 'in-service', 'pending', 'faulty', 'removed'];
export const STATUS_COLOR: Record<ObjStatus, string> = { planned: '#8e8e93', installed: '#30d158', 'in-service': '#0a84ff', pending: '#ffb000', faulty: '#ff3b30', removed: '#636366' };

export const CABLE_CATEGORIES: { id: CableCategory; label: string; color: string }[] = [
  { id: 'feeder', label: 'Feeder', color: '#ff3b30' },
  { id: 'distribution', label: 'Distribution', color: '#ff9f0a' },
  { id: 'drop', label: 'Drop', color: '#30d158' },
  { id: 'duct', label: 'Duct', color: '#8e8e93' },
  { id: 'conduit', label: 'Conduit', color: '#636366' },
];
export const FIBER_COUNTS = [1, 2, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96, 144, 192, 288, 432, 576];
export const SPLITTER_RATIOS = [2, 4, 8, 16, 32, 64];

/** TIA-598-C fibre / tube colour code */
export const TIA598 = [
  { name: 'Blue', hex: '#1f6fff' }, { name: 'Orange', hex: '#ff8c1a' }, { name: 'Green', hex: '#2fbf4a' }, { name: 'Brown', hex: '#8b5a2b' },
  { name: 'Slate', hex: '#7d8b99' }, { name: 'White', hex: '#f2f2f2' }, { name: 'Red', hex: '#e8202a' }, { name: 'Black', hex: '#1a1a1a' },
  { name: 'Yellow', hex: '#ffe014' }, { name: 'Violet', hex: '#8f3fd6' }, { name: 'Rose', hex: '#ff8fb8' }, { name: 'Aqua', hex: '#2fd6d6' },
];
export const CORE_STATUSES: CoreStatus[] = ['available', 'used', 'spare', 'reserved', 'damaged'];
export const CORE_STATUS_COLOR: Record<CoreStatus, string> = { available: '#8e8e93', used: '#0a84ff', spare: '#30d158', reserved: '#ffb000', damaged: '#ff3b30' };

export function coreColor(index1: number, tubeSize = 12) {
  const fiber = TIA598[(index1 - 1) % 12];
  const tube = TIA598[Math.floor((index1 - 1) / tubeSize) % 12];
  return { fiber, tube, tubeNo: Math.floor((index1 - 1) / tubeSize) + 1 };
}

export function cableTypeLabel(category: CableCategory, fibers: number) {
  return category === 'duct' || category === 'conduit' ? category[0].toUpperCase() + category.slice(1) : `${fibers}F ${category}`;
}
