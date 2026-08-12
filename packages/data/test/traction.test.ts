import { describe, expect, it } from 'vitest';
import {
  commuter4ChopperVehicle,
  commuter4ResistorVehicle,
  commuter4Vehicle,
  compileVehicle,
  createDefaultLibrary,
} from '@railsim/data';
import {
  Simulation,
  backEmf,
  consistMass,
  kmhToMps,
  motorTorque,
  mps2ToKmhs,
  rpmToRadPerSec,
  type ResistorTractionSpec,
} from '@railsim/core';

const resistorSpec = () => {
  const consist = compileVehicle(commuter4ResistorVehicle);
  const spec = consist.vehicles[1]?.traction;
  if (spec?.kind !== 'resistor') throw new Error('抵抗制御の仕様が取れません');
  return { consist, spec };
};

const chopperSpec = () => {
  const consist = compileVehicle(commuter4ChopperVehicle);
  const spec = consist.vehicles[1]?.traction;
  if (spec?.kind !== 'chopper') throw new Error('チョッパの仕様が取れません');
  return { consist, spec };
};

describe('制御方式の判別可能ユニオン', () => {
  it('3 方式それぞれがコンパイルできる', () => {
    expect(compileVehicle(commuter4Vehicle).vehicles[1]?.traction?.kind).toBe('vvvf');
    expect(compileVehicle(commuter4ResistorVehicle).vehicles[1]?.traction?.kind).toBe('resistor');
    expect(compileVehicle(commuter4ChopperVehicle).vehicles[1]?.traction?.kind).toBe('chopper');
  });

  it('方式ごとに違う諸元を要求する（VVVF に抵抗制御の諸元は書けない）', () => {
    expect(() =>
      compileVehicle({
        ...commuter4Vehicle,
        cars: commuter4Vehicle.cars.map((car) =>
          car.traction ? { ...car, traction: { ...car.traction, kind: 'resistor' as const } } : car,
        ),
      } as never),
    ).toThrow();
  });

  it('標準ライブラリに 3 方式の車両とシナリオが入っている', () => {
    const lib = createDefaultLibrary();
    expect(lib.vehicleIds).toEqual(['commuter-4', 'commuter-4-resistor', 'commuter-4-chopper']);
    expect(lib.scenarioIds).toContain('test-line-resistor');
    expect(lib.scenarioIds).toContain('test-line-chopper');
  });
});

describe('直流直巻電動機の諸元の逆算', () => {
  it('磁束定数が銘板の定格点を再現する', () => {
    const { spec } = resistorSpec();
    const motor = spec.motor;
    // データに書いてある銘板は 375V・350A・1630rpm
    const omega = rpmToRadPerSec(1630);
    expect(backEmf(motor, 350, 1, omega)).toBeCloseTo(375 - 350 * motor.armatureResistance, 6);
    // 定格出力が 120kW 級に収まる
    const power = (motorTorque(motor, 350, 1) * omega) / 1000;
    expect(power).toBeGreaterThan(115);
    expect(power).toBeLessThan(122);
  });

  it('インダクタンスが mH から H へ換算される', () => {
    const { spec } = resistorSpec();
    expect(spec.motor.armatureInductance).toBeCloseTo(0.022, 9);
  });

  it('抵抗制御とチョッパで同じ電動機を使っている', () => {
    const r = resistorSpec().spec.motor;
    const c = chopperSpec().spec.motor;
    expect(c.fluxConstant).toBeCloseTo(r.fluxConstant, 9);
    expect(c.saturationCurrent).toBe(r.saturationCurrent);
    expect(c.armatureResistance).toBe(r.armatureResistance);
  });
});

