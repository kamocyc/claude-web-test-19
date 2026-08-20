import { describe, expect, it } from 'vitest';
import {
  ElectroPneumaticBrakeSystem,
  TrainDynamics,
  VvvfTractionSystem,
  kmhToMps,
  paToKpa,
  type BrakeCommand,
  type DynamicsEnvironment,
} from '@railsim/core';
import { NO_TUNNEL, flatTrack, testConsist } from './fixtures.ts';

const DT = 0.001;
const CONTROL_DT = 0.01;

/** 動力・ブレーキ・力学を結線した試験用リグ（速度 60km/h の平坦線） */
function rig() {
  const consist = testConsist({ cars: 4 });
  const dyn = new TrainDynamics(consist, flatTrack(), {
    initialSpeed: kmhToMps(60),
    initialFrontPosition: 1000,
  });
  const traction = new VvvfTractionSystem(consist);
  const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
  const env: DynamicsEnvironment = { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL };
  const ctx = {
    dynamics: dyn,
    traction,
    loadFactor: 0,
    regenerationReceptivity: 1,
    lineVoltage: 1500,
  };
  let sinceControl = 0;
  const run = (seconds: number) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      sinceControl += DT;
      if (sinceControl >= CONTROL_DT - 1e-9) {
        brake.update(sinceControl, ctx);
        traction.update(sinceControl, ctx);
        sinceControl = 0;
      }
      dyn.step(DT, env);
    }
  };
  return { dyn, brake, run };
}

const cmd = (over: Partial<BrakeCommand> = {}): BrakeCommand => ({
  notch: 0,
  emergency: false,
  holdingNotch: 0,
  backup: false,
  snowproof: false,
  ...over,
});

describe('耐雪ブレーキ', () => {
  it('緩解中に低い圧力を込め続ける', () => {
    const r = rig();
    r.brake.setCommand(cmd({ snowproof: true }));
    r.run(4);
    const kpa = paToKpa(r.brake.averageCylinderPressure());
    // 制輪子を軽く当てておくだけの圧力。止めるための圧力ではない。
    expect(kpa).toBeGreaterThan(20);
    expect(kpa).toBeLessThan(80);
    // 空気だけで込める。電気ブレーキは呼ばない。
    expect(r.brake.state.electricForce).toBe(0);
  });

  it('入れなければ BC 圧は立たない', () => {
    const r = rig();
    r.brake.setCommand(cmd());
    r.run(4);
    expect(paToKpa(r.brake.averageCylinderPressure())).toBeLessThan(1);
  });

  it('常用ブレーキと重複して効かない（電空協調が耐雪ぶんを電気から差し引く）', () => {
    const plain = rig();
    plain.brake.setCommand(cmd({ notch: 3 }));
    plain.run(4);

    const snow = rig();
    snow.brake.setCommand(cmd({ notch: 3, snowproof: true }));
    snow.run(4);

    // 込まった空気のぶんだけ電気ブレーキの分担が減るので、指令減速度は変わらない
    expect(snow.dyn.speed).toBeCloseTo(plain.dyn.speed, 3);
    expect(snow.brake.state.electricForce).toBeLessThan(plain.brake.state.electricForce);
  });

  it('惰行の伸びが鈍る', () => {
    const coast = rig();
    coast.brake.setCommand(cmd());
    coast.run(20);

    const snow = rig();
    snow.brake.setCommand(cmd({ snowproof: true }));
    snow.run(20);

    // 制輪子を当てているぶんの抵抗。止めるほどではないが、惰行では目に見えて鈍る
    const differenceKmh = (coast.dyn.speed - snow.dyn.speed) * 3.6;
    expect(differenceKmh).toBeGreaterThan(4);
    expect(differenceKmh).toBeLessThan(14);
  });

  it('非常ブレーキ中は下限を張らない（非常の指令がそのまま出る）', () => {
    const plain = rig();
    plain.brake.setCommand(cmd({ emergency: true }));
    plain.run(2);

    const snow = rig();
    snow.brake.setCommand(cmd({ emergency: true, snowproof: true }));
    snow.run(2);

    expect(paToKpa(snow.brake.averageCylinderPressure())).toBeCloseTo(
      paToKpa(plain.brake.averageCylinderPressure()),
      6,
    );
  });
});
