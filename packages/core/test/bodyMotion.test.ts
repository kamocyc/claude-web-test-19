import { describe, expect, it } from 'vitest';
import {
  CarBodyMotion,
  DEFAULT_IRREGULARITY,
  DEFAULT_SUSPENSION,
  GRAVITY,
  Oscillator,
  TrackIrregularity,
  TrainDynamics,
  buildAlignment,
  kmhToMps,
  mmToM,
  type BodyMotionInput,
} from '@railsim/core';
import { NO_TUNNEL, flatTrack, testConsist } from './fixtures.ts';

const DT = 0.001;

const baseInput = (over: Partial<BodyMotionInput> = {}): BodyMotionInput => ({
  unbalancedLateral: 0,
  longitudinalAcceleration: 0,
  frontVertical: 0,
  rearVertical: 0,
  frontLateral: 0,
  rearLateral: 0,
  crossLevel: 0,
  bogieSpacing: 13.8,
  gauge: 1.067,
  ...over,
});

describe('2 次系の振動子', () => {
  it('目標値へ減衰しながら収束する', () => {
    const osc = new Oscillator();
    for (let i = 0; i < 20_000; i++) osc.step(DT, 1, 1.0, 0.3);
    expect(osc.value).toBeCloseTo(1, 4);
    expect(osc.rate).toBeCloseTo(0, 3);
  });

  it('固有振動数どおりの周期で振動する', () => {
    const osc = new Oscillator();
    const freq = 1.0;
    // 減衰をほぼ 0 にしてステップ応答の周期を測る
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) {
      osc.step(DT, 1, freq, 0.001);
      values.push(osc.value);
    }
    // 最初のピーク（オーバーシュート）はおよそ半周期後に来る
    let peakIndex = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i]! > values[peakIndex]!) peakIndex = i;
      else if (values[i]! < values[i - 1]!) break;
    }
    expect(peakIndex * DT).toBeCloseTo(0.5 / freq, 1);
  });
});

describe('軌道狂い', () => {
  const irr = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 1);

  it('距離程の関数なので、同じ地点では常に同じ値になる', () => {
    expect(irr.verticalAt(1234.5)).toBe(irr.verticalAt(1234.5));
    expect(irr.crossLevelAt(500)).toBe(irr.crossLevelAt(500));
    expect(irr.verticalAt(1234.5)).not.toBe(irr.verticalAt(1240));
  });

  it('同じシードなら同じ軌道狂いになる', () => {
    const other = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 1);
    expect(other.verticalAt(777)).toBeCloseTo(irr.verticalAt(777), 12);
  });

  it('シードが違えば別の軌道狂いになる', () => {
    const other = new TrackIrregularity(43, DEFAULT_IRREGULARITY, 1);
    expect(other.verticalAt(777)).not.toBeCloseTo(irr.verticalAt(777), 6);
  });

  it('標準偏差が指定した振幅と概ね一致する', () => {
    let sum = 0;
    let sumSq = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const v = irr.verticalAt(i * 0.37);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(sd).toBeGreaterThan(DEFAULT_IRREGULARITY.verticalAmplitude * 0.7);
    expect(sd).toBeLessThan(DEFAULT_IRREGULARITY.verticalAmplitude * 1.4);
  });

  it('レベル 0 では完全に平滑になる', () => {
    const smooth = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 0);
    expect(smooth.verticalAt(123)).toBe(0);
    expect(smooth.crossLevelAt(456)).toBe(0);
  });
});

describe('車体の動揺', () => {
  it('横加速度がゼロなら車体は傾かない', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    for (let i = 0; i < 10_000; i++) body.step(DT, baseInput());
    expect(body.state.roll).toBeCloseTo(0, 6);
    expect(body.state.feltLateral).toBeCloseTo(0, 6);
  });

  it('曲線の横加速度で車体が外側へロールする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    const a = 0.8; // 右へ押される
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    // 車体傾斜率 0.3、つり合い角 atan(0.8/g) = 0.0815 rad
    const expected = 0.3 * Math.atan2(a, GRAVITY);
    expect(body.state.roll).toBeCloseTo(expected, 4);
    expect(body.state.roll).toBeGreaterThan(0);
  });

  it('車体ロールにより乗客が感じる横 G は軌道面の値より大きくなる', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    const a = 0.8;
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    expect(body.state.feltLateral).toBeGreaterThan(a);
    // ロール角ぶんの重力成分が上乗せされる
    const expected = a * Math.cos(body.state.roll) + GRAVITY * Math.sin(body.state.roll);
    expect(body.state.feltLateral).toBeCloseTo(expected, 6);
  });

  it('車体傾斜率が 0 なら体感横 G は軌道面の値と一致する', () => {
    const rigid = { ...DEFAULT_SUSPENSION, rollFlexibility: 0 };
    const body = new CarBodyMotion(rigid);
    const a = 0.8;
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    expect(body.state.feltLateral).toBeCloseTo(a, 5);
  });

  it('加速すると乗客は後ろへ押され、車体は前上がりにピッチングする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ longitudinalAcceleration: 1.0 }));
    }
    expect(body.state.feltLongitudinal).toBeCloseTo(-1.0, 6);
    expect(body.state.pitch).toBeLessThan(0);
    expect(body.state.pitch).toBeCloseTo(-DEFAULT_SUSPENSION.pitchGain * 1.0, 4);
  });

  it('制動すると乗客は前へ押され、車体は前下がりにピッチングする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ longitudinalAcceleration: -1.0 }));
    }
    expect(body.state.feltLongitudinal).toBeCloseTo(1.0, 6);
    expect(body.state.pitch).toBeGreaterThan(0);
  });

  it('水準狂いは軌道の傾きとしてそのまま車体を傾ける', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    const crossLevel = mmToM(10);
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ crossLevel }));
    expect(body.state.roll).toBeCloseTo(Math.asin(crossLevel / 1.067), 4);
  });

  it('前後台車の高低差はピッチングを、通り狂いの差はヨーイングを生む', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION);
    for (let i = 0; i < 20_000; i++) {
      body.step(
        DT,
        baseInput({
          frontVertical: 0.01,
          rearVertical: -0.01,
          frontLateral: 0.01,
          rearLateral: -0.01,
        }),
      );
    }
    expect(body.state.pitch).toBeCloseTo(-0.02 / 13.8, 4);
    expect(body.state.yaw).toBeCloseTo(0.02 / 13.8, 4);
    // 上下動は前後の平均なのでゼロ
    expect(body.state.vertical).toBeCloseTo(0, 5);
  });
});

