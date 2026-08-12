import {
  DEFAULT_NOISE_MIX,
  SILENT_CHOPPER,
  SILENT_INVERTER,
  SILENT_RESISTOR,
  VOICE_COUNT,
  type ChopperVoiceParams,
  type InverterVoiceParams,
  type JointImpact,
  type NoiseMix,
  type ResistorVoiceParams,
  type TrainNoiseParams,
  type TurnoutImpact,
} from '@railsim/audio';
import { axleOffsets, jointCrossings, type BodyMotionState, type Simulation } from '@railsim/core';
import workletUrl from './trainNoise.worklet.ts?worker&url';

const PROCESSOR = 'train-noise';

/** 継目音の基準速度 [m/s]。この速度で衝撃の強さが 1 になる。 */
const JOINT_REFERENCE_SPEED = 25;

/**
 * 分岐器の衝撃音の基準速度 [m/s]。
 *
 * 継目より低いのは、欠線を渡るときの落ち込みが継目の段差より大きく、同じ速度でも
 * 明確に強く鳴るためである（分岐器を渡る音が離れていても聞こえるのはこのため）。
 */
const TURNOUT_REFERENCE_SPEED = 18;

/**
 * 運転台から音源までの距離による減衰の効き方 [m]。
 * この距離だけ離れると音量が半分になる。
 */
const DISTANCE_HALF = 25;

/**
 * 起動抵抗のうなりを正規化する基準電力 [W]。
 *
 * 抵抗制御では起動直後に電動機の入力とほぼ同じだけの電力を抵抗で熱にしている
 * （だから直列初段の効率は 5 割を切る）。編成の公称出力と同じ桁を基準にしておくと、
 * 起動でうなりが最大、進段するほど下がり、全短絡で消えるという関係になる。
 */
const RESISTOR_GRID_REFERENCE_POWER = 800_000;

/** 0..1 に丸める */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 左右の空気ばねの間隔の半分 [m]。
 * 台車の幾何で決まる値で、1067mm 軌間の台車なら空気ばねの中心間は 2m 前後。
 * ロール角速度にこの腕の長さを掛けたぶんが、上下速度に加わる。
 */
const AIR_SPRING_HALF_SPACING = 1.0;

