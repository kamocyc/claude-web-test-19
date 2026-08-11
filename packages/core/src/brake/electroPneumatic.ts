import { DelayLine } from '../math/delay.ts';
import { PiecewiseLinear, clamp, firstOrderLag } from '../math/scalar.ts';
import type { TrainDynamics, VehicleRuntime } from '../train/dynamics.ts';
import type { MetersPerSecond, MetersPerSecondSquared, Newtons, Pascals } from '../units.ts';
import type { ConsistSpec } from '../vehicle/spec.ts';
import { vehicleMass } from '../vehicle/spec.ts';
import {
  RELEASED_BRAKE,
  type BrakeCommand,
  type BrakeContext,
  type BrakeState,
  type BrakeSystem,
} from './types.ts';

export interface ElectroPneumaticOptions {
  /** 制御周期 [s]（むだ時間バッファの分解能） */
  readonly controlPeriod?: number;
  /** 滑走検知のしきい値（ピークすべり率に対する倍率） */
  readonly slideThreshold?: number;
  /** 滑走時に BC 圧を緩解する時定数 [s] */
  readonly skidReleaseTime?: number;
  /** 滑走から復帰して込め直す時定数 [s] */
  readonly skidRecoverTime?: number;
  /** 滑走防止動作時の緩解率の下限 */
  readonly minSkidFactor?: number;
}

/** 1 両ぶんの空気ブレーキの内部状態 */
interface AirUnit {
  readonly delay: DelayLine;
  pressure: Pascals;
  targetPressure: Pascals;
  skidFactor: number;
  readonly friction: PiecewiseLinear;
}

/**
 * 電気指令式ブレーキ（電空協調・応荷重付き）。
 *
 * 実車の流れをそのまま段階的にモデル化している:
 *
 *  1. ブレーキノッチ → 指令減速度（定減速度制御）
 *  2. 指令減速度 × 実際の編成質量 → 必要制動力（応荷重制御）
 *  3. まず電気（回生）ブレーキに割り当てる
 *  4. 不足分を空気ブレーキが受け持つ（電空協調）
 *  5. 空気ブレーキ指令 → むだ時間 → BC 圧の一次遅れ → 摩擦材の μ(v) → 車輪周制動力
 *  6. 滑走を検知したら該当車の BC 圧を緩解する（滑走防止装置）
 *
 * 低速域で回生が絞られる（回生失効）と 3 の分担が減り、4 の空気ブレーキが
 * 立ち上がるまでのあいだ減速度が落ち込む。この過渡が実車の「回生失効の谷」であり、
 * 単に減速度を与えるモデルでは決して現れない。
 */
export class ElectroPneumaticBrakeSystem implements BrakeSystem {
  readonly state: BrakeState;
  private readonly consist: ConsistSpec;
  private readonly units: AirUnit[] = [];
  private readonly opts: Required<ElectroPneumaticOptions>;
  private readonly notchDeceleration: number[];
  /** 空気ブレーキの先込めに使う先行時間 [s]（むだ時間 + 込め時定数の最大値） */
  private readonly leadTime: number;

  constructor(consist: ConsistSpec, options: ElectroPneumaticOptions = {}) {
    this.consist = consist;
    this.opts = {
      controlPeriod: options.controlPeriod ?? 0.01,
      slideThreshold: options.slideThreshold ?? 2.0,
      skidReleaseTime: options.skidReleaseTime ?? 0.25,
      skidRecoverTime: options.skidRecoverTime ?? 0.8,
      minSkidFactor: options.minSkidFactor ?? 0.2,
    };

    for (const veh of consist.vehicles) {
      this.units.push({
        delay: new DelayLine(veh.brake.deadTime, this.opts.controlPeriod, 0),
        pressure: 0,
        targetPressure: 0,
        skidFactor: 1,
        friction: new PiecewiseLinear(
          veh.brake.frictionSpeedCurve.map((p) => [p[0], p[1]] as [number, number]),
        ),
      });
    }

    this.leadTime = consist.vehicles.reduce(
      (a, v) => Math.max(a, v.brake.deadTime + v.brake.fillTimeConstant),
      0,
    );

    const ctrl = consist.brake;
    this.notchDeceleration = [];
    for (let n = 0; n <= ctrl.notchCount; n++) {
      if (n === 0) {
        this.notchDeceleration.push(0);
      } else if (ctrl.notchDeceleration && ctrl.notchDeceleration.length >= ctrl.notchCount) {
        this.notchDeceleration.push(ctrl.notchDeceleration[n - 1]!);
      } else {
        this.notchDeceleration.push((ctrl.maxServiceDeceleration * n) / ctrl.notchCount);
      }
    }

    this.state = {
      command: RELEASED_BRAKE,
      targetDeceleration: 0,
      requiredForce: 0,
      electricForce: 0,
      airForceCommand: 0,
      airForceActual: 0,
      cylinderPressure: consist.vehicles.map(() => 0),
      regenerationLost: false,
      antiSkidActive: false,
      antiSkidFactor: consist.vehicles.map(() => 1),
    };
  }

