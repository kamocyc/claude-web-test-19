import type { PointTable, SpanTable, StepTable } from '../math/table.ts';
import type { Alignment } from '../track/alignment.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';

/** 信号現示。数値が大きいほど高速で進行できる。 */
export type SignalAspect = 'R' | 'YY' | 'Y' | 'YG' | 'G';

/** 現示の序列（現示アップの計算に使う） */
export const ASPECT_ORDER: readonly SignalAspect[] = ['R', 'YY', 'Y', 'YG', 'G'];

export const aspectRank = (a: SignalAspect): number => ASPECT_ORDER.indexOf(a);
export const aspectFromRank = (r: number): SignalAspect =>
  ASPECT_ORDER[Math.max(0, Math.min(ASPECT_ORDER.length - 1, r))]!;

/** 現示ごとの許容速度 [m/s] */
export type AspectSpeeds = Readonly<Record<SignalAspect, MetersPerSecond>>;

/** 信号機の種別 */
export type SignalKind = 'block' | 'home' | 'starting' | 'distant';

export interface SignalDefinition {
  readonly id: string;
  /** 信号機の位置（距離程）[m] */
  readonly position: Meters;
  /** 種別 */
  readonly kind: SignalKind;
  /** この信号機が出しうる最大現示（3 現示の信号機なら 'Y' など） */
  readonly maxAspect: SignalAspect;
  /** 現示ごとの許容速度（省略時は路線既定値） */
  readonly aspectSpeeds?: Partial<AspectSpeeds>;
}

/** 閉塞区間。信号機の位置から次の信号機の位置までを 1 閉塞とする。 */
export interface BlockSection {
  readonly id: string;
  readonly start: Meters;
  readonly end: Meters;
  /** この閉塞を防護する信号機 */
  readonly signalId: string;
}

/** 駅 */
export interface Station {
  readonly id: string;
  readonly name: string;
  /** 停止位置目標（列車先頭端を合わせる距離程）[m] */
  readonly stopPosition: Meters;
  /** ホーム始端 [m] */
  readonly platformStart: Meters;
  /** ホーム終端 [m] */
  readonly platformEnd: Meters;
  /** 通過駅か */
  readonly isPass: boolean;
  /** 停車時分 [s] */
  readonly dwellTime: Seconds;
  /** 停止位置の許容誤差 [m] */
  readonly stopTolerance: Meters;
  /** 着時刻（基準時刻からの秒）*/
  readonly arrivalTime?: Seconds;
  /** 発時刻 */
  readonly departureTime?: Seconds;
}

/** 速度制限 */
export interface SpeedLimitEntry {
  readonly id: string;
  /** 制限が始まる距離程 [m] */
  readonly start: Meters;
  /** 制限速度 [m/s] */
  readonly speed: MetersPerSecond;
  /** 制限の理由（表示用） */
  readonly reason: 'curve' | 'turnout' | 'temporary' | 'line' | 'station';
}

/** トンネル区間 */
export interface TunnelSection {
  readonly id: string;
  readonly start: Meters;
  readonly end: Meters;
}

/** 地上子が車上装置へ伝える情報 */
export type BeaconPayload =
  /** ATS-SN のロング地上子（警報。確認扱いが必要） */
  | { readonly kind: 'ats-sn-long'; readonly signalId: string }
  /** ATS-SN の直下地上子（停止現示なら即時非常） */
  | { readonly kind: 'ats-sn-immediate'; readonly signalId: string }
  /** ATS-P: 信号機までの距離を伝える */
  | { readonly kind: 'ats-p-signal'; readonly signalId: string; readonly distance: Meters }
  /** ATS-P: 速度制限の始端までの距離と制限速度を伝える */
  | {
      readonly kind: 'ats-p-limit';
      readonly limitId: string;
      readonly distance: Meters;
      readonly speed: MetersPerSecond;
    }
  /** ATS-P: 線路終端（車止め）までの距離 */
  | { readonly kind: 'ats-p-terminus'; readonly distance: Meters };

/** 保安装置の種別 */
export type SafetySystemKind = 'ats-sn' | 'ats-p' | 'atc';

/** 保安装置の適用区間 */
export interface SafetySection {
  readonly start: Meters;
  readonly end: Meters;
  readonly kind: SafetySystemKind;
}

/** コンパイル済みの路線データ */
export interface CompiledRoute {
  readonly id: string;
  readonly name: string;
  readonly alignment: Alignment;
  readonly length: Meters;
  /** 線路の最高速度 [m/s] */
  readonly maxSpeed: MetersPerSecond;
  readonly stations: readonly Station[];
  readonly signals: readonly SignalDefinition[];
  readonly blocks: readonly BlockSection[];
  /** 距離程 -> 制限速度 [m/s] */
  readonly speedLimits: StepTable<number>;
  /** 制限速度の一覧（パターン生成用） */
  readonly speedLimitEntries: readonly SpeedLimitEntry[];
  readonly tunnels: SpanTable<TunnelSection>;
  readonly beacons: PointTable<BeaconPayload>;
  readonly safetySections: SpanTable<SafetySystemKind>;
  /** 現示ごとの既定許容速度 */
  readonly aspectSpeeds: AspectSpeeds;
}

/** 列車が占有する距離程の範囲 */
export interface Occupancy {
  readonly rear: Meters;
  readonly front: Meters;
}

/** 区間が重なるか */
export function occupancyOverlaps(a: Occupancy, start: Meters, end: Meters): boolean {
  return a.front > start && a.rear < end;
}
