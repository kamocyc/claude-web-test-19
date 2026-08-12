import { describe, expect, it } from 'vitest';
import { Simulation } from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

/** 停車状態から始めて、扉を開けてから閉め直すまでを回す */
function stoppedSim() {
  const sim = new Simulation(createDefaultLibrary().scenario('test-line-local'));
  // 停車のままにしたいのでブレーキを込めておく
  sim.input = { ...sim.input, brakeNotch: 4 };
  for (let i = 0; i < 200; i++) sim.step(0.01);
  return sim;
}

describe('戸閉連動', () => {
  it('開扉指令を出すと扉が動き、力行が切れる', () => {
    const sim = stoppedSim();
    expect(sim.snapshot().doors.interlocked).toBe(true);

    sim.input = { ...sim.input, doorsClosed: false };
    for (let i = 0; i < 50; i++) sim.step(0.01);
    expect(sim.snapshot().doors.moving).toBe(true);
    expect(sim.snapshot().doors.interlocked).toBe(false);
  });

  it('閉指令を出しても、閉まり切るまでは力行できない', () => {
    const sim = stoppedSim();
    sim.input = { ...sim.input, doorsClosed: false };
    for (let i = 0; i < 400; i++) sim.step(0.01);
    expect(sim.snapshot().doors.phase).toBe('open');

    // 閉指令 + 全力行ノッチ。扉が閉まり切るまで引張力は出ない。
    sim.input = { ...sim.input, doorsClosed: true, brakeNotch: 0, powerNotch: 4 };
    const spec = sim.scenario.consist.door;
    const beforeLatch = Math.round((spec.closeWarningTime + spec.closeTime - 0.1) / 0.01);
    for (let i = 0; i < beforeLatch; i++) {
      sim.step(0.01);
      expect(sim.snapshot().tractiveEffort).toBe(0);
      expect(sim.snapshot().doors.interlocked).toBe(false);
    }

    // 閉まり切れば連動が成立し、力行が入る
    for (let i = 0; i < 100; i++) sim.step(0.01);
    expect(sim.snapshot().doors.interlocked).toBe(true);
    expect(sim.snapshot().tractiveEffort).toBeGreaterThan(0);
  });

  it('扉の開閉は決定論的（同じ入力なら同じ時刻に施錠される）', () => {
    const latchTimeOf = () => {
      const sim = stoppedSim();
      sim.input = { ...sim.input, doorsClosed: false };
      for (let i = 0; i < 400; i++) sim.step(0.01);
      sim.input = { ...sim.input, doorsClosed: true };
      for (let i = 0; i < 600; i++) {
        sim.step(0.01);
        if (sim.snapshot().doors.latchEvents > 0) return sim.elapsed;
      }
      throw new Error('施錠されませんでした');
    };
    expect(latchTimeOf()).toBe(latchTimeOf());
  });

  it('自動運転でも扉が開閉し、チャイムが鳴る', () => {
    const sim = new Simulation(createDefaultLibrary().scenario('test-line-local'));
    sim.setAutoDrive(true);
    let sawOpen = false;
    let sawChime = false;
    let sawLatch = false;
    for (let i = 0; i < 30_000; i++) {
      sim.step(0.01);
      const doors = sim.snapshot().doors;
      if (doors.phase === 'open') sawOpen = true;
      if (doors.chiming) sawChime = true;
      if (doors.latchEvents > 0) sawLatch = true;
      if (sawOpen && sawChime && sawLatch) break;
    }
    expect(sawOpen).toBe(true);
    expect(sawChime).toBe(true);
    expect(sawLatch).toBe(true);
  });
});
