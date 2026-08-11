import {
  buildAlignment,
  kmhToMps,
  type AdhesionSpec,
  type Alignment,
  type BrakeControlSpec,
  DEFAULT_SUSPENSION,
  type ConsistSpec,
  type CouplerSpec,
  type DavisCoefficients,
  type TractionControlSpec,
  type VehicleBrakeSpec,
  type VehicleSpec,
  type VvvfTractionSpec,
} from '@railsim/core';

/** 抵抗ゼロの係数（解析解との突き合わせ用） */
export const NO_RESISTANCE: DavisCoefficients = { a: 0, b: 0, c: 0 };

export const TEST_TRACTION: VvvfTractionSpec = {
  kind: 'vvvf',
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  maxMotorTorque: 1200,
  constantTorqueSpeed: kmhToMps(35),
  constantPowerSpeed: kmhToMps(70),
  maxBrakingMotorTorque: 1200,
  regenFadeStartSpeed: kmhToMps(10),
  regenFadeEndSpeed: kmhToMps(3),
  lineVoltage: 1500,
  converterEfficiency: 0.97,
};

export const TEST_VEHICLE_BRAKE: VehicleBrakeSpec = {
  kind: 'disc',
  forcePerPressure: 0.15,
  maxCylinderPressure: 400_000,
  deadTime: 0.3,
  fillTimeConstant: 0.6,
  releaseTimeConstant: 0.5,
  frictionSpeedCurve: [
    [0, 1.05],
    [kmhToMps(30), 1.0],
    [kmhToMps(80), 0.95],
    [kmhToMps(120), 0.9],
  ],
  brakedAxleRatio: 1,
};

export const TEST_ADHESION: AdhesionSpec = {
  mu0: 0.33,
  speedCoefficient: 0.008,
  peakCreep: 0.012,
  kineticRatio: 0.6,
  sandingFactor: 1.25,
  creepReferenceSpeed: 0.5,
};

export const TEST_COUPLER: CouplerSpec = {
  slack: 0.01,
  stiffness1: 2.0e6,
  travel1: 0.02,
  stiffness2: 2.0e7,
  damping: 2.0e5,
};

export const TEST_TRACTION_CONTROL: TractionControlSpec = {
  notchCount: 4,
  notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
  torqueRiseRate: 2.5,
  torqueFallRate: 4.0,
  loadCompensation: true,
  referenceLoadFactor: 0.5,
  targetAcceleration: 0,
};

export const TEST_BRAKE_CONTROL: BrakeControlSpec = {
  notchCount: 8,
  maxServiceDeceleration: 1.0,
  emergencyDeceleration: 1.25,
  blending: true,
  loadCompensation: true,
  antiSkid: true,
  antiSkidOnEmergency: true,
  emergencyIsAirOnly: true,
  hasHoldingBrake: true,
};

export interface TestVehicleOptions {
  readonly id?: string;
  readonly tareMass?: number;
  readonly fullLoadMass?: number;
  readonly length?: number;
  readonly drivenAxleCount?: number;
  readonly rotatingMassFactor?: number;
  readonly runningResistance?: DavisCoefficients;
  readonly traction?: VvvfTractionSpec | null;
}

export function testVehicle(options: TestVehicleOptions = {}): VehicleSpec {
  return {
    id: options.id ?? 'test-car',
    tareMass: options.tareMass ?? 32_000,
    fullLoadMass: options.fullLoadMass ?? 9_000,
    length: options.length ?? 20,
    bogieSpacing: 13.8,
    bogieWheelbase: 2.1,
    axleCount: 4,
    drivenAxleCount: options.drivenAxleCount ?? 4,
    wheelDiameter: 0.86,
    rotatingMassFactor: options.rotatingMassFactor ?? 0.09,
    runningResistance: options.runningResistance ?? NO_RESISTANCE,
    centerOfGravityHeight: 1.8,
    tractionLinkHeight: 0.6,
    brake: TEST_VEHICLE_BRAKE,
    traction: options.traction === undefined ? TEST_TRACTION : options.traction,
    suspension: DEFAULT_SUSPENSION,
  };
}

export interface TestConsistOptions extends TestVehicleOptions {
  readonly cars?: number;
  readonly coupler?: CouplerSpec;
  readonly adhesion?: Partial<AdhesionSpec>;
  readonly curveResistanceCoefficient?: number;
}

export function testConsist(options: TestConsistOptions = {}): ConsistSpec {
  const cars = options.cars ?? 1;
  const vehicles: VehicleSpec[] = [];
  for (let i = 0; i < cars; i++) {
    vehicles.push(testVehicle({ ...options, id: `${options.id ?? 'car'}-${i + 1}` }));
  }
  return {
    id: 'test-consist',
    name: 'テスト編成',
    vehicles,
    coupler: options.coupler ?? TEST_COUPLER,
    adhesion: { ...TEST_ADHESION, ...options.adhesion },
    traction: TEST_TRACTION_CONTROL,
    brake: TEST_BRAKE_CONTROL,
    maxSpeed: kmhToMps(120),
    curveResistanceCoefficient: options.curveResistanceCoefficient ?? 0,
    tunnelResistanceFactor: 1.6,
  };
}

/** 平坦・直線の試験線 */
export function flatTrack(length = 20_000): Alignment {
  return buildAlignment({
    gauge: 1.067,
    horizontal: [{ length }],
    vertical: [{ length, gradePermil: 0 }],
    sampleStep: 5,
  });
}

/** 一定勾配の試験線 */
export function gradeTrack(permil: number, length = 20_000): Alignment {
  return buildAlignment({
    gauge: 1.067,
    horizontal: [{ length }],
    vertical: [{ length, gradePermil: permil }],
    sampleStep: 5,
  });
}

/** トンネルなしの環境 */
export const NO_TUNNEL = { isTunnel: () => false };
