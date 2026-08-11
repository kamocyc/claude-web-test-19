import { describe, expect, it } from 'vitest';
import { TrainNoiseSynth, type TrainNoiseParams } from '@railsim/audio';
import { bandPower, peakProminence, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;

const silence = (): TrainNoiseParams => ({
  inverter: {
    fundamental: 0,
    carrier: 0,
    modulation: 0,
    pulses: 0,
    slotFrequency: 0,
    level: 0,
  },
  runningGear: {
    speed: 0,
    gearMeshFrequency: 0,
    shaftFrequency: 0,
    gearLoad: 0,
    level: 0,
  },
  brake: { speed: 0, cylinderPressure: 0, pressureRate: 0, level: 0 },
  auxiliary: { compressor: 0, level: 0 },
});

const merge = (over: Partial<TrainNoiseParams>): TrainNoiseParams => ({ ...silence(), ...over });

function render(p: TrainNoiseParams, seconds = 1): Float32Array {
  const synth = new TrainNoiseSynth(SAMPLE_RATE);
  synth.setParams(p);
  synth.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.3)));
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  synth.render(out);
  return out;
}

describe('走行音の合成全体', () => {
  it('すべての音源が無音なら完全な無音になる', () => {
    expect(rms(render(silence()))).toBeLessThan(1e-5);
  });

  it('混ざっても出力が [-1, 1] に収まる', () => {
    const x = render(
      merge({
        inverter: {
          fundamental: 40,
          carrier: 360,
          modulation: 0.8,
          pulses: 9,
          slotFrequency: 900,
          level: 1,
        },
        runningGear: {
          speed: 30,
          gearMeshFrequency: 1200,
          shaftFrequency: 70,
          gearLoad: 1,
          level: 1,
        },
        brake: { speed: 30, cylinderPressure: 1, pressureRate: -2, level: 1 },
        auxiliary: { compressor: 1, level: 1 },
      }),
    );
    for (let i = 0; i < x.length; i++) {
      expect(Number.isFinite(x[i]!)).toBe(true);
      expect(Math.abs(x[i]!)).toBeLessThanOrEqual(1);
    }
    expect(rms(x)).toBeGreaterThan(0.05);
  });
});

describe('走行装置の音', () => {
  const running = (over: Partial<TrainNoiseParams['runningGear']>): TrainNoiseParams =>
    merge({
      runningGear: { ...silence().runningGear, level: 1, ...over },
    });

  it('歯車のかみ合い周波数に峰が立ち、その高調波も出る', () => {
    const mesh = 900;
    const x = render(
      running({ speed: 20, gearMeshFrequency: mesh, shaftFrequency: 53, gearLoad: 1 }),
    );
    expect(peakProminence(x, SAMPLE_RATE, mesh, 120)).toBeGreaterThan(10);
    expect(peakProminence(x, SAMPLE_RATE, 2 * mesh, 120)).toBeGreaterThan(10);
  });

  it('歯形誤差で 1 回転ごとの側帯波が付く（うなりの正体）', () => {
    const mesh = 900;
    const shaft = 53;
    const x = render(
      running({ speed: 20, gearMeshFrequency: mesh, shaftFrequency: shaft, gearLoad: 1 }),
    );
    expect(peakProminence(x, SAMPLE_RATE, mesh - shaft, shaft / 2)).toBeGreaterThan(6);
    expect(peakProminence(x, SAMPLE_RATE, mesh + shaft, shaft / 2)).toBeGreaterThan(6);
  });

  it('惰行しても歯車の音は消えない（インバータ音との決定的な違い）', () => {
    const mesh = 900;
    const powering = render(
      running({ speed: 20, gearMeshFrequency: mesh, shaftFrequency: 53, gearLoad: 1 }),
    );
    const coasting = render(
      running({ speed: 20, gearMeshFrequency: mesh, shaftFrequency: 53, gearLoad: 0 }),
    );
    expect(peakProminence(coasting, SAMPLE_RATE, mesh, 120)).toBeGreaterThan(10);
    // 力行のほうが強いが、惰行でも半分程度は残る
    const ratio =
      bandPower(coasting, SAMPLE_RATE, 880, 920) / bandPower(powering, SAMPLE_RATE, 880, 920);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(1);
  });

  it('転動音が 30·log₁₀v で増える（速度 2 倍で約 9dB）', () => {
    const level = (v: number): number =>
      rms(render(running({ speed: v, gearMeshFrequency: 0, shaftFrequency: 0, gearLoad: 0 })));
    const a = level(10);
    const b = level(20);
    const db = 20 * Math.log10(b / a);
    // 振幅 ∝ v^1.5 なので、速度 2 倍で 20·log10(2^1.5) = 9.03 dB
    expect(db).toBeGreaterThan(8);
    expect(db).toBeLessThan(10);
  });

  it('停止していれば走行装置は無音', () => {
    expect(rms(render(running({ speed: 0 })))).toBeLessThan(1e-5);
  });

  it('高速ほど転動音のスペクトル重心が上がる', () => {
    const slow = render(running({ speed: 8 }));
    const fast = render(running({ speed: 33 }));
    const centroid = (x: Float32Array): number => {
      let num = 0;
      let den = 0;
      for (let f = 200; f <= 3000; f += 50) {
        const p = bandPower(x, SAMPLE_RATE, f - 25, f + 25, 4);
        num += f * p;
        den += p;
      }
      return num / den;
    };
    expect(centroid(fast)).toBeGreaterThan(centroid(slow));
  });
});

