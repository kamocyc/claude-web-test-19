import { clamp, rateLimit } from '../math/scalar.ts';
import type { MetersPerSecond, Newtons } from '../units.ts';
import { GRAVITY } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type { ConsistSpec, VehicleSpec, VvvfTractionSpec } from '../vehicle/spec.ts';
import { vehicleMass } from '../vehicle/spec.ts';
import { InverterModulation } from './modulation.ts';
import type { TractionContext, TractionState, TractionSystem } from './types.ts';

/**
 * 誘導電動機 1 台のトルク特性 [N*m]。
 *
 * VVVF インバータ制御では、電動機の出力は速度に応じて 3 つの領域に分かれる:
 *
 *  1. 定トルク領域（〜 constantTorqueSpeed）: 電圧・周波数を比例制御し、トルク一定
 *  2. 定出力領域（〜 constantPowerSpeed）: 電圧が上限に達し、トルク ∝ 1/v
 *  3. 特性領域（それ以上）: すべり周波数が上限に達し、トルク ∝ 1/v^2
 *
 * この 3 領域の折れ点が、実車の引張力曲線・加速度曲線の形をそのまま決める。
 */
export function motorTorqueAt(
  spec: VvvfTractionSpec,
  v: MetersPerSecond,
  maxTorque: number,
): number {
  const av = Math.abs(v);
  const v1 = spec.constantTorqueSpeed;
  const v2 = spec.constantPowerSpeed;
  if (av <= v1 || v1 <= 0) return maxTorque;
  if (av <= v2) return (maxTorque * v1) / av;
  return (maxTorque * v1 * v2) / (av * av);
}

/** 電動機トルクから車輪周の引張力 [N] へ換算する（1 両分） */
export function rimForceFromMotorTorque(
  spec: VvvfTractionSpec,
  vehicle: VehicleSpec,
  motorTorque: number,
): Newtons {
  const r = vehicle.wheelDiameter / 2;
  return (motorTorque * spec.motorCount * spec.gearRatio * spec.driveEfficiency) / r;
}

/**
 * 回生ブレーキの絞り込み率（0..1）。
 * 低速域では誘導電動機の回生能力が落ちるため、指定速度で 1 → 0 へ絞られる。
 * 絞り込みが進むあいだ、空気ブレーキが不足分を補う必要がある（電空協調）。
 */
export function regenerationFade(spec: VvvfTractionSpec, v: MetersPerSecond): number {
  const av = Math.abs(v);
  const hi = spec.regenFadeStartSpeed;
  const lo = spec.regenFadeEndSpeed;
  if (av >= hi) return 1;
  if (av <= lo) return 0;
  return (av - lo) / (hi - lo);
}

export interface VvvfOptions {
  /** 空転検知のしきい値（ピークすべり率に対する倍率） */
  readonly slipThreshold?: number;
  /** 空転検知時に絞り込む時定数 [s]（0 まで絞るのに要する時間） */
  readonly cutTime?: number;
  /** 絞り込みから復帰する時定数 [s] */
  readonly recoverTime?: number;
  /** 再粘着制御の絞り込み下限 */
  readonly minReAdhesionFactor?: number;
}

/**
 * VVVF インバータ制御・誘導電動機による動力装置。
 *
 * ノッチ指令 → トルク指令（レート制限）→ 電動機特性 → 各動軸のトルク という流れで、
 * 「指令」と「実出力」を分けて時間発展させる。応荷重制御（定加速度制御）と
 * 再粘着制御を内蔵する。
 */
export class VvvfTractionSystem implements TractionSystem {
  readonly state: TractionState = {
    notch: 0,
    torqueCommand: 0,
    tractiveEffort: 0,
    motorCurrent: 0,
    power: 0,
    electricBraking: false,
    reAdhesionFactor: 1,
    slipDetected: false,
  };

  /**
   * インバータの変調状態（音響・表示用）。
   * 引張力の計算には一切関与しない — 同じ出力をどのスイッチングで作っているかを
   * 追いかけているだけである。
   */
  readonly modulation: InverterModulation | null;

