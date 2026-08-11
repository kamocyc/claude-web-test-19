import { z } from 'zod';

/**
 * 車両データのスキーマ。
 * 質量は t、速度は km/h、減速度は km/h/s、圧力は kPa、走行抵抗は kgf/t で書く。
 */

export const davisSchema = z.object({
  /** 速度に依らない項 [kgf/t] */
  a: z.number().default(1.65),
  /** 速度比例項 [kgf/t / (km/h)] */
  b: z.number().default(0.0247),
  /** 速度 2 乗項 [kgf/t / (km/h)^2] */
  c: z.number().default(0.00028),
});

/**
 * 変調方式と、電動機・駆動装置の音に関わる諸元。
 *
 * 引張力には一切影響しない（引張力は 3 領域のトルク特性で決まる）。ここは
 * 「その出力をどういうスイッチングで作るか」だけを持つ。既定値は GTO
 * サイリスタ素子の通勤形で、キャリアが低く、パルスモードの切り替わりが
 * 音程の段差としてはっきり聞こえる。IGBT にするならキャリアの表を高く平坦に、
 * 音階インバータにするなら階段状にすればよい。
 */
export const inverterSchema = z.object({
  /** 極対数（4 極機なら 2） */
  polePairs: z.number().int().positive().default(2),
  /** 定格トルクでのすべり周波数 [Hz] */
  ratedSlipFrequency: z.number().positive().default(2.0),
  /** 基底周波数 [Hz]。ここで変調率が 1 に飽和し、以降は弱め界磁になる。 */
  baseFrequency: z.number().positive().default(53),
  /** 非同期モードのキャリア [出力周波数 Hz, キャリア Hz] の折れ線 */
  asyncCarrier: z
    .array(z.tuple([z.number(), z.number()]))
    .default([
      [0, 250],
      [6, 250],
      [7, 350],
      [12, 350],
      [13, 480],
      [18, 480],
    ]),
  /** パルスモードの梯子（出力周波数の昇順。pulses = 0 が非同期、1 が一パルス） */
  pulseModes: z
    .array(z.object({ minFrequency: z.number().nonnegative(), pulses: z.number().int().min(0) }))
    .default([
      { minFrequency: 0, pulses: 0 },
      { minFrequency: 18, pulses: 15 },
      { minFrequency: 28, pulses: 9 },
      { minFrequency: 38, pulses: 5 },
      { minFrequency: 47, pulses: 3 },
      { minFrequency: 53, pulses: 1 },
    ]),
  /** モード切替のヒステリシス幅 [Hz] */
  modeHysteresis: z.number().nonnegative().default(1.5),
  /** 回転子スロット数 */
  rotorSlots: z.number().int().positive().default(44),
  /** 小歯車の歯数 */
  pinionTeeth: z.number().int().positive().default(17),
});

export const vvvfSchema = z.object({
  kind: z.literal('vvvf').default('vvvf'),
  /** 1 両あたりの主電動機数 */
  motorCount: z.number().int().positive().default(4),
  /** 歯車比 */
  gearRatio: z.number().positive().default(7.07),
  /** 駆動効率 */
  driveEfficiency: z.number().positive().max(1).default(0.97),
  /** 電動機 1 台あたりの最大トルク [N*m] */
  maxMotorTorque: z.number().positive(),
  /** 定トルク域の上限速度 [km/h] */
  constantTorqueSpeed: z.number().positive().default(35),
  /** 定出力域の上限速度 [km/h] */
  constantPowerSpeed: z.number().positive().default(70),
  /** 電気ブレーキ時の電動機 1 台あたり最大トルク [N*m] */
  maxBrakingMotorTorque: z.number().positive(),
  /** 回生の絞り込みが始まる速度 [km/h] */
  regenFadeStartSpeed: z.number().nonnegative().default(10),
  /** 回生が完全に失効する速度 [km/h] */
  regenFadeEndSpeed: z.number().nonnegative().default(3),
  /** 公称架線電圧 [V] */
  lineVoltage: z.number().positive().default(1500),
  /** 主変換装置の効率 */
  converterEfficiency: z.number().positive().max(1).default(0.97),
  /** 変調方式と音に関わる諸元 */
  inverter: inverterSchema.default({}),
});