describe('進段表の生成', () => {
  const ladder = (spec: ResistorTractionSpec, motorsInSeries: number) =>
    spec.camSteps.filter((s) => s.motorsInSeries === motorsInSeries && s.fieldRatio === 1);

  it('つなぎごとに抵抗が公比 進段電流/限流値 の幾何級数で落ちる', () => {
    const { spec } = resistorSpec();
    const ratio = spec.stepCurrent / spec.currentLimit;
    for (const motorsInSeries of [8, 4]) {
      const steps = ladder(spec, motorsInSeries);
      const internal = motorsInSeries * spec.motor.armatureResistance;
      // 全短絡の段を除いた隣接ペアで、合計抵抗の比が公比になる
      for (let i = 1; i < steps.length - 1; i++) {
        const previous = steps[i - 1]!.resistance + internal;
        const current = steps[i]!.resistance + internal;
        expect(current / previous).toBeCloseTo(ratio, 6);
      }
    }
  });

  it('各つなぎの初段は起動時に限流値がちょうど流れる抵抗になっている', () => {
    const { spec } = resistorSpec();
    const first = spec.camSteps[0]!;
    const total = first.resistance + first.motorsInSeries * spec.motor.armatureResistance;
    // 起動時は逆起電力が無いので、V / R_合計 = 限流値
    expect(spec.lineVoltage / total).toBeCloseTo(spec.currentLimit, 6);
  });

  it('各つなぎの最後は全短絡、最後の 4 段は弱め界磁', () => {
    const { spec } = resistorSpec();
    expect(ladder(spec, 8).at(-1)?.resistance).toBe(0);
    expect(ladder(spec, 4).at(-1)?.resistance).toBe(0);
    const weakened = spec.camSteps.filter((s) => s.fieldRatio < 1);
    expect(weakened).toHaveLength(4);
    expect(weakened.map((s) => s.fieldRatio)).toEqual([0.8, 0.65, 0.55, 0.45]);
    // 弱め界磁は最終つなぎ・全短絡のうえに積まれる
    for (const s of weakened) {
      expect(s.resistance).toBe(0);
      expect(s.motorsInSeries).toBe(4);
    }
  });

  it('つなぎ方は直列から並列へ 1 度だけ変わる', () => {
    const { spec } = resistorSpec();
    const changes = spec.camSteps.filter(
      (s, i) => i > 0 && spec.camSteps[i - 1]!.motorsInSeries !== s.motorsInSeries,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.motorsInSeries).toBe(4);
  });

  it('ノッチの止まり位置がすべて全短絡の段である（抵抗を残したまま走れない）', () => {
    const { spec } = resistorSpec();
    expect(spec.notchFinalStep).toHaveLength(4);
    for (const index of spec.notchFinalStep) {
      expect(spec.camSteps[index]?.resistance).toBe(0);
    }
    // 昇順で、最終ノッチが最終段
    for (let i = 1; i < spec.notchFinalStep.length; i++) {
      expect(spec.notchFinalStep[i]!).toBeGreaterThan(spec.notchFinalStep[i - 1]!);
    }
    expect(spec.notchFinalStep.at(-1)).toBe(spec.camSteps.length - 1);
  });

  it('進段電流が限流値以上なら弾く', () => {
    const broken = {
      ...commuter4ResistorVehicle,
      cars: commuter4ResistorVehicle.cars.map((car) =>
        car.traction?.kind === 'resistor'
          ? { ...car, traction: { ...car.traction, stepCurrent: car.traction.currentLimit } }
          : car,
      ),
    };
    expect(() => compileVehicle(broken)).toThrow(/進段電流/);
  });
});

describe('チョッパの単位換算', () => {
  it('回生の絞り込み速度が km/h から m/s へ換算される', () => {
    const { spec } = chopperSpec();
    expect(spec.regenFadeStartSpeed).toBeCloseTo(kmhToMps(12), 9);
    expect(spec.regenFadeEndSpeed).toBeCloseTo(kmhToMps(5), 9);
  });
});

describe('公称性能', () => {
  const startingAcceleration = (scenarioId: string) => {
    const sim = new Simulation(createDefaultLibrary().scenario(scenarioId));
    sim.input = { ...sim.input, powerNotch: sim.scenario.consist.traction.notchCount };
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      sim.step(0.01);
      peak = Math.max(peak, sim.dynamics.acceleration);
    }
    return mps2ToKmhs(peak);
  };

  it('抵抗制御車の起動加速度がおよそ 2.4km/h/s', () => {
    expect(startingAcceleration('test-line-resistor')).toBeGreaterThan(2.2);
    expect(startingAcceleration('test-line-resistor')).toBeLessThan(2.6);
  });

  it('チョッパ車の起動加速度がおよそ 2.8km/h/s', () => {
    expect(startingAcceleration('test-line-chopper')).toBeGreaterThan(2.6);
    expect(startingAcceleration('test-line-chopper')).toBeLessThan(3.0);
  });

  it('抵抗制御車は VVVF 車より重く、加速が鈍い', () => {
    const resistor = compileVehicle(commuter4ResistorVehicle);
    const vvvf = compileVehicle(commuter4Vehicle);
    expect(consistMass(resistor, 0.5)).toBeGreaterThan(consistMass(vvvf, 0.5));
    expect(startingAcceleration('test-line-resistor')).toBeLessThan(
      startingAcceleration('test-line-local'),
    );
  });
});
