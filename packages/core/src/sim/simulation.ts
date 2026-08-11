import { AirCompressor, type CompressorState } from '../brake/compressor.ts';
import { ElectroPneumaticBrakeSystem } from '../brake/electroPneumatic.ts';
import type { BrakeCommand } from '../brake/types.ts';
import { Rng } from '../math/rng.ts';
import { clamp } from '../math/scalar.ts';
import { MetricsRecorder, type StopRecord } from '../operation/metrics.ts';
import type { BeaconPayload, SafetySystemKind, Station } from '../route/types.ts';
import { AtcSystem } from '../safety/atc.ts';
import { AtsPSystem } from '../safety/atsP.ts';
import { AtsSnSystem } from '../safety/atsSn.ts';
import { CompositeSafetySystem } from '../safety/composite.ts';
import type { SafetyContext, SafetyOutput, SafetySystem } from '../safety/types.ts';
import { noOutput } from '../safety/types.ts';
import { VigilanceSystem } from '../safety/vigilance.ts';
import { SignallingSystem } from '../signalling/system.ts';
import type { Turnout } from '../track/turnout.ts';
import type { BodyMotionState } from '../train/bodyMotion.ts';
import { TrainDynamics, type DynamicsEnvironment } from '../train/dynamics.ts';
import { createInverterState, type InverterState } from '../traction/modulation.ts';
import { VvvfTractionSystem } from '../traction/vvvf.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import { NEUTRAL_INPUT, type ControlInput, type Scenario } from './types.ts';

/** 物理積分の刻み [s] */
export const PHYSICS_DT = 0.001;
/** 物理積分の刻み [マイクロ秒]（整数で時間を貯めるための単位） */
const PHYSICS_MICROS = 1000;
/** 装置制御の周期 [s] */
export const CONTROL_DT = 0.01;
/** 1 回の step() で進める最大の物理ステップ数（処理落ち時の暴走防止） */
const MAX_SUBSTEPS = 2000;

/** 動力装置を持たない編成（付随車のみ）のときのインバータ状態 */
const NO_INVERTER: InverterState = createInverterState();

/** 駅での取り扱い状態 */
export interface StationProgress {
  readonly station: Station;
  arrived: boolean;
  departed: boolean;
  arrivalTime: Seconds | null;
  departureTime: Seconds | null;
  stopError: Meters | null;
  doorsOpen: boolean;
  /** 停車時分の経過 [s] */
  dwellElapsed: Seconds;
}

export interface SimulationOptions {
  /** 保安装置を差し替える（テスト用） */
  readonly safetyFactory?: (scenario: Scenario) => SafetySystem;
}

/**
 * シミュレーション全体を束ねる。
 *
 * 時間の進め方は 3 階層に分かれている:
 *
 *  - 物理積分: 1 kHz（連結器とクリープ力の剛性に対して安定な刻み）
 *  - 装置制御: 100 Hz（ノッチ・保安装置・信号・滑走防止の判断）
 *  - 描画:     可変（`step()` を呼ぶ側の任意のタイミング）
 *
 * 外部からの入力は `input`（運転士の操作）だけであり、それ以外に時刻や乱数へ
 * 依存する箇所は無い。したがって「同じシナリオ + 同じ入力列」なら、
 * 実行環境やフレームレートに関係なく完全に同じ結果になる。
 */
export class Simulation {
  readonly scenario: Scenario;
  readonly dynamics: TrainDynamics;
  readonly traction: VvvfTractionSystem;
  readonly brake: ElectroPneumaticBrakeSystem;
  readonly compressor = new AirCompressor();
  readonly signalling: SignallingSystem;
  readonly safety: SafetySystem;
  readonly metrics = new MetricsRecorder();
  readonly rng: Rng;

  /** 運転士の操作入力（外部から書き換える） */
  input: ControlInput = NEUTRAL_INPUT;

  /** シミュレーション内時刻 [s] */
  time: Seconds;
  /** 走行開始からの経過時間 [s] */
  elapsed: Seconds = 0;

  /**
   * 未消化の時間 [マイクロ秒]。
   * 浮動小数で貯めると呼び出し間隔によって刻み数が 1 ずれ、結果が再現しなくなるため、
   * 整数のマイクロ秒で保持する（物理刻み 1ms = 1000 マイクロ秒）。
   */
  private accumulatorMicros = 0;
  private controlAccumulator = 0;
  private previousFront: Meters;
  private lastControlFront: Meters;
  private safetyOutput: SafetyOutput = noOutput();
  private previousAcknowledge = false;
  private previousInput: ControlInput = NEUTRAL_INPUT;
  private lastCylinderPressure = 0;
  private readonly env: DynamicsEnvironment;

