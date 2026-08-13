import { describe, expect, it } from 'vitest';
import {
  PassingVoice,
  RollingVoice,
  SILENT_PASSING,
  type PassingVoiceParams,
} from '@railsim/audio';
import { bandPower, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
/** 相手の編成長 [m]（4 両） */
const LENGTH = 80;

const params = (over: Partial<PassingVoiceParams> = {}): PassingVoiceParams => ({
  ...SILENT_PASSING,
  present: true,
  headGap: 0,
  tailGap: LENGTH,
  closingSpeed: 28,
  otherSpeed: 28,
  gearMeshFrequency: 0,
  separation: 3.4,
  level: 1,
  ...over,
});

/** 相手が動かない前提で、その位置関係のまま鳴らす（圧力波は起きない） */
function render(p: PassingVoiceParams, seconds = 0.5): Float32Array {
  const voice = new PassingVoice(SAMPLE_RATE);
  voice.setParams(p);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/** 相手を `head` まで近づけてすれ違わせ、そのときの波形を返す */
function sweep(from: number, to: number, over: Partial<PassingVoiceParams> = {}): Float32Array {
  const voice = new PassingVoice(SAMPLE_RATE);
  const closing = over.closingSpeed ?? 28;
  const block = 1024;
  const frames = Math.ceil(((from - to) / closing / block) * SAMPLE_RATE);
  const out = new Float32Array(frames * block);
  const buffer = new Float32Array(block);
  for (let frame = 0; frame < frames; frame++) {
    const head = from - (closing * frame * block) / SAMPLE_RATE;
    voice.setParams(params({ ...over, headGap: head, tailGap: head + LENGTH }));
    buffer.fill(0);
    voice.render(buffer);
    out.set(buffer, frame * block);
  }
  return out;
}

/**
 * すれ違いの瞬間（`at` を跨いだ直後）の 0.2 秒の実効値。
 *
 * 圧力波は「先頭が並んだ瞬間」と「最後尾が抜けた瞬間」に来るので、その位置を
 * 跨いだ直後だけを測れば、並走中の定常音と分けて比べられる。
 */
function pulseRms(over: Partial<PassingVoiceParams>, tail = false): number {
  const voice = new PassingVoice(SAMPLE_RATE);
  const head = tail ? -LENGTH + 2 : 2;
  voice.setParams(params({ ...over, headGap: head, tailGap: head + LENGTH }));
  const warm = new Float32Array(1024);
  voice.render(warm);
  // 跨いだ位置へ進める（ここで圧力波が起きる）
  voice.setParams(params({ ...over, headGap: head - 4, tailGap: head - 4 + LENGTH }));
  const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.2));
  voice.render(out);
  return rms(out);
}

