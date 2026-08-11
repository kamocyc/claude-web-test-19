import { Biquad, DcBlocker, Smoothed } from './biquad.ts';

const TWO_PI = Math.PI * 2;

/** インバータの変調から音を作るのに必要な量（`InverterState` から素直に写せる） */
export interface InverterVoiceParams {
  /** インバータ出力（固定子）周波数 [Hz] */
  readonly fundamental: number;
  /** キャリア（スイッチング）周波数 [Hz]。0 = 搬送波なし */
  readonly carrier: number;
  /** 変調率 0..1 */
  readonly modulation: number;
  /** 出力 1 周期あたりのパルス数（0 = 非同期、1 = 一パルス） */
  readonly pulses: number;
  /** 回転子スロット高調波の周波数 [Hz] */
  readonly slotFrequency: number;
  /** 音量 0..1（主回路が切れていれば 0） */
  readonly level: number;
}

export interface InverterVoiceOptions {
  /**
   * オーバーサンプリング倍率。比較器の出力は理想的な矩形波なので、
   * 出力サンプルレートのまま作ると折り返し（エイリアシング）が可聴帯域に落ちる。
   * さらに磁束を 2 乗する段で帯域が倍に広がるため、2 乗まで済ませてから
   * 低域通過させて間引く。
   */
  readonly oversample?: number;
  /**
   * 固定子鉄心・フレームの構造共振 [周波数 Hz, Q, 重み]。
   *
   * 実際の電動機は電磁力そのものを放射しているのではなく、その力で構造が
   * 変形して音になる。どの周波数がよく響くかは固定子の形状で決まり、
   * これが「その形式らしい音色」の正体である。磁束の積分で高域が 1/f で
   * 落ちるぶんをここが持ち上げるのも、実機とまったく同じ関係になっている。
   *
   * 1 次元のモデルでは表せない空間次数（低次の変形モードだけがよく放射する）の
   * 効果も、実質的にここが代役をしている。
   */
  readonly resonances?: ReadonlyArray<readonly [number, number, number]>;
  /** 回転子スロットによる磁気抵抗（パーミアンス）変動の深さ */
  readonly slotDepth?: number;
}

const DEFAULT_RESONANCES: ReadonlyArray<readonly [number, number, number]> = [
  [620, 7, 1.0],
  [1180, 9, 0.7],
  [2350, 11, 0.45],
];

/**
 * 磁束の正規化基準周波数 [Hz]。
 * V/f 一定制御では磁束が一定に保たれるので、基底周波数付近で磁束が 1 前後に
 * なるよう正規化しておくと、弱め界磁に入ってから磁束が落ちる（＝高速域で
 * 磁気音が弱まる）という実機の関係がそのまま出る。
 */
const FLUX_REFERENCE = 50;

/**
 * VVVF インバータと主電動機の音を、**実際の PWM 波形から**合成する。
 *
 * 発振器を並べてキャリアとサイドバンドを 1 本ずつ作るのではなく、実機と同じ
 * 手順を音声サンプルレートで踏む。
 *
 * ```
 * 1. 三角波キャリア c(θc) と 3 相の正弦変調波 m_x(θ₁) を比較して相電圧 ±1 を作る
 * 2. 線間中性点電圧 v_an = v_a − (v_a+v_b+v_c)/3
 * 3. 磁束 λ = ∫v_an dt          （固定子電圧はほぼ磁束の微分）
 * 4. 電磁半径力 ∝ λ²            （マクスウェル応力は磁束密度の 2 乗）
 * 5. 構造共振を通して放射音にする
 * ```
 *
 * 4 の 2 乗が要である。`λ = λ₁ + λ_h` を 2 乗すると交差項 `2λ₁λ_h` が現れるので、
 * **キャリア ± 出力周波数のサイドバンドと 2f₁ の磁気音が、個別に作り込まなくても
 * 自動的に出てくる**。同期モードへの移行も、過変調も、一パルスの矩形波音も、
 * 比較の結果として現れるだけで特別扱いは要らない。
 *
 * 同期モードではキャリアの位相を出力の位相へロックする（`θc = N·θ₁`）。これが
 * 同期の定義であり、非同期のときのようなうなりが出ないのはこのためである。
 * パルス数が切り替わる瞬間は位相のオフセットを付け替えて連続にする（実機の
 * モード切替も電圧に段差を作らないように再同期する）。
 */
export class InverterVoice {
  private readonly oversample: number;
  private readonly innerRate: number;
  private readonly innerDt: number;
  private readonly resonators: Biquad[] = [];
  private readonly resonanceWeights: number[] = [];
  private readonly decimation: Biquad[] = [];
  private readonly dcBlock: DcBlocker;
  private readonly levelSmooth: Smoothed;
  private readonly modulationSmooth: Smoothed;
  private readonly frequencySmooth: Smoothed;
  private readonly slotDepth: number;

  private theta1 = 0;
  private thetaCarrier = 0;
  private thetaSlot = 0;
  private syncOffset = 0;
  private lastPulses = 0;
  private flux = 0;
  private readonly fluxLeak: number;

  private params: InverterVoiceParams = {
    fundamental: 0,
    carrier: 0,
    modulation: 0,
    pulses: 0,
    slotFrequency: 0,
    level: 0,
  };

