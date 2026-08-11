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
  private readonly envelopes = new Float64Array(MAX_VOICES);
  private readonly active = new Uint8Array(MAX_VOICES);
  private readonly thud = new Biquad();
  private readonly clack = new Biquad();
  private readonly decay: number;

  constructor(sampleRate: number) {
    // レール・車輪の低次モード（ゴトン）と、踏面の高次モード（カチッ）
    this.thud.bandPass(sampleRate, 105, 2.5);
    this.clack.bandPass(sampleRate, 1650, 2.0);
    // 衝撃の包絡（約 45ms で減衰）
    this.decay = Math.exp(-1 / (sampleRate * 0.045));
  }

  /** 衝撃を予約する。バッファの先頭から `delay` サンプル後に鳴る。 */
  trigger(impact: JointImpact): void {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.delays[i] = Math.max(0, impact.delay);
      this.amplitudes[i] = impact.strength;
      this.envelopes[i] = 0;
      return;
    }
    // 空きが無ければ捨てる。取りこぼしても次の継目で鳴るので破綻はしない。
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      let excitation = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        if (!this.active[v]) continue;
        if (this.delays[v]! > 0) {
          this.delays[v]!--;
          continue;
        }
        if (this.envelopes[v] === 0) {
          // 立ち上がりの 1 サンプルが衝撃そのもの
          this.envelopes[v] = this.amplitudes[v]!;
          excitation += this.amplitudes[v]!;
        } else {
          excitation += this.envelopes[v]! * this.noise.next() * 0.55;
          this.envelopes[v]! *= this.decay;
          if (this.envelopes[v]! < 1e-4) this.active[v] = 0;
        }
      }
      if (excitation !== 0 || this.hasActive()) {
        // 帯域通過はピークゲインが 1 になるよう正規化してあるため、衝撃のような
        // 短い入力に対する出力は帯域幅のぶんだけ小さくなる。継目音は実際には
        // 転動音より明確に大きい（それが「ガタン ゴトン」として聞こえる理由）ので、
        // 転動音を基準に測って決めた倍率でここを持ち上げる。
        out[i] = out[i]! + this.thud.process(excitation) * 11 + this.clack.process(excitation) * 4;
      }
    }
  }

  private hasActive(): boolean {
    for (let v = 0; v < MAX_VOICES; v++) if (this.active[v]) return true;
    return false;
  }

  reset(): void {
    this.active.fill(0);
    this.envelopes.fill(0);
    this.thud.reset();
    this.clack.reset();
  }
}
