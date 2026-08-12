import type { VehicleDefinition } from '../schema/vehicle.ts';

/**
 * 音階インバータ（通称「ドレミファインバータ」）の変調諸元。
 *
 * **コアには 1 行も足していない。** インバータの音は
 * 「出力周波数 → キャリア周波数」の折れ線（`asyncCarrier`）と、非同期から同期へ
 * 移るパルスモードの梯子だけで決まる。音階インバータはその折れ線を
 * **平らな段の階段**にしただけのものである。
 *
 * 磁気音の音程を決めているのはキャリア周波数そのものなので、段の高さを平均律の
 * 音名に合わせれば、そのまま音階として聞こえる。ふつうの GTO 車（`inverterSchema` の
 * 既定値）は段が 3 つしかなく、しかも音名とは無関係な 250/350/480Hz なので、
 * 「なんとなく段階的に上がる」だけで音階には聞こえない。違いはそれだけである。
 *
 * 減速時は出力周波数が下がるので、同じ折れ線を逆にたどって**音階が下りていく**。
 * これも作り込んでいるわけではなく、キャリアが出力周波数の関数であることの帰結。
 *
 * 段は 12 段（ソラシド レミファソ ラシドレ）。1 段あたり出力周波数 3.4Hz なので、
 * 非同期モードは 40.8Hz まで続く。既定の GTO 車（18Hz で同期へ移る）よりずっと
 * 高い速度まで階段を上り続けるのは、音階を鳴らし切るのに段数が要るためである。
 *
 * 音名は平均律（A4 = 440Hz）。段の変わり目に 0.4Hz の傾斜を入れてあるので、
 * 音は瞬間的に飛ばずわずかに滑る — 実車もこう聞こえる。
 */
const scaleInverter = {
  polePairs: 2,
  ratedSlipFrequency: 2.0,
  /** 40.8Hz で非同期を抜けたところで変調率が飽和し、一パルスへ入る */
  baseFrequency: 41,
  asyncCarrier: [
    [0.0, 196.0], // ソ (G3)
    [3.0, 196.0],
    [3.4, 220.0], // ラ (A3)
    [6.4, 220.0],
    [6.8, 246.94], // シ (B3)
    [9.8, 246.94],
    [10.2, 261.63], // ド (C4)
    [13.2, 261.63],
    [13.6, 293.66], // レ (D4)
    [16.6, 293.66],
    [17.0, 329.63], // ミ (E4)
    [20.0, 329.63],
    [20.4, 349.23], // ファ (F4)
    [23.4, 349.23],
    [23.8, 392.0], // ソ (G4)
    [26.8, 392.0],
    [27.2, 440.0], // ラ (A4)
    [30.2, 440.0],
    [30.6, 493.88], // シ (B4)
    [33.6, 493.88],
    [34.0, 523.25], // ド (C5)
    [37.0, 523.25],
    [37.4, 587.33], // レ (D5)
    [40.4, 587.33],
  ] as [number, number][],
  /**
   * 階段を鳴らし切るまで非同期のままにし、そのあと一気に同期 → 一パルスへ落とす。
   * 音階が終わったところで音の性格ががらりと変わるのが、この方式の聞きどころ。
   */
  pulseModes: [
    { minFrequency: 0, pulses: 0 },
    { minFrequency: 41, pulses: 5 },
    { minFrequency: 48, pulses: 3 },
    { minFrequency: 55, pulses: 1 },
  ],
  modeHysteresis: 1.5,
  rotorSlots: 44,
  pinionTeeth: 17,
};

/** VVVF 主回路の共通仕様（M 車 2 両とも同じ） */
const motorSpec = {
  kind: 'vvvf' as const,
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  /**
   * 走りは既定の通勤形（`commuter4.ts`）と同じにしてある。
   * 変調だけを入れ替えたときに音がどう変わるかを、そのまま聴き比べられる。
   */
  maxMotorTorque: 1010,
  constantTorqueSpeed: 35,
  constantPowerSpeed: 70,
  maxBrakingMotorTorque: 1100,
  regenFadeStartSpeed: 10,
  regenFadeEndSpeed: 3,
  lineVoltage: 1500,
  converterEfficiency: 0.97,
  inverter: scaleInverter,
};

/** 先頭車の走行抵抗係数 [kgf/t] */
const leadResistance = { a: 1.65, b: 0.0247, c: 0.00078 };
/** 中間車の走行抵抗係数 [kgf/t] */
const middleResistance = { a: 1.65, b: 0.0247, c: 0.00028 };

/**
 * 音階インバータ 通勤形電車 4 両編成（Tc - M - M - Tc）。
 *
 * 走行性能は既定の通勤形（`commuter4Vehicle`）とまったく同じで、**変調の諸元だけが
 * 違う**。引張力は 3 領域のトルク特性で決まっており、変調方式はその同じ出力を
 * どういうスイッチングで作るかという話にすぎないので、走りは 1 ミリも変わらない。
 * 変わるのは音と、HUD の「変調」行の表示だけである。
 *
 * 数値は日本の在来線通勤形電車の代表値であり、実在形式の諸元ではない。
 */
export const commuter4ScaleVehicle: VehicleDefinition = {
  id: 'commuter-4-scale',
  name: '通勤形 4 両編成 音階インバータ (2M2T)',
  maxSpeed: 120,

  cars: [
    {
      id: 'Tc1',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
    {
      id: 'M1',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'M2',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'Tc2',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
  ],

  coupler: {
    slack: 0.01,
    stiffness1: 2.0e6,
    travel1: 0.02,
    stiffness2: 2.0e7,
    damping: 2.0e5,
  },

  adhesion: {
    mu0: 0.33,
    speedCoefficient: 0.008,
    peakCreep: 0.012,
    kineticRatio: 0.6,
    sandingFactor: 1.25,
    creepReferenceSpeed: 1.8,
  },

  traction: {
    notchCount: 4,
    notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
    torqueRiseRate: 2.5,
    torqueFallRate: 4.0,
    loadCompensation: true,
    referenceLoadFactor: 0.5,
    targetAcceleration: 0,
  },

  brake: {
    notchCount: 8,
    maxServiceDeceleration: 3.5,
    emergencyDeceleration: 4.5,
    blending: true,
    loadCompensation: true,
    antiSkid: true,
    antiSkidOnEmergency: true,
    emergencyIsAirOnly: true,
    hasHoldingBrake: true,
  },

  curveResistanceCoefficient: 600,
  tunnelResistanceFactor: 1.6,
};
