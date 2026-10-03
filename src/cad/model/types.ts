/**
 * FiberLens drawing model. 2D, world coordinates (WCS), angles in radians CCW.
 * Plain serialisable objects: they cross the worker boundary and are stored as JSON snapshots.
 */

export interface Vec2 { x: number; y: number }

/** Colour: ACI index (0 = ByBlock, 256 = ByLayer, 1..255) and optional true colour (0xRRGGBB). */
export interface ColorProps {
  aci?: number;
  rgb?: number;
}

/** Lineweight in 1/100 mm. -1 ByLayer, -2 ByBlock, -3 Default. */
export type LineWeight = number;

export interface EntityBase extends ColorProps {
  id: number;
  type: EntityType;
  layer: string;
  /** Linetype name; undefined/'ByLayer' = by layer, 'ByBlock', 'Continuous', ... */
  lineType?: string;
  ltScale?: number;
  lineWeight?: LineWeight;
  /** 0 = opaque .. 0.9 = 90 % transparent. undefined = ByLayer. */
  transparency?: number;
  /** Original DWG/DXF handle (hex) — used to merge edits back into the source file. */
  handle?: string;
  invisible?: boolean;
}

export type EntityType =
  | 'line' | 'polyline' | 'circle' | 'arc' | 'ellipse' | 'spline'
  | 'text' | 'mtext' | 'insert' | 'hatch' | 'point' | 'solid'
  | 'dimension' | 'leader' | 'image' | 'wipeout';

export interface LineEnt extends EntityBase { type: 'line'; p1: Vec2; p2: Vec2 }

/** LWPOLYLINE / 2D POLYLINE / 3D POLYLINE (flattened). pts = [x0,y0,x1,y1,...] */
export interface PolylineEnt extends EntityBase {
  type: 'polyline';
  pts: number[];
  /** bulge per vertex (segment i → i+1); omitted when all zero */
  bulges?: number[];
  closed: boolean;
  /** constant width in drawing units (0 = hairline) */
  width?: number;
  /** per-vertex start/end widths (optional) */
  widths?: number[];
}

export interface CircleEnt extends EntityBase { type: 'circle'; c: Vec2; r: number }
export interface ArcEnt extends EntityBase { type: 'arc'; c: Vec2; r: number; a0: number; a1: number }

export interface EllipseEnt extends EntityBase {
  type: 'ellipse';
  c: Vec2;
  /** major axis end point relative to centre */
  major: Vec2;
  ratio: number;
  /** parameters (radians) */
  t0: number;
  t1: number;
}

export interface SplineEnt extends EntityBase {
  type: 'spline';
  degree: number;
  ctrl: number[];
  knots: number[];
  weights?: number[];
  fit?: number[];
  closed: boolean;
}

export type HAlign = 'left' | 'center' | 'right' | 'aligned' | 'middle' | 'fit';
export type VAlign = 'baseline' | 'bottom' | 'middle' | 'top';

export interface TextEnt extends EntityBase {
  type: 'text';
  p: Vec2;
  /** alignment point (used when halign/valign != left/baseline) */
  p2?: Vec2;
  h: number;
  rot: number;
  value: string;
  style?: string;
  halign?: HAlign;
  valign?: VAlign;
  widthFactor?: number;
  oblique?: number;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  /** attribute tag when this text is a block attribute */
  tag?: string;
  mirrorX?: boolean;
}

/** attachment 1..9: TL TC TR ML MC MR BL BC BR */
export interface MTextEnt extends EntityBase {
  type: 'mtext';
  p: Vec2;
  h: number;
  rot: number;
  /** reference rectangle width (0 = no wrapping) */
  width: number;
  attach: number;
  /** raw MTEXT value including formatting codes */
  value: string;
  style?: string;
  lineSpacing?: number;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  /** background mask: colour (rgb) or -1 for drawing background */
  bgFill?: number;
  bgScale?: number;
}

export interface AttribEnt extends TextEnt { tag: string }

export interface InsertEnt extends EntityBase {
  type: 'insert';
  block: string;
  p: Vec2;
  sx: number;
  sy: number;
  rot: number;
  attribs?: AttribEnt[];
  cols?: number;
  rows?: number;
  colSpacing?: number;
  rowSpacing?: number;
}

export interface HatchLoop { pts: number[]; bulges?: number[] }
export interface HatchPatternLine { angle: number; base: Vec2; offset: Vec2; dashes: number[] }

export interface HatchEnt extends EntityBase {
  type: 'hatch';
  loops: HatchLoop[];
  solid: boolean;
  pattern?: string;
  patternAngle?: number;
  patternScale?: number;
  /** pattern lines in world units (already scaled/rotated) */
  patternLines?: HatchPatternLine[];
  /** gradient/solid fill colour alpha override */
  fillAlpha?: number;
}

export interface PointEnt extends EntityBase { type: 'point'; p: Vec2 }
export interface SolidEnt extends EntityBase { type: 'solid'; pts: number[] }

