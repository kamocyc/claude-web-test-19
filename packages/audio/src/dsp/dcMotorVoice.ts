import { Biquad, DcBlocker, OnePoleHighPass, Smoothed } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/**
 * 直流直巻電動機の固定子・フレームの構造共振 [周波数 Hz, Q, 重み]。
 *
 * 誘導電動機（`inverterVoice.ts` の既定値）より低いところに寄っている。直流機は
 * 界磁鉄心と継鉄で外殻が組まれていて重く、しかも冷却のために大きな送風路が
 * 空いているので、箱として低く鳴る。VVVF 車と抵抗制御車の音色の違いは、
 * 変調のあるなしだけでなくこの共振の位置の違いでもある。
 */
export const DC_MOTOR_RESONANCES: ReadonlyArray<readonly [number, number, number]> = [
  [420, 6, 1.0],
  [980, 8, 0.65],
  [1850, 10, 0.4],
  [3100, 12, 0.22],
];

/**
 * 放射効率の一致（コインシデンス）周波数 [Hz]。
 * `inverterVoice.ts` と同じ理由でここから上が平坦、下は f² で落ちる。
 */
const COINCIDENCE_FREQUENCY = 2200;

/** 放射効率を入れたことによる全体の落ちを補う */
const RADIATION_GAIN = 2.6;

/** 整流子音のパラメータ */
export interface CommutatorParams {
  /** ブラシが整流子片を渡る周波数 [Hz] = 片数 × 回転数/60 */
  readonly frequency: number;
  /** 定格に対する電機子電流 0..（1 を超えてよい） */
  readonly current: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_COMMUTATOR: CommutatorParams = {
  frequency: 0,
  current: 0,
  level: 0,
};

/**
 * 整流子片を渡る調波の重み。
 *
 * ブラシが 1 片から次の片へ移るたびに電流が転流し、そのつど電磁力が跳ねる。
 * 波形は正弦ではなく尖った繰り返しなので、基音より 2 次・3 次のほうがよく出る。
 */
const HARMONIC_WEIGHTS: readonly number[] = [0.6, 1.0, 0.7, 0.35, 0.18];

/** ブラシの接触抵抗のゆらぎ（広帯域のシャリシャリ）の深さ */
const BRUSH_NOISE_DEPTH = 0.35;

/**
 * 直流電動機そのものの音（抵抗制御・チョッパに共通）。
 *
 * VVVF の音といちばん違うのは、**キャリアが無い**ことである。音程を決める量が
 * 回転数しかないので、力行しているあいだ音程は速度に比例して素直に上がり続け、
 * 途中で飛んだり落ちたりしない。段が進んでも、界磁を弱めても、音程は変わらない
 * （変わるのは音量だけ）。抵抗制御車の走行音が「モーターがただ唸って上がっていく」
 * ように聞こえるのはこのためである。
 *
 * 力は磁束 × 電流で、直巻機の磁束は電流が作るので、音量はおおむね電流の 2 乗に
 * 比例する。限流値制御をしているあいだ電流はほぼ一定なので、**起動から加速中は
 * 音量が変わらず音程だけが上がる**という、これも実車どおりの振る舞いになる。
 */
export class CommutatorTone {
  private readonly resonators: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly radiation: OnePoleHighPass;
  private readonly dcBlock: DcBlocker;
  private readonly noise = new Noise(0x27b1);
  private readonly noiseBand: Biquad;
  private readonly levelSmooth: Smoothed;
  private readonly currentSmooth: Smoothed;
  private readonly frequencySmooth: Smoothed;

  private theta = 0;
  private params: CommutatorParams = SILENT_COMMUTATOR;

  constructor(readonly sampleRate: number) {
    for (const [frequency, q, weight] of DC_MOTOR_RESONANCES) {
      this.resonators.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
    }
    this.radiation = new OnePoleHighPass(sampleRate, COINCIDENCE_FREQUENCY);
    this.dcBlock = new DcBlocker(sampleRate, 25);
    this.noiseBand = new Biquad().bandPass(sampleRate, 2600, 0.7);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    // 電流の鈍り。実機の電流も電機子回路のインダクタンスで鈍るが、ここでは
    // 制御周期（10ms）ごとの階段を均すためだけのごく短い平滑。
    this.currentSmooth = new Smoothed(sampleRate, 0.015);
    this.frequencySmooth = new Smoothed(sampleRate, 0.01);
  }

  setParams(params: CommutatorParams): void {
    this.params = params;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const p = this.params;
    const dt = 1 / this.sampleRate;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const current = this.currentSmooth.process(p.current);
      const frequency = this.frequencySmooth.process(p.frequency);
      if (level <= 1e-5) {
        // 位相とフィルタは回し続ける（再投入で不連続にならないように）
        this.theta = wrap(this.theta + TWO_PI * frequency * dt);
        continue;
      }

      this.theta = wrap(this.theta + TWO_PI * frequency * dt);

      let excitation = 0;
      for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) {
        excitation += HARMONIC_WEIGHTS[h]! * Math.sin((h + 1) * this.theta);
      }
      // ブラシの接触抵抗のゆらぎ。整流子の位相に同期して強弱がつく。
      const brush =
        this.noiseBand.process(this.noise.next()) *
        BRUSH_NOISE_DEPTH *
        (1 + 0.5 * Math.sin(this.theta));

      // 電磁力 ∝ 磁束 × 電流。直巻機は磁束を電流が作るので、実質 電流² になる。
      const force = this.dcBlock.process((excitation + brush) * current * current);

      let radiated = force * 0.25;
      for (let r = 0; r < this.resonators.length; r++) {
        radiated += this.resonators[r]!.process(force) * this.weights[r]!;
      }
      out[i] = out[i]! + this.radiation.process(radiated) * RADIATION_GAIN * level;
    }
  }

  reset(): void {
    this.theta = 0;
    this.dcBlock.reset();
    this.radiation.reset();
    this.noiseBand.reset();
    for (const f of this.resonators) f.reset();
    this.levelSmooth.set(0);
    this.currentSmooth.set(0);
    this.frequencySmooth.set(0);
  }
}

/** 位相を [0, 2π) に畳む */
export function wrapPhase(theta: number): number {
  return wrap(theta);
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
