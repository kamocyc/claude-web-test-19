import {
  DEFAULT_NOISE_MIX,
  SILENT_CROSSING,
  SILENT_PASSING,
  VOICE_COUNT,
  type CrossingVoiceParams,
  type JointImpact,
  type JointImpactKind,
  type NoiseMix,
  type PassingVoiceParams,
  type RemoteTrainParams,
  type TrainNoiseParams,
  type TurnoutImpact,
} from '@railsim/audio';
import {
  axleOffsets,
  bridgeAcoustics,
  jointCrossings,
  type Bridge,
  type BridgeAcoustics,
  type CompiledRoute,
  type RailJointKind,
  type RemoteTrain,
  type Simulation,
  type TrainDynamics,
} from '@railsim/core';
import {
  DISTANCE_HALF,
  OTHER_TRAIN_DISTANCE_HALF,
  TrainSoundParams,
  consistExtent,
  gainAt,
  type Listener,
} from './params.ts';
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
 * 隣の線路の列車の音が届く範囲 [m]。
 * これより遠ければ自分の走行音に埋もれて聞こえない。
 */
const AUDIBLE_RANGE = 400;

/** 線路中心間隔が取れないときの既定値 [m]（在来線の標準） */
const DEFAULT_SEPARATION = 3.4;

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

/** いちばん近いダイヤ列車と、そこまでの位置関係 */
interface NearestRemote {
  readonly id: string;
  readonly train: RemoteTrain;
  /** 線路中心間隔 [m]（同じ線路の先行列車なら 0） */
  readonly lateral: number;
  /** 運転台から相手の編成のいちばん近いところまでの距離 [m] */
  readonly distance: number;
}

