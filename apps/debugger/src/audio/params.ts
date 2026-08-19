import {
  SILENT_BRIDGE,
  SILENT_CHOPPER,
  SILENT_CROSSING,
  SILENT_INVERTER,
  SILENT_PASSING,
  SILENT_RESISTOR,
  type AlarmParams,
  type BridgeVoiceParams,
  type ChopperVoiceParams,
  type CrossingVoiceParams,
  type HornParams,
  type InverterVoiceParams,
  type NoiseMix,
  type PassingVoiceParams,
  type ResistorVoiceParams,
  type TrainNoiseParams,
} from '@railsim/audio';
import {
  bogieSquealDrive,
  bridgeAcoustics,
  type BodyMotionState,
  type Bridge,
  type BridgeAcoustics,
  type CompiledRoute,
  type CompressorState,
  type ConsistSpec,
  type DoorState,
  type DriveState,
  type RailCondition,
  type TrainDynamics,
} from '@railsim/core';

/**
 * 運転台から音源までの距離による減衰の効き方 [m]。
 * この距離だけ離れると音量が半分になる。
 */
export const DISTANCE_HALF = 25;

/**
 * 隣の線路の音が半分になる距離 [m]。
 *
 * 自分の足元の音（`DISTANCE_HALF` = 25m）より短いのは、床下から構造を伝わって
 * 入ってくる自分の走行音と違い、相手の音は空気だけを伝わってくるからである。
 */
export const OTHER_TRAIN_DISTANCE_HALF = 12;

/**
 * 起動抵抗のうなりを正規化する基準電力 [W]。
 *
 * 抵抗制御では起動直後に電動機の入力とほぼ同じだけの電力を抵抗で熱にしている
 * （だから直列初段の効率は 5 割を切る）。編成の公称出力と同じ桁を基準にしておくと、
 * 起動でうなりが最大、進段するほど下がり、全短絡で消えるという関係になる。
 */
const RESISTOR_GRID_REFERENCE_POWER = 800_000;

/**
 * 左右の空気ばねの間隔の半分 [m]。
 * 台車の幾何で決まる値で、1067mm 軌間の台車なら空気ばねの中心間は 2m 前後。
 * ロール角速度にこの腕の長さを掛けたぶんが、上下速度に加わる。
 */
const AIR_SPRING_HALF_SPACING = 1.0;

/** 鳴っていない状態の報知音・警笛 */
const SILENT_ALARM: AlarmParams = {
  bell: false,
  chime: false,
  patternApproach: false,
  level: 0,
};
const SILENT_HORN: HornParams = { sounding: false, level: 0 };

/**
 * 音を聞く場所。
 *
 * 自列車なら自分の運転台（`lateral` = 0）で、隣の線路の列車を聞くときは同じ
 * 運転台だが線路中心間隔だけ横にずれている。**どの列車の音を作るときも、
 * 距離はここから測る**。これがあるおかげで、自列車と対向列車で同じ計算が使える。
 */
export interface Listener {
  /** 運転台の距離程 [m] */
  readonly position: number;
  /** 軌道中心どうしの横の隔たり [m]（自列車なら 0） */
  readonly lateral: number;
  /** 音量が半分になる距離 [m] */
  readonly halfDistance: number;
}

/** 列車が出す音を決めるのに要る一式 */
export interface TrainSoundInput {
  readonly route: CompiledRoute;
  readonly consist: ConsistSpec;
  readonly railCondition: RailCondition;
  /** 走行状態（対向列車のものは `RemoteTrain` が同じ形で持っている） */
  readonly dynamics: TrainDynamics;
  readonly drive: DriveState;
  readonly doors: DoorState;
  readonly compressor: CompressorState;
  /** ブレーキシリンダ圧 [Pa]（編成平均） */
  readonly cylinderPressure: number;
  /** シミュレーション内の経過時間 [s]（BC 圧の変化率を出す時計） */
  readonly elapsed: number;
  /** 速度の大きさ [m/s] */
  readonly speed: number;
  /** 動いているか（一時停止中は false） */
  readonly running: boolean;
  readonly listener: Listener;
  readonly mix: NoiseMix;
  /**
   * 車体の動揺。空気ばねのきしみは**自分が乗っている車**の台車から床を伝わって
   * 来る音なので、隣の線路の列車については渡さない（渡す値も無い）。
   */
  readonly body?: BodyMotionState;
  /** 踏切の警報音。音源は線路脇に 1 つなので、自列車の側からだけ鳴らす。 */
  readonly crossing?: CrossingVoiceParams;
  /** すれ違いざまの圧力波（自分の車体が受ける力なので自列車の側にしか無い） */
  readonly passing?: PassingVoiceParams;
  /** 保安装置の報知音（運転台の中で鳴るので、相手のものは聞こえない） */
  readonly alarm?: AlarmParams;
  /** 警笛 */
  readonly horn?: HornParams;
}

/** 橋の音の諸元。桁の寸法から決まる値なので、橋ごとに 1 度求めて使い回す。 */
const bridgeCache = new Map<string, BridgeAcoustics>();

