import {
  davisFromKgfPerTon,
  kgfPerTonToNPerKg,
  kmhToMps,
  kmhsToMps2,
  kpaToPa,
  tonsToKg,
  type ConsistSpec,
  type VehicleBrakeSpec,
  type VehicleSpec,
  type VvvfTractionSpec,
} from '@railsim/core';
import { vehicleSchema, type ParsedVehicle, type VehicleDefinition } from '../schema/vehicle.ts';

type ParsedCar = ParsedVehicle['cars'][number];

function compileTraction(spec: ParsedCar['traction']): VvvfTractionSpec | null {
  if (!spec) return null;
  return {
    kind: 'vvvf',
    motorCount: spec.motorCount,
    gearRatio: spec.gearRatio,
    driveEfficiency: spec.driveEfficiency,
    maxMotorTorque: spec.maxMotorTorque,
    constantTorqueSpeed: kmhToMps(spec.constantTorqueSpeed),
    constantPowerSpeed: kmhToMps(spec.constantPowerSpeed),
    maxBrakingMotorTorque: spec.maxBrakingMotorTorque,
    regenFadeStartSpeed: kmhToMps(spec.regenFadeStartSpeed),
    regenFadeEndSpeed: kmhToMps(spec.regenFadeEndSpeed),
    lineVoltage: spec.lineVoltage,
    converterEfficiency: spec.converterEfficiency,
    // 変調の諸元はもともと Hz と個数なので換算は要らない
    inverter: {
      polePairs: spec.inverter.polePairs,
      ratedSlipFrequency: spec.inverter.ratedSlipFrequency,
      baseFrequency: spec.inverter.baseFrequency,
      asyncCarrier: spec.inverter.asyncCarrier.map(([f, c]) => [f, c] as [number, number]),
      pulseModes: spec.inverter.pulseModes,
      modeHysteresis: spec.inverter.modeHysteresis,
      rotorSlots: spec.inverter.rotorSlots,
      pinionTeeth: spec.inverter.pinionTeeth,
    },
  };
}

function compileBrake(spec: ParsedCar['brake']): VehicleBrakeSpec {
  return {
    kind: spec.kind,
    forcePerPressure: spec.forcePerPressure,
    maxCylinderPressure: kpaToPa(spec.maxCylinderPressure),
    deadTime: spec.deadTime,
    fillTimeConstant: spec.fillTimeConstant,
    releaseTimeConstant: spec.releaseTimeConstant,
    frictionSpeedCurve: spec.frictionSpeedCurve.map(
      ([v, f]) => [kmhToMps(v), f] as [number, number],
    ),
    brakedAxleRatio: spec.brakedAxleRatio,
  };
}

/**
 * 車両定義をコンパイルして編成仕様にする。
 * 現場の単位（t・km/h・km/h/s・kPa・kgf/t）をすべて SI へ変換する。
 */
export function compileVehicle(definition: VehicleDefinition): ConsistSpec {
  const def = vehicleSchema.parse(definition);

  const vehicles: VehicleSpec[] = def.cars.map((car) => ({
    id: car.id,
    tareMass: tonsToKg(car.tareMass),
    fullLoadMass: tonsToKg(car.fullLoadMass),
    length: car.length,
    bogieSpacing: car.bogieSpacing,
    bogieWheelbase: car.bogieWheelbase,
    axleCount: car.axleCount,
    drivenAxleCount: car.drivenAxleCount,
    wheelDiameter: car.wheelDiameter,
    rotatingMassFactor: car.rotatingMassFactor,
    runningResistance: davisFromKgfPerTon(car.resistance),
    centerOfGravityHeight: car.centerOfGravityHeight,
    tractionLinkHeight: car.tractionLinkHeight,
    brake: compileBrake(car.brake),
    traction: compileTraction(car.traction),
    suspension: car.suspension,
    passenger: car.passenger,
  }));

  const notchDeceleration = def.brake.notchDeceleration?.map(kmhsToMps2);

  return {
    id: def.id,
    name: def.name,
    vehicles,
    coupler: {
      slack: def.coupler.slack,
      stiffness1: def.coupler.stiffness1,
      travel1: def.coupler.travel1,
      stiffness2: def.coupler.stiffness2,
      damping: def.coupler.damping,
      ...(def.coupler.maxForce === undefined ? {} : { maxForce: def.coupler.maxForce * 1000 }),
    },
    adhesion: {
      mu0: def.adhesion.mu0,
      speedCoefficient: def.adhesion.speedCoefficient,
      peakCreep: def.adhesion.peakCreep,
      kineticRatio: def.adhesion.kineticRatio,
      sandingFactor: def.adhesion.sandingFactor,
      creepReferenceSpeed: kmhToMps(def.adhesion.creepReferenceSpeed),
    },
    traction: {
      notchCount: def.traction.notchCount,
      notchTorqueRatio: def.traction.notchTorqueRatio,
      torqueRiseRate: def.traction.torqueRiseRate,
      torqueFallRate: def.traction.torqueFallRate,
      loadCompensation: def.traction.loadCompensation,
      referenceLoadFactor: def.traction.referenceLoadFactor,
      targetAcceleration: kmhsToMps2(def.traction.targetAcceleration),
    },
    brake: {
      notchCount: def.brake.notchCount,
      maxServiceDeceleration: kmhsToMps2(def.brake.maxServiceDeceleration),
      emergencyDeceleration: kmhsToMps2(def.brake.emergencyDeceleration),
      ...(notchDeceleration === undefined ? {} : { notchDeceleration }),
      blending: def.brake.blending,
      loadCompensation: def.brake.loadCompensation,
      antiSkid: def.brake.antiSkid,
      antiSkidOnEmergency: def.brake.antiSkidOnEmergency,
      emergencyIsAirOnly: def.brake.emergencyIsAirOnly,
      hasHoldingBrake: def.brake.hasHoldingBrake,
    },
    maxSpeed: kmhToMps(def.maxSpeed),
    curveResistanceCoefficient: kgfPerTonToNPerKg(def.curveResistanceCoefficient),
    tunnelResistanceFactor: def.tunnelResistanceFactor,
  };
}
