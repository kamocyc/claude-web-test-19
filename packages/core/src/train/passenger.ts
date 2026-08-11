import { GRAVITY, type Radians } from '../units.ts';
import type { PassengerSpec } from '../vehicle/spec.ts';

/** 乗客（吊り革）の振れの状態 */
export interface PassengerSwayState {
  /** 左右の振れ角 [rad]（正 = 右へ振られる） */
  lateral: Radians;
  /** 前後の振れ角 [rad]（正 = 前へ振られる＝制動中） */
  longitudinal: Radians;
  /** 左右の振れの角速度 [rad/s] */
  lateralRate: number;
  /** 前後の振れの角速度 [rad/s] */
  longitudinalRate: number;
  /**
   * 瞬時の平衡角 [rad]。比力の向きそのもので、慣性を持たない。
   * 実際の振れ角との差が「まだ振れ切っていない量」＝加加速度の効き具合になる。
   */
  equilibriumLateral: Radians;
  equilibriumLongitudinal: Radians;
}

export function createPassengerSwayState(): PassengerSwayState {
  return {
    lateral: 0,
    longitudinal: 0,
    lateralRate: 0,
    longitudinalRate: 0,
    equilibriumLateral: 0,
    equilibriumLongitudinal: 0,
  };
}

/** 1 面ぶんの平面振り子 */
class PlanarPendulum {
  angle = 0;
  rate = 0;

  /**
   * @param felt      その面の比力 [m/s^2]（正 = その向きへ押される）
   * @param vertical  床に垂直な比力 [m/s^2]
   * @param pivotRate 支点（車体）の角加速度 [rad/s^2]
   */
  step(
    dt: number,
    felt: number,
    vertical: number,
    pivotAcceleration: number,
    length: number,
    damping: number,
  ): number {
    // 見かけの重力の大きさと向き。上下 G が増える曲線では振り子が硬くなる。
    const gEff = Math.hypot(felt, vertical);
    const equilibrium = Math.atan2(felt, vertical);
    const omega = Math.sqrt(Math.max(gEff, 1e-3) / length);
    const acc =
      -omega * omega * Math.sin(this.angle - equilibrium) -
      2 * damping * omega * this.rate -
      pivotAcceleration;
    // 半陰的オイラー（車体動揺と同じ）
    this.rate += acc * dt;
    this.angle += this.rate * dt;
    return equilibrium;
  }

  reset(): void {
    this.angle = 0;
    this.rate = 0;
  }
}

/**
 * 乗客の振られ方を、車内に吊るした減衰振り子として解く。
 *
 * 加速度をそのまま角度に変換すると（`atan2(横G, 上下G)`）、加速度が変わった瞬間に
 * 角度が飛んでしまい、加加速度（ジャーク）が見えない。実際の吊り革や立っている乗客は
 * 固有周期 1.5 秒程度の振り子なので、加速度に**遅れて**追従する。ノッチを一気に
 * 動かせば振られて行き過ぎ、丁寧に刻めば静かに傾く — この差が運転の質そのものになる。
 *
 * 車体座標系で、左右面と前後面に分けた 2 つの平面振り子として積分する。
 *
 * ```
 * g_eff = hypot(f_i, f_z)
 * θ_eq  = atan2(f_i, f_z)                       瞬時の平衡角
 * ω     = sqrt(g_eff / L)
 * θ̈     = -ω² sin(θ - θ_eq) - 2ζω θ̇ - φ̈_車体
 * ```
 *
 * - 復元項は非線形（`sin`）のまま。定常では `tan θ = f_i / f_z` に収束するので、
 *   減衰を強くすれば従来の瞬時値表示に連続的に近づく。
 * - `φ̈_車体` は車体のロール／ピッチ角加速度。吊り革の支点は車体と一緒に回るため、
 *   軌道狂いによる車体の揺れが吊り革を細かく揺らす。
 * - 球面振り子としての 2 面の連成は O(θ²) で、実際の振れ角（15 度以下）では無視できる。
 */
export class PassengerPendulum {
  readonly state = createPassengerSwayState();
  private readonly lat = new PlanarPendulum();
  private readonly lon = new PlanarPendulum();

  constructor(private readonly spec: PassengerSpec) {}

  step(
    dt: number,
    feltLateral: number,
    feltLongitudinal: number,
    feltVertical: number,
    rollAcceleration: number,
    pitchAcceleration: number,
  ): PassengerSwayState {
    const { pendulumLength: L, dampingRatio: z } = this.spec;
    // 床に垂直な比力。無重量状態では振り子が復元力を失うので下限を置く。
    const vertical = Math.max(feltVertical, 0.5);

    // 支点の回転: 車体が右下がりに転がると、吊り革は取り残されて相対的に左へ振れる。
    // ピッチは「正 = 前下がり」で、前へ振れる向きと同じ回転なので符号が逆になる。
    const eqLat = this.lat.step(dt, feltLateral, vertical, rollAcceleration, L, z);
    const eqLon = this.lon.step(dt, feltLongitudinal, vertical, -pitchAcceleration, L, z);

    const st = this.state;
    st.lateral = this.lat.angle;
    st.longitudinal = this.lon.angle;
    st.lateralRate = this.lat.rate;
    st.longitudinalRate = this.lon.rate;
    st.equilibriumLateral = eqLat;
    st.equilibriumLongitudinal = eqLon;
    return st;
  }

  reset(): void {
    this.lat.reset();
    this.lon.reset();
  }
}

/** 振れ角から、振り子の先端の変位 [m] を求める（表示用） */
export function swayOffset(state: PassengerSwayState, length: number): { x: number; y: number } {
  return {
    x: length * Math.sin(state.lateral),
    y: length * Math.sin(state.longitudinal),
  };
}

/**
 * 振れ角に対応する加速度 [m/s^2]。
 * 平衡状態では `tan θ = a / g` なので、角度の目盛りを加速度で読める。
 */
export function swayToAcceleration(angle: Radians): number {
  return GRAVITY * Math.tan(angle);
}
