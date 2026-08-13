import {
  CAR_BODY_LOSS,
  DEFAULT_NOISE_MIX,
  SILENT_BRIDGE,
  SILENT_CHOPPER,
  SILENT_CROSSING,
  SILENT_INVERTER,
  SILENT_PASSING,
  SILENT_RESISTOR,
  VOICE_COUNT,
  type BridgeVoiceParams,
  type ChopperVoiceParams,
  type CrossingVoiceParams,
  type InverterVoiceParams,
  type JointImpact,
  type JointImpactKind,
  type NoiseMix,
  type PassingVoiceParams,
  type ResistorVoiceParams,
  type TrainNoiseParams,
  type TurnoutImpact,
} from '@railsim/audio';
import {
  axleOffsets,
  bogieSquealDrive,
  bridgeAcoustics,
  gearMeshFrequencyAt,
  jointCrossings,
  type BodyMotionState,
  type Bridge,
  type BridgeAcoustics,
  type RailJointKind,
  type Simulation,
} from '@railsim/core';
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

/**
 * 路線データの継目の種類から、合成器の音色への対応。
 *
 * 音の側（`@railsim/audio`）は物理コアを知らないので、種類の名前を独立に持っている。
 * ここが唯一の対応表で、踏切板の目地（`panel`）だけは継目ではなく踏切の側から来る。
 */
const JOINT_KIND: Readonly<Record<RailJointKind, JointImpactKind>> = {
  standard: 'standard',
  insulated: 'insulated',
  expansion: 'expansion',
};

/**
 * 隣の線路の音が半分になる距離 [m]。
 *
 * 自分の足元の音（`DISTANCE_HALF` = 25m）より短いのは、床下から構造を伝わって
 * 入ってくる自分の走行音と違い、相手の音は空気を伝わってくるからである。
 */
const OTHER_TRAIN_DISTANCE_HALF = 12;

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

/**
 * 踏切の警報機の位置。
 *
 * 警報機は踏切道の両側、軌道中心から 3.5m ほど離れた道路側に建つ。2 台の線路方向の
 * 間隔は道路の幅より一回り広い（道路の外側に立つため）。この 2 つの数字が、
 * すれ違いざまに「片方が近づき、もう片方が遠ざかる」聞こえ方を決めている。
 */
const CROSSING_POST = { lateral: 3.5, margin: 3 } as const;

/**
 * 橋りょうの反響を残響へ送る比率。
 *
 * トンネルほど閉じてはいないが、桁と主構は硬い反射面である。下路トラス橋は
 * 列車が主構のあいだを通るのでよく響き、上路桁では足元だけが返ってくる。
 * どちらになるかは `bridgeAcoustics()` の反射の強さがそのまま決める。
 */