describe('対向列車とのすれ違い', () => {
  it('隣の線路に誰も居なければ鳴らない', () => {
    expect(rms(render(params({ present: false })))).toBe(0);
  });

  it('並んでいるあいだがいちばん大きい', () => {
    const far = rms(render(params({ headGap: 200, tailGap: 280 })));
    const near = rms(render(params({ headGap: 30, tailGap: 110 })));
    const beside = rms(render(params({ headGap: -40, tailGap: 40 })));
    expect(near).toBeGreaterThan(far * 2);
    expect(beside).toBeGreaterThan(near * 2);
  });

  it('至近距離ですれ違うので、自分の走行音に匹敵する大きさになる', () => {
    const rolling = new RollingVoice(SAMPLE_RATE);
    rolling.setParams({ speed: 25, corrugation: 0.2, level: 1 });
    const reference = new Float32Array(SAMPLE_RATE);
    rolling.render(reference);
    const beside = rms(render(params({ headGap: -40, tailGap: 40 })));
    expect(beside).toBeGreaterThan(rms(reference) * 0.4);
    expect(beside).toBeLessThan(rms(reference) * 3);
  });

  it('近づくあいだは音程が高く、離れるあいだは低い（ドップラー効果）', () => {
    const centre = (x: Float32Array): number => {
      // 帯域の重心。転動音の帯（相手 28m/s なら 770Hz あたり）が上下する。
      let weighted = 0;
      let total = 0;
      for (let f = 400; f <= 1400; f += 20) {
        const power = bandPower(x, SAMPLE_RATE, f - 10, f + 10, 4);
        weighted += f * power;
        total += power;
      }
      return weighted / total;
    };
    const approaching = centre(render(params({ headGap: 60, tailGap: 140 })));
    const receding = centre(render(params({ headGap: -140, tailGap: -60 })));
    expect(approaching).toBeGreaterThan(receding * 1.05);
  });

  it('先頭がすれ違う瞬間に圧力波が来る', () => {
    // 並走中の定常音（圧力波の起きない状態）と、跨いだ直後を比べる
    const steady = rms(render(params({ headGap: -40, tailGap: 40 })));
    expect(pulseRms({})).toBeGreaterThan(steady * 2);
  });

  it('圧力波は相対速度の 2 乗で効く', () => {
    // 相手の走行音が混ざらないよう、相手は止まっていて自分だけが動く条件で測る
    const slow = pulseRms({ closingSpeed: 10, otherSpeed: 0 });
    const fast = pulseRms({ closingSpeed: 30, otherSpeed: 0 });
    // 3 倍の相対速度なら 9 倍。動圧が速度の 2 乗に比例することがそのまま出る。
    expect(fast / slow).toBeGreaterThan(7);
    expect(fast / slow).toBeLessThan(11);
  });

  it('最後尾が抜けるときにも圧力波が来る（対で「バン…バン」になる）', () => {
    const middle = rms(render(params({ headGap: -40, tailGap: 40, otherSpeed: 0 })));
    expect(pulseRms({ otherSpeed: 0 }, true)).toBeGreaterThan(middle * 2);
  });

  it('相手の歯車のかみ合い音が乗る', () => {
    const at = (x: Float32Array, f: number): number =>
      bandPower(x, SAMPLE_RATE, f * 0.98, f * 1.02);
    const mesh = 520;
    const withGear = render(params({ headGap: -40, tailGap: 40, gearMeshFrequency: mesh }), 1);
    const without = render(params({ headGap: -40, tailGap: 40, gearMeshFrequency: 0 }), 1);
    // 転動音は広帯域だが、歯車はかみ合い周波数に線が立つ
    expect(at(withGear, mesh)).toBeGreaterThan(at(without, mesh) * 20);
    // 2 倍の高調波も出る（歯面のかみ合いは正弦ではない）
    expect(at(withGear, mesh * 2)).toBeGreaterThan(at(without, mesh * 2) * 5);
  });

  it('歯車の音程もドップラーで動く（近づくと高く、離れると低い）', () => {
    const mesh = 520;
    const peak = (x: Float32Array): number => {
      let best = mesh;
      let bestPower = -Infinity;
      for (let f = mesh * 0.85; f <= mesh * 1.15; f += 1) {
        const power = bandPower(x, SAMPLE_RATE, f - 1, f + 1, 2);
        if (power > bestPower) {
          bestPower = power;
          best = f;
        }
      }
      return best;
    };
    const approaching = peak(
      render(params({ headGap: 120, tailGap: 200, gearMeshFrequency: mesh }), 1),
    );
    const receding = peak(
      render(params({ headGap: -200, tailGap: -120, gearMeshFrequency: mesh }), 1),
    );
    // 相対速度 28m/s なら前後で 1.08 倍と 0.92 倍
    expect(approaching).toBeGreaterThan(mesh * 1.05);
    expect(receding).toBeLessThan(mesh * 0.95);
  });

  it('音量を 0 にすれば鳴らない', () => {
    expect(rms(sweep(60, -60, { level: 0 }))).toBe(0);
    expect(pulseRms({ level: 0 })).toBe(0);
  });
});
