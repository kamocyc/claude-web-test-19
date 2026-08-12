import { describe, expect, it } from 'vitest';
import {
  ChopperVoice,
  InverterVoice,
  ResistorVoice,
  SILENT_CHOPPER,
  SILENT_RESISTOR,
  type ChopperVoiceParams,
  type ResistorVoiceParams,
} from '@railsim/audio';
import { aWeightedRms, bandPower, goertzel, peakProminence, rms } from './spectrum.ts';

/** 実車の整流子片数。回転数からブラシの通過周波数を出すのに使う。 */
const COMMUTATOR_BARS = 93;
const commutatorFrequencyAt = (rpm: number) => (COMMUTATOR_BARS * rpm) / 60;

/**
 * 比較の基準になるインバータ音。
 * どの制御方式でもミキサのつまみ 1.0 でおおむね同じ大きさに聞こえてほしいので、
 * 直流機の音はこれを物差しにして較正してある。
 */
function renderInverterReference(): Float32Array {
  const voice = new InverterVoice(SAMPLE_RATE);
  voice.setParams({
    gate: true,
    fundamental: 45,
    carrier: 480,
    modulation: 1,
    pulses: 0,
    slotFrequency: 1200,
    level: 1,
  });
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  const out = new Float32Array(LENGTH);
  voice.render(out);
  return out;
}

const SAMPLE_RATE = 48_000;
/** 1 秒ぶんレンダすれば 1Hz 分解能で峰が見える */
const LENGTH = SAMPLE_RATE;

const resistorParams = (over: Partial<ResistorVoiceParams> = {}): ResistorVoiceParams => ({
  gate: true,
  current: 1,
  commutatorFrequency: 620,
  resistorPower: 0.6,
  steps: 0,
  groupChanges: 0,
  level: 1,
  ...over,
});

const chopperParams = (over: Partial<ChopperVoiceParams> = {}): ChopperVoiceParams => ({
  gate: true,
  current: 1,
  duty: 0.5,
  chopFrequency: 400,
  commutatorFrequency: 620,
  level: 1,
  ...over,
});

/** 定常状態を 1 秒ぶんレンダする（平滑化と共振の立ち上がりは捨てる） */
function renderResistor(p: ResistorVoiceParams, length = LENGTH): Float32Array {
  const voice = new ResistorVoice(SAMPLE_RATE);
  voice.setParams(p);
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  // 撃力は setParams のたびに予約されるので、定常の測定では鳴らさない
  voice.setParams({ ...p, steps: 0, groupChanges: 0 });
  const out = new Float32Array(length);
  voice.render(out);
  return out;
}

function renderChopper(p: ChopperVoiceParams, length = LENGTH): Float32Array {
  const voice = new ChopperVoice(SAMPLE_RATE);
  voice.setParams(p);
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  const out = new Float32Array(length);
  voice.render(out);
  return out;
}

describe('抵抗制御の主回路音', () => {
  it('無音のパラメータでは何も鳴らない', () => {
    const voice = new ResistorVoice(SAMPLE_RATE);
    voice.setParams(SILENT_RESISTOR);
    const out = new Float32Array(LENGTH);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('整流子の周波数に峰が立つ', () => {
    const out = renderResistor(resistorParams({ commutatorFrequency: 620, resistorPower: 0 }));
    expect(peakProminence(out, SAMPLE_RATE, 620, 90)).toBeGreaterThan(4);
  });

  it('音程は回転数だけで決まる（キャリアが無いので段では変わらない）', () => {
    const slow = renderResistor(resistorParams({ commutatorFrequency: 400, resistorPower: 0 }));
    const fast = renderResistor(resistorParams({ commutatorFrequency: 800, resistorPower: 0 }));
    expect(peakProminence(slow, SAMPLE_RATE, 400, 70)).toBeGreaterThan(4);
    expect(peakProminence(fast, SAMPLE_RATE, 800, 70)).toBeGreaterThan(4);
    // 速いほうに遅いほうの峰は立っていない
    expect(peakProminence(fast, SAMPLE_RATE, 400, 70)).toBeLessThan(3);
  });

  it('電流が大きいほど音が大きい（力は磁束 × 電流 ≒ 電流²）', () => {
    const half = renderResistor(resistorParams({ current: 0.5, resistorPower: 0 }));
    const full = renderResistor(resistorParams({ current: 1.0, resistorPower: 0 }));
    expect(rms(full)).toBeGreaterThan(rms(half) * 2.5);
  });

  it('起動抵抗を短絡すると低いうなりが消える', () => {
    const hot = renderResistor(resistorParams({ resistorPower: 1 }));
    const shorted = renderResistor(resistorParams({ resistorPower: 0 }));
    // 抵抗器のうなりの帯（100〜900Hz）で明確に差が出る
    expect(bandPower(hot, SAMPLE_RATE, 120, 600)).toBeGreaterThan(
      bandPower(shorted, SAMPLE_RATE, 120, 600) * 3,
    );
  });

  it('進段すると撃力が鳴り、短時間で減衰する', () => {
    const voice = new ResistorVoice(SAMPLE_RATE);
    voice.setParams(resistorParams({ gate: false, current: 0, resistorPower: 0, steps: 1 }));
    const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.5));
    voice.render(out);
    const head = out.subarray(0, Math.floor(SAMPLE_RATE * 0.05));
    const tail = out.subarray(Math.floor(SAMPLE_RATE * 0.3));
    expect(rms(head)).toBeGreaterThan(0);
    // 300ms 後にはほぼ収まっている
    expect(rms(tail)).toBeLessThan(rms(head) * 0.05);
  });

  it('直並列の組替えは進段より重い音になる', () => {
    const strike = (over: Partial<ResistorVoiceParams>) => {
      const voice = new ResistorVoice(SAMPLE_RATE);
      voice.setParams(resistorParams({ gate: false, current: 0, resistorPower: 0, ...over }));
      const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.3));
      voice.render(out);
      return rms(out);
    };
    expect(strike({ steps: 1, groupChanges: 1 })).toBeGreaterThan(strike({ steps: 1 }) * 1.5);
  });
});

