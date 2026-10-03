import type { ToolManager } from './ToolManager';
import type { Tool } from './types';
import { SelectTool } from './SelectTool';
import * as D from './drawTools';
import * as T from './textTools';
import * as E from './editTools';
import * as M from './measureTools';

export interface ToolInfo { id: string; label: string; icon: string; group: 'draw' | 'edit' | 'text' | 'measure'; make: () => Tool }

export const TOOL_INFO: ToolInfo[] = [
  { id: 'line', label: 'Line', icon: 'line', group: 'draw', make: () => new D.LineTool() },
  { id: 'polyline', label: 'Polyline', icon: 'polyline', group: 'draw', make: () => new D.PolylineTool() },
  { id: 'arc', label: 'Arc', icon: 'arc', group: 'draw', make: () => new D.ArcTool() },
  { id: 'circle', label: 'Circle', icon: 'circle', group: 'draw', make: () => new D.CircleTool() },
  { id: 'rectangle', label: 'Rectangle', icon: 'rect', group: 'draw', make: () => new D.RectangleTool() },
  { id: 'triangle', label: 'Triangle', icon: 'triangle', group: 'draw', make: () => new D.TriangleTool() },
  { id: 'polygon', label: 'Polygon', icon: 'polygon', group: 'draw', make: () => new D.PolygonTool() },
  { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', group: 'draw', make: () => new D.EllipseTool() },
  { id: 'cloud', label: 'Cloud', icon: 'cloud', group: 'draw', make: () => new D.CloudTool() },
  { id: 'arrow', label: 'Arrow', icon: 'arrow', group: 'draw', make: () => new D.ArrowTool() },
  { id: 'freehand', label: 'Freehand', icon: 'freehand', group: 'draw', make: () => new D.FreehandTool() },
  { id: 'point', label: 'Point', icon: 'point', group: 'draw', make: () => new D.PointTool() },
  { id: 'hatch', label: 'Hatch', icon: 'hatch', group: 'draw', make: () => new D.HatchTool() },
  { id: 'leader', label: 'Leader', icon: 'leader', group: 'draw', make: () => new D.LeaderTool() },

  { id: 'text', label: 'Text', icon: 'text', group: 'text', make: () => new T.TextTool() },
  { id: 'mtext', label: 'MText', icon: 'mtext', group: 'text', make: () => new T.MTextTool() },
  { id: 'edittext', label: 'Edit text', icon: 'edit', group: 'text', make: () => new T.EditTextTool() },

  { id: 'move', label: 'Move', icon: 'move', group: 'edit', make: () => new E.MoveTool() },
  { id: 'copy', label: 'Copy', icon: 'copy', group: 'edit', make: () => new E.CopyTool() },
  { id: 'rotate', label: 'Rotate', icon: 'rotate', group: 'edit', make: () => new E.RotateTool() },
  { id: 'mirror', label: 'Mirror', icon: 'mirror', group: 'edit', make: () => new E.MirrorTool() },
  { id: 'scale', label: 'Scale', icon: 'scale', group: 'edit', make: () => new E.ScaleTool() },
  { id: 'stretch', label: 'Stretch', icon: 'stretch', group: 'edit', make: () => new E.StretchTool() },
  { id: 'trim', label: 'Trim', icon: 'trim', group: 'edit', make: () => new E.TrimTool() },
  { id: 'extend', label: 'Extend', icon: 'extend', group: 'edit', make: () => new E.ExtendTool() },
  { id: 'offset', label: 'Offset', icon: 'offset', group: 'edit', make: () => new E.OffsetTool() },
  { id: 'fillet', label: 'Fillet', icon: 'fillet', group: 'edit', make: () => new E.FilletTool() },
  { id: 'chamfer', label: 'Chamfer', icon: 'chamfer', group: 'edit', make: () => new E.ChamferTool() },
  { id: 'explode', label: 'Explode', icon: 'explode', group: 'edit', make: () => new E.ExplodeTool() },
  { id: 'join', label: 'Join', icon: 'join', group: 'edit', make: () => new E.JoinTool() },
  { id: 'break', label: 'Break', icon: 'break', group: 'edit', make: () => new E.BreakTool() },
  { id: 'pedit', label: 'Edit Polyline', icon: 'pedit', group: 'edit', make: () => new E.PEditTool() },
  { id: 'match', label: 'Match Props', icon: 'match', group: 'edit', make: () => new E.MatchPropsTool() },
  { id: 'copyclip', label: 'Copy (clip)', icon: 'copy', group: 'edit', make: () => new E.CopyClipTool() },
  { id: 'paste', label: 'Paste', icon: 'paste', group: 'edit', make: () => new E.PasteTool() },
  { id: 'delete', label: 'Delete', icon: 'trash', group: 'edit', make: () => new E.DeleteTool() },

  { id: 'mdist', label: 'Distance', icon: 'distance', group: 'measure', make: () => new M.DistanceTool() },
  { id: 'marea', label: 'Area', icon: 'area', group: 'measure', make: () => new M.AreaTool() },
  { id: 'mangle', label: 'Angle', icon: 'angle', group: 'measure', make: () => new M.AngleTool() },
  { id: 'mobject', label: 'Cable / Duct length', icon: 'cable', group: 'measure', make: () => new M.ObjectLengthTool() },
  { id: 'mobjdist', label: 'Object ↔ Object', icon: 'measure', group: 'measure', make: () => new M.ObjDistanceTool() },
];

/** extra tools registered by feature modules (FTTH, calibration, survey…) */
export const extraTools: { id: string; make: () => Tool }[] = [];

/** Register every interactive tool with the tool manager. */
export function registerTools(tm: ToolManager) {
  tm.register('select', () => new SelectTool());
  for (const t of TOOL_INFO) tm.register(t.id, t.make);
  for (const t of extraTools) tm.register(t.id, t.make);
}
