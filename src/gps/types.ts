export type FixType = 'none' | 'gps' | 'dgps' | 'rtk-float' | 'rtk-fixed' | 'estimated' | 'network';

export interface GpsFix {
  lat: number;
  lon: number;
  alt?: number;
  /** horizontal accuracy (m, ~68 %) */
  accuracy: number;
  altAccuracy?: number;
  /** course over ground, degrees clockwise from true north */
  heading?: number;
  /** m/s */
  speed?: number;
  satellites?: number;
  satellitesInView?: number;
  hdop?: number;
  fixType?: FixType;
  source: string;
  time: number;
}

export interface GpsSource {
  readonly id: string;
  readonly label: string;
  start(onFix: (f: GpsFix) => void, onError: (e: string) => void): Promise<void>;
  stop(): void;
}