describe('電機子チョッパの音', () => {
  it('無音のパラメータでは何も鳴らない', () => {
    const voice = new ChopperVoice(SAMPLE_RATE);
    voice.setParams(SILENT_CHOPPER);
    const out = new Float32Array(LENGTH);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('チョッパ周波数に峰が立つ', () => {
    const out = renderChopper(chopperParams({ commutatorFrequency: 0 }));
    expect(peakProminence(out, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
  });

  it('速度が変わっても音程が動かない（チョッパ車の音のいちばんの特徴）', () => {
    const slow = renderChopper(chopperParams({ commutatorFrequency: 300 }));
    const fast = renderChopper(chopperParams({ commutatorFrequency: 900 }));
    expect(peakProminence(slow, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
    expect(peakProminence(fast, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
  });

  it('全通流ではチョッパ音が消え、整流子の音だけが残る', () => {
    const chopping = renderChopper(chopperParams({ duty: 0.5, commutatorFrequency: 0 }));
    const full = renderChopper(chopperParams({ duty: 1, commutatorFrequency: 0 }));
    expect(bandPower(full, SAMPLE_RATE, 350, 450)).toBeLessThan(
      bandPower(chopping, SAMPLE_RATE, 350, 450) * 0.05,
    );
  });

  it('通流率 0.5 でリップルが最大になる', () => {
    const at = (duty: number) =>
      bandPower(
        renderChopper(chopperParams({ duty, commutatorFrequency: 0 })),
        SAMPLE_RATE,
        350,
        450,
      );
    expect(at(0.5)).toBeGreaterThan(at(0.2));
    expect(at(0.5)).toBeGreaterThan(at(0.85));
  });

  it('ゲートを切ると主回路の音が消え、電動機の音だけが残る', () => {
    const on = renderChopper(chopperParams({ commutatorFrequency: 620 }));
    const off = renderChopper(chopperParams({ gate: false, commutatorFrequency: 620 }));
    expect(bandPower(off, SAMPLE_RATE, 350, 450)).toBeLessThan(
      bandPower(on, SAMPLE_RATE, 350, 450) * 0.05,
    );
  });
});

describe('直流電動機の音の大きさと高域', () => {
  // 起動から最高速までの回転数（限流値制御なので電流はほぼ一定）
  const RPMS = [200, 600, 1000, 1400, 1800, 2200];
  const loudness = RPMS.map((rpm) =>
    aWeightedRms(
      renderResistor(
        resistorParams({ commutatorFrequency: commutatorFrequencyAt(rpm), resistorPower: 0 }),
      ),
      SAMPLE_RATE,
    ),
  );

  it('インバータ音とおおむね同じ大きさに収まる', () => {
    // 直流機のほうが大きいと、整流子の高い成分がそのまま耳につく。
    const reference = aWeightedRms(renderInverterReference(), SAMPLE_RATE);
    for (const level of loudness) {
      expect(level).toBeLessThan(reference * 2);
    }
    // 逆に小さすぎて聞こえないのも困る（走行中の代表的な回転数で確かめる）
    expect(loudness[3]!).toBeGreaterThan(reference * 0.5);
  });

  it('回転数が上がっても音量が跳ね上がらない', () => {
    // 共振を跨ぐぶんの上下はあってよいが、桁で変わってはいけない
    const running = loudness.slice(1);
    expect(Math.max(...running) / Math.min(...running)).toBeLessThan(2.5);
  });

  it('スペクトルが高域へ向かって落ちる（上がりっぱなしにならない）', () => {
    for (const rpm of RPMS) {
      const out = renderResistor(
        resistorParams({ commutatorFrequency: commutatorFrequencyAt(rpm), resistorPower: 0 }),
      );
      const mid = bandPower(out, SAMPLE_RATE, 800, 3000);
      const high = bandPower(out, SAMPLE_RATE, 4000, 14000);
      // 放射効率が高域を持ち上げるぶんを、質量制御のロールオフが上回っていること。
      // ここが逆転すると、回転が上がるほど金属的で耳につく音になる。
      expect(high).toBeLessThan(mid * 0.1);
    }
  });

  it('高域の量がインバータ音と同じ桁に収まる', () => {
    const reference = bandPower(renderInverterReference(), SAMPLE_RATE, 4000, 14000);
    const fast = renderResistor(
      resistorParams({ commutatorFrequency: commutatorFrequencyAt(2200), resistorPower: 0 }),
    );
    expect(bandPower(fast, SAMPLE_RATE, 4000, 14000)).toBeLessThan(reference * 10);
  });
});

describe('チョッパ音と主電動機の釣り合い', () => {
  it('チョッパ音が主電動機の音に埋もれない', () => {
    // この車の音のいちばんの特徴なので、整流子の音と同じ桁で鳴っていること。
    for (const rpm of [600, 1400, 2200]) {
      const out = renderChopper(
        chopperParams({ duty: 0.5, commutatorFrequency: commutatorFrequencyAt(rpm) }),
      );
      const chop = goertzel(out, SAMPLE_RATE, 400);
      const commutator = goertzel(out, SAMPLE_RATE, commutatorFrequencyAt(rpm));
      expect(chop / commutator).toBeGreaterThan(0.1);
      // かといって電動機を覆い隠すほどでもない
      expect(chop / commutator).toBeLessThan(3);
    }
  });
});
