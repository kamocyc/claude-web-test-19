/**
 * テスト用のスペクトル測定。
 *
 * FFT を持ち込むほどの用は無く、知りたいのは「この周波数に峰が立っているか」
 * だけなので、ゲルツェル法で任意の周波数のパワーを直接測る。
 */

/** 信号 `x` の周波数 `frequency` におけるパワー（振幅の 2 乗に比例） */
export function goertzel(x: Float32Array, sampleRate: number, frequency: number): number {
  const n = x.length;
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    // 端の不連続による漏れを抑えるためハン窓を掛ける
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = x[i]! * window + coefficient * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return (real * real + imag * imag) / (n * n);
}

/** 信号全体の実効値 */
export function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / x.length);
}

/**
 * `frequency` のパワーが、その左右 `offset` Hz の「谷」に対して何倍あるか。
 *
 * 絶対的なパワーは共振や 1/f の傾きで大きく変わるため、峰が立っているかどうかは
 * **近傍との比**で判定する。これなら共振の位置に左右されない。
 */
export function peakProminence(
  x: Float32Array,
  sampleRate: number,
  frequency: number,
  offset: number,
): number {
  const peak = goertzel(x, sampleRate, frequency);
  const low = goertzel(x, sampleRate, frequency - offset);
  const high = goertzel(x, sampleRate, frequency + offset);
  const floor = Math.max((low + high) / 2, 1e-30);
  return peak / floor;
}

/** 帯域 [lo, hi] のパワーを粗く積分する */
export function bandPower(
  x: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
  steps = 64,
): number {
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    sum += goertzel(x, sampleRate, lo + ((hi - lo) * i) / steps);
  }
  return sum / (steps + 1);
}
