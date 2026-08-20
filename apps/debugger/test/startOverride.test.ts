import { describe, expect, it } from 'vitest';
import type { Scenario } from '@railsim/core';
import { parseStartOverride, withStartOverride } from '../src/startOverride.ts';

/** 開始位置の差し替えに要るのは、この 3 つだけ */
const scenario = {
  startPosition: 300,
  startSpeed: 0,
  route: { length: 8000 },
} as unknown as Scenario;

describe('確認用の開始位置指定', () => {
  it('距離程と速度を読む（速度は km/h で受けて m/s にする）', () => {
    const override = parseStartOverride('?s=2000&v=72');
    expect(override.position).toBe(2000);
    expect(override.speed).toBeCloseTo(20, 6);
    expect(override.hideUi).toBe(false);
  });

  it('指定が無ければ何も変えない', () => {
    const override = parseStartOverride('');
    expect(override.position).toBeNull();
    expect(override.speed).toBeNull();
    // 同じ実体がそのまま返る（作り直さない）
    expect(withStartOverride(scenario, override)).toBe(scenario);
  });

  it('数として読めない値と負の値は無視する', () => {
    const override = parseStartOverride('?s=abc&v=-10');
    expect(override.position).toBeNull();
    expect(override.speed).toBeNull();
  });

  it('片方だけの指定では、もう片方はシナリオの値を残す', () => {
    const moved = withStartOverride(scenario, parseStartOverride('?s=2000'));
    expect(moved.startPosition).toBe(2000);
    expect(moved.startSpeed).toBe(scenario.startSpeed);
  });

  it('路線の終端より先へは出さない', () => {
    const moved = withStartOverride(scenario, parseStartOverride('?s=99999'));
    expect(moved.startPosition).toBe(8000);
  });

  it('ui=0 のときだけ画面を消す', () => {
    expect(parseStartOverride('?ui=0').hideUi).toBe(true);
    expect(parseStartOverride('?ui=1').hideUi).toBe(false);
    expect(parseStartOverride('').hideUi).toBe(false);
  });
});