function acousticsOf(bridge: Bridge): BridgeAcoustics {
  const cached = bridgeCache.get(bridge.id);
  if (cached) return cached;
  const acoustics = bridgeAcoustics(bridge);
  bridgeCache.set(bridge.id, acoustics);
  return acoustics;
}

/** 0..1 に丸める */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 列車が出す音のパラメータを組み立てる。
 *
 * **自列車と対向列車で同じものを使う。** 音がどう出るかは「誰の列車か」ではなく
 * 装置の状態で決まるので、区別する理由が無い。違うのは聞く場所（`listener`）と、
 * 運転台の中でしか鳴らないもの（報知音）だけである。
 *
 * 進段や戸当たりのように「回数」で渡す音があるため、列車 1 本につき 1 つ持つ
 * （前回の値を覚えている必要がある）。
 */
export class TrainSoundParams {
  /** 進段・組替えのカウンタ（増分を撃力の回数として鳴らす） */
  private lastStepEvents = 0;
  private lastGroupEvents = 0;
  /** 扉の戸当たりのカウンタ */
  private lastLatchEvents = 0;
  private lastOpenEvents = 0;
  private lastCylinder = 0;
  private lastCylinderTime = 0;

  build(input: TrainSoundInput): TrainNoiseParams {
    const { drive, mix, running } = input;
    const speed = running ? Math.abs(input.speed) : 0;

    // 負荷率はどの方式でも「定格に対するトルク比」で表せる。歯車の音はこれで駆動する。
    const load = Math.min(1, Math.abs(drive.torqueRatio));
    // 電動機は M 車の床下にある。この編成は Tc 先頭なので、運転士には
    // 数十メートル後方から聞こえることになる。
    const motorGain = this.motorGain(input);
    // 転動音・風切り・扉・ブレーキは編成のどこからでも来るので、いちばん近い
    // ところで代表する。自列車なら運転台の真下に軸があるので減衰しない。
    const nearGain = this.nearestGain(input);

    // 戸当たりは進段と同じくフレーム精度で足りる（1 回の停車で数回しか鳴らない）。
    const doors = input.doors;
    const doorParams = {
      moving: doors.moving && running,
      closing: doors.closing,
      chiming: doors.chiming && running,
      latches: running ? Math.max(0, doors.latchEvents - this.lastLatchEvents) : 0,
      opens: running ? Math.max(0, doors.openEvents - this.lastOpenEvents) : 0,
      level: nearGain * mix.door,
    };
    this.lastLatchEvents = doors.latchEvents;
    this.lastOpenEvents = doors.openEvents;

    const maxCylinder = input.consist.vehicles[0]?.brake.maxCylinderPressure ?? 400_000;
    const pressureRate = this.cylinderRate(input.cylinderPressure, maxCylinder, input.elapsed);

    return {
      ...this.mainCircuitParams(input, motorGain, load),
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
      rolling: {
        speed,
        // 先頭車の位置で引く。`frontPosition` は距離程の増える向きを前提に
        // しているので、対向列車でも正しく取れる車両中心のほうを使う。
        corrugation: input.route.railCorrugation.at(input.dynamics.vehicles[0]?.s ?? 0),
        level: nearGain * mix.rolling,
      },
      wind: { speed, level: nearGain * mix.wind },
      brake: {
        speed,
        cylinderPressure: input.cylinderPressure / maxCylinder,
        pressureRate: running ? pressureRate : 0,
        level: nearGain * mix.brake,
      },
      auxiliary: {
        compressor: running ? input.compressor.output : 0,
        level: nearGain * mix.auxiliary,
      },
      airSpring: {
        strokeRate: running && input.body ? airSpringStrokeRate(input.body) : 0,
        level: mix.airSpring,
      },
      curveSqueal: {
        drive: running ? this.squealDrive(input) : 0,
        speed,
        level: mix.curveSqueal,
      },
      // 橋は列車ではなく**桁**が鳴っているので、渡っている列車の側から鳴らす。
      // 対向列車が橋の上にいれば、その橋がその列車のぶんだけ鳴る。
      bridge: this.bridgeParams(input, nearGain),
      crossing: input.crossing ?? SILENT_CROSSING,
      passing: input.passing ?? SILENT_PASSING,
      alarm: input.alarm ?? SILENT_ALARM,
      horn: input.horn ?? SILENT_HORN,
    };
  }

  /** シナリオを切り替えたときにカウンタを捨てる */
  reset(): void {
    this.lastStepEvents = 0;
    this.lastGroupEvents = 0;
    this.lastLatchEvents = 0;
    this.lastOpenEvents = 0;
    this.lastCylinder = 0;
    this.lastCylinderTime = 0;
  }

