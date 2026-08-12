import { describe, expect, it } from 'vitest';
import { createDefaultLibrary } from '@railsim/data';
import { bogieSquealDrive, squealOnsetRadius, type RailCondition } from '@railsim/core';

const library = createDefaultLibrary();

/**
 * 距離程 `a` 〜 `b` を舐めて、軋みの駆動を測る。
 * 実際の合成では編成の台車ごとに求めるが、ここで見たいのは**線路のどこで
 * 条件が揃うか**なので、台車 1 つを走らせた形で足りる。
 */
function scan(
  scenarioId: string,
  a: number,
  b: number,
  rail: RailCondition = 'dry',
): { peak: number; ratio: number } {
  const scenario = library.scenario(scenarioId);
  const route = scenario.route;
  const spec = scenario.consist.vehicles[0]!;
  const lateralAt = (s: number): number =>
    route.irregularity.lateralAt(s) + route.turnouts.lateralAt(s);

  let peak = 0;
  let above = 0;
  let n = 0;
  for (let s = a; s < b; s += 0.25) {
    const drive = bogieSquealDrive({
      adhesion: scenario.consist.adhesion,
      curvature: route.alignment.curvatureAt(s),
      lateralAt,
      position: s,
      bogieWheelbase: spec.bogieWheelbase,
      speed: 12,
      rail,
    });
    peak = Math.max(peak, drive);
    if (drive > 0.02) above++;
    n++;
  }
  return { peak, ratio: above / n };
}

describe('試験線のどこで軋み音が出るか', () => {
  it('鳴きはじめる半径が編成の諸元から R300 前後になる', () => {
    const scenario = library.scenario('test-line-local');
    const onset = squealOnsetRadius(
      scenario.consist.adhesion,
      scenario.consist.vehicles[0]!.bogieWheelbase,
    );
    expect(onset).toBeGreaterThan(280);
    expect(onset).toBeLessThan(330);
  });

  it('直線では鳴らない（通り狂いだけでは閾値に届かない）', () => {
    expect(scan('test-line-local', 200, 1400).peak).toBe(0);
    expect(scan('test-line-local', 3000, 4150).peak).toBe(0);
    expect(scan('test-line-local', 5200, 6250).peak).toBe(0);
  });

  it('R600 では鳴らない', () => {
    // アタック角 1.75mrad。飽和 3mrad に遠く届かない。
    expect(scan('test-line-local', 1550, 2250).peak).toBe(0);
  });

  it('R400 では軌道狂いと重なったところだけ断続的に鳴る', () => {
    // アタック角 2.6mrad。曲線だけでは足りず、通り狂いが乗ったところで越える。
    const { peak, ratio } = scan('test-line-local', 4250, 4950);
    expect(peak).toBeGreaterThan(0.5);
    expect(ratio).toBeGreaterThan(0.02);
    expect(ratio).toBeLessThan(0.3);
  });

  it('分岐器を直進で渡っても鳴らない', () => {
    // 曲率が 0 のままで、護輪軌条の押し戻しは軸距の弦で均されてしまう
    expect(scan('test-line-turnout', 6280, 6360).peak).toBe(0);
    // 交換設備も 1 番線を通るかぎり直線のまま
    expect(scan('test-line-local', 30, 470).peak).toBe(0);
  });

  it('2 番線へ入ると鳴る（リード曲線 R350 + トングレールの遊間）', () => {
    const { peak, ratio } = scan('test-line-loop', 380, 470);
    expect(peak).toBe(1);
    expect(ratio).toBeGreaterThan(0.1);
    // ホームの部分は本線と平行な直線なので鳴らない
    expect(scan('test-line-loop', 170, 380).peak).toBe(0);
  });

  it('分岐側でも降雪ならほとんど鳴らない', () => {
    const dry = scan('test-line-loop', 380, 470, 'dry');
    const snow = scan('test-line-loop', 380, 470, 'snow');
    expect(snow.peak).toBeGreaterThan(0);
    expect(snow.peak).toBeLessThan(dry.peak * 0.15);
  });
});