  setCommand(command: BrakeCommand): void {
    this.state.command = command;
  }

  decelerationForNotch(notch: number): MetersPerSecondSquared {
    const n = clamp(Math.round(notch), 0, this.consist.brake.notchCount);
    return this.notchDeceleration[n]!;
  }

  averageCylinderPressure(): Pascals {
    let sum = 0;
    for (const u of this.units) sum += u.pressure;
    return sum / Math.max(1, this.units.length);
  }

  /** 1 両が最大 BC 圧で出せる制動力 [N] */
  private maxAirForce(index: number, v: MetersPerSecond): Newtons {
    const veh = this.consist.vehicles[index]!;
    const unit = this.units[index]!;
    return (
      veh.brake.maxCylinderPressure * veh.brake.forcePerPressure * unit.friction.at(Math.abs(v))
    );
  }

  update(dt: number, ctx: BrakeContext): void {
    const dyn = ctx.dynamics;
    const cmd = this.state.command;
    const v = Math.abs(dyn.speed);
    const ctrl = this.consist.brake;

    // --- 1. 指令減速度 ---
    let target: number;
    if (cmd.emergency) {
      target = ctrl.emergencyDeceleration;
    } else if (cmd.backup) {
      target = ctrl.maxServiceDeceleration;
    } else {
      target = this.decelerationForNotch(cmd.notch);
    }
    this.state.targetDeceleration = target;

    // --- 2. 応荷重: 必要制動力 ---
    // 回転部慣性を含む等価質量で計算する。実車の定減速度制御も換算質量を用いるため、
    // これにより指令減速度と実減速度が一致する。
    const actualMass = this.consist.vehicles.reduce(
      (a, veh) => a + vehicleMass(veh, ctx.loadFactor) + veh.rotatingMassFactor * veh.tareMass,
      0,
    );
    const referenceMass = this.consist.vehicles.reduce(
      (a, veh) =>
        a +
        vehicleMass(veh, this.consist.traction.referenceLoadFactor) +
        veh.rotatingMassFactor * veh.tareMass,
      0,
    );
    const massForForce = ctrl.loadCompensation ? actualMass : referenceMass;
    const requiredForce = massForForce * target;
    this.state.requiredForce = requiredForce;

    // --- 3. 電気ブレーキと空気ブレーキの分担（電空協調） ---
    const tctx = {
      dynamics: dyn,
      loadFactor: ctx.loadFactor,
      regenerationReceptivity: ctx.regenerationReceptivity,
      lineVoltage: ctx.lineVoltage,
    };
    const useElectric = ctrl.blending && !(cmd.emergency && ctrl.emergencyIsAirOnly) && !cmd.backup;

    // 抑速ブレーキ: 電気ブレーキのみで勾配を抑える
    if (cmd.holdingNotch > 0 && ctrl.hasHoldingBrake && target === 0) {
      const available = ctx.traction.availableElectricBrakeForce(v, tctx);
      const ratio = clamp(cmd.holdingNotch / ctrl.notchCount, 0, 1);
      const electricForce = available * ratio;
      ctx.traction.requestElectricBrakeForce(electricForce);
      this.state.electricForce = electricForce;
      this.state.airForceCommand = 0;
      this.state.regenerationLost = false;
      this.applyAir(dt, ctx, 0);
      return;
    }

    const availableNow = useElectric ? ctx.traction.availableElectricBrakeForce(v, tctx) : 0;

    // 空気ブレーキ指令は「これから回生が失効すること」を見越して先行して出す。
    // 空気ブレーキはむだ時間と込め時定数のぶん遅れるため、その時間だけ先の速度で
    // 見込まれる回生能力を基準に不足分を求める（先込め）。これがないと、
    // 回生絞り込み速度を下回った瞬間に減速度が大きく落ち込んでしまう。
    let airCommand = requiredForce;
    if (useElectric && requiredForce > 0) {
      const leadSpeed = Math.max(0, v - target * this.leadTime);
      const availableLead = ctx.traction.availableElectricBrakeForce(leadSpeed, tctx);
      airCommand = Math.max(0, requiredForce - Math.min(requiredForce, availableLead));
    }
    this.state.airForceCommand = airCommand;

    // --- 4. 空気ブレーキを時間発展させる ---
    this.applyAir(dt, ctx, airCommand);
    const airActual = this.state.airForceActual;

    // --- 5. 残りを電気ブレーキが受け持つ（空気が立ち上がるほど回生を絞る） ---
    let electricForce = 0;
    if (useElectric && requiredForce > 0) {
      electricForce = clamp(requiredForce - airActual, 0, availableNow);
    }
    ctx.traction.requestElectricBrakeForce(electricForce);
    this.state.electricForce = electricForce;
    this.state.regenerationLost =
      requiredForce > 0 && electricForce + airActual < requiredForce * 0.999;
  }