export const vehicleBrakeSchema = z.object({
  kind: z.enum(['tread', 'disc']).default('disc'),
  /** BC 圧 1 kPa あたりに車輪周で発生する制動力 [kN/(100kPa)] 相当の係数 [N/Pa] */
  forcePerPressure: z.number().positive().default(0.15),
  /** 最大 BC 圧 [kPa] */
  maxCylinderPressure: z.number().positive().default(400),
  /** むだ時間 [s] */
  deadTime: z.number().nonnegative().default(0.3),
  /** BC 圧の込め時定数 [s] */
  fillTimeConstant: z.number().positive().default(0.6),
  /** BC 圧の緩め時定数 [s] */
  releaseTimeConstant: z.number().positive().default(0.5),
  /**
   * 摩擦材の μ の速度依存。[速度 km/h, 基準 μ に対する比] の折れ線。
   * 鋳鉄制輪子は高速で大きく低下するため、踏面ブレーキ車では傾きを強くする。
   */
  frictionSpeedCurve: z.array(z.tuple([z.number(), z.number()])).default([
    [0, 1.05],
    [30, 1.0],
    [80, 0.95],
    [120, 0.9],
  ]),
  /** ブレーキが作用する軸の割合 */
  brakedAxleRatio: z.number().min(0).max(1).default(1),
});

export const suspensionSchema = z.object({
  /** ロールの固有振動数 [Hz] */
  rollFrequency: z.number().positive().default(0.85),
  /** ロールの減衰比 */
  rollDamping: z.number().positive().default(0.22),
  /** 車体傾斜率（フレキシビリティ係数）。大きいほど乗客の感じる横 G が増える。 */
  rollFlexibility: z.number().nonnegative().default(0.3),
  /** 上下動の固有振動数 [Hz] */
  bounceFrequency: z.number().positive().default(1.2),
  bounceDamping: z.number().positive().default(0.28),
  /** ピッチングの固有振動数 [Hz] */
  pitchFrequency: z.number().positive().default(1.35),
  pitchDamping: z.number().positive().default(0.32),
  /** 前後加速度 1 m/s^2 あたりのピッチ角 [rad] */
  pitchGain: z.number().nonnegative().default(0.006),
  /** 左右動の固有振動数 [Hz] */
  swayFrequency: z.number().positive().default(1.0),
  swayDamping: z.number().positive().default(0.24),
  /** 横加速度 1 m/s^2 あたりの左右変位 [m] */
  swayGain: z.number().nonnegative().default(0.012),
  /** ヨーイングの固有振動数 [Hz] */
  yawFrequency: z.number().positive().default(1.5),
  yawDamping: z.number().positive().default(0.3),
});

/** 乗客（吊り革）の振られ方 */
export const passengerSchema = z.object({
  /** 振り子の長さ [m]。固有周期 T = 2π√(L/g) が 1.4〜1.7 秒になる 0.5〜0.7m 程度。 */
  pendulumLength: z.number().positive().default(0.6),
  /** 減衰比（0 = 減衰なし、1 = 臨界減衰） */
  dampingRatio: z.number().positive().default(0.45),
});

export const carSchema = z.object({
  id: z.string(),
  /** 車種（表示用）。Mc/Tc は先頭車。 */
  type: z.enum(['M', 'T', 'Mc', 'Tc']).default('T'),
  /** 自重 [t] */
  tareMass: z.number().positive(),
  /** 乗車率 100% における積載質量 [t] */
  fullLoadMass: z.number().nonnegative().default(9),
  /** 連結面間距離 [m] */
  length: z.number().positive().default(20),
  /** 台車中心間距離 [m] */
  bogieSpacing: z.number().positive().default(13.8),
  /** 固定軸距 [m] */
  bogieWheelbase: z.number().positive().default(2.1),
  /** 軸数 */
  axleCount: z.number().int().positive().default(4),
  /** 動軸数 */
  drivenAxleCount: z.number().int().nonnegative().default(0),
  /** 車輪径 [m] */
  wheelDiameter: z.number().positive().default(0.86),
  /** 回転部慣性の等価質量係数 γ */
  rotatingMassFactor: z.number().nonnegative().default(0.05),
  /** 走行抵抗 [kgf/t] */
  resistance: davisSchema.default({}),
  /** 重心高さ [m] */
  centerOfGravityHeight: z.number().positive().default(1.8),
  /** 牽引装置高さ [m] */
  tractionLinkHeight: z.number().positive().default(0.6),
  brake: vehicleBrakeSchema.default({}),
  traction: vvvfSchema.nullable().default(null),
  /** 車体を支えるばねの動揺特性 */
  suspension: suspensionSchema.default({}),
  /** 乗客（吊り革）の振られ方 */
  passenger: passengerSchema.default({}),
});

