import { describe, expect, it } from 'vitest';
import { commuter4ScaleVehicle, commuter4Vehicle, compileVehicle } from '@railsim/data';
import { createDefaultLibrary } from '@railsim/data';
import { InverterModulation, Simulation, mpsToKmh, type VvvfTractionSpec } from '@railsim/core';

const vvvfSpecOf = (definition: typeof commuter4ScaleVehicle): VvvfTractionSpec => {
  const s = compileVehicle(definition).vehicles[1]?.traction;
  if (s?.kind !== 'vvvf') throw new Error('VVVF の仕様が取れません');
  return s;
};

const scale = () => vvvfSpecOf(commuter4ScaleVehicle);

/** 平均律の半音比 */
const SEMITONE = Math.pow(2, 1 / 12);

/**
 * 出力周波数 `f1` で落ち着いたときのキャリア周波数を返す。
 *
 * `InverterModulation` はパルスモードのヒステリシスとトルク指令の平滑を持つので、
 * 1 回呼んだだけでは前の状態を引きずる。定常値が見たいので数十周期ぶん回す。
 */
function settledCarrier(modulation: InverterModulation, spec: VvvfTractionSpec, f1: number) {
  // 出力周波数 = 回転子周波数 + すべり周波数。逆算して軸の角速度を作る。
  const rotorFrequency = Math.max(0, f1 - spec.inverter.ratedSlipFrequency);
  const axleAngularVelocity =
    ((rotorFrequency / spec.inverter.polePairs) * 2 * Math.PI) / spec.gearRatio;
  let state = modulation.step(0.01, { axleAngularVelocity, torqueRatio: 1 });
  for (let i = 0; i < 50; i++) {
    state = modulation.step(0.01, { axleAngularVelocity, torqueRatio: 1 });
  }
  return state;
}

describe('音階インバータ', () => {
  it('コアを 1 行も変えずに、変調の折れ線だけで表せている', () => {
    // 既定の GTO 車とまったく同じ型・同じ枠組み。違うのは表の中身だけ。
    const plain = vvvfSpecOf(commuter4Vehicle);
    expect(Object.keys(scale().inverter).sort()).toEqual(Object.keys(plain.inverter).sort());
    // 段数が段違いに多い（既定は 3 段）
    expect(new Set(scale().inverter.asyncCarrier.map(([, c]) => c)).size).toBeGreaterThan(10);
    expect(new Set(plain.inverter.asyncCarrier.map(([, c]) => c)).size).toBeLessThan(5);
  });

  it('段の高さが平均律の音名になっている', () => {
    const notes = [...new Set(scale().inverter.asyncCarrier.map(([, c]) => c))];
    // 昇順で、隣り合う段は全音（2 半音）か半音
    for (let i = 1; i < notes.length; i++) {
      const semitones = Math.log(notes[i]! / notes[i - 1]!) / Math.log(SEMITONE);
      expect(Math.abs(semitones - Math.round(semitones))).toBeLessThan(0.01);
      expect(Math.round(semitones)).toBeGreaterThanOrEqual(1);
      expect(Math.round(semitones)).toBeLessThanOrEqual(2);
    }
    // ソラシド レミファソ ラシドレ の 12 段で 2 オクターブ弱
    expect(notes).toHaveLength(12);
    expect(notes.at(-1)! / notes[0]!).toBeGreaterThan(2.5);
    expect(notes).toContain(440); // A4
    expect(notes).toContain(220); // A3
  });

  it('出力周波数を上げるとキャリアが階段状に上る（連続に上がるのではない）', () => {
    const spec = scale();
    const modulation = new InverterModulation(spec);
    const samples: number[] = [];
    for (let f1 = 2; f1 <= 40; f1 += 0.5) {
      const state = settledCarrier(modulation, spec, f1);
      if (state.mode === 'async') samples.push(state.carrierFrequency);
    }
    expect(samples.length).toBeGreaterThan(50);

    // 隣り合うサンプルの差を見ると、大半は 0（段の上を歩いている）で、
    // ときどき大きく跳ぶ（次の音へ移る）。連続な傾斜ならこうはならない。
    const deltas = samples.slice(1).map((c, i) => c - samples[i]!);
    const flat = deltas.filter((d) => Math.abs(d) < 0.01).length;
    const jumps = deltas.filter((d) => d > 5).length;
    expect(flat / deltas.length).toBeGreaterThan(0.6);
    expect(jumps).toBeGreaterThanOrEqual(8);
    // 下る向きへは動かない（力行中に音程が下がらない）
    expect(deltas.every((d) => d > -0.01)).toBe(true);
  });

  it('減速すると同じ階段を下りてくる（キャリアは出力周波数の関数）', () => {
    const spec = scale();
    const modulation = new InverterModulation(spec);
    const points = [4, 8, 12, 16, 20, 24, 28];
    const up = points.map((f) => settledCarrier(modulation, spec, f).carrierFrequency);
    const down = [...points]
      .reverse()
      .map((f) => settledCarrier(modulation, spec, f).carrierFrequency);
    expect(down.reverse()).toEqual(up);
  });

  it('走りは既定の通勤形とまったく同じ（変調は引張力に関与しない）', () => {
    const run = (scenarioId: string) => {
      const sim = new Simulation(createDefaultLibrary().scenario(scenarioId));
      sim.input = { ...sim.input, powerNotch: 4 };
      for (let i = 0; i < 3000; i++) sim.step(0.01);
      return { speed: mpsToKmh(sim.speed), front: sim.dynamics.frontPosition };
    };
    const plain = run('test-line-local');
    const musical = run('test-line-scale');
    expect(musical.speed).toBeCloseTo(plain.speed, 9);
    expect(musical.front).toBeCloseTo(plain.front, 9);
  });
});