describe('走行中の車体動揺', () => {
  const irregular = (level: number) => new TrackIrregularity(2024, DEFAULT_IRREGULARITY, level);

  it('軌道狂いがあると走行中に揺れ続ける', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: kmhToMps(80),
      initialFrontPosition: 1000,
      irregularity: irregular(1),
    });
    let maxRoll = 0;
    let maxVertical = 0;
    for (let i = 0; i < 20_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      maxRoll = Math.max(maxRoll, Math.abs(dyn.vehicles[0]!.body.roll));
      maxVertical = Math.max(maxVertical, Math.abs(dyn.vehicles[0]!.body.vertical));
    }
    expect(maxRoll).toBeGreaterThan(0.001);
    expect(maxVertical).toBeGreaterThan(0.001);
    // 過大な揺れにはならない（ロール 3 度以内、上下 3cm 以内）
    expect(maxRoll).toBeLessThan(0.05);
    expect(maxVertical).toBeLessThan(0.03);
  });

  it('軌道狂いが大きいほど揺れが大きい', () => {
    const amplitude = (level: number) => {
      const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
        initialSpeed: kmhToMps(80),
        initialFrontPosition: 1000,
        irregularity: irregular(level),
      });
      let sum = 0;
      for (let i = 0; i < 20_000; i++) {
        dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
        sum += Math.abs(dyn.vehicles[0]!.body.roll);
      }
      return sum / 20_000;
    };
    expect(amplitude(2)).toBeGreaterThan(amplitude(1) * 1.5);
  });

  it('狂いのない軌道では揺れない', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: kmhToMps(80),
      initialFrontPosition: 1000,
    });
    for (let i = 0; i < 10_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
    }
    expect(Math.abs(dyn.vehicles[0]!.body.roll)).toBeLessThan(1e-9);
    expect(Math.abs(dyn.vehicles[0]!.body.vertical)).toBeLessThan(1e-9);
  });

  it('曲線に進入すると車体が外側へ傾き、体感横 G が立ち上がる', () => {
    const alignment = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 500 },
        { length: 800, radius: 400, transitionLength: 60, cant: mmToM(60) },
        { length: 500, transitionLength: 60 },
      ],
      vertical: [{ length: 1800, gradePermil: 0 }],
      sampleStep: 5,
    });
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), alignment, {
      initialSpeed: kmhToMps(90),
      initialFrontPosition: 100,
    });
    let maxFelt = 0;
    let rollAtCurve = 0;
    for (let i = 0; i < 40_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      const body = dyn.vehicles[0]!.body;
      maxFelt = Math.max(maxFelt, Math.abs(body.feltLateral));
      if (dyn.vehicles[0]!.s > 700 && dyn.vehicles[0]!.s < 1200) rollAtCurve = body.roll;
      if (dyn.frontPosition > 1700) break;
    }
    // 左曲線でカント不足 → 乗客は右（外側）へ押され、車体も右下がりにロールする
    expect(rollAtCurve).toBeGreaterThan(0.005);
    expect(maxFelt).toBeGreaterThan(0.3);
  });

  it('車体動揺は決定論的（同じ条件なら同じ揺れ）', () => {
    const runOnce = () => {
      const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
        initialSpeed: kmhToMps(80),
        initialFrontPosition: 1000,
        irregularity: irregular(1),
      });
      for (let i = 0; i < 5000; i++) {
        dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      }
      return dyn.vehicles[0]!.body.roll;
    };
    expect(runOnce()).toBe(runOnce());
  });
});
