import { create } from 'zustand';
import type { GpsFix } from './types';
import type { Calibration } from '../geo/calibration';
import type { Vec2 } from '../cad/model/types';

export interface TrackPoint { t: number; lat: number; lon: number; x?: number; y?: number; acc: number; alt?: number; spd?: number; hdg?: number }

export interface GpsState {
  running: boolean;
  sourceId: string;
  fix: GpsFix | null;
  cad: Vec2 | null;
  error: string | null;
  calibration: Calibration | null;
  calibrated: boolean;
  follow: boolean;
  headingUp: boolean;
  northUp: boolean;
  compass: number | null;
  tracking: boolean;
  track: TrackPoint[];
  trackName: string;
  navTarget: { name: string; x: number; y: number; id?: string } | null;
  fixCount: number;
  set: (p: Partial<GpsState>) => void;
}

export const useGps = create<GpsState>((set) => ({
  running: false,
  sourceId: 'device',
  fix: null,
  cad: null,
  error: null,
  calibration: null,
  calibrated: false,
  follow: false,
  headingUp: false,
  northUp: false,
  compass: null,
  tracking: false,
  track: [],
  trackName: '',
  navTarget: null,
  fixCount: 0,
  set: (p) => set(p),
}));