  readonly stations: StationProgress[];
  private nextStationIndex = 0;
  private slipLatched = false;
  private slideLatched = false;
  private emergencyLatched = false;
  private patternLatched = false;
  private warningLatched = false;

  constructor(scenario: Scenario, options: SimulationOptions = {}) {
    this.scenario = scenario;
    this.rng = new Rng(scenario.seed);
    this.time = scenario.startTime;
    this.dynamics = new TrainDynamics(scenario.consist, scenario.route.alignment, {
      loadFactor: scenario.loadFactor,
      initialFrontPosition: scenario.startPosition,
      initialSpeed: scenario.startSpeed,
      irregularity: scenario.route.irregularity,
      turnouts: scenario.route.turnouts,
      ...(scenario.rigidConsist === undefined ? {} : { rigidConsist: scenario.rigidConsist }),
    });
    this.traction = new VvvfTractionSystem(scenario.consist);
    this.brake = new ElectroPneumaticBrakeSystem(scenario.consist, {
      controlPeriod: CONTROL_DT,
    });
    this.signalling = new SignallingSystem(scenario.route, scenario.scheduledTrains);
    this.safety = options.safetyFactory
      ? options.safetyFactory(scenario)
      : buildSafetySystems(scenario);
    this.previousFront = this.dynamics.frontPosition;
    this.lastControlFront = this.previousFront;

    const tunnels = scenario.route.tunnels;
    this.env = {
      adhesion: { rail: scenario.railCondition, sanding: false },
      isTunnel: (s: Meters) => tunnels.at(s).length > 0,
    };

    this.stations = scenario.route.stations.map((station) => ({
      station,
      arrived: false,
      departed: false,
      arrivalTime: null,
      departureTime: null,
      stopError: null,
      doorsOpen: false,
      dwellElapsed: 0,
    }));

    this.signalling.update(this.occupancy(), this.time);
    this.runControl(CONTROL_DT);
  }

  /** 列車の在線範囲 */
  occupancy(): { front: Meters; rear: Meters } {
    return { front: this.dynamics.frontPosition, rear: this.dynamics.rearPosition };
  }

  get speed(): MetersPerSecond {
    return this.dynamics.speed;
  }

  get position(): Meters {
    return this.dynamics.frontPosition;
  }

  /** 現在位置の速度制限 [m/s] */
  get currentSpeedLimit(): MetersPerSecond {
    return this.scenario.route.speedLimits.at(this.dynamics.frontPosition);
  }

  /** 次に停車すべき駅 */
  get nextStation(): StationProgress | undefined {
    for (let i = this.nextStationIndex; i < this.stations.length; i++) {
      const st = this.stations[i]!;
      if (!st.departed) return st;
    }
    return undefined;
  }

  /**
   * 実時間 `elapsedSeconds` ぶんシミュレーションを進める。
   * 固定刻みのアキュムレータ方式で、呼び出し間隔に依らず同じ結果になる。
   */
  step(elapsedSeconds: Seconds): void {
    this.accumulatorMicros += Math.round(elapsedSeconds * 1e6);
    let steps = 0;
    while (this.accumulatorMicros >= PHYSICS_MICROS && steps < MAX_SUBSTEPS) {
      this.substep(PHYSICS_DT);
      this.accumulatorMicros -= PHYSICS_MICROS;
      steps++;
    }
    if (steps >= MAX_SUBSTEPS) {
      // 処理が追いつかない場合は残りを捨てる（時間を飛ばして破綻させない）
      this.accumulatorMicros = 0;
    }
  }

  /** 物理 1 ステップぶん進める */
  private substep(dt: Seconds): void {
    this.controlAccumulator += dt;
    if (this.controlAccumulator >= CONTROL_DT - 1e-9) {
      this.runControl(this.controlAccumulator);
      this.controlAccumulator = 0;
    }

    this.previousFront = this.dynamics.frontPosition;
    this.env.adhesion = {
      rail: this.scenario.railCondition,
      sanding: this.input.sanding,
    };
    this.dynamics.step(dt, this.env);
    this.time += dt;
    this.elapsed += dt;

    this.sampleMetrics(dt);
    this.updateStations(dt);
  }