describe('ブレーキと空気の音', () => {
  const brake = (over: Partial<TrainNoiseParams['brake']>): TrainNoiseParams =>
    merge({ brake: { ...silence().brake, level: 1, ...over } });

  it('摩擦音は押付力と速度の両方が要る', () => {
    const moving = rms(render(brake({ speed: 20, cylinderPressure: 0.8 })));
    const stopped = rms(render(brake({ speed: 0, cylinderPressure: 0.8 })));
    const released = rms(render(brake({ speed: 20, cylinderPressure: 0 })));
    expect(moving).toBeGreaterThan(stopped * 5);
    expect(moving).toBeGreaterThan(released * 5);
  });

  it('鳴きは低速で押付力が強いときだけ出る', () => {
    const squealing = render(brake({ speed: 2.5, cylinderPressure: 0.9 }));
    const fast = render(brake({ speed: 25, cylinderPressure: 0.9 }));
    // 2.6kHz の鋭い共振
    expect(peakProminence(squealing, SAMPLE_RATE, 2600, 700)).toBeGreaterThan(3);
    expect(peakProminence(squealing, SAMPLE_RATE, 2600, 700)).toBeGreaterThan(
      peakProminence(fast, SAMPLE_RATE, 2600, 700),
    );
  });

  it('緩めの排気音は込めの音より大きい（大気開放だから）', () => {
    const fill = rms(render(brake({ speed: 15, cylinderPressure: 0.5, pressureRate: 1.5 })));
    const release = rms(render(brake({ speed: 15, cylinderPressure: 0.5, pressureRate: -1.5 })));
    expect(release).toBeGreaterThan(fill * 1.5);
  });
});

describe('補機の音', () => {
  it('空気圧縮機は回転周期の峰を持つ（連続音ではなく打撃の列）', () => {
    const x = render(merge({ auxiliary: { compressor: 1, level: 1 } }));
    // 2 気筒なので 16.5Hz の 2 倍 = 33Hz ごとに吐出しが起きる
    expect(peakProminence(x, SAMPLE_RATE, 33, 8)).toBeGreaterThan(4);
    expect(rms(x)).toBeGreaterThan(1e-3);
  });

  it('止まっていれば無音', () => {
    expect(rms(render(merge({ auxiliary: { compressor: 0, level: 1 } })))).toBeLessThan(1e-5);
  });
});

describe('レール継目の衝撃', () => {
  it('予約したサンプル位置ちょうどから鳴り始める', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerJoint({ delay: 1000, strength: 1 });
    const out = new Float32Array(4096);
    synth.render(out);

    let first = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]!) > 1e-6) {
        first = i;
        break;
      }
    }
    expect(first).toBe(1000);
  });

  it('衝撃は短く減衰し、鳴りっぱなしにならない', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerJoint({ delay: 0, strength: 1 });
    const out = new Float32Array(SAMPLE_RATE);
    synth.render(out);
    const head = rms(out.subarray(0, 2400));
    const tail = rms(out.subarray(SAMPLE_RATE - 2400));
    expect(head).toBeGreaterThan(1e-3);
    expect(tail).toBeLessThan(head / 100);
  });

  it('走行音に混ざっても衝撃として聞き取れる', () => {
    // 帯域通過を通した衝撃は、正規化のせいで見た目より遥かに小さくなる。
    // 「鳴ってはいるが転動音に埋もれて区別できない」という失敗をしたので、
    // 実際の走行音を背景に置いて突出しているかどうかで固める。
    const background: TrainNoiseParams = merge({
      runningGear: {
        speed: 24.7, // 約 90km/h
        gearMeshFrequency: 1050,
        shaftFrequency: 62,
        gearLoad: 0,
        level: 1,
      },
    });

    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(background);
    synth.render(new Float32Array(SAMPLE_RATE));

    const quiet = new Float32Array(2400);
    synth.render(quiet);
    synth.triggerJoint({ delay: 0, strength: 1 });
    const struck = new Float32Array(2400);
    synth.render(struck);

    // 衝撃の直後 50ms は、直前の 50ms より明確に大きくなければならない
    expect(rms(struck)).toBeGreaterThan(rms(quiet) * 1.8);
    let peak = 0;
    for (const v of struck) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(rms(quiet) * 4);
  });

  it('強さに比例した音量になる', () => {
    const shot = (strength: number): number => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(silence());
      synth.triggerJoint({ delay: 0, strength });
      const out = new Float32Array(SAMPLE_RATE / 2);
      synth.render(out);
      return rms(out);
    };
    expect(shot(0.5)).toBeGreaterThan(shot(0.2));
    expect(shot(1)).toBeGreaterThan(shot(0.5));
  });

  it('同じ入力なら同じ波形になる（決定論）', () => {
    const once = (): string => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(
        merge({
          runningGear: {
            speed: 25,
            gearMeshFrequency: 1000,
            shaftFrequency: 59,
            gearLoad: 0.7,
            level: 1,
          },
        }),
      );
      synth.triggerJoint({ delay: 128, strength: 0.8 });
      const out = new Float32Array(8192);
      synth.render(out);
      return Array.from(out).join(',');
    };
    expect(once()).toBe(once());
  });
});