  constructor(
    readonly sampleRate: number,
    options: InverterVoiceOptions = {},
  ) {
    this.oversample = Math.max(1, Math.floor(options.oversample ?? 4));
    this.innerRate = sampleRate * this.oversample;
    this.innerDt = 1 / this.innerRate;
    this.slotDepth = options.slotDepth ?? 0.18;

    for (const [frequency, q, weight] of options.resonances ?? DEFAULT_RESONANCES) {
      this.resonators.push(new Biquad().bandPass(this.innerRate, frequency, q));
      this.resonanceWeights.push(weight);
    }
    // 間引きのための低域通過（2 乗で広がった帯域を出力のナイキスト以下へ落とす）
    if (this.oversample > 1) {
      for (let i = 0; i < 2; i++) {
        this.decimation.push(new Biquad().lowPass(this.innerRate, sampleRate * 0.42));
      }
    }
    this.dcBlock = new DcBlocker(this.innerRate, 25);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    this.modulationSmooth = new Smoothed(sampleRate, 0.01);
    this.frequencySmooth = new Smoothed(sampleRate, 0.005);
    // 磁束の漏れ積分。8Hz 以上ではほぼ真の積分として働き、直流の暴走だけを防ぐ。
    this.fluxLeak = Math.exp(-TWO_PI * 8 * this.innerDt);
  }

  setParams(params: InverterVoiceParams): void {
    this.params = params;
  }

  /** 出力バッファへ加算せず上書きする */
  render(out: Float32Array): void {
    const p = this.params;
    const os = this.oversample;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const modulation = this.modulationSmooth.process(p.modulation);
      const f1 = this.frequencySmooth.process(p.fundamental);
      let sample = 0;

      for (let k = 0; k < os; k++) {
        sample = this.renderInner(f1, modulation, p);
      }
      out[i] = sample * level;
    }
  }

  /** オーバーサンプリングされた内部レートでの 1 サンプル */
  private renderInner(f1: number, modulation: number, p: InverterVoiceParams): number {
    // --- 位相を進める ---
    this.theta1 = wrap(this.theta1 + TWO_PI * f1 * this.innerDt);
    this.thetaSlot = wrap(this.thetaSlot + TWO_PI * p.slotFrequency * this.innerDt);

    const pulses = p.pulses;
    if (pulses !== this.lastPulses) {
      // モードが変わる瞬間、キャリアの位相が飛ばないようオフセットを付け替える
      if (pulses >= 2) this.syncOffset = this.thetaCarrier - pulses * this.theta1;
      this.lastPulses = pulses;
    }
    if (pulses >= 2) {
      // 同期モード: キャリアは出力の整数倍に位相までロックされる
      this.thetaCarrier = wrap(pulses * this.theta1 + this.syncOffset);
    } else {
      this.thetaCarrier = wrap(this.thetaCarrier + TWO_PI * p.carrier * this.innerDt);
    }

    // --- 3 相の変調波と比較 ---
    const ma = modulation * Math.sin(this.theta1);
    const mb = modulation * Math.sin(this.theta1 - TWO_PI / 3);
    const mc = modulation * Math.sin(this.theta1 + TWO_PI / 3);

    let va: number;
    let vb: number;
    let vc: number;
    if (pulses === 1 || p.carrier <= 0) {
      // 一パルス: 搬送波が無く、変調波の符号がそのまま相電圧になる（矩形波）
      va = ma >= 0 ? 1 : -1;
      vb = mb >= 0 ? 1 : -1;
      vc = mc >= 0 ? 1 : -1;
    } else {
      const carrier = triangle(this.thetaCarrier);
      va = ma > carrier ? 1 : -1;
      vb = mb > carrier ? 1 : -1;
      vc = mc > carrier ? 1 : -1;
    }
    // 中性点電位を引いて相電圧にする（3 相 3 線なので零相分は流れない）
    const van = va - (va + vb + vc) / 3;

    // --- 磁束と電磁力 ---
    this.flux = this.flux * this.fluxLeak + van * this.innerDt;
    // 回転子スロットによるパーミアンス変動。積の形にすることで
    // スロット周波数 ± 2f₁ のサイドバンドが自動的に生まれる。
    const flux =
      this.flux * TWO_PI * FLUX_REFERENCE * (1 + this.slotDepth * Math.sin(this.thetaSlot));
    // マクスウェル応力 ∝ 磁束密度の 2 乗
    const force = this.dcBlock.process(flux * flux);

    // --- 構造共振を通す ---
    let radiated = force * 0.3;
    for (let r = 0; r < this.resonators.length; r++) {
      radiated += this.resonators[r]!.process(force) * this.resonanceWeights[r]!;
    }
    let y = radiated;
    for (const filter of this.decimation) y = filter.process(y);
    return y;
  }

  reset(): void {
    this.theta1 = 0;
    this.thetaCarrier = 0;
    this.thetaSlot = 0;
    this.syncOffset = 0;
    this.lastPulses = 0;
    this.flux = 0;
    this.dcBlock.reset();
    for (const f of this.resonators) f.reset();
    for (const f of this.decimation) f.reset();
    this.levelSmooth.set(0);
    this.modulationSmooth.set(0);
    this.frequencySmooth.set(0);
  }
}

/** 位相を [0, 2π) に畳む */
function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}

/** 位相 [0, 2π) から三角波 [-1, 1] */
function triangle(theta: number): number {
  const p = theta / TWO_PI;
  return p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
}
