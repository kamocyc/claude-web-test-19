import { describe, expect, it } from 'vitest';
import {
  ChopperVoice,
  ResistorVoice,
  SILENT_CHOPPER,
  SILENT_RESISTOR,
  type ChopperVoiceParams,
  type ResistorVoiceParams,
} from '@railsim/audio';
import { bandPower, peakProminence, rms } from './spectrum.ts';

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
