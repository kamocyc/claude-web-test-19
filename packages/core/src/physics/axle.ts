import { GRAVITY, type Kilograms, type Newtons } from '../units.ts';
import type { VehicleSpec } from '../vehicle/spec.ts';
import { creepAdhesion, creepAdhesionDerivative, slipRatio } from './adhesion.ts';

/**
 * 軸重（各軸のレール上への垂直荷重）を求める。
 *
 * 静的な等分配に加えて、長手方向の力による荷重移動（軸重移動）を考慮する:
 *
 * - 台車間の移動: レール面に作用する長手力 F と、車体重心高さ h_g のあいだの偶力により、
 *   台車中心間距離 L で ΔW = F h_g / L の荷重が前台車から後台車へ移る（力行時）。
 * - 台車内の移動: 台車が牽引装置（高さ h_t）を介して車体へ力を伝える反作用により、
 *   固定軸距 b で ΔW = (F/2) h_t / b の荷重が前軸から後軸へ移る。
 *
 * 空転・滑走は軸ごとに起きるため、この軸重の偏りが「どの軸から空転するか」を決める。
 *
 * @param loads 結果を書き込む配列（長さ = 軸数）
 * @param railForce レール面に作用する長手方向の力の合計 [N]（正 = 前進方向）
 */
export function computeAxleLoads(
  spec: VehicleSpec,
  mass: Kilograms,
  railForce: Newtons,
  loads: Float64Array,
): void {
  const n = spec.axleCount;
  const weight = mass * GRAVITY;
  const perAxle = weight / n;
  if (n < 2) {
    loads[0] = weight;
    return;
  }
  const axlesPerBogie = Math.max(1, Math.floor(n / 2));
  const bogieTransfer =
    spec.bogieSpacing > 0 ? (railForce * spec.centerOfGravityHeight) / spec.bogieSpacing : 0;
  const axleTransfer =
    spec.bogieWheelbase > 0 && axlesPerBogie > 1
      ? ((railForce / 2) * spec.tractionLinkHeight) / spec.bogieWheelbase
      : 0;

  for (let i = 0; i < n; i++) {
    const isFrontBogie = i < axlesPerBogie;
    // 台車間: 前台車は減、後台車は増
    const bogieShare = (isFrontBogie ? -bogieTransfer : bogieTransfer) / axlesPerBogie;
    // 台車内: 前軸は減、後軸は増（軸位置に応じて線形配分）
    const idxInBogie = isFrontBogie ? i : i - axlesPerBogie;
    const rel = axlesPerBogie > 1 ? idxInBogie / (axlesPerBogie - 1) - 0.5 : 0;
    const axleShare = axleTransfer * rel * 2;
    loads[i] = Math.max(0, perAxle + bogieShare + axleShare);
  }
}

export interface AxleSolveInput {
  /** 回転慣性 [kg*m^2] */
  readonly inertia: number;
  /** 車輪半径 [m] */
  readonly radius: number;
  /** 駆動トルク [N*m]（正 = 力行、負 = 電気ブレーキ） */
  readonly driveTorque: number;
  /** 機械ブレーキトルクの大きさ [N*m]（常に回転を妨げる向きに働く） */
  readonly brakeTorque: number;
  /** 軸重 [N] */
  readonly load: number;
  /** 車体速度 [m/s] */
  readonly vehicleSpeed: number;
  /** 現在の車輪角速度 [rad/s] */
  readonly omega: number;
  /** ピーク粘着係数 */
  readonly peakAdhesion: number;
  /** ピークを与えるすべり率 */
  readonly peakCreep: number;
  /** 滑走摩擦係数比 */
  readonly kineticRatio: number;
  /** すべり率の基準速度 [m/s] */
  readonly creepReferenceSpeed: number;
  /** 時間刻み [s] */
  readonly dt: number;
}

export interface AxleSolveResult {
  /** 更新後の車輪角速度 [rad/s] */
  omega: number;
  /** レールに作用する長手力 [N]（正 = 車両を前進させる向き） */
  creepForce: number;
  /** すべり率 */
  slip: number;
}

/** 機械ブレーキトルクの符号を滑らかにする角速度スケール [rad/s] */
const BRAKE_SIGN_SCALE = 1.0;

/**
 * 輪軸の回転運動を 1 ステップ進める。
 *
 *   J dω/dt = T_drive - T_brake*sgn(ω) - r F_creep(ω, v)
 *
 * クリープ力はすべり率に対して非常に急峻（微小すべりで立ち上がる）なため、
 * 陽解法では dt = 1ms でも容易に発散する。ここでは**後退オイラー法を
 * ニュートン反復で解く**ことで、剛性に関係なく安定に積分する。
 * 機械ブレーキの符号関数は tanh で正則化し、ヤコビアンに含める（車輪ロックの表現）。
 */
export function solveAxle(input: AxleSolveInput, out: AxleSolveResult): AxleSolveResult {
  const { inertia: J, radius: r, dt, load: W, vehicleSpeed: v } = input;
  const vref = input.creepReferenceSpeed;
  const xiPeak = input.peakCreep;
  const w0 = input.omega;
  let w = w0;

  const denomSpeed = Math.max(Math.abs(v), vref);

  for (let iter = 0; iter < 4; iter++) {
    const xi = slipRatio(r * w, v, vref);
    const x = xi / xiPeak;
    const mu = creepAdhesion(x, input.peakAdhesion, input.kineticRatio);
    const dmu = creepAdhesionDerivative(x, input.peakAdhesion, input.kineticRatio);
    const F = W * mu;
    // dF/dω = W * dμ/dx * dx/dξ * dξ/dω
    const dFdw = (W * dmu * r) / (xiPeak * denomSpeed);

    const th = Math.tanh(w / BRAKE_SIGN_SCALE);
    const T = input.driveTorque - input.brakeTorque * th;
    const dTdw = (-input.brakeTorque * (1 - th * th)) / BRAKE_SIGN_SCALE;

    const residual = (J * (w - w0)) / dt - T + r * F;
    const jac = J / dt - dTdw + r * dFdw;
    if (jac === 0) break;
    const step = residual / jac;
    w -= step;
    if (Math.abs(step) < 1e-9) break;
  }

  const xi = slipRatio(r * w, v, vref);
  const mu = creepAdhesion(xi / xiPeak, input.peakAdhesion, input.kineticRatio);
  out.omega = w;
  out.creepForce = W * mu;
  out.slip = xi;
  return out;
}
