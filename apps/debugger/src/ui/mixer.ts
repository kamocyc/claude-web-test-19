import {
  DEFAULT_NOISE_MIX,
  NOISE_MIX_LEVELS,
  NOISE_MIX_TRACKING,
  type NoiseMix,
  type NoiseMixControl,
} from '@railsim/audio';

/** メータの下端 [dB]（これより静かなものは目盛りの外） */
const METER_FLOOR = -54;
/** メータの上端 [dB]。飽和が掛かり始める手前に取る。 */
const METER_CEILING = -6;

interface MixerOptions {
  /** つまみを動かしたとき。音を出していなければここで解錠もする。 */
  readonly onChange: (patch: Partial<NoiseMix>) => void;
}

/**
 * 音量バランスの調整 UI。
 *
 * つまみだけでなく、**音源ごとの実効値メータ**を並べているのが要点である。
 * 「補機がうるさい」と感じたときに、それが本当に補機なのか、走行音に対して
 * どれだけ大きいのかが数値で分かる。混ざったあとの波形からでは分からないので、
 * 合成器が音源ごとに測った値（`TrainNoiseSynth.readLevels`）を使う。
 *
 * 項目は `@railsim/audio` の定義から組み立てる。音源を足したときに UI を
 * 直し忘れないようにするためで、ここには「並べ方」しか無い。
 */
export class Mixer {
  private readonly meters = new Map<number, HTMLElement>();
  private readonly inputs = new Map<keyof NoiseMix, HTMLInputElement>();
  private readonly values = new Map<keyof NoiseMix, HTMLElement>();

  constructor(
    root: HTMLElement,
    private readonly options: MixerOptions,
  ) {
    const details = document.createElement('details');
    details.className = 'mixer';
    const summary = document.createElement('summary');
    summary.textContent = '音量バランス';
    details.append(summary);

    for (const control of NOISE_MIX_LEVELS) details.append(this.row(control));

    const heading = document.createElement('div');
    heading.className = 'mixer-heading';
    heading.textContent = '力行と惰行の差';
    details.append(heading);
    for (const control of NOISE_MIX_TRACKING) details.append(this.row(control));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mixer-reset';
    reset.textContent = '既定に戻す';
    reset.addEventListener('click', () => {
      this.set(DEFAULT_NOISE_MIX);
      this.options.onChange(DEFAULT_NOISE_MIX);
      reset.blur();
    });
    details.append(reset);
    root.append(details);

    this.set(DEFAULT_NOISE_MIX);
  }

  private row(control: NoiseMixControl): HTMLElement {
    const row = document.createElement('label');
    row.className = 'mixer-row';

    const name = document.createElement('span');
    name.className = 'mixer-label';
    name.textContent = control.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.addEventListener('input', () => {
      const value = Number(input.value) / 100;
      this.showValue(control.key, value);
      this.options.onChange({ [control.key]: value });
    });
    // 操作したあとはフォーカスを運転台へ返す（矢印キーがつまみに食われる）
    input.addEventListener('change', () => input.blur());
    this.inputs.set(control.key, input);

    const value = document.createElement('span');
    value.className = 'mixer-value';
    this.values.set(control.key, value);

    row.append(name, input, value);

    if (control.voice !== undefined) {
      const meter = document.createElement('span');
      meter.className = 'mixer-meter';
      const bar = document.createElement('span');
      meter.append(bar);
      this.meters.set(control.voice, bar);
      row.append(meter);
    } else {
      row.append(document.createElement('span'));
    }
    return row;
  }

  /** つまみの位置を値に合わせる */
  set(mix: NoiseMix): void {
    for (const [key, input] of this.inputs) {
      const value = mix[key];
      input.value = String(Math.round(value * 100));
      this.showValue(key, value);
    }
  }

  private showValue(key: keyof NoiseMix, value: number): void {
    const element = this.values.get(key);
    if (element) element.textContent = `${Math.round(value * 100)}`;
  }

  /**
   * 音源ごとの実効値をメータへ描く。
   * 耳の感じ方に合わせて dB 目盛りにする（線形だと静かな側が全部つぶれる）。
   */
  update(levels: Float32Array): void {
    for (const [voice, bar] of this.meters) {
      const rms = levels[voice] ?? 0;
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const ratio = (db - METER_FLOOR) / (METER_CEILING - METER_FLOOR);
      bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    }
  }
}