  /** 装置制御（100 Hz） */
  private runControl(dt: Seconds): void {
    const front = this.dynamics.frontPosition;

    // 1. 閉塞・信号現示の更新
    this.signalling.update(this.occupancy(), this.time);

    // 2. 地上子の通過処理（区間交差で判定するため取りこぼしがない）
    const ctx = this.safetyContext(front, this.lastControlFront);
    const crossed = this.scenario.route.beacons.crossing(this.lastControlFront, front);
    for (const entry of crossed) {
      this.safety.onBeacon(entry.value as BeaconPayload, entry.s, ctx);
    }

    // 3. 保安装置
    this.safetyOutput = this.safety.update(dt, ctx);
    if (this.input.safetyReset && Math.abs(this.dynamics.speed) < 0.05) {
      this.safety.reset();
    }
    this.lastControlFront = front;

    // 4. 運転士の指令と保安装置の出力を合成する
    const emergency = this.input.emergency || this.safetyOutput.emergencyBrake;
    let brakeNotch = this.input.brakeNotch;
    if (this.safetyOutput.serviceBrakeNotch !== null) {
      brakeNotch = Math.max(
        brakeNotch,
        Math.min(this.safetyOutput.serviceBrakeNotch, this.scenario.consist.brake.notchCount),
      );
    }
    const cutOff = this.safetyOutput.cutOffTraction || emergency || brakeNotch > 0;
    const powerNotch =
      cutOff || this.input.reverser === 0 || !this.input.doorsClosed ? 0 : this.input.powerNotch;

    const brakeCommand: BrakeCommand = {
      notch: clamp(brakeNotch, 0, this.scenario.consist.brake.notchCount),
      emergency,
      holdingNotch: powerNotch > 0 ? 0 : this.input.holdingNotch,
      backup: this.input.backupBrake,
    };

    // 5. ブレーキ → 動力の順に更新する（電空協調で電気ブレーキ量が決まるため）
    const brakeCtx = {
      dynamics: this.dynamics,
      traction: this.traction,
      loadFactor: this.scenario.loadFactor,
      regenerationReceptivity: this.scenario.regenerationReceptivity,
      lineVoltage: 1500,
    };
    this.brake.setCommand(brakeCommand);
    this.brake.update(dt, brakeCtx);

    this.traction.setNotch(powerNotch);
    this.traction.update(dt, {
      dynamics: this.dynamics,
      loadFactor: this.scenario.loadFactor,
      regenerationReceptivity: this.scenario.regenerationReceptivity,
      lineVoltage: 1500,
    });

    // 6. 補機（空気圧縮機）。ブレーキの物理には影響しないが、BC へ込めたぶん
    //    元空気溜めが減るので、ブレーキを使うほど早く回り出す。
    const cylinderPressure = this.brake.averageCylinderPressure();
    const fillRate = dt > 0 ? Math.max(0, cylinderPressure - this.lastCylinderPressure) / dt : 0;
    this.lastCylinderPressure = cylinderPressure;
    this.compressor.step(dt, fillRate * this.scenario.consist.vehicles.length);

    this.updateSafetyMetrics();
    this.previousInput = this.input;
    this.previousAcknowledge = this.input.acknowledge;
  }

  private safetyContext(front: Meters, previousFront: Meters): SafetyContext {
    const anyOperation =
      this.input.powerNotch !== this.previousInput.powerNotch ||
      this.input.brakeNotch !== this.previousInput.brakeNotch ||
      this.input.horn ||
      this.input.acknowledge ||
      this.input.emergency !== this.previousInput.emergency;
    return {
      time: this.time,
      position: front,
      previousPosition: previousFront,
      speed: this.dynamics.speed,
      signalling: this.signalling,
      driver: {
        acknowledge: this.input.acknowledge && !this.previousAcknowledge,
        anyOperation,
      },
      lineSpeedLimit: this.scenario.route.maxSpeed,
      currentSpeedLimit: this.currentSpeedLimit,
    };
  }