  /**
   * 空気ブレーキの指令を各車へ配分し、BC 圧を時間発展させて軸へトルクを与える。
   * 配分は車両質量に比例させる（各車が自車の応荷重で受け持つ）。
   */
  private applyAir(dt: number, ctx: BrakeContext, totalAirForce: Newtons): void {
    const dyn = ctx.dynamics;
    const v = Math.abs(dyn.speed);
    const cmd = this.state.command;
    const ctrl = this.consist.brake;
    const antiSkidEnabled = ctrl.antiSkid && (!cmd.emergency || ctrl.antiSkidOnEmergency);

    const totalMass = dyn.vehicles.reduce((a, veh) => a + veh.mass, 0);
    let actualTotal = 0;
    let anySkid = false;

    for (let i = 0; i < dyn.vehicles.length; i++) {
      const veh = dyn.vehicles[i]!;
      const spec = veh.spec.brake;
      const unit = this.units[i]!;
      const share = totalMass > 0 ? veh.mass / totalMass : 1 / dyn.vehicles.length;
      const wanted = totalAirForce * share;
      const frictionFactor = unit.friction.at(v);
      const denom = spec.forcePerPressure * frictionFactor;
      const rawTarget = denom > 0 ? wanted / denom : 0;
      unit.targetPressure = clamp(rawTarget, 0, spec.maxCylinderPressure);

      // むだ時間（指令から BC 圧が動き出すまで）
      const delayed = unit.delay.push(unit.targetPressure);

      // 滑走防止: 滑走を検知した車の BC 圧を素早く抜き、収まったらゆっくり込め直す
      if (antiSkidEnabled) {
        const sliding = this.isSliding(veh);
        if (sliding) {
          unit.skidFactor = Math.max(
            this.opts.minSkidFactor,
            unit.skidFactor - dt / this.opts.skidReleaseTime,
          );
          anySkid = true;
        } else {
          unit.skidFactor = Math.min(1, unit.skidFactor + dt / this.opts.skidRecoverTime);
        }
      } else {
        unit.skidFactor = 1;
      }

      const commanded = delayed * unit.skidFactor;
      // 込めと緩めで時定数が異なる
      const tau = commanded > unit.pressure ? spec.fillTimeConstant : spec.releaseTimeConstant;
      unit.pressure = firstOrderLag(unit.pressure, commanded, tau, dt);
      this.state.cylinderPressure[i] = unit.pressure;
      this.state.antiSkidFactor[i] = unit.skidFactor;

      // BC 圧 → 車輪周制動力 → 軸トルク
      const vehicleForce = unit.pressure * spec.forcePerPressure * frictionFactor;
      actualTotal += vehicleForce;
      const brakedAxles = veh.axles.filter((a) => a.braked).length;
      const r = veh.spec.wheelDiameter / 2;
      const torquePerAxle = brakedAxles > 0 ? (vehicleForce * r) / brakedAxles : 0;
      for (const ax of veh.axles) {
        ax.brakeTorque = ax.braked ? torquePerAxle : 0;
      }
    }

    this.state.airForceActual = actualTotal;
    this.state.antiSkidActive = anySkid;
  }

  private isSliding(veh: VehicleRuntime): boolean {
    const threshold = -this.consist.adhesion.peakCreep * this.opts.slideThreshold;
    for (const ax of veh.axles) {
      if (ax.braked && ax.slip < threshold) return true;
    }
    return false;
  }

  /** 空気ブレーキのみで得られる最大減速度 [m/s^2]（粘着は考慮しない） */
  maxAirDeceleration(dyn: TrainDynamics, v: MetersPerSecond): MetersPerSecondSquared {
    let force = 0;
    for (let i = 0; i < this.consist.vehicles.length; i++) force += this.maxAirForce(i, v);
    return force / dyn.totalMass;
  }
}