  private readonly consist: ConsistSpec;
  private readonly opts: Required<VvvfOptions>;
  /** ブレーキ装置から要求された電気ブレーキ力 [N]（正値） */
  private electricBrakeRequest = 0;
  private cutOffActive = false;
  /** 直近に各電動機へ出したトルク [N*m]（正 = 力行、負 = 電気ブレーキ） */
  private lastMotorTorque = 0;

  constructor(consist: ConsistSpec, options: VvvfOptions = {}) {
    this.consist = consist;
    const spec = this.firstTractionSpec();
    this.modulation = spec ? new InverterModulation(spec) : null;
    this.opts = {
      slipThreshold: options.slipThreshold ?? 2.0,
      cutTime: options.cutTime ?? 0.35,
      recoverTime: options.recoverTime ?? 2.5,
      minReAdhesionFactor: options.minReAdhesionFactor ?? 0.15,
    };
  }

  setNotch(notch: number): void {
    this.state.notch = clamp(Math.round(notch), 0, this.consist.traction.notchCount);
  }

  requestElectricBrakeForce(force: Newtons): void {
    this.electricBrakeRequest = Math.max(0, force);
  }

  cutOff(): void {
    this.cutOffActive = true;
    this.state.notch = 0;
    this.electricBrakeRequest = 0;
  }

  /** 引き通し（非常ブレーキ復帰など）で出力を許可し直す */
  restore(): void {
    this.cutOffActive = false;
  }

  /** 力行時に車輪周で出せる最大引張力 [N]（編成合計） */
  maxTractiveEffort(v: MetersPerSecond, loadFactor: number): Newtons {
    let total = 0;
    for (const veh of this.consist.vehicles) {
      const spec = veh.traction;
      if (!spec) continue;
      const t = motorTorqueAt(spec, v, spec.maxMotorTorque);
      total += rimForceFromMotorTorque(spec, veh, t);
    }
    return total * this.loadCompensationRatio(loadFactor);
  }

  availableElectricBrakeForce(v: MetersPerSecond, ctx: TractionContext): Newtons {
    if (this.cutOffActive) return 0;
    let total = 0;
    for (const veh of this.consist.vehicles) {
      const spec = veh.traction;
      if (!spec) continue;
      const t = motorTorqueAt(spec, v, spec.maxBrakingMotorTorque);
      total += rimForceFromMotorTorque(spec, veh, t) * regenerationFade(spec, v);
    }
    return total * clamp(ctx.regenerationReceptivity, 0, 1);
  }

  /**
   * 応荷重制御の補正率。
   * 実際の編成質量が基準乗車率のときの質量より重ければ、同じ加速度を得るために
   * 引張力を増やす。頭打ちを設けて過大な出力を防ぐ。
   */
  private loadCompensationRatio(loadFactor: number): number {
    const ctrl = this.consist.traction;
    if (!ctrl.loadCompensation) return 1;
    const actual = this.consist.vehicles.reduce((a, v) => a + vehicleMass(v, loadFactor), 0);
    const reference = this.consist.vehicles.reduce(
      (a, v) => a + vehicleMass(v, ctrl.referenceLoadFactor),
      0,
    );
    return clamp(actual / reference, 0.7, 1.3);
  }

  /** 等価質量（回転部慣性を含む）[kg] */
  private equivalentMass(loadFactor: number): number {
    return this.consist.vehicles.reduce(
      (a, v) => a + vehicleMass(v, loadFactor) + v.rotatingMassFactor * v.tareMass,
      0,
    );
  }

