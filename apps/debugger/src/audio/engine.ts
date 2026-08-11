import type { JointImpact, TrainNoiseParams } from '@railsim/audio';
import { axleOffsets, jointCrossings, type Simulation } from '@railsim/core';
import workletUrl from './trainNoise.worklet.ts?worker&url';

const PROCESSOR = 'train-noise';

/** 継目音の基準速度 [m/s]。この速度で衝撃の強さが 1 になる。 */
const JOINT_REFERENCE_SPEED = 25;

/**
 * 運転台から音源までの距離による減衰の効き方 [m]。
 * この距離だけ離れると音量が半分になる。
 */
const DISTANCE_HALF = 25;

/**
 * 走行音の出力。
 *
 * 合成そのものは `@railsim/audio` の素のクラスが AudioWorklet の中で行う。
 * ここはその配線と、シミュレーションの状態から合成パラメータへの写像だけを持つ。
 *
 * 他のサブシステム（`TrackScene` / `Hud` / `ChartPanel`）と同じく `Simulation` を
 * コンストラクタで抱え込まず、毎フレーム引数で受け取る。シナリオを切り替えると
 * `Simulation` は作り直されるためである。
 */
export class TrainAudio {
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private starting: Promise<void> | null = null;
  private failed = false;
  private volume = 0.7;
  private muted = false;
  private paused = false;

  /** 各車両の前フレームでの距離程（継目の跨ぎ判定に使う） */
  private previousPositions: number[] = [];
  private readonly offsetScratch: number[] = [];
  private readonly joints: JointImpact[] = [];

  get available(): boolean {
    return !this.failed;
  }

  /**
   * 音声を開始する。ブラウザの自動再生規制があるため、
   * 最初のクリックやキー入力（ユーザ操作）の中から呼ぶ必要がある。
   */
  async start(): Promise<void> {
    if (this.failed) return;
    if (this.context) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    this.starting ??= this.build();
    return this.starting;
  }