export interface DimensionEnt extends EntityBase {
  type: 'dimension';
  /** anonymous block containing the rendered dimension graphics (*D…) */
  block?: string;
  dimType: 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter' | 'ordinate' | 'arc';
  defPts: number[];
  textPos: Vec2;
  text: string;
  measurement: number;
  textHeight?: number;
  /** extra transform applied to the dimension block after edits */
  xf?: { a: number; b: number; c: number; d: number; e: number; f: number };
}

export interface LeaderEnt extends EntityBase {
  type: 'leader';
  pts: number[];
  arrow: boolean;
  arrowSize?: number;
  /** optional attached text (MLEADER content) */
  text?: string;
  textPos?: Vec2;
  textHeight?: number;
}

export interface ImageEnt extends EntityBase { type: 'image' | 'wipeout'; pts: number[]; name?: string }

export type Entity =
  | LineEnt | PolylineEnt | CircleEnt | ArcEnt | EllipseEnt | SplineEnt
  | TextEnt | MTextEnt | InsertEnt | HatchEnt | PointEnt | SolidEnt
  | DimensionEnt | LeaderEnt | ImageEnt;

export interface Layer extends ColorProps {
  name: string;
  lineType: string;
  lineWeight: LineWeight;
  transparency: number;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
  handle?: string;
  description?: string;
}

export interface LineTypeDef {
  name: string;
  description?: string;
  /** dash pattern: + dash, - gap, 0 dot (drawing units) */
  pattern: number[];
}

export interface TextStyleDef {
  name: string;
  font: string;
  bigFont?: string;
  widthFactor: number;
  oblique: number;
  height: number;
}

export interface BlockDef {
  name: string;
  base: Vec2;
  entities: Entity[];
  /** attribute definitions (tag, prompt, default) */
  attdefs?: { tag: string; prompt?: string; value: string; p?: Vec2; p2?: Vec2; h?: number; rot?: number; halign?: HAlign; valign?: VAlign }[];
  anonymous?: boolean;
  xref?: string;
}

export interface LayoutDef {
  name: string;
  tabOrder: number;
  /** paper-space entities */
  entities: Entity[];
  /** model-space window shown by each viewport */
  viewports: { center: Vec2; width: number; height: number; viewCenter: Vec2; viewHeight: number; twist: number }[];
}

export interface GeoInfo {
  /** design point in drawing coordinates */
  designPoint: Vec2;
  /** reference point: lon/lat (degrees) or projected XY depending on coordinatesType */
  referencePoint: Vec2;
  northDirection: Vec2;
  unitScale: number;
  /** coordinate system definition (WKT / XML / EPSG) as found in GEODATA */
  csDefinition?: string;
  coordinatesType: number;
}

export interface DrawingMeta {
  name: string;
  sourceFormat: 'dwg' | 'dxf' | 'new';
  version: string;
  /** $INSUNITS */
  units: number;
  ltScale: number;
  extMin: Vec2;
  extMax: Vec2;
  codePage?: string;
  pdMode?: number;
  pdSize?: number;
  /** warnings/notes emitted by the engine */
  notes: string[];
}

export interface Drawing {
  meta: DrawingMeta;
  layers: Layer[];
  lineTypes: LineTypeDef[];
  textStyles: TextStyleDef[];
  blocks: Record<string, BlockDef>;
  entities: Entity[];
  layouts: LayoutDef[];
  geo?: GeoInfo;
  /** next free entity id */
  nextId: number;
}

export const INSUNITS: Record<number, { name: string; meters: number }> = {
  0: { name: 'Unitless', meters: 1 },
  1: { name: 'Inches', meters: 0.0254 },
  2: { name: 'Feet', meters: 0.3048 },
  3: { name: 'Miles', meters: 1609.344 },
  4: { name: 'Millimeters', meters: 0.001 },
  5: { name: 'Centimeters', meters: 0.01 },
  6: { name: 'Meters', meters: 1 },
  7: { name: 'Kilometers', meters: 1000 },
  14: { name: 'Decimeters', meters: 0.1 },
};

export function emptyDrawing(name = 'Untitled'): Drawing {
  return {
    meta: {
      name, sourceFormat: 'new', version: 'AC1032', units: 6, ltScale: 1,
      extMin: { x: 0, y: 0 }, extMax: { x: 100, y: 100 }, notes: [],
    },
    layers: [{ name: '0', aci: 7, lineType: 'Continuous', lineWeight: -3, transparency: 0, on: true, frozen: false, locked: false, plot: true }],
    lineTypes: [
      { name: 'Continuous', pattern: [] },
      { name: 'DASHED', description: '__ __ __', pattern: [0.5, -0.25] },
      { name: 'HIDDEN', description: '_ _ _ _', pattern: [0.25, -0.125] },
      { name: 'CENTER', description: '____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] },
      { name: 'DOT', description: '. . . .', pattern: [0, -0.25] },
      { name: 'DASHDOT', description: '__ . __ .', pattern: [0.5, -0.25, 0, -0.25] },
      { name: 'PHANTOM', description: '___ _ _ ___', pattern: [1.25, -0.25, 0.25, -0.25, 0.25, -0.25] },
    ],
    textStyles: [{ name: 'Standard', font: 'Arial', widthFactor: 1, oblique: 0, height: 0 }],
    blocks: {},
    entities: [],
    layouts: [],
    nextId: 1,
  };
}