  private sampleMetrics(dt: Seconds): void {
    const dyn = this.dynamics;
    const lateral = this.scenario.route.alignment.lateralAcceleration(dyn.frontPosition, dyn.speed);
    let resistancePower = 0;
    let brakePower = 0;
    for (const veh of dyn.vehicles) {
      resistancePower +=
        Math.abs(veh.runningResistanceForce + veh.curveResistanceForce) * Math.abs(veh.v);
      for (const ax of veh.axles) {
        brakePower += Math.abs(ax.brakeTorque * ax.omega);
      }
    }
    const stance = dyn.vehicles[0]!.body.passenger.stance;
    this.metrics.sample({
      dt,
      acceleration: dyn.acceleration,
      lateralAcceleration: lateral,
      couplerForce: dyn.maxCouplerForce,
      electricPower: this.traction.state.power,
      resistancePower,
      brakePower,
      stagger: stance.stagger,
      passengerSteps: stance.steps,
    });
  }

  private updateSafetyMetrics(): void {
    const m = this.metrics.safety;
    if (this.safetyOutput.emergencyBrake) {
      if (!this.emergencyLatched) m.emergencyBrakeCount++;
      this.emergencyLatched = true;
    } else {
      this.emergencyLatched = false;
    }
    if (this.safetyOutput.serviceBrakeNotch !== null) {
      if (!this.patternLatched) m.patternBrakeCount++;
      this.patternLatched = true;
    } else {
      this.patternLatched = false;
    }
    if (this.safetyOutput.indication.bell) {
      if (!this.warningLatched) m.atsWarningCount++;
      this.warningLatched = true;
    } else {
      this.warningLatched = false;
    }
    if (this.dynamics.anySlipping) {
      if (!this.slipLatched) m.slipEvents++;
      this.slipLatched = true;
    } else {
      this.slipLatched = false;
    }
    if (this.dynamics.anySliding) {
      if (!this.slideLatched) m.slideEvents++;
      this.slideLatched = true;
    } else {
      this.slideLatched = false;
    }
  }

  /** 駅の到着・停車・出発を管理する */
  private updateStations(dt: Seconds): void {
    const progress = this.nextStation;
    if (!progress) return;
    const station = progress.station;
    const front = this.dynamics.frontPosition;
    const stopped = Math.abs(this.dynamics.speed) < 0.05;

    if (station.isPass) {
      if (front > station.platformEnd) {
        progress.departed = true;
        progress.arrived = true;
        this.advanceStation();
      }
      return;
    }

    if (!progress.arrived) {
      const withinPlatform = front >= station.platformStart && front <= station.platformEnd + 50;
      if (stopped && withinPlatform) {
        progress.arrived = true;
        progress.arrivalTime = this.time;
        progress.stopError = front - station.stopPosition;
        this.metrics.recordStop({
          stationId: station.id,
          stationName: station.name,
          stopError: progress.stopError,
          arrivalTime: this.time,
          delay: station.arrivalTime === undefined ? null : this.time - station.arrivalTime,
          departureTime: null,
          departureDelay: null,
        } satisfies StopRecord);
      } else if (front > station.platformEnd + 50) {
        // 停止位置を大きく行き過ぎた場合は通過扱いとして次へ進む
        progress.arrived = true;
        progress.departed = true;
        this.advanceStation();
      }
      return;
    }

    if (!progress.departed) {
      progress.doorsOpen = !this.input.doorsClosed && stopped;
      if (progress.doorsOpen || progress.dwellElapsed > 0) {
        progress.dwellElapsed += dt;
      }
      if (!stopped && front > station.stopPosition - 1) {
        progress.departed = true;
        progress.departureTime = this.time;
        const record = this.metrics.stops[this.metrics.stops.length - 1];
        if (record && record.stationId === station.id) {
          record.departureTime = this.time;
          record.departureDelay =
            station.departureTime === undefined ? null : this.time - station.departureTime;
        }
        this.advanceStation();
      }
    }
  }

  private advanceStation(): void {
    while (
      this.nextStationIndex < this.stations.length &&
      this.stations[this.nextStationIndex]!.departed
    ) {
      this.nextStationIndex++;
    }
  }