  private async build(): Promise<void> {
    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(context, PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const master = context.createGain();
      master.gain.value = 0;
      worklet.connect(master).connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      this.context = context;
      this.worklet = worklet;
      this.master = master;
      this.applyGain();
    } catch (error) {
      // 音が出せなくても運転はできる。黙って落とさず、以後は諦める。
      this.failed = true;
      console.warn('走行音を初期化できませんでした', error);
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyGain();
  }

  private applyGain(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const target = this.muted || this.paused ? 0 : this.volume;
    // 急に切ると耳障りなクリックが出るので短くランプする
    master.gain.setTargetAtTime(target, context.currentTime, 0.02);
  }

  /**
   * @param advance この描画フレームで進めたシミュレーション時間 [s]。
   *                一時停止中は 0 になるので、それを見て音を止める。
   * @param wall    実時間で経過した秒数。継目音を鳴らす位置の計算に使う
   *                （時間倍率を上げると、同じ距離を短い実時間で走るため）。
   */
  update(sim: Simulation, advance: number, wall: number): void {
    const worklet = this.worklet;
    if (!worklet) return;
    const snap = sim.snapshot();
    const running = advance > 0;

    const params = this.buildParams(sim, snap, running);
    const joints = running ? this.collectJoints(sim, wall) : this.clearJoints(sim);
    worklet.port.postMessage(joints.length > 0 ? { params, joints } : { params });
  }

  private buildParams(
    sim: Simulation,
    snap: ReturnType<Simulation['snapshot']>,
    running: boolean,
  ): TrainNoiseParams {
    const inv = snap.inverter;
    const speed = running ? Math.abs(snap.speed) : 0;
    const spec = sim.scenario.consist.vehicles.find((v) => v.traction)?.traction ?? null;

    // 主回路が切れていれば（惰行・ノッチ切）インバータは黙る。磁束は V/f 一定で
    // 保たれるため、音量はトルクよりも「switching しているかどうか」で決まる。
    const active = inv.mode !== 'off' && running;
    const load = Math.min(1, Math.abs(inv.torqueRatio));
    // 電動機は M 車の床下にある。この編成は Tc 先頭なので、運転士には
    // 数十メートル後方から聞こえることになる。
    const motorGain = this.motorDistanceGain(sim);

    const cylinder = spec
      ? snap.cylinderPressure /
        (sim.scenario.consist.vehicles[0]?.brake.maxCylinderPressure ?? 400_000)
      : 0;
    const pressureRate = this.cylinderRate(snap.cylinderPressure, sim);

    return {
      inverter: {
        fundamental: inv.fundamentalFrequency,
        carrier: inv.carrierFrequency,
        modulation: inv.modulationIndex,
        pulses: inv.pulses,
        slotFrequency: inv.slotFrequency,
        level: active ? (0.35 + 0.65 * load) * motorGain : 0,
      },
      runningGear: {
        speed,
        gearMeshFrequency: running ? inv.gearMeshFrequency : 0,
        shaftFrequency: running ? inv.motorRpm / 60 : 0,
        gearLoad: load,
        // 歯車は M 車、転動音は全車の足元から来るので、減衰は控えめにする
        level: 0.5 + 0.5 * motorGain,
      },
      brake: {
        speed,
        cylinderPressure: cylinder,
        pressureRate: running ? pressureRate : 0,
        level: 1,
      },
      auxiliary: {
        compressor: running ? snap.compressor.output : 0,
        level: 0.8,
      },
    };
  }

  /** 運転台から電動機（M 車）までの距離による減衰 */
  private motorDistanceGain(sim: Simulation): number {
    const cab = sim.dynamics.frontPosition;
    let sum = 0;
    let count = 0;
    for (const veh of sim.dynamics.vehicles) {
      if (!veh.spec.traction) continue;
      sum += Math.abs(cab - veh.s);
      count++;
    }
    if (count === 0) return 0;
    return 1 / (1 + sum / count / DISTANCE_HALF);
  }

  private lastCylinder = 0;
  private lastCylinderTime = 0;

  /** BC 圧の変化率（最大圧に対する比 / 秒） */
  private cylinderRate(pressure: number, sim: Simulation): number {
    const max = sim.scenario.consist.vehicles[0]?.brake.maxCylinderPressure ?? 400_000;
    const now = sim.elapsed;
    const dt = now - this.lastCylinderTime;
    this.lastCylinderTime = now;
    if (dt <= 0 || dt > 1) {
      this.lastCylinder = pressure;
      return 0;
    }
    const rate = (pressure - this.lastCylinder) / max / dt;
    this.lastCylinder = pressure;
    return rate;
  }

  /**
   * この描画フレームのあいだに各軸が踏んだ継目を集める。
   *
   * 軸ごと・継目ごとに、フレーム内のどの位置で踏んだかを小数で求め、
   * サンプル数に直して予約する。60fps に丸めると 16ms もばらつき、
   * 「ガタン ゴトン」の間隔が台車の寸法を映さなくなる。
   */
  private collectJoints(sim: Simulation, wall: number): readonly JointImpact[] {
    this.joints.length = 0;
    const context = this.context;
    if (!context || wall <= 0) return this.joints;

    const route = sim.scenario.route;
    const speed = Math.abs(sim.speed);
    if (speed < 0.3) {
      this.syncPositions(sim);
      return this.joints;
    }
    const strength = Math.min(1.2, Math.pow(speed / JOINT_REFERENCE_SPEED, 1.5));
    const frameSamples = wall * context.sampleRate;
    const vehicles = sim.dynamics.vehicles;
    if (this.previousPositions.length !== vehicles.length) {
      this.syncPositions(sim);
      return this.joints;
    }

    const crossings: number[] = [];
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i]!;
      const offsets = axleOffsets(veh.spec, this.offsetScratch);
      const dCentre = veh.s - this.previousPositions[i]!;
      this.previousPositions[i] = veh.s;
      for (const offset of offsets) {
        const now = veh.s + offset;
        const prev = now - dCentre;
        const spacing = route.railJointSpacing.at(now);
        jointCrossings(prev, now, spacing, crossings);
        for (const u of crossings) {
          this.joints.push({
            delay: Math.round(u * frameSamples),
            // 後方の車ほど遠いので弱く聞こえる
            strength: strength * (i === 0 ? 1 : 0.75 / (1 + i * 0.35)),
          });
        }
      }
    }
    return this.joints;
  }

  private clearJoints(sim: Simulation): readonly JointImpact[] {
    this.syncPositions(sim);
    this.joints.length = 0;
    return this.joints;
  }

  private syncPositions(sim: Simulation): void {
    const vehicles = sim.dynamics.vehicles;
    this.previousPositions.length = vehicles.length;
    for (let i = 0; i < vehicles.length; i++) this.previousPositions[i] = vehicles[i]!.s;
  }

  /** シナリオを切り替えたときに合成器の内部状態を捨てる */
  reset(): void {
    this.previousPositions.length = 0;
    this.lastCylinder = 0;
    this.lastCylinderTime = 0;
    this.worklet?.port.postMessage({ reset: true });
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.worklet = null;
    this.master = null;
  }
}