/** トンネル内の残響時間 [s]（覆工が硬く、断面が狭いので長め） */
const TUNNEL_REVERB_TIME = 1.1;
/** トンネル内で残響へ送る比率 */
const TUNNEL_WET = 0.55;
/** 坑口での切り替わりの滑らかさ [s] */
const TUNNEL_FADE = 0.35;

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
  private tunnelSend: GainNode | null = null;
  private starting: Promise<void> | null = null;
  private failed = false;
  private muted = false;
  private paused = false;
  private mixValues: NoiseMix = DEFAULT_NOISE_MIX;

  /** ワークレットから返ってくる音源ごとの実効値 */
  readonly levels = new Float32Array(VOICE_COUNT);

  /** 各車両の前フレームでの距離程（継目・分岐器の跨ぎ判定に使う） */
  private previousPositions: number[] = [];
  private readonly offsetScratch: number[] = [];
  private readonly joints: JointImpact[] = [];
  private readonly turnouts: TurnoutImpact[] = [];
  /** 進段・組替えのカウンタ（増分を撃力の回数として鳴らす） */
  private lastStepEvents = 0;
  private lastGroupEvents = 0;
  /** 扉の戸当たりのカウンタ（増分を撃力の回数として鳴らす） */
  private lastLatchEvents = 0;
  private lastOpenEvents = 0;

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
      worklet.port.onmessage = (event: MessageEvent<{ levels?: number[] }>) => {
        const levels = event.data.levels;
        if (levels) this.levels.set(levels);
      };
      const master = context.createGain();
      master.gain.value = 0;
      master.connect(context.destination);

      // トンネルの反響。乾いた音はそのまま、送り量ぶんだけ残響へ回す。
      const convolver = context.createConvolver();
      convolver.buffer = createTunnelImpulse(context);
      const tunnelSend = context.createGain();
      tunnelSend.gain.value = 0;
      worklet.connect(master);
      worklet.connect(tunnelSend).connect(convolver).connect(master);

      if (context.state === 'suspended') await context.resume();
      this.context = context;
      this.worklet = worklet;
      this.master = master;
      this.tunnelSend = tunnelSend;
      this.applyGain();
    } catch (error) {
      // 音が出せなくても運転はできる。黙って落とさず、以後は諦める。
      this.failed = true;
      console.warn('走行音を初期化できませんでした', error);
    }
  }

  get mix(): NoiseMix {
    return this.mixValues;
  }

  /** 音量バランスを変える（変えた項目だけ渡せばよい） */
  setMix(patch: Partial<NoiseMix>): void {
    this.mixValues = { ...this.mixValues, ...patch };
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
    const target = this.muted || this.paused ? 0 : this.mixValues.master;
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
    if (running) this.collectImpacts(sim, wall);
    else this.clearImpacts(sim);
    worklet.port.postMessage({
      params,
      ...(this.joints.length > 0 ? { joints: this.joints } : {}),
      ...(this.turnouts.length > 0 ? { turnouts: this.turnouts } : {}),
    });
    this.updateTunnel(sim);
  }

  /**
   * トンネル内かどうかで残響の送り量を切り替える。
   * 坑口では一瞬で変わるのではなく、列車が入りきるまでのあいだに移り変わる。
   */
  private updateTunnel(sim: Simulation): void {
    const context = this.context;
    const send = this.tunnelSend;
    if (!context || !send) return;
    let inside = 0;
    for (const veh of sim.dynamics.vehicles) if (veh.inTunnel) inside++;
    const ratio = sim.dynamics.vehicles.length > 0 ? inside / sim.dynamics.vehicles.length : 0;
    send.gain.setTargetAtTime(ratio * TUNNEL_WET, context.currentTime, TUNNEL_FADE);
  }

  /**
   * 制御方式に応じて主回路の音源を選ぶ。
   *
   * 鳴らない方式には無音のパラメータを渡す。方式は走行中に変わらないので、
   * 使われない音源は毎フレームそのまま素通りするだけで負荷にならない。
   */
  private mainCircuitParams(
    drive: ReturnType<Simulation['snapshot']>['drive'],
    running: boolean,
    motorGain: number,
    load: number,
  ): {
    inverter: InverterVoiceParams;
    resistor: ResistorVoiceParams;
    chopper: ChopperVoiceParams;
  } {
    const mix = this.mixValues;
    const silent = {
      inverter: SILENT_INVERTER,
      resistor: SILENT_RESISTOR,
      chopper: SILENT_CHOPPER,
    };

    switch (drive.kind) {
      case 'vvvf': {
        // 主回路が切れていれば（惰行・ノッチ切）ゲートが閉じる。音量を 0 にするのでは
        // なく合成器へゲートの状態を渡し、相電圧を 0 にして磁束を自然に減衰させる。
        const gate = drive.mode !== 'off' && running;
        // V/f 一定で磁束が保たれるので、実機の磁気音は負荷でそれほど変わらない。
        // どれだけ追従させるかは耳で決められるようミキサのつまみにしてある。
        const inverterLoad = 1 - mix.inverterLoadTracking + mix.inverterLoadTracking * load;
        return {
          ...silent,
          inverter: {
            gate,
            // ゲートが閉じているあいだも回転子の周波数を渡し続ける。0 へ落とすと、
            // 磁束が積分であるために消えぎわで利得が跳ね上がって掃引音が出る。
            fundamental: gate ? drive.fundamentalFrequency : drive.rotorFrequency,
            carrier: drive.carrierFrequency,
            modulation: drive.modulationIndex,
            pulses: drive.pulses,
            slotFrequency: drive.slotFrequency,
            level: inverterLoad * motorGain * mix.inverter,
          },
        };
      }
      case 'resistor': {
        // 進段は 1 秒に数回までなので、フレーム精度で鳴らせば足りる
        // （継目や分岐器のようなサンプル精度の予約は要らない）。
        const steps = running ? Math.max(0, drive.stepEvents - this.lastStepEvents) : 0;
        const groupChanges = running ? Math.max(0, drive.groupEvents - this.lastGroupEvents) : 0;
        this.lastStepEvents = drive.stepEvents;
        this.lastGroupEvents = drive.groupEvents;
        return {
          ...silent,
          resistor: {
            gate: (drive.gate || drive.dynamicBraking) && running,
            current: Math.abs(drive.torqueRatio),
            commutatorFrequency: running ? drive.commutatorFrequency : 0,
            // 起動抵抗で捨てている電力を、編成の公称出力で正規化して渡す。
            // 段が進んで抵抗が短絡されるほど 0 に近づき、うなりが消える。
            resistorPower: clamp01(drive.resistorPower / RESISTOR_GRID_REFERENCE_POWER),
            steps,
            groupChanges,
            level: motorGain * mix.resistor,
          },
        };
      }
      case 'chopper':
        return {
          ...silent,
          chopper: {
            gate: drive.gate && running,
            current: Math.abs(drive.torqueRatio),
            duty: drive.duty,
            chopFrequency: drive.chopFrequency,
            commutatorFrequency: running ? drive.commutatorFrequency : 0,
            level: motorGain * mix.chopper,
          },
        };
      case 'none':
        return silent;
    }
  }

  private buildParams(
    sim: Simulation,
    snap: ReturnType<Simulation['snapshot']>,
    running: boolean,
  ): TrainNoiseParams {
    const drive = snap.drive;
    const indication = snap.safety.indication;
    const mix = this.mixValues;
    const speed = running ? Math.abs(snap.speed) : 0;
    const spec = sim.scenario.consist.vehicles.find((v) => v.traction)?.traction ?? null;

    // 負荷率はどの方式でも「定格に対するトルク比」で表せる。歯車の音はこれで駆動する。
    const load = Math.min(1, Math.abs(drive.torqueRatio));
    // 電動機は M 車の床下にある。この編成は Tc 先頭なので、運転士には
    // 数十メートル後方から聞こえることになる。
    const motorGain = this.motorDistanceGain(sim);

    // 戸当たりは進段と同じくフレーム精度で足りる（1 回の停車で数回しか鳴らない）。
    const doorParams = {
      moving: snap.doors.moving && running,
      closing: snap.doors.closing,
      chiming: snap.doors.chiming && running,
      latches: running ? Math.max(0, snap.doors.latchEvents - this.lastLatchEvents) : 0,
      opens: running ? Math.max(0, snap.doors.openEvents - this.lastOpenEvents) : 0,
      // 扉は運転台のすぐ後ろから編成の端までにあるので、距離減衰は掛けない。
      level: mix.door,
    };
    this.lastLatchEvents = snap.doors.latchEvents;
    this.lastOpenEvents = snap.doors.openEvents;

    const cylinder = spec
      ? snap.cylinderPressure /
        (sim.scenario.consist.vehicles[0]?.brake.maxCylinderPressure ?? 400_000)
      : 0;
    const pressureRate = this.cylinderRate(snap.cylinderPressure, sim);

    return {
      ...this.mainCircuitParams(drive, running, motorGain, load),
      gear: {
        // 歯車のかみ合いは主回路が何であろうと同じように鳴るので、
        // 制御方式に依らない共通の回転量から作る。
        meshFrequency: running ? drive.gearMeshFrequency : 0,
        shaftFrequency: running ? drive.motorRpm / 60 : 0,
        load: 1 - mix.gearLoadTracking + mix.gearLoadTracking * load,
        // 歯車箱は M 車の床下にしか無いので、電動機と同じだけ遠い
        level: motorGain * mix.gear,
      },
      door: doorParams,
      // 転動音と風切り音は編成のどこからでも来る。運転台の真下にも軸があるし、
      // 前面は自分が風を切っている当人なので、距離減衰は掛からない。
      rolling: {
        speed,
        corrugation: sim.scenario.route.railCorrugation.at(sim.dynamics.frontPosition),
        level: mix.rolling,
      },
      wind: { speed, level: mix.wind },
      brake: {
        speed,
        cylinderPressure: cylinder,
        pressureRate: running ? pressureRate : 0,
        level: mix.brake,
      },
      auxiliary: {
        compressor: running ? snap.compressor.output : 0,
        level: mix.auxiliary,
      },
      airSpring: {
        strokeRate: running ? airSpringStrokeRate(snap.body) : 0,
        level: mix.airSpring,
      },
      // 保安装置の報知音と警笛は運転台の中で鳴るので、距離減衰も走行音による
      // マスクも受けない。運転士に届かなければ意味が無い装置だからである。
      alarm: {
        bell: indication.bell,
        chime: indication.chime,
        patternApproach: indication.patternApproach,
        level: mix.alarm,
      },
      horn: { sounding: sim.input.horn, level: mix.horn },
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
   * この描画フレームのあいだに各軸が踏んだ継目と分岐器を集める。
   *
   * 軸ごと・要素ごとに、フレーム内のどの位置で踏んだかを小数で求め、
   * サンプル数に直して予約する。60fps に丸めると 16ms もばらつき、
   * 「ガタン ゴトン」の間隔が台車の寸法を映さなくなる。
   *
   * 分岐器も同じ扱いで、1 つの分岐器につき軸ごとに 2 回（トングレール先端と
   * クロッシング）鳴る。2 つの間隔はリード長を速度で割った時間そのものなので、
   * 番数の大きい分岐器ほど離れて聞こえる。
   */
  private collectImpacts(sim: Simulation, wall: number): void {
    this.joints.length = 0;
    this.turnouts.length = 0;
    const context = this.context;
    if (!context || wall <= 0) return;

    const route = sim.scenario.route;
    const speed = Math.abs(sim.speed);
    const vehicles = sim.dynamics.vehicles;
    if (speed < 0.3 || this.previousPositions.length !== vehicles.length) {
      this.syncPositions(sim);
      return;
    }
    const jointStrength = Math.min(1.2, Math.pow(speed / JOINT_REFERENCE_SPEED, 1.5));
    const turnoutStrength = Math.min(1.4, Math.pow(speed / TURNOUT_REFERENCE_SPEED, 1.5));
    const frameSamples = wall * context.sampleRate;

    const crossings: number[] = [];
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i]!;
      const offsets = axleOffsets(veh.spec, this.offsetScratch);
      const dCentre = veh.s - this.previousPositions[i]!;
      this.previousPositions[i] = veh.s;
      // 後方の車ほど遠いので弱く聞こえる
      const distance = i === 0 ? 1 : 0.75 / (1 + i * 0.35);
      for (const offset of offsets) {
        const now = veh.s + offset;
        const prev = now - dCentre;
        const spacing = route.railJointSpacing.at(now);
        jointCrossings(prev, now, spacing, crossings);
        for (const u of crossings) {
          this.joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance,
          });
        }
        if (route.turnouts.length === 0 || dCentre === 0) continue;
        for (const entry of route.turnouts.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          this.turnouts.push({
            delay: Math.round(u * frameSamples),
            strength: turnoutStrength * distance * entry.value.strength,
            crossing: entry.value.kind === 'crossing',
          });
        }
      }
    }
  }

  private clearImpacts(sim: Simulation): void {
    this.syncPositions(sim);
    this.joints.length = 0;
    this.turnouts.length = 0;
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
    this.lastStepEvents = 0;
    this.lastGroupEvents = 0;
    this.lastLatchEvents = 0;
    this.lastOpenEvents = 0;
    this.worklet?.port.postMessage({ reset: true });
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.worklet = null;
    this.master = null;
    this.tunnelSend = null;
  }
}