  update(dt: number, ctx: TractionContext): void {
    const dyn = ctx.dynamics;
    const ctrl = this.consist.traction;
    const v = dyn.speed;

    // --- 空転検知と再粘着制御 ---
    let slipping = false;
    const threshold = this.consist.adhesion.peakCreep * this.opts.slipThreshold;
    for (const veh of dyn.vehicles) {
      for (const ax of veh.axles) {
        if (ax.driven && ax.slip > threshold) slipping = true;
      }
    }
    this.state.slipDetected = slipping;
    if (slipping) {
      this.state.reAdhesionFactor = Math.max(
        this.opts.minReAdhesionFactor,
        this.state.reAdhesionFactor - dt / this.opts.cutTime,
      );
    } else {
      this.state.reAdhesionFactor = Math.min(
        1,
        this.state.reAdhesionFactor + dt / this.opts.recoverTime,
      );
    }

    // --- ノッチ指令 → トルク指令率（レート制限） ---
    const notch = this.cutOffActive ? 0 : this.state.notch;
    const notchRatio = notch > 0 ? (ctrl.notchTorqueRatio[notch - 1] ?? 1) : 0;
    const rate = notchRatio > this.state.torqueCommand ? ctrl.torqueRiseRate : ctrl.torqueFallRate;
    this.state.torqueCommand = rateLimit(this.state.torqueCommand, notchRatio, rate, dt);

    // --- 力行トルクの決定 ---
    const braking = this.electricBrakeRequest > 0 && this.state.torqueCommand <= 0;
    this.state.electricBraking = braking;

    let totalRimForce = 0;
    this.lastMotorTorque = 0;
    if (braking) {
      totalRimForce = -this.distributeElectricBrake(dyn, v, ctx);
    } else {
      totalRimForce = this.distributeTraction(dyn, v, ctx);
    }

    this.state.tractiveEffort = totalRimForce;
    this.updateModulation(dt, dyn);
    const mechanicalPower = totalRimForce * v;
    // 力行時は効率で割り、回生時は効率を掛けて架線側の電力とする
    let elecPower: number;
    if (mechanicalPower >= 0) {
      const spec = this.firstTractionSpec();
      elecPower = spec ? mechanicalPower / spec.converterEfficiency : mechanicalPower;
    } else {
      const spec = this.firstTractionSpec();
      elecPower = spec ? mechanicalPower * spec.converterEfficiency : mechanicalPower;
    }
    this.state.power = elecPower;
    this.state.motorCurrent = ctx.lineVoltage > 0 ? elecPower / ctx.lineVoltage : 0;
  }

  private firstTractionSpec(): VvvfTractionSpec | null {
    for (const veh of this.consist.vehicles) if (veh.traction) return veh.traction;
    return null;
  }

  /**
   * 変調状態を更新する（表示・音響用）。
   *
   * 電動機の回転は**動軸の実角速度**から取る。車速から逆算すると、空転しているのに
   * 音が上がらないという実車ではありえない挙動になる。
   */
  private updateModulation(dt: number, dyn: TrainDynamics): void {
    const mod = this.modulation;
    if (!mod) return;
    const spec = this.firstTractionSpec();
    if (!spec) return;

    let omegaSum = 0;
    let count = 0;
    for (const veh of dyn.vehicles) {
      if (!veh.spec.traction) continue;
      for (const ax of veh.axles) {
        if (!ax.driven) continue;
        omegaSum += ax.omega;
        count++;
      }
    }
    mod.step(dt, {
      axleAngularVelocity: count > 0 ? omegaSum / count : 0,
      torqueRatio: spec.maxMotorTorque > 0 ? this.lastMotorTorque / spec.maxMotorTorque : 0,
    });
  }

