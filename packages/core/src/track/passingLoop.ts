import type { Meters, Radians } from '../units.ts';
import type { Turnout } from './turnout.ts';

/**
 * 行き違い設備（交換設備）の、**自列車が走っていないほうの線路**。
 *
 * 単線の路線で対向列車とすれ違えるのは交換設備の中だけである。そこには線路が
 * 2 本あり、片方を自列車が、もう片方を対向列車が通る。自列車の路線データは
 * 自分が通る側の線形しか持っていないので、もう 1 本がどこにあるかを
 * **距離程に対する横のずれ**として持つのがこの型である。
 *
 * ずれの形は分岐器の寸法だけで決まる。対向分岐器のリード曲線で振れ、護輪軌条部を
 * 直線で進み、戻し曲線で本線と平行になる — この 3 段で横へ寄る量が線路中心間隔に
 * なる（#12・R350 なら 3.38m）。すなわち**線路中心間隔は分岐器の番数が決めている**
 * のであって、別に与える値ではない。
 */
export interface PassingLoop {
  readonly id: string;
  /** 2 本が 1 本になる側の端（入口の分岐器）の距離程 [m] */
  readonly entry: Meters;
  /** 2 本が 1 本になる側の端（出口の分岐器）の距離程 [m] */
  readonly exit: Meters;
  /** リード曲線の半径 [m] */
  readonly radius: Meters;
  /** クロッシング角 [rad] */
  readonly angle: Radians;
  /** 護輪軌条部（リード曲線と戻し曲線のあいだの直線）の長さ [m] */
  readonly tailLength: Meters;
  /** 線路中心間隔 [m] */
  readonly spacing: Meters;
  /** 隣の線路が自列車から見てどちら側にあるか（+1 = 右） */
  readonly side: 1 | -1;
}

/**
 * 分岐器 1 組（リード曲線 → 護輪軌条部 → 戻し曲線）で横へ寄る量 [m]。
 *
 * 方位角 θ(d) を積分して求める。
 *
 * | 区間                    | 方位角        | 横のずれ |
 * | ----------------------- | ------------- | -------- |
 * | 0 ≤ d ≤ L（リード曲線） | d/R           | R(1 − cos(d/R)) |
 * | L ≤ d ≤ L+T（直線）     | α             | 前段 + (d−L) sinα |
 * | L+T ≤ d（戻し曲線）     | α − (d−L−T)/R | 前段 + R(cos(α−u/R) − cosα) |
 *
 * 戻し曲線が終わったところで方位角は 0 に戻り、そこから先は本線と平行に
 * `2R(1−cosα) + T sinα` だけ離れて進む。緩和曲線もカントも無いのがこの線形の
 * 要点で、分岐側を通る列車が受ける階段状の横 G はここから出る。
 */
export function turnoutBranchOffset(
  distance: Meters,
  radius: Meters,
  angle: Radians,
  tailLength: Meters,
): Meters {
  const lead = radius * angle;
  const d = Math.max(0, distance);
  if (d <= lead) return radius * (1 - Math.cos(d / radius));
  const afterLead = radius * (1 - Math.cos(angle));
  if (d <= lead + tailLength) return afterLead + (d - lead) * Math.sin(angle);
  const straight = afterLead + tailLength * Math.sin(angle);
  const u = Math.min(d - lead - tailLength, lead);
  return straight + radius * (Math.cos(angle - u / radius) - Math.cos(angle));
}

/** 分岐器 1 組で寄りきる量（= 線路中心間隔）[m] */
export function loopSpacingOf(radius: Meters, angle: Radians, tailLength: Meters): Meters {
  return turnoutBranchOffset(Infinity, radius, angle, tailLength);
}

/**
 * 分岐器の「2 本が 1 本になっている側」の端の距離程 [m]。
 *
 * 対向分岐器はトングレール先端の側、背向分岐器はその反対側で 1 本になる。
 * 隣の線路が現れる／消える点はここである。
 */
export function turnoutMergePoint(turnout: Turnout): Meters {
  return turnout.orientation === 'facing' ? turnout.position : turnout.position + turnout.length;
}

/**
 * 路線に沿った「隣の線路」。
 *
 * 交換設備のあいだだけ存在し、それ以外の区間では**無い**（単線だから）。
 * 対向列車をこの上に置き、すれ違いの音と絵はここから出す。
 */
export class AdjacentTrack {
  readonly loops: readonly PassingLoop[];

  constructor(loops: readonly PassingLoop[]) {
    this.loops = [...loops].sort((a, b) => a.entry - b.entry);
  }

  get length(): number {
    return this.loops.length;
  }

  /** 距離程 s に隣の線路があるか */
  has(s: Meters): boolean {
    return this.loopAt(s) !== undefined;
  }

  loopAt(s: Meters): PassingLoop | undefined {
    for (const loop of this.loops) {
      if (s < loop.entry) return undefined;
      if (s <= loop.exit) return loop;
    }
    return undefined;
  }

  /**
   * 距離程 s における隣の線路の横のずれ [m]（正 = 進行方向右）。
   * 隣の線路が無い区間では 0 を返す。
   */
  offsetAt(s: Meters): Meters {
    const loop = this.loopAt(s);
    if (!loop) return 0;
    const fromEntry = turnoutBranchOffset(s - loop.entry, loop.radius, loop.angle, loop.tailLength);
    const fromExit = turnoutBranchOffset(loop.exit - s, loop.radius, loop.angle, loop.tailLength);
    return loop.side * Math.min(fromEntry, fromExit, loop.spacing);
  }
}

/** 隣の線路を持たない路線用の空のテーブル */
export const NO_ADJACENT_TRACK = new AdjacentTrack([]);