  /** 描画・記録用のスナップショット */
  snapshot(): SimSnapshot {
    const dyn = this.dynamics;
    const alignment = this.scenario.route.alignment;
    const nextStation = this.nextStation;
    const turnout = this.scenario.route.turnouts.next(dyn.frontPosition);
    return {
      time: this.time,
      elapsed: this.elapsed,
      speed: dyn.speed,
      acceleration: dyn.acceleration,
      front: dyn.frontPosition,
      rear: dyn.rearPosition,
      grade: dyn.vehicles[0]!.grade,
      curvature: dyn.vehicles[0]!.curvature,
      cant: alignment.cantAt(dyn.frontPosition),
      cantDeficiency: alignment.cantDeficiencyAmount(dyn.frontPosition, dyn.speed),
      lateralAcceleration: alignment.lateralAcceleration(dyn.frontPosition, dyn.speed),
      body: dyn.vehicles[0]!.body,
      speedLimit: this.currentSpeedLimit,
      tractiveEffort: this.traction.state.tractiveEffort,
      motorCurrent: this.traction.state.motorCurrent,
      power: this.traction.state.power,
      powerNotch: this.traction.state.notch,
      brakeNotch: this.brake.state.command.notch,
      emergency: this.brake.state.command.emergency,
      cylinderPressure: this.brake.averageCylinderPressure(),
      electricBrakeForce: this.brake.state.electricForce,
      airBrakeForce: this.brake.state.airForceActual,
      regenerationLost: this.brake.state.regenerationLost,
      antiSkidActive: this.brake.state.antiSkidActive,
      reAdhesionFactor: this.traction.state.reAdhesionFactor,
      inverter: this.traction.modulation?.state ?? NO_INVERTER,
      compressor: this.compressor.state,
      maxSlip: dyn.vehicles.reduce(
        (m, v) => v.axles.reduce((mm, a) => (Math.abs(a.slip) > Math.abs(mm) ? a.slip : mm), m),
        0,
      ),
      maxCouplerForce: dyn.maxCouplerForce,
      safety: this.safetyOutput,
      nextSignal: this.signalling.signalAhead(dyn.frontPosition) ?? null,
      nextStationName: nextStation?.station.name ?? null,
      distanceToStop: nextStation ? nextStation.station.stopPosition - dyn.frontPosition : null,
      nextTurnout: turnout ? { turnout, distance: turnout.position - dyn.frontPosition } : null,
    };
  }
}

/** 描画・グラフ用の 1 時点のスナップショット */
export interface SimSnapshot {
  time: Seconds;
  elapsed: Seconds;
  speed: MetersPerSecond;
  acceleration: number;
  front: Meters;
  rear: Meters;
  grade: number;
  curvature: number;
  /** カント [m] */
  cant: number;
  /** カント過不足量 [m]（正 = 不足、負 = 超過。曲線の左右によらない） */
  cantDeficiency: number;
  lateralAcceleration: number;
  /** 先頭車の車体動揺と体感加速度 */
  body: BodyMotionState;
  speedLimit: MetersPerSecond;
  tractiveEffort: number;
  motorCurrent: number;
  power: number;
  powerNotch: number;
  brakeNotch: number;
  emergency: boolean;
  cylinderPressure: number;
  electricBrakeForce: number;
  airBrakeForce: number;
  regenerationLost: boolean;
  antiSkidActive: boolean;
  reAdhesionFactor: number;
  /** インバータの変調状態（出力周波数・パルスモード・キャリア周波数） */
  inverter: InverterState;
  /** 元空気溜めと空気圧縮機 */
  compressor: CompressorState;
  maxSlip: number;
  maxCouplerForce: number;
  safety: SafetyOutput;
  nextSignal: { state: { aspect: string; speed: number }; distance: number } | null;
  nextStationName: string | null;
  distanceToStop: number | null;
  /**
   * 次の分岐器（通過中ならその分岐器。距離は負になる）。
   * 開通方向と分岐側の制限速度が入っているので、手前で速度を落とす判断に使える。
   */
  nextTurnout: { turnout: Turnout; distance: Meters } | null;
}

/** シナリオの指定に従って保安装置を組み立てる */
export function buildSafetySystems(scenario: Scenario): SafetySystem {
  const systems: SafetySystem[] = [];
  for (const kind of scenario.safetySystems) {
    systems.push(createSafetySystem(kind));
  }
  if (scenario.hasVigilance) systems.push(new VigilanceSystem());
  return new CompositeSafetySystem(systems);
}

export function createSafetySystem(kind: SafetySystemKind): SafetySystem {
  switch (kind) {
    case 'ats-sn':
      return new AtsSnSystem();
    case 'ats-p':
      return new AtsPSystem();
    case 'atc':
      return new AtcSystem();
    default:
      throw new Error(`未知の保安装置: ${String(kind)}`);
  }
}