  /** 力行トルクを各動軸へ配分する。戻り値は車輪周の引張力合計 [N]。 */
  private distributeTraction(
    dyn: TrainDynamics,
    v: MetersPerSecond,
    ctx: TractionContext,
  ): Newtons {
    const ctrl = this.consist.traction;
    const cmd = this.state.torqueCommand * this.state.reAdhesionFactor;
    if (cmd <= 0) {
      this.clearDriveTorques(dyn);
      return 0;
    }

    // 定加速度制御が有効なら、目標加速度から必要な引張力を逆算する
    let ratioLimit = cmd;
    if (ctrl.targetAcceleration > 0) {
      const target = ctrl.targetAcceleration * cmd;
      const required = this.equivalentMass(ctx.loadFactor) * target;
      const available = this.maxTractiveEffort(v, ctx.loadFactor);
      ratioLimit = available > 0 ? clamp(required / available, 0, cmd) : 0;
    }

    const loadRatio = this.loadCompensationRatio(ctx.loadFactor);
    let total = 0;
    for (const veh of dyn.vehicles) {
      const spec = veh.spec.traction;
      if (!spec || veh.spec.drivenAxleCount === 0) {
        for (const ax of veh.axles) ax.driveTorque = 0;
        continue;
      }
      const motorTorque = motorTorqueAt(spec, v, spec.maxMotorTorque) * ratioLimit * loadRatio;
      const axleTorqueTotal = motorTorque * spec.motorCount * spec.gearRatio * spec.driveEfficiency;
      const perAxle = axleTorqueTotal / veh.spec.drivenAxleCount;
      for (const ax of veh.axles) ax.driveTorque = ax.driven ? perAxle : 0;
      total += rimForceFromMotorTorque(spec, veh.spec, motorTorque);
      this.lastMotorTorque = motorTorque;
    }
    return total;
  }

  /** 電気ブレーキ力を各動軸へ配分する。戻り値は車輪周の制動力 [N]（正値）。 */
  private distributeElectricBrake(
    dyn: TrainDynamics,
    v: MetersPerSecond,
    ctx: TractionContext,
  ): Newtons {
    const available = this.availableElectricBrakeForce(v, ctx);
    const requested = Math.min(this.electricBrakeRequest, available);
    if (requested <= 0 || available <= 0) {
      this.clearDriveTorques(dyn);
      return 0;
    }
    const ratio = requested / available;
    let total = 0;
    for (const veh of dyn.vehicles) {
      const spec = veh.spec.traction;
      if (!spec || veh.spec.drivenAxleCount === 0) {
        for (const ax of veh.axles) ax.driveTorque = 0;
        continue;
      }
      const motorTorque =
        motorTorqueAt(spec, v, spec.maxBrakingMotorTorque) * regenerationFade(spec, v) * ratio;
      const axleTorqueTotal = motorTorque * spec.motorCount * spec.gearRatio * spec.driveEfficiency;
      const perAxle = axleTorqueTotal / veh.spec.drivenAxleCount;
      // 電気ブレーキは進行方向と逆向きのトルク
      const dir = v >= 0 ? -1 : 1;
      for (const ax of veh.axles) ax.driveTorque = ax.driven ? dir * perAxle : 0;
      total += rimForceFromMotorTorque(spec, veh.spec, motorTorque);
      // 変調から見ると回生はすべりが負の側なので、トルクは負として扱う
      this.lastMotorTorque = -motorTorque;
    }
    return total;
  }

  private clearDriveTorques(dyn: TrainDynamics): void {
    for (const veh of dyn.vehicles) {
      for (const ax of veh.axles) ax.driveTorque = 0;
    }
  }

  /** 表示用: 現在の粘着余裕（引張力 / 粘着限界） */
  adhesionUtilisation(dyn: TrainDynamics): number {
    let force = 0;
    let limit = 0;
    for (const veh of dyn.vehicles) {
      for (const ax of veh.axles) {
        if (!ax.driven) continue;
        force += Math.abs(ax.creepForce);
        limit += ax.adhesionLimit;
      }
    }
    return limit > 0 ? force / limit : 0;
  }

  /** 参考: 起動時の粘着限界による最大加速度 [m/s^2] */
  adhesionLimitedAcceleration(loadFactor: number, mu: number): number {
    let drivenWeight = 0;
    let mass = 0;
    for (const veh of this.consist.vehicles) {
      const m = vehicleMass(veh, loadFactor);
      mass += m;
      drivenWeight += (m * GRAVITY * veh.drivenAxleCount) / veh.axleCount;
    }
    return (mu * drivenWeight) / mass;
  }
}