/**
 * 走行音の出力。
 *
 * 合成そのものは `@railsim/audio` の素のクラスが AudioWorklet の中で行う。
 * ここはその配線と、シミュレーションの状態から合成パラメータへの写像だけを持つ。
 *
 * 写像そのものは `TrainSoundParams`（`params.ts`）にあり、**自列車にも対向列車にも
 * 同じものを使う**。音の出方は「誰の列車か」ではなく装置の状態で決まるので、
 * 区別する理由が無い。違うのは聞く場所（`Listener`）と、運転台の中でしか鳴らない
 * ものだけである。
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

  /** 自列車と対向列車のパラメータ組み立て（同じ実装を 1 つずつ持つ） */
  private readonly ownParams = new TrainSoundParams();
  private remoteParams = new TrainSoundParams();
  /** いま鳴らしているダイヤ列車の id（変わったら合成器を捨てる） */
  private remoteId: string | null = null;

  /** 各車両の前フレームでの距離程（継目・分岐器の跨ぎ判定に使う） */
  private readonly ownPositions: number[] = [];
  private readonly remotePositions: number[] = [];
  private readonly joints: JointImpact[] = [];
  private readonly turnouts: TurnoutImpact[] = [];
  private readonly remoteJoints: JointImpact[] = [];
  private readonly remoteTurnouts: TurnoutImpact[] = [];
  /** 橋りょうの音の諸元（桁の寸法から決まるので、橋ごとに 1 度求めれば足りる） */
  private readonly bridgeCache = new Map<string, BridgeAcoustics>();

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
    const cab = sim.dynamics.frontPosition;

    const listener: Listener = { position: cab, lateral: 0, halfDistance: DISTANCE_HALF };
    const params: TrainNoiseParams = this.ownParams.build({
      route: sim.scenario.route,
      consist: sim.scenario.consist,
      railCondition: sim.scenario.railCondition,
      dynamics: sim.dynamics,
      drive: snap.drive,
      doors: snap.doors,
      compressor: snap.compressor,
      cylinderPressure: snap.cylinderPressure,
      elapsed: sim.elapsed,
      speed: snap.speed,
      running,
      listener,
      mix: this.mixValues,
      body: snap.body,
      crossing: this.crossingParams(snap, running),
      passing: this.passingParams(snap, running),
      // 保安装置の報知音と警笛は運転台の中で鳴るので、距離減衰も走行音による
      // マスクも受けない。運転士に届かなければ意味が無い装置だからである。
      alarm: {
        bell: snap.safety.indication.bell,
        chime: snap.safety.indication.chime,
        patternApproach: snap.safety.indication.patternApproach,
        level: this.mixValues.alarm,
      },
      horn: { sounding: sim.input.horn, level: this.mixValues.horn },
    });

    const nearest = running ? this.nearestRemote(sim, cab) : null;
    const reset = this.syncRemote(nearest);
    const remote = this.remoteMessage(sim, nearest, cab, running);

    this.joints.length = 0;
    this.turnouts.length = 0;
    this.remoteJoints.length = 0;
    this.remoteTurnouts.length = 0;
    if (running) {
      this.collectImpacts(sim, nearest, cab, wall);
    } else {
      this.syncPositions(sim.dynamics, this.ownPositions);
    }

    worklet.port.postMessage({
      params,
      remote,
      ...(reset ? { resetRemote: true } : {}),
      ...(this.joints.length > 0 ? { joints: this.joints } : {}),
      ...(this.turnouts.length > 0 ? { turnouts: this.turnouts } : {}),
      ...(this.remoteJoints.length > 0 ? { remoteJoints: this.remoteJoints } : {}),
      ...(this.remoteTurnouts.length > 0 ? { remoteTurnouts: this.remoteTurnouts } : {}),
    });
    this.updateTunnel(sim);
  }

  /**
   * いま鳴らすべきダイヤ列車。
   *
   * 合成器は 1 本ぶんしか持たないので、いちばん近い列車を選ぶ。同じ線路の
   * 先行列車も対象で、隣の線路かどうかは横の隔たり（`lateral`）の違いにすぎない。
   */
  private nearestRemote(sim: Simulation, cab: number): NearestRemote | null {
    if (sim.remoteTrains.size === 0) return null;
    const adjacent = sim.scenario.route.adjacentTrack;
    let best: NearestRemote | null = null;
    for (const state of sim.signalling.trainStates) {
      const train = sim.remoteTrains.get(state.train.id);
      if (!train) continue;
      const lateral =
        (state.train.track ?? 'own') === 'adjacent'
          ? Math.abs(adjacent.offsetAt(state.leadPosition)) || DEFAULT_SEPARATION
          : 0;
      const distance = Math.hypot(nearestOffset(train.dynamics, cab), lateral);
      if (distance > AUDIBLE_RANGE) continue;
      if (!best || distance < best.distance) {
        best = { id: state.train.id, train, lateral, distance };
      }
    }
    return best;
  }

  /** 鳴らす相手が変わったら、前の列車の音を引きずらないよう作り直す */
  private syncRemote(nearest: NearestRemote | null): boolean {
    const id = nearest?.id ?? null;
    if (id === this.remoteId) return false;
    this.remoteId = id;
    this.remoteParams = new TrainSoundParams();
    this.remotePositions.length = 0;
    return true;
  }

  /**
   * 隣の線路（あるいは前方）を走る列車の音。
   *
   * 渡すのは**自列車とまったく同じ形のパラメータ**である。相手の装置は
   * `RemoteTrain` が自列車と同じ実装で回しているので、力行していればゲートの
   * 開いた音が、ブレーキを掛けていれば空気の音が、そのまま出てくる。
   *
   * 運転台の中で鳴る報知音だけは渡さない。あれは相手の運転士のための音であって、
   * こちらに届く経路が無い。警笛は逆に外へ向けて鳴らす装置なので渡す。
   */
  private remoteMessage(
    sim: Simulation,
    nearest: NearestRemote | null,
    cab: number,
    running: boolean,
  ): RemoteTrainParams | null {
    if (!nearest || !running) return null;
    const train = nearest.train;
    const listener: Listener = {
      position: cab,
      lateral: nearest.lateral,
      halfDistance: OTHER_TRAIN_DISTANCE_HALF,
    };
    return {
      present: true,
      train: this.remoteParams.build({
        route: sim.scenario.route,
        consist: sim.scenario.consist,
        railCondition: sim.scenario.railCondition,
        dynamics: train.dynamics,
        drive: train.traction.driveState,
        doors: train.doors.state,
        compressor: train.compressor.state,
        cylinderPressure: train.brake.averageCylinderPressure(),
        elapsed: sim.elapsed,
        speed: train.speed,
        running,
        listener,
        mix: this.mixValues,
        horn: { sounding: train.horn, level: this.mixValues.horn },
      }),
      distance: nearest.distance,
      level: this.mixValues.passing,
    };
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
   * すれ違いざまの圧力波。
   *
   * 相手の走行音そのものは `remoteMessage()` の側から出るので、ここに残っているのは
   * **音として伝わってくるのではない**成分だけである（相手が押しのけた空気が
   * 自分の車体を直接叩く力）。
   */
  private passingParams(
    snap: ReturnType<Simulation['snapshot']>,
    running: boolean,
  ): PassingVoiceParams {
    const passing = snap.passing;
    if (!passing || !running) return SILENT_PASSING;
    return {
      present: true,
      headGap: passing.headGap,
      tailGap: passing.tailGap,
      closingSpeed: passing.closingSpeed,
      separation: passing.lateralSeparation,
      level: this.mixValues.passing,
    };
  }

  /**
   * この描画フレームのあいだに各軸が踏んだ継目・分岐器・踏切板を集める。
   *
   * 自列車と対向列車で同じ手続きを使う（`collectTrainImpacts`）。継目は**線路の
   * 側にあるもの**なので、誰の軸が踏んでも同じ継目が同じように鳴る。違うのは
   * 鳴った音がどこから届くかだけで、それは音源の側（`RemoteTrainVoice`）が
   * 遅れと遮音として受け持つ。
   */
  private collectImpacts(
    sim: Simulation,
    nearest: NearestRemote | null,
    cab: number,
    wall: number,
  ): void {
    const context = this.context;
    if (!context || wall <= 0) return;
    const frameSamples = wall * context.sampleRate;
    const route = sim.scenario.route;

    this.collectTrainImpacts(
      route,
      sim.dynamics,
      this.ownPositions,
      { position: cab, lateral: 0, halfDistance: DISTANCE_HALF },
      frameSamples,
      this.joints,
      this.turnouts,
    );

    if (!nearest) {
      this.remotePositions.length = 0;
      return;
    }
    this.collectTrainImpacts(
      route,
      nearest.train.dynamics,
      this.remotePositions,
      { position: cab, lateral: nearest.lateral, halfDistance: OTHER_TRAIN_DISTANCE_HALF },
      frameSamples,
      this.remoteJoints,
      this.remoteTurnouts,
    );
  }

  /**
   * 1 本の列車が踏んだ継目・分岐器・踏切板を集める。
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
   *
   * 距離程の減る向きへ走っていても（対向列車）そのまま動く。跨ぎの判定は
   * 前の位置と今の位置の区間で行っており、向きに依らないためである。
   */
  private collectTrainImpacts(
    route: CompiledRoute,
    dynamics: TrainDynamics,
    previous: number[],
    listener: Listener,
    frameSamples: number,
    joints: JointImpact[],
    turnouts: TurnoutImpact[],
  ): void {
    const vehicles = dynamics.vehicles;
    const speed = Math.abs(dynamics.speed);
    if (speed < 0.3 || previous.length !== vehicles.length) {
      this.syncPositions(dynamics, previous);
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
      const dCentre = veh.s - previous[i]!;
      previous[i] = veh.s;
      // 遠い車の音ほど弱く聞こえる。自列車なら運転台の真下が 1 になる。
      const distance = gainAt(listener, veh.s);
      for (const offset of offsets) {
        const now = veh.s + offset;
        const prev = now - dCentre;
        const spacing = route.railJointSpacing.at(now);
        jointCrossings(prev, now, spacing, crossings);
        for (const u of crossings) {
          joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance,
            kind: 'standard',
          });
        }
        if (dCentre === 0) continue;
        // 個別に置かれた継目（絶縁継目・伸縮継目）
        for (const entry of route.railJoints.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance * entry.value.strength,
            kind: JOINT_KIND[entry.value.kind],
          });
        }
        // 踏切道の入口と出口（舗装と踏切板の目地）
        for (const entry of route.levelCrossings.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          joints.push({
            delay: Math.round(u * frameSamples),
            strength: jointStrength * distance * entry.value.strength,
            kind: 'panel',
          });
        }
        if (route.turnouts.length === 0) continue;
        for (const entry of route.turnouts.crossing(prev, now)) {
          const u = (entry.s - prev) / dCentre;
          turnouts.push({
            delay: Math.round(u * frameSamples),
            strength: turnoutStrength * distance * entry.value.strength,
            crossing: entry.value.kind === 'crossing',
          });
        }
      }
    }
  }

  private readonly offsetScratch: number[] = [];

  private syncPositions(dynamics: TrainDynamics, out: number[]): void {
    const vehicles = dynamics.vehicles;
    out.length = vehicles.length;
    for (let i = 0; i < vehicles.length; i++) out[i] = vehicles[i]!.s;
  }

  /** シナリオを切り替えたときに合成器の内部状態を捨てる */
  reset(): void {
    this.ownPositions.length = 0;
    this.remotePositions.length = 0;
    this.remoteId = null;
    this.ownParams.reset();
    this.remoteParams = new TrainSoundParams();
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

/** 編成のいちばん近いところと `s` との距離程の差 [m] */
function nearestOffset(dynamics: TrainDynamics, s: number): number {
  const { lo, hi } = consistExtent(dynamics);
  if (s < lo) return lo - s;
  if (s > hi) return s - hi;
  return 0;
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