/**
 * トンネルのインパルス応答を合成する。
 *
 * 音源を持ち込まずに済ませたいので、指数減衰する雑音から作る。断面が狭く
 * 覆工が硬いトンネルでは、初期反射が密で残響時間が長く、低域ほどよく残る。
 * 左右で別の雑音を使うと横方向の広がりが出る。
 */
function createTunnelImpulse(context: BaseAudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * TUNNEL_REVERB_TIME);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  // 決定論のため（そして毎回同じトンネルであるため）固定シードの雑音を使う
  let state = 0x2f6e >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  };
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // 低域ほど長く残る（高域は覆工と車体に吸われる）
      low = low * 0.72 + random() * 0.28;
      const decay = Math.pow(1 - t, 2.6);
      data[i] = (random() * 0.45 + low * 0.55) * decay;
    }
    // 直達音のぶんは畳み込みの外にあるので、先頭は落としておく
    for (let i = 0; i < 64; i++) data[i]! *= i / 64;
  }
  return buffer;
}

/**
 * 空気ばねが伸縮する速さ [m/s]。
 *
 * 車体の上下動そのものと、ロールによる左右差の両方が効く。左右の空気ばねは
 * 車体中心から `間隔/2` だけ離れているので、ロール角速度にその腕の長さを
 * 掛けたぶんが上下速度に加わる。大きいほうの側が鳴く。
 */
function airSpringStrokeRate(body: BodyMotionState): number {
  return Math.abs(body.verticalRate) + AIR_SPRING_HALF_SPACING * Math.abs(body.rollRate);
}
