import { bench, describe } from 'vitest';
import { NEUTRAL_INPUT, Simulation } from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

const lib = createDefaultLibrary();

/**
 * リアルタイム比（RTF）の目安を測る。
 * 1 回の反復で 10 秒ぶんのシミュレーションを進めるので、
 * 1 反復あたり 10ms なら RTF = 1000 倍。
 */
describe('シミュレーションのスループット（1 反復 = 10 秒ぶん）', () => {
  bench('4 両編成 / 多質点 / 1kHz', () => {
    const sim = new Simulation({ ...lib.scenario('test-line-local'), hasVigilance: false });
    sim.input = { ...NEUTRAL_INPUT, powerNotch: 4 };
    for (let i = 0; i < 200; i++) sim.step(0.05);
  });

  bench('4 両編成 / 単一質点 / 1kHz', () => {
    const sim = new Simulation({
      ...lib.scenario('test-line-local'),
      hasVigilance: false,
      rigidConsist: true,
    });
    sim.input = { ...NEUTRAL_INPUT, powerNotch: 4 };
    for (let i = 0; i < 200; i++) sim.step(0.05);
  });
});