  /**
   * 制御方式に応じて主回路の音源を選ぶ。
   *
   * 鳴らない方式には無音のパラメータを渡す。方式は走行中に変わらないので、
   * 使われない音源は毎フレームそのまま素通りするだけで負荷にならない。
   */
  private mainCircuitParams(
    input: TrainSoundInput,
    motorGain: number,
    load: number,
  ): {
    inverter: InverterVoiceParams;
    resistor: ResistorVoiceParams;
    chopper: ChopperVoiceParams;
  } {
    const { drive, mix, running } = input;
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

  /**
   * 橋りょうの音。
   *
   * 鳴らしているのは桁であって列車ではないので、音量は**桁に乗っている編成の
   * 割合**で決まる。先頭が橋台へ乗った瞬間に鳴り出し、最後部が抜けた瞬間に
   * 止まる。編成より短い橋なら、渡りきるまで音は最大にならない。
   */
  private bridgeParams(input: TrainSoundInput, gain: number): BridgeVoiceParams {
    if (!input.running) return SILENT_BRIDGE;
    const bridges = input.route.bridges;
    const vehicles = input.dynamics.vehicles;
    let covered = 0;
    let bridge: Bridge | undefined;
    for (const veh of vehicles) {
      const found = bridges.at(veh.s);
      if (!found) continue;
      covered++;
      bridge ??= found;
    }
    if (!bridge || vehicles.length === 0) return SILENT_BRIDGE;
    const acoustics = acousticsOf(bridge);
    return {
      speed: Math.abs(input.speed),
      coverage: covered / vehicles.length,
      radiation: acoustics.radiation,
      reflection: acoustics.reflection,
      modes: acoustics.modes,
      weights: acoustics.weights,
      damping: acoustics.damping,
      sleeperSpacing: bridge.sleeperSpacing,
      level: gain * input.mix.bridge,
    };
  }

  /**
   * 編成のうちいちばん強く軋っている台車の駆動の強さ。
   *
   * 判定そのものは `bogieSquealDrive`（コア）にある。ここがやるのは台車の位置を
   * 並べることと、聞く場所からの距離で弱めることだけである。
   *
   * 足し合わせずに最大を取っているのは、軋りが**その 1 つのモードの自励振動**で
   * あって、鳴いている台車が増えても音量が線形に増える種類の音ではないためである。
   */
  private squealDrive(input: TrainSoundInput): number {
    const route = input.route;
    const adhesion = input.consist.adhesion;
    const lateralAt = (s: number): number =>
      route.irregularity.lateralAt(s) + route.turnouts.lateralAt(s);

    let worst = 0;
    for (const veh of input.dynamics.vehicles) {
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
          rail: input.railCondition,
        });
        worst = Math.max(worst, drive * gainAt(input.listener, centre));
      }
    }
    return worst;
  }

  /** 聞く場所から電動機（M 車）までの平均距離による減衰 */
  private motorGain(input: TrainSoundInput): number {
    let sum = 0;
    let count = 0;
    for (const veh of input.dynamics.vehicles) {
      if (!veh.spec.traction) continue;
      sum += veh.s;
      count++;
    }
    if (count === 0) return 0;
    return gainAt(input.listener, sum / count);
  }

  /**
   * 編成のうち聞く場所にいちばん近いところの減衰。
   *
   * 自列車なら運転台の真下にも軸があるので 1 になる（転動音や風切り音に距離
   * 減衰が掛からないのはこのため）。隣の線路の列車なら、線路中心間隔と、
   * 相手の編成のいちばん近い車までの距離で決まる。
   */
  private nearestGain(input: TrainSoundInput): number {
    const listener = input.listener;
    const { lo, hi } = consistExtent(input.dynamics);
    return gainAt(listener, Math.min(hi, Math.max(lo, listener.position)));
  }

  /** BC 圧の変化率（最大圧に対する比 / 秒） */
  private cylinderRate(pressure: number, max: number, now: number): number {
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
}

/**
 * 編成が占める距離程の範囲。
 *
 * `TrainDynamics` の `frontPosition` / `rearPosition` は距離程の増える向きへ
 * 走ることを前提にしているので、対向列車には使えない。走る向きに依らない形で
 * 端を取り直す。
 */
export function consistExtent(dynamics: TrainDynamics): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const veh of dynamics.vehicles) {
    const half = veh.spec.length / 2;
    lo = Math.min(lo, veh.s - half);
    hi = Math.max(hi, veh.s + half);
  }
  return Number.isFinite(lo) ? { lo, hi } : { lo: 0, hi: 0 };
}

/** 聞く場所から距離程 `s` の音源までの減衰 */
export function gainAt(listener: Listener, s: number): number {
  const r = Math.hypot(s - listener.position, listener.lateral);
  return 1 / (1 + r / listener.halfDistance);
}

/**
 * 空気ばねが伸縮する速さ [m/s]。
 *
 * 車体の上下動そのものと、ロールによる左右差の両方が効く。左右の空気ばねは
 * 車体中心から `間隔/2` だけ離れているので、ロール角速度にその腕の長さを
 * 掛けたぶんが上下速度に加わる。大きいほうの側が鳴く。
 */
export function airSpringStrokeRate(body: BodyMotionState): number {
  return Math.abs(body.verticalRate) + AIR_SPRING_HALF_SPACING * Math.abs(body.rollRate);
}