const BRIDGE_WET = 0.4;

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

  /**
   * 音声の時計。レンダされた**音声の秒数**を約 60ms ごとに知らせる。
   *
   * `requestAnimationFrame` は背面タブで止まるが、AudioWorklet は音声スレッドで
   * 動き続ける（音を出しているタブはブラウザの凍結対象からも外れる）。背面のあいだ
   * だけこちらを親時計に使えば、シミュレーションが止まらずに済む。
   * 実時間ではなく音声時間を渡すのは、それがワークレットの持つ唯一の時計であり、
   * 音の連続性を決めているのもそれだからである。
   */
  onClock: ((seconds: number) => void) | null = null;

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
  /** 橋りょうの音の諸元（桁の寸法から決まるので、橋ごとに 1 度求めれば足りる） */
  private readonly bridgeCache = new Map<string, BridgeAcoustics>();
  /** ダイヤ列車の前フレームでの先頭端（相手の軸が踏んだ継目を数えるのに使う） */
  private readonly previousTrainPositions = new Map<string, number>();

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
      worklet.port.onmessage = (event: MessageEvent<{ levels?: number[]; seconds?: number }>) => {
        const levels = event.data.levels;
        if (levels) this.levels.set(levels);
        const seconds = event.data.seconds;
        if (seconds !== undefined && seconds > 0) this.onClock?.(seconds);
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
   * 反響の送り量を切り替える。
   *
   * 硬い面に囲まれるほど響くので、トンネルと橋りょうを同じ経路で扱う。坑口や
   * 橋台では一瞬で変わるのではなく、列車が入りきるまでのあいだに移り変わる。
   */
  private updateTunnel(sim: Simulation): void {
    const context = this.context;
    const send = this.tunnelSend;
    if (!context || !send) return;
    const vehicles = sim.dynamics.vehicles;
    const bridges = sim.scenario.route.bridges;
    let inside = 0;
    let onBridge = 0;
    let reflection = 0;
    for (const veh of vehicles) {
      if (veh.inTunnel) inside++;
      const bridge = bridges.at(veh.s);
      if (!bridge) continue;
      onBridge++;
      reflection = Math.max(reflection, this.acousticsOf(bridge).reflection);
    }
    const count = vehicles.length > 0 ? vehicles.length : 1;
    const wet = (inside / count) * TUNNEL_WET + (onBridge / count) * reflection * BRIDGE_WET;
    send.gain.setTargetAtTime(wet, context.currentTime, TUNNEL_FADE);
  }

  /** 橋の音の諸元。桁の寸法から決まる値なので、橋ごとに 1 度求めて使い回す。 */
  private acousticsOf(bridge: Bridge): BridgeAcoustics {
    const cached = this.bridgeCache.get(bridge.id);
    if (cached) return cached;
    const acoustics = bridgeAcoustics(bridge);
    this.bridgeCache.set(bridge.id, acoustics);
    return acoustics;
  }

  /**
   * 橋りょうの音。
   *
   * 鳴らしているのは桁であって列車ではないので、音量は**桁に乗っている編成の
   * 割合**で決まる。先頭が橋台へ乗った瞬間に鳴り出し、最後部が抜けた瞬間に
   * 止まる。編成より短い橋なら、渡りきるまで音は最大にならない。
   */
  private bridgeParams(sim: Simulation, running: boolean): BridgeVoiceParams {
    if (!running) return SILENT_BRIDGE;
    const bridges = sim.scenario.route.bridges;
    const vehicles = sim.dynamics.vehicles;
    let covered = 0;
    let bridge: Bridge | undefined;
    for (const veh of vehicles) {
      const found = bridges.at(veh.s);
      if (!found) continue;
      covered++;
      bridge ??= found;
    }
    if (!bridge || vehicles.length === 0) return SILENT_BRIDGE;
    const acoustics = this.acousticsOf(bridge);
    return {
      speed: Math.abs(sim.speed),
      coverage: covered / vehicles.length,
      radiation: acoustics.radiation,
      reflection: acoustics.reflection,
      modes: acoustics.modes,
      weights: acoustics.weights,
      damping: acoustics.damping,
      sleeperSpacing: bridge.sleeperSpacing,
      level: this.mixValues.bridge,
    };
  }

  /**
   * 踏切の警報音。
   *
   * 音源は線路脇に**静止している**ので、渡す量は位置関係と自分の速度だけである。
   * 距離減衰もドップラーも音源側で決めることは何も無い。鳴っているかどうかは
   * 踏切保安装置（`LevelCrossingSystem`）が決めていて、対向列車が来れば自分が
   * 止まっていても鳴る。
   */
  private crossingParams(
    snap: ReturnType<Simulation['snapshot']>,
    running: boolean,
  ): CrossingVoiceParams {
    const crossing = snap.crossing;
    if (!crossing || !running) return SILENT_CROSSING;
    return {
      ringing: crossing.state.ringing,
      bell: crossing.state.crossing.bell,
      distance: crossing.distance,
      lateral: CROSSING_POST.lateral,
      postSpacing: crossing.state.crossing.roadWidth + CROSSING_POST.margin,
      speed: snap.speed,
      level: this.mixValues.crossing,
    };
  }

  /**
   * 対向列車とのすれ違い。
   *
   * 相手の歯車のかみ合い周波数は、相手の速度と**こちらと同じ諸元**（同じ路線を走る
   * 同じ形式の列車と見なす）から求める。歯車の音は力行に依らず鳴るので速度だけで
   * 決まるが、インバータの磁気音はゲートが開いていないと出ない。等速で通過していく
   * ダイヤ列車は惰行にあたるので、実車でもインバータ音は聞こえない。
   */
  private passingParams(
    sim: Simulation,
    snap: ReturnType<Simulation['snapshot']>,
    running: boolean,
  ): PassingVoiceParams {
    const passing = snap.passing;
    if (!passing || !running) return SILENT_PASSING;
    const motored = sim.scenario.consist.vehicles.find((v) => v.traction);
    return {
      present: true,
      headGap: passing.headGap,
      tailGap: passing.tailGap,
      closingSpeed: passing.closingSpeed,
      otherSpeed: passing.otherSpeed,
      gearMeshFrequency: motored?.traction
        ? gearMeshFrequencyAt(motored.traction, motored.wheelDiameter, passing.otherSpeed)
        : 0,
      separation: passing.lateralSeparation,
      level: this.mixValues.passing,
    };
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
            // 主接触器が切れていても電動機は回っている。周波数は `gate` で止めず、
            // 惰行でも通風音が残るようにする（消えるのは電流が作る電磁音だけ）。
            slotFrequency: running ? drive.slotFrequency : 0,
            commutatorFrequency: running ? drive.commutatorFrequency : 0,
            ventilationFrequency: running ? drive.ventilationFrequency : 0,
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
            slotFrequency: running ? drive.slotFrequency : 0,
            commutatorFrequency: running ? drive.commutatorFrequency : 0,
            ventilationFrequency: running ? drive.ventilationFrequency : 0,
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
      curveSqueal: {
        drive: running ? this.squealDrive(sim) : 0,
        speed,
        level: mix.curveSqueal,
      },
      // 橋・踏切・対向列車は「線路と沿線の側にあるもの」なので、車両の状態では
      // なく位置関係から決まる。3 つとも音源は自分の外にある。
      bridge: this.bridgeParams(sim, running),
      crossing: this.crossingParams(snap, running),
      passing: this.passingParams(sim, snap, running),
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

  /**
   * 編成のうちいちばん強く軋っている台車の駆動の強さ。
   *
   * 判定そのものは `bogieSquealDrive`（コア）にある。ここがやるのは台車の位置を
   * 並べることと、運転台からの距離で弱めることだけである。
   *
   * 足し合わせずに最大を取っているのは、軋りが**その 1 つのモードの自励振動**で
   * あって、鳴いている台車が増えても音量が線形に増える種類の音ではないためである。
   */
  private squealDrive(sim: Simulation): number {
    const route = sim.scenario.route;
    const cab = sim.dynamics.frontPosition;
    const rail = sim.scenario.railCondition;
    const adhesion = sim.scenario.consist.adhesion;
    const lateralAt = (s: number): number =>
      route.irregularity.lateralAt(s) + route.turnouts.lateralAt(s);

    let worst = 0;
    for (const veh of sim.dynamics.vehicles) {
      const spec = veh.spec;
      const half = spec.bogieSpacing / 2;
      for (const centre of [veh.s + half, veh.s - half]) {
        const drive = bogieSquealDrive({
          adhesion,
          curvature: route.alignment.curvatureAt(centre),
          lateralAt,
          position: centre,
          bogieWheelbase: spec.bogieWheelbase,
          speed: veh.v,
          rail,
        });
        // 台車は編成のあちこちにあるので、運転台からの距離で弱まる
        const gain = 1 / (1 + Math.abs(cab - centre) / DISTANCE_HALF);
        worst = Math.max(worst, drive * gain);
      }
    }
    return worst;
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
   * この描画フレームのあいだに各軸が踏んだ継目・分岐器・踏切板を集める。
   *
   * 軸ごと・要素ごとに、フレーム内のどの位置で踏んだかを小数で求め、
   * サンプル数に直して予約する。60fps に丸めると 16ms もばらつき、
   * 「ガタン ゴトン」の間隔が台車の寸法を映さなくなる。
   *
   * 分岐器も同じ扱いで、1 つの分岐器につき軸ごとに 2 回（トングレール先端と
   * クロッシング）鳴る。2 つの間隔はリード長を速度で割った時間そのものなので、
   * 番数の大きい分岐器ほど離れて聞こえる。
   *
   * 継目には 3 通りある。
   *
   *  - **定尺の継目** — 距離程の周期なので、`jointCrossings()` が跨ぎを数える
   *  - **個別の継目**（分岐器の前後の絶縁継目・橋の両端の伸縮継目）— そこに
   *    置く理由がある継目なので、位置を 1 つずつ持つ。ロングレール区間でここだけ
   *    音がするのはこのため
   *  - **踏切板の目地** — 踏切道の入口と出口。舗装と踏切板の段差を踏む
   *
   * どれも同じ音源（`RailJointVoice`）へ送るが、種類ごとに構造が違うので鳴り方が
   * 違う。ミキサのつまみを 1 本にしてあるのも「継目の音」として一括りにできるためで、
   * 音色を分けているのは構造の違いだけである。
   */
  private collectImpacts(sim: Simulation, wall: number): void {
    this.joints.length = 0;
    this.turnouts.length = 0;
    const context = this.context;
    if (!context || wall <= 0) return;

    const route = sim.scenario.route;
    const speed = Math.abs(sim.speed);
    const vehicles = sim.dynamics.vehicles;
    const frameSamples = wall * context.sampleRate;

    // 隣の線路の列車は自分が止まっていても走っている。自分の足元の話とは別に数える。
    this.collectOtherTrainImpacts(sim, frameSamples);

    if (speed < 0.3 || this.previousPositions.length !== vehicles.length) {
      this.syncPositions(sim);
      return;
    }
    // 衝撃は音源側に音量の入り口が無い（撃力そのものを渡すため）ので、
    // ミキサのつまみはここで強さに掛ける。
    const jointStrength =
      Math.min(1.2, Math.pow(speed / JOINT_REFERENCE_SPEED, 1.5)) * this.mixValues.railJoint;
    const turnoutStrength =
      Math.min(1.4, Math.pow(speed / TURNOUT_REFERENCE_SPEED, 1.5)) * this.mixValues.turnout;

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
            kind: 'standard',
          });
        }
        if (dCentre === 0) continue;
        // 個別に置かれた継目（絶縁継目・伸縮継目）
        for (const entry of route.railJoints.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          this.joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance * entry.value.strength,
            kind: JOINT_KIND[entry.value.kind],
          });
        }
        // 踏切道の入口と出口（舗装と踏切板の目地）
        for (const entry of route.levelCrossings.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          this.joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance * entry.value.strength,
            kind: 'panel',
          });
        }
        if (route.turnouts.length === 0) continue;
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

  /**
   * 隣の線路を走る対向列車が踏んだ継目を集める。
   *
   * 継目は**線路の側にあるもの**なので、誰の軸が踏んでも同じ継目が鳴る。自列車と
   * 同じように、相手の軸が跨いだ継目を数えて同じ音源（`RailJointVoice`）へ送る。
   * 違うのは届き方だけで、
   *
   *  - 音源が離れている（最短でも線路中心間隔ぶん）ので距離で減衰し、
   *  - 車外の音なので車体の遮音（`CAR_BODY_LOSS`）を受ける
   *
   * この 2 つのぶんだけ小さくなる。すれ違いざまに相手の「ガタン ゴトン」が
   * こもって聞こえるのはそのためで、相手が定尺レール区間にいれば鳴り、
   * ロングレール区間にいれば鳴らない — こちらの足元と同じ理屈である。
   */
  private collectOtherTrainImpacts(sim: Simulation, frameSamples: number): void {
    const route = sim.scenario.route;
    const spec = sim.scenario.consist.vehicles[0];
    if (!spec) return;
    const cab = sim.dynamics.frontPosition;
    const crossings: number[] = [];

    for (const state of sim.signalling.trainStates) {
      if ((state.train.track ?? 'own') !== 'adjacent') continue;
      const previous = this.previousTrainPositions.get(state.train.id);
      this.previousTrainPositions.set(state.train.id, state.leadPosition);
      if (previous === undefined) continue;
      const delta = state.leadPosition - previous;
      if (delta === 0 || Math.abs(delta) > 200) continue;

      const strength =
        Math.min(1.2, Math.pow(state.speed / JOINT_REFERENCE_SPEED, 1.5)) *
        this.mixValues.railJoint;
      const cars = Math.max(1, Math.round(state.train.length / spec.length));
      const offsets = axleOffsets(spec, this.offsetScratch);
      const separation = Math.abs(route.adjacentTrack.offsetAt(state.leadPosition)) || 3.4;

      for (let car = 0; car < cars; car++) {
        // 先頭端は進行方向の先。編成はそこから後ろへ伸びる。
        const centre = state.leadPosition - state.direction * (car + 0.5) * spec.length;
        for (const offset of offsets) {
          const now = centre + state.direction * offset;
          const prev = now - delta;
          // 運転台から相手の軸までの距離。並んだ瞬間は線路中心間隔そのものになる。
          const distance = Math.hypot(now - cab, separation);
          const gain = (CAR_BODY_LOSS * strength) / (1 + distance / OTHER_TRAIN_DISTANCE_HALF);
          if (gain < 1e-3) continue;

          jointCrossings(prev, now, route.railJointSpacing.at(now), crossings);
          for (const u of crossings) {
            this.joints.push({ delay: Math.round(u * frameSamples), strength: gain });
          }
          for (const entry of route.railJoints.crossing(prev, now)) {
            const u = (entry.s - prev) / delta;
            this.joints.push({
              delay: Math.round(u * frameSamples),
              strength: gain * entry.value.strength,
              kind: JOINT_KIND[entry.value.kind],
            });
          }
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
    this.previousTrainPositions.clear();
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
