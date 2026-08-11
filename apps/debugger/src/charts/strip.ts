/** 1 本の系列 */
export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** 破線で描く（パターン速度や制限速度など「上限」を表す線に使う） */
  readonly dashed?: boolean;
}

export interface StripChartOptions {
  readonly title: string;
  readonly series: readonly Series[];
  /** 表示する時間幅 [s] */
  readonly window?: number;
  /** y 軸の下限（省略時はデータから決める） */
  readonly min?: number;
  /** y 軸の上限 */
  readonly max?: number;
  /** 0 の位置に基準線を引く */
  readonly zeroLine?: boolean;
  /** 値の表示に付ける単位 */
  readonly unit?: string;
}

const MAX_POINTS = 4000;

/**
 * 時系列を左から右へ流すストリップチャート。
 *
 * 依存を増やさないよう Canvas2D で自前描画する。物理量の検証が目的なので、
 * 見た目より「複数の量を同じ時間軸で重ねて比較できること」を優先している。
 */
export class StripChart {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly titleEl: HTMLHeadingElement;
  private readonly times: number[] = [];
  private readonly values = new Map<string, number[]>();
  private readonly options: Required<Pick<StripChartOptions, 'window'>> & StripChartOptions;

  constructor(options: StripChartOptions) {
    this.options = { window: 60, ...options };
    this.element = document.createElement('div');
    this.element.className = 'chart';
    this.titleEl = document.createElement('h3');
    this.canvas = document.createElement('canvas');
    this.element.append(this.titleEl, this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D を初期化できません');
    this.ctx = ctx;
    for (const s of options.series) this.values.set(s.key, []);
  }

  push(time: number, sample: Record<string, number>): void {
    this.times.push(time);
    for (const s of this.options.series) {
      this.values.get(s.key)!.push(sample[s.key] ?? Number.NaN);
    }
    if (this.times.length > MAX_POINTS) {
      this.times.splice(0, this.times.length - MAX_POINTS);
      for (const arr of this.values.values()) arr.splice(0, arr.length - MAX_POINTS);
    }
  }

  clear(): void {
    this.times.length = 0;
    for (const arr of this.values.values()) arr.length = 0;
  }

  private resizeCanvas(): { w: number; h: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = Math.max(1, Math.floor(w * dpr));
      this.canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  draw(): void {
    const { w, h } = this.resizeCanvas();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (this.times.length < 2) return;

    const tEnd = this.times[this.times.length - 1]!;
    const tStart = tEnd - this.options.window;
    let from = 0;
    while (from < this.times.length - 1 && this.times[from]! < tStart) from++;

    // y 範囲
    let min = this.options.min ?? Number.POSITIVE_INFINITY;
    let max = this.options.max ?? Number.NEGATIVE_INFINITY;
    if (this.options.min === undefined || this.options.max === undefined) {
      for (const arr of this.values.values()) {
        for (let i = from; i < arr.length; i++) {
          const v = arr[i]!;
          if (!Number.isFinite(v)) continue;
          if (this.options.min === undefined) min = Math.min(min, v);
          if (this.options.max === undefined) max = Math.max(max, v);
        }
      }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 1;
    if (max - min < 1e-6) {
      max = min + 1;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;

    const x = (t: number) => ((t - tStart) / this.options.window) * w;
    const y = (v: number) => h - ((v - min) / (max - min)) * h;

    // 目盛り
    ctx.strokeStyle = '#1e2733';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const yy = Math.round((h * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }
    if (this.options.zeroLine && min < 0 && max > 0) {
      ctx.strokeStyle = '#3a4756';
      ctx.beginPath();
      const yy = Math.round(y(0)) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }

    const latest: string[] = [];
    for (const s of this.options.series) {
      const arr = this.values.get(s.key)!;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = from; i < arr.length; i++) {
        const v = arr[i]!;
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const px = x(this.times[i]!);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const last = arr[arr.length - 1];
      if (last !== undefined && Number.isFinite(last)) {
        latest.push(
          `<span class="legend" style="color:${s.color}">${s.label} ${formatValue(last)}${this.options.unit ?? ''}</span>`,
        );
      }
    }

    this.titleEl.innerHTML = `${this.options.title} ${latest.join(' ')}`;
  }
}

function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
