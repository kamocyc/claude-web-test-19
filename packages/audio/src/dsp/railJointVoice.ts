import { Biquad } from './biquad.ts';
import { Noise } from './noise.ts';

/** 継目を 1 つ踏んだイベント */
export interface JointImpact {
  /** 発音までの遅れ [サンプル数]（フレーム内の位置をサンプル精度で表す） */
  readonly delay: number;
  /** 衝撃の強さ 0..1 */
  readonly strength: number;
}

/** 同時に鳴らせる衝撃の数（4 両 16 軸が同じ継目に重なることはない） */
const MAX_VOICES = 24;

/**
 * 打撃で励振される経路 [中心周波数 Hz, Q, 減衰時定数 s, 重み]。
 *
 * 継目の段差を車輪が踏むと接触力に鋭いインパルスが入り、それが**別々の経路**を
 * 通って音になる。経路ごとに関わる質量とばねが違うので、周波数も**残る長さも**
 * 違う。低次のモードほど減衰が小さく長く残るというのは構造振動の一般則で、
 * 「ガタン」の重さはこの長い低域の余韻そのものである。
 *
 * | 経路                             | 周波数 | 残る長さ | 聞こえ方 |
 * | -------------------------------- | ------ | -------- | -------- |
 * | ばね上（車体）とレールの曲げ     | 80Hz   | 250ms    | ガ〜     |
 * | 台車枠・軸箱（ばね下）           | 230Hz  | 90ms     | タン     |
 * | 車輪踏面とレール腹部             | 1500Hz | 18ms     | カッ     |
 *
 * すべて同じ短い時定数で鳴らしていたころは、低域が高域と一緒に切れてしまうので
 * 「カタッ カタッ」という軽い音にしかならなかった。
 */
const MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [80, 1.6, 0.14, 0.8],
  [230, 2.4, 0.06, 1.0],
  [1500, 2.0, 0.014, 0.6],
];

/**
 * 全体の倍率。
 *
 * 帯域通過はピークゲインが 1 になるよう正規化してあるため、衝撃のような短い
 * 入力に対する出力は帯域幅のぶんだけ小さくなる。継目音は実際には転動音より
 * 明確に大きい（それが「ガタン ゴトン」として聞こえる理由）ので、転動音を
 * 基準に測って決めた倍率でここを持ち上げる。
 */
const IMPACT_GAIN = 7.5;

/**
 * レール継目の衝撃音。
 *
 * 軸が継目の段差を踏むと、車輪とレールに短い衝撃が入る。これは連続音ではなく
 * **離散的な打撃**なので、`delay` をサンプル数で受けてその位置から鳴らす。
 * 60fps の描画に丸めてしまうと 16ms もばらつき、「ガタン ゴトン」の間隔が
 * 台車の寸法を映さなくなる。
 *
 * 1 両 4 軸なら、前台車の 2 軸（固定軸距 2.1m）→ 間を空けて → 後台車の 2 軸、
 * という 2 拍ずつの並びになる。これが「ガタン、ゴトン」の正体で、
 * 続いて次の車両が同じ継目を踏む。速度が上がるほど間隔が詰まる。
 */
export class RailJointVoice {
  private readonly noise = new Noise(0x77a3);
  private readonly delays = new Float64Array(MAX_VOICES);
  private readonly amplitudes = new Float64Array(MAX_VOICES);
  /** 声 × 経路 の包絡。経路ごとに減衰の速さが違う。 */
  private readonly envelopes = new Float64Array(MAX_VOICES * MODES.length);
  private readonly started = new Uint8Array(MAX_VOICES);
  private readonly active = new Uint8Array(MAX_VOICES);
  private readonly filters: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly decays: number[] = [];
  /** 経路ごとの励振（毎サンプル使い回す。音声スレッドで確保はしない） */
  private readonly excitation = new Float64Array(MODES.length);

  constructor(sampleRate: number) {
    for (const [frequency, q, tau, weight] of MODES) {
      this.filters.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
      this.decays.push(Math.exp(-1 / (sampleRate * tau)));
    }
  }

  /** 衝撃を予約する。バッファの先頭から `delay` サンプル後に鳴る。 */
  trigger(impact: JointImpact): void {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.started[i] = 0;
      this.delays[i] = Math.max(0, impact.delay);
      this.amplitudes[i] = impact.strength;
      for (let m = 0; m < MODES.length; m++) this.envelopes[i * MODES.length + m] = 0;
      return;
    }
    // 空きが無ければ捨てる。取りこぼしても次の継目で鳴るので破綻はしない。
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const modes = MODES.length;
    const excitation = this.excitation;

    for (let i = 0; i < out.length; i++) {
      excitation.fill(0);
      let ringing = false;

      for (let v = 0; v < MAX_VOICES; v++) {
        if (!this.active[v]) continue;
        if (this.delays[v]! > 0) {
          this.delays[v]!--;
          ringing = true;
          continue;
        }
        const base = v * modes;
        if (!this.started[v]) {
          // 立ち上がりの 1 サンプルが衝撃そのもの。すべての経路を同時に叩く。
          this.started[v] = 1;
          const amplitude = this.amplitudes[v]!;
          for (let m = 0; m < modes; m++) {
            this.envelopes[base + m] = amplitude;
            excitation[m] = excitation[m]! + amplitude;
          }
          ringing = true;
          continue;
        }
        let alive = false;
        for (let m = 0; m < modes; m++) {
          const env = this.envelopes[base + m]!;
          if (env < 1e-4) continue;
          excitation[m] = excitation[m]! + env * this.noise.next() * 0.55;
          this.envelopes[base + m] = env * this.decays[m]!;
          alive = true;
        }
        if (alive) ringing = true;
        else this.active[v] = 0;
      }

      if (!ringing) continue;
      let sum = 0;
      for (let m = 0; m < modes; m++) {
        sum += this.filters[m]!.process(excitation[m]!) * this.weights[m]!;
      }
      out[i] = out[i]! + sum * IMPACT_GAIN;
    }
  }

  reset(): void {
    this.active.fill(0);
    this.started.fill(0);
    this.envelopes.fill(0);
    for (const f of this.filters) f.reset();
  }
}
