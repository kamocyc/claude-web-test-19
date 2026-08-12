import { Biquad, DcBlocker, OnePoleHighPass, OnePoleLowPass, Smoothed } from './biquad.ts';
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
  [420, 4, 1.0],
  [980, 5, 0.7],
  [1850, 6, 0.5],
  [3100, 7, 0.32],
];

/**
 * 放射効率の一致（コインシデンス）周波数 [Hz]。
 * `inverterVoice.ts` と同じ理由でここから上が平坦、下は f² で落ちる。
 */
const COINCIDENCE_FREQUENCY = 2200;

/**
 * 放射効率と質量制御のロールオフを入れたことによる全体の落ちを補う。
 *
 * 値は実測して決めてある。ミキサのつまみを 1.0 にしたとき、A 特性実効値が
 * インバータ音（`inverterVoice.ts`）とおおむね揃うようにしてある。揃えていないと
 * 車両を切り替えるたびに音量を取り直すことになるし、直流機のほうが大きいと
 * 整流子の高い成分がそのまま耳につく。
 */
const RADIATION_GAIN = 0.8;

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
 * ただし**その跳ねは尖っていない**。ブラシは 1 片より広く整流子に当たっていて、
 * 転流するコイルはその間ブラシに短絡されているため、電流は有限の時間をかけて
 * 移る。跳ねの立ち上がりが 1 片ぶんの時間と同程度に鈍るということは、次数が
 * 上がるほど成分が落ちるということで、およそ `1/n²` になる。
 *
 * ここを「基音より 2 次・3 次のほうが強い」と置くと、回転が上がったときに
 * 実車ではありえない金属的な高音になる。
 */
const HARMONIC_WEIGHTS: readonly number[] = [1.0, 0.4, 0.16, 0.07];

/**
 * 構造が質量制御に入る周波数 [Hz]。
 *
 * 共振より十分上では、固定子とフレームは剛性ではなく**質量**で応答が決まるので、
 * 加振力に対する応答が落ちていく。
 *
 * インバータ音（`inverterVoice.ts`）ではこの役目を磁束の積分（利得 ∝ 1/f）が
 * 果たしていた。整流子音には積分が無いので、代わりにこれを置かないと高域が
 * 上がりっぱなしになり、回転が上がるほど耳につく音になってしまう。
 *
 * 傾きは 1 極（−6dB/oct）にしてある。一致周波数より上では放射効率が平坦なので、
 * 正味 `−20·log₁₀f` — インバータ音とまったく同じ傾きになる。2 極にすると
 * 高速域で電動機の音がほとんど消えてしまい、これも実車と違う。
 */
export const MASS_CONTROLLED_FREQUENCY = 1600;

/** ブラシの接触抵抗のゆらぎ（広帯域のかすれ）の深さ */
const BRUSH_NOISE_DEPTH = 0.12;

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
  /** 質量制御域のロールオフ（1 極・−6dB/oct） */
  private readonly massRolloff: OnePoleLowPass;
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
    this.noiseBand = new Biquad().bandPass(sampleRate, 1400, 0.5);
    this.massRolloff = new OnePoleLowPass(sampleRate, MASS_CONTROLLED_FREQUENCY);
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
      // 放射効率（一致周波数より下は f² で落ちる）→ 質量制御のロールオフ の順に通す。
      // 前者が高域を持ち上げ、後者が落とす。正味の傾きがこの音の性格を決める。
      const y = this.massRolloff.process(this.radiation.process(radiated));
      out[i] = out[i]! + y * RADIATION_GAIN * level;
    }
  }

  reset(): void {
    this.theta = 0;
    this.dcBlock.reset();
    this.radiation.reset();
    this.noiseBand.reset();
    for (const f of this.resonators) f.reset();
    this.massRolloff.reset();
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