export const couplerSchema = z.object({
  /** 遊間の全幅 [m] */
  slack: z.number().nonnegative().default(0.01),
  /** 1 段目のばね定数 [N/m] */
  stiffness1: z.number().positive().default(2.0e6),
  /** 1 段目が受け持つ変位 [m] */
  travel1: z.number().positive().default(0.02),
  /** 2 段目のばね定数 [N/m] */
  stiffness2: z.number().positive().default(2.0e7),
  /** 緩衝器の減衰係数 [N/(m/s)] */
  damping: z.number().nonnegative().default(2.0e5),
  /** 伝達力の上限 [kN] */
  maxForce: z.number().positive().optional(),
});

export const adhesionSchema = z.object({
  /** 停止時のピーク粘着係数（乾燥レール） */
  mu0: z.number().positive().default(0.33),
  /** 速度依存係数 [1/(km/h)] */
  speedCoefficient: z.number().nonnegative().default(0.008),
  /** ピーク粘着を与えるすべり率 */
  peakCreep: z.number().positive().default(0.012),
  /** 滑走摩擦係数比 */
  kineticRatio: z.number().positive().max(1).default(0.6),
  /** 砂撒き時の倍率 */
  sandingFactor: z.number().min(1).default(1.25),
  /** すべり率の基準速度 [km/h] */
  creepReferenceSpeed: z.number().positive().default(1.8),
});

export const tractionControlSchema = z.object({
  /** 力行ノッチ数 */
  notchCount: z.number().int().positive().default(4),
  /** 各ノッチのトルク指令率 */
  notchTorqueRatio: z.array(z.number().positive().max(1)).default([0.25, 0.5, 0.75, 1.0]),
  /** トルク指令の立ち上がり速度 [1/s] */
  torqueRiseRate: z.number().positive().default(2.5),
  /** トルク指令の立ち下がり速度 [1/s] */
  torqueFallRate: z.number().positive().default(4.0),
  /** 応荷重制御 */
  loadCompensation: z.boolean().default(true),
  /** 応荷重制御の基準乗車率 */
  referenceLoadFactor: z.number().min(0).default(0.5),
  /** 定加速度制御の目標加速度 [km/h/s]（0 で無効） */
  targetAcceleration: z.number().nonnegative().default(0),
});

export const brakeControlSchema = z.object({
  /** 常用ブレーキのノッチ数 */
  notchCount: z.number().int().positive().default(8),
  /** 常用最大の減速度 [km/h/s] */
  maxServiceDeceleration: z.number().positive().default(3.5),
  /** 非常ブレーキの減速度 [km/h/s] */
  emergencyDeceleration: z.number().positive().default(4.5),
  /** ノッチごとの減速度 [km/h/s]（省略時は等分） */
  notchDeceleration: z.array(z.number().nonnegative()).optional(),
  blending: z.boolean().default(true),
  loadCompensation: z.boolean().default(true),
  antiSkid: z.boolean().default(true),
  antiSkidOnEmergency: z.boolean().default(true),
  /** 非常ブレーキで電気ブレーキを併用しない */
  emergencyIsAirOnly: z.boolean().default(true),
  hasHoldingBrake: z.boolean().default(true),
});

export const vehicleSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 設計最高速度 [km/h] */
  maxSpeed: z.number().positive(),
  cars: z.array(carSchema).min(1),
  coupler: couplerSchema.default({}),
  adhesion: adhesionSchema.default({}),
  traction: tractionControlSchema.default({}),
  brake: brakeControlSchema.default({}),
  /** 曲線抵抗係数 f [kgf/t·m]（比抵抗 = f / R）。狭軌 600、標準軌 800 が目安。 */
  curveResistanceCoefficient: z.number().nonnegative().default(600),
  /** トンネル内で走行抵抗の速度 2 乗項に掛かる倍率 */
  tunnelResistanceFactor: z.number().min(1).default(1.6),
});

export type VehicleDefinition = z.input<typeof vehicleSchema>;
export type ParsedVehicle = z.output<typeof vehicleSchema>;
