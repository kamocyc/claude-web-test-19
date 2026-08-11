import type {
  Kilograms,
  Meters,
  MetersPerSecond,
  MetersPerSecondSquared,
  NewtonMeters,
  Newtons,
  Pascals,
  Seconds,
} from '../units.ts';

/**
 * 走行抵抗の係数。比抵抗 r [N/kg] = a + b*v + c*v^2（v は m/s）。
 * 日本形の慣用式 (kgf/t, km/h) からは `davisFromKgfPerTon()` で変換する。
 */
export interface DavisCoefficients {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** VVVF インバータ制御・誘導電動機の仕様 */
export interface VvvfTractionSpec {
  readonly kind: 'vvvf';
  /** 1 両あたりの主電動機数 */
  readonly motorCount: number;
  /** 歯車比（電動機回転数 / 車軸回転数） */
  readonly gearRatio: number;
  /** 歯車・軸受を含む駆動効率 */
  readonly driveEfficiency: number;
  /** 電動機 1 台あたりの最大トルク [N*m]（定トルク域） */
  readonly maxMotorTorque: NewtonMeters;
  /** 定トルク域の上限速度 [m/s] */
  readonly constantTorqueSpeed: MetersPerSecond;
  /** 定出力域の上限速度 [m/s]。これ以上は特性領域（トルク ∝ 1/v^2）。 */
  readonly constantPowerSpeed: MetersPerSecond;
  /** 電気（回生）ブレーキ時の電動機 1 台あたり最大トルク [N*m] */
  readonly maxBrakingMotorTorque: NewtonMeters;
  /** 回生の絞り込みが始まる速度 [m/s] */
  readonly regenFadeStartSpeed: MetersPerSecond;
  /** 回生が完全に失効する速度 [m/s] */
  readonly regenFadeEndSpeed: MetersPerSecond;
  /** 公称架線電圧 [V] */
  readonly lineVoltage: number;
  /** 主変換装置の効率（電力計算用） */
  readonly converterEfficiency: number;
}

export type VehicleTractionSpec = VvvfTractionSpec;

/** 基礎ブレーキ装置（車両側） */
export interface VehicleBrakeSpec {
  /** 踏面ブレーキ（鋳鉄・レジン制輪子）か、ディスクブレーキか */
  readonly kind: 'tread' | 'disc';
  /**
   * ブレーキシリンダ圧 1 Pa あたりに車輪周で発生する制動力 [N/Pa]。
   * てこ比・シリンダ断面積・基礎ブレーキ倍率・摩擦材の基準 μ を畳み込んだ値。
   */
  readonly forcePerPressure: number;
  /** ブレーキシリンダの最大圧力 [Pa] */
  readonly maxCylinderPressure: Pascals;
  /** 指令から BC 圧が動き始めるまでのむだ時間 [s] */
  readonly deadTime: Seconds;
  /** BC 圧の一次遅れ時定数（込め）[s] */
  readonly fillTimeConstant: Seconds;
  /** BC 圧の一次遅れ時定数（緩め）[s] */
  readonly releaseTimeConstant: Seconds;
  /**
   * 摩擦材の μ の速度依存。[速度 m/s, 基準 μ に対する比] の折れ線。
   * 鋳鉄制輪子は高速で μ が大きく低下し、レジン・ディスクは比較的平坦。
   */
  readonly frictionSpeedCurve: ReadonlyArray<readonly [MetersPerSecond, number]>;
  /** ブレーキが作用する軸の割合（1 = 全軸） */
  readonly brakedAxleRatio: number;
}

/** 粘着特性 */
export interface AdhesionSpec {
  /** 停止時のピーク粘着係数（乾燥レール基準） */
  readonly mu0: number;
  /** 速度依存係数 k [1/(km/h)]。μ_max(V) = mu0 / (1 + k V) */
  readonly speedCoefficient: number;
  /** ピーク粘着を与えるすべり率 */
  readonly peakCreep: number;
  /** 大すべり域の μ / ピーク μ（滑走時の摩擦係数比） */
  readonly kineticRatio: number;
  /** 砂撒き時の粘着係数の倍率 */
  readonly sandingFactor: number;
  /** すべり率の分母に用いる速度の下限 [m/s]（低速での特異点回避） */
  readonly creepReferenceSpeed: MetersPerSecond;
}

/**
 * 車体を支えるばね（枕ばね・軸ばね）の特性。
 * 車体の動揺は各自由度の固有振動数と減衰比で決まるため、
 * ばね定数そのものではなく振動特性としてパラメータ化する。
 */
export interface SuspensionSpec {
  /** ロールの固有振動数 [Hz] */
  readonly rollFrequency: number;
  /** ロールの減衰比 */
  readonly rollDamping: number;
  /**
   * 車体傾斜率（フレキシビリティ係数）。
   * 横加速度によるつり合い角に対して、車体がどれだけ余分に外側へ傾くかの比。
   * 空気ばね車で 0.2〜0.4 程度。大きいほど乗客の感じる横 G が増える。
   */
  readonly rollFlexibility: number;
  /** 上下動の固有振動数 [Hz] */
  readonly bounceFrequency: number;
  /** 上下動の減衰比 */
  readonly bounceDamping: number;
  /** ピッチングの固有振動数 [Hz] */
  readonly pitchFrequency: number;
  /** ピッチングの減衰比 */
  readonly pitchDamping: number;
  /** 前後加速度 1 m/s^2 あたりのピッチ角 [rad] */
  readonly pitchGain: number;
  /** 左右動の固有振動数 [Hz] */
  readonly swayFrequency: number;
  /** 左右動の減衰比 */
  readonly swayDamping: number;
  /** 横加速度 1 m/s^2 あたりの左右変位 [m] */
  readonly swayGain: number;
  /** ヨーイングの固有振動数 [Hz] */
  readonly yawFrequency: number;
  /** ヨーイングの減衰比 */
  readonly yawDamping: number;
}

/** 空気ばね付き通勤形電車の代表的な動揺特性 */
export const DEFAULT_SUSPENSION: SuspensionSpec = {
  rollFrequency: 0.85,
  rollDamping: 0.22,
  rollFlexibility: 0.3,
  bounceFrequency: 1.2,
  bounceDamping: 0.28,
  pitchFrequency: 1.35,
  pitchDamping: 0.32,
  pitchGain: 0.006,
  swayFrequency: 1.0,
  swayDamping: 0.24,
  swayGain: 0.012,
  yawFrequency: 1.5,
  yawDamping: 0.3,
};

/**
 * 乗客の振られ方（車内に吊るした減衰振り子）の仕様。
 *
 * 吊り革は天井の握り棒からリングまで 0.5〜0.7m 程度、固有周期は
 * `T = 2π√(L/g)` で 1.4〜1.7 秒。立っている乗客も重心高さがおよそ 1m なので
 * 同じ帯域になる。減衰比は「すぐには収まらないが振動し続けもしない」値にする。
 */
export interface PassengerSpec {
  /** 振り子の長さ [m] */
  readonly pendulumLength: Meters;
  /** 減衰比（0 = 減衰なし、1 = 臨界減衰） */
  readonly dampingRatio: number;
}

export const DEFAULT_PASSENGER: PassengerSpec = {
  pendulumLength: 0.6,
  dampingRatio: 0.45,
};

/** 連結器（緩衝器を含む）の仕様 */
export interface CouplerSpec {
  /** 遊間の全幅 [m]。この範囲では力を伝えない。 */
  readonly slack: Meters;
  /** 1 段目のばね定数 [N/m] */
  readonly stiffness1: number;
  /** 1 段目が受け持つ変位 [m]。これを超えると 2 段目の剛性になる。 */
  readonly travel1: Meters;
  /** 2 段目のばね定数 [N/m] */
  readonly stiffness2: number;
  /** 緩衝器の減衰係数 [N/(m/s)] */
  readonly damping: number;
  /** 伝達力の上限 [N]（省略時は無制限） */
  readonly maxForce?: Newtons;
}

/** 1 両の仕様 */
export interface VehicleSpec {
  readonly id: string;
  /** 自重 [kg] */
  readonly tareMass: Kilograms;
  /** 乗車率 100% における積載質量 [kg] */
  readonly fullLoadMass: Kilograms;
  /** 連結面間距離 [m] */
  readonly length: Meters;
  /** 台車中心間距離 [m] */
  readonly bogieSpacing: Meters;
  /** 固定軸距（台車内の軸間距離）[m] */
  readonly bogieWheelbase: Meters;
  /** 軸数（通常 4） */
  readonly axleCount: number;
  /** 動軸数（0 なら付随車） */
  readonly drivenAxleCount: number;
  /** 車輪径 [m] */
  readonly wheelDiameter: Meters;
  /**
   * 回転部慣性の等価質量係数 γ。等価質量 = m (1 + γ)。
   * 各軸の回転慣性 J は J = γ m r^2 / 軸数 として逆算される。
   */
  readonly rotatingMassFactor: number;
  /** 走行抵抗係数 */
  readonly runningResistance: DavisCoefficients;
  /** 重心高さ（レール面から）[m] */
  readonly centerOfGravityHeight: Meters;
  /** 牽引装置の高さ（レール面から）[m] */
  readonly tractionLinkHeight: Meters;
  /** 基礎ブレーキ装置 */
  readonly brake: VehicleBrakeSpec;
  /** 動力装置（付随車は null） */
  readonly traction: VehicleTractionSpec | null;
  /** 車体を支えるばねの動揺特性 */
  readonly suspension: SuspensionSpec;
  /** 乗客（吊り革）の振られ方 */
  readonly passenger: PassengerSpec;
}

/** 力行制御（編成としての取り扱い） */
export interface TractionControlSpec {
  /** 力行ノッチ数 */
  readonly notchCount: number;
  /** 各ノッチのトルク指令率（要素数 = notchCount、0 < r <= 1） */
  readonly notchTorqueRatio: readonly number[];
  /** トルク指令の立ち上がり速度 [1/s]（最大トルクに対する割合／秒） */
  readonly torqueRiseRate: number;
  /** トルク指令の立ち下がり速度 [1/s] */
  readonly torqueFallRate: number;
  /** 応荷重制御（乗車率に応じて引張力を補正し、加速度を一定に保つ） */
  readonly loadCompensation: boolean;
  /** 応荷重制御の基準乗車率（この乗車率で公称性能となる） */
  readonly referenceLoadFactor: number;
  /** 定加速度制御の目標加速度 [m/s^2]（0 以下で無効） */
  readonly targetAcceleration: MetersPerSecondSquared;
}

/** ブレーキ制御（編成としての取り扱い） */
export interface BrakeControlSpec {
  /** 常用ブレーキのノッチ数 */
  readonly notchCount: number;
  /** 常用最大ノッチの減速度 [m/s^2] */
  readonly maxServiceDeceleration: MetersPerSecondSquared;
  /** 非常ブレーキの減速度 [m/s^2] */
  readonly emergencyDeceleration: MetersPerSecondSquared;
  /** 各ノッチの減速度 [m/s^2]（省略時は最大減速度をノッチ数で等分） */
  readonly notchDeceleration?: readonly MetersPerSecondSquared[];
  /** 電空協調（回生優先で空気ブレーキが不足分を補う） */
  readonly blending: boolean;
  /** 応荷重制御 */
  readonly loadCompensation: boolean;
  /** 滑走防止装置 */
  readonly antiSkid: boolean;
  /** 非常ブレーキでも滑走防止を働かせるか */
  readonly antiSkidOnEmergency: boolean;
  /** 非常ブレーキで電気ブレーキを併用しない（純空気とする） */
  readonly emergencyIsAirOnly: boolean;
  /** 抑速ブレーキ（電気ブレーキによる勾配抑速）を持つか */
  readonly hasHoldingBrake: boolean;
}

/** レール踏面の状態 */
export type RailCondition = 'dry' | 'wet' | 'leaves' | 'snow';

/** 編成全体の仕様 */
export interface ConsistSpec {
  readonly id: string;
  readonly name: string;
  readonly vehicles: readonly VehicleSpec[];
  readonly coupler: CouplerSpec;
  readonly adhesion: AdhesionSpec;
  readonly traction: TractionControlSpec;
  readonly brake: BrakeControlSpec;
  /** 設計最高速度 [m/s] */
  readonly maxSpeed: MetersPerSecond;
  /**
   * 曲線抵抗係数 f [N/kg * m]。比抵抗 r_c = f / R。
   * 慣用式の 600/R（狭軌, kgf/t）などから `kgfPerTonToNPerKg` で変換した値を入れる。
   */
  readonly curveResistanceCoefficient: number;
  /** トンネル内で走行抵抗の速度 2 乗項に掛かる倍率 */
  readonly tunnelResistanceFactor: number;
}

/** 編成の総自重 [kg] */
export function tareMassOf(consist: ConsistSpec): Kilograms {
  return consist.vehicles.reduce((a, v) => a + v.tareMass, 0);
}

/** 乗車率 loadFactor における 1 両の質量 [kg] */
export function vehicleMass(v: VehicleSpec, loadFactor: number): Kilograms {
  return v.tareMass + v.fullLoadMass * loadFactor;
}

/** 乗車率 loadFactor における編成の総質量 [kg] */
export function consistMass(consist: ConsistSpec, loadFactor: number): Kilograms {
  return consist.vehicles.reduce((a, v) => a + vehicleMass(v, loadFactor), 0);
}

/** 編成長 [m] */
export function consistLength(consist: ConsistSpec): Meters {
  return consist.vehicles.reduce((a, v) => a + v.length, 0);
}

/**
 * 1 軸あたりの回転慣性 [kg*m^2]。
 *
 * 回転部（車輪・車軸・歯車・電動機回転子）の慣性は乗客の増減で変わらないため、
 * 等価質量係数 γ は**自重**に対して定義されているものとして J = γ m_tare r^2 / 軸数 とする。
 * これにより等価質量は m_total + γ m_tare となり、満車時に加速度が落ちる挙動が正しく出る。
 */
export function axleInertia(v: VehicleSpec): number {
  const r = v.wheelDiameter / 2;
  return (v.rotatingMassFactor * v.tareMass * r * r) / v.axleCount;
}
