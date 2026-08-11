/**
 * 双 2 次フィルタ（biquad）。
 *
 * Web Audio の `BiquadFilterNode` と同じ構造だが、こちらは AudioWorklet の中でも
 * node のテストの中でも同じコードが走る**素のクラス**である。合成の中核部分を
 * Web Audio に依存させないことで、オフラインでレンダしてスペクトルを検定できる。
 *
 * 係数は Robert Bristow-Johnson の Audio EQ Cookbook に従う。
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  /** 帯域通過（ピークゲインが 1 になる正規化） */
  bandPass(sampleRate: number, frequency: number, q: number): this {
    const w = (2 * Math.PI * clampFrequency(frequency, sampleRate)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.setCoefficients(alpha / a0, 0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0);
    return this;
  }

  /** 低域通過 */
  lowPass(sampleRate: number, frequency: number, q = Math.SQRT1_2): this {
    const w = (2 * Math.PI * clampFrequency(frequency, sampleRate)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b = (1 - cos) / 2;
    this.setCoefficients(b / a0, (1 - cos) / a0, b / a0, (-2 * cos) / a0, (1 - alpha) / a0);
    return this;
  }

  /** 高域通過（直流と超低域を落とす） */
  highPass(sampleRate: number, frequency: number, q = Math.SQRT1_2): this {
    const w = (2 * Math.PI * clampFrequency(frequency, sampleRate)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b = (1 + cos) / 2;
    this.setCoefficients(b / a0, -(1 + cos) / a0, b / a0, (-2 * cos) / a0, (1 - alpha) / a0);
    return this;
  }

  private setCoefficients(b0: number, b1: number, b2: number, a1: number, a2: number): void {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  process(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

/** ナイキスト周波数を超える指定を安全側へ丸める */
function clampFrequency(frequency: number, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  return Math.min(Math.max(frequency, 1), nyquist * 0.98);
}

/**
 * 直流阻止（1 次のハイパス）。
 * 電磁力は磁束の 2 乗なので必ず正の直流成分を持つ。音として出すには取り除く。
 */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private readonly r: number;

  constructor(sampleRate: number, cutoff = 18) {
    this.r = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  }

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** 1 次の平滑化（パラメータの急変によるクリックを防ぐ） */
export class Smoothed {
  private value: number;
  private readonly coefficient: number;

  constructor(sampleRate: number, timeConstant: number, initial = 0) {
    this.value = initial;
    this.coefficient = timeConstant > 0 ? Math.exp(-1 / (sampleRate * timeConstant)) : 0;
  }

  process(target: number): number {
    this.value = target + (this.value - target) * this.coefficient;
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }

  get current(): number {
    return this.value;
  }
}
