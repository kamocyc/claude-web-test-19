import { GRAVITY, swayToAcceleration, type Simulation } from '@railsim/core';

const WIDTH = 340;
const HEIGHT = 214;
/** 振れ盤の外周が表す加速度 [m/s^2]（角度に直すと atan(1.6/g) = 9.3 度） */
const FULL_SCALE = 1.6;
const TRAIL_LENGTH = 120;
/**
 * 前面図・側面図で角度にかける強調倍率。
 * 実際の振れ角やカント角は 5 度前後で、数十ピクセルの絵ではほとんど動いて見えない。
 * 姿勢計と同じく倍率をかけて読めるようにする（振れ盤のほうは等倍で定量表示）。
 */
const ATTITUDE_GAIN = 3;

interface TrailPoint {
  readonly lateral: number;
  readonly longitudinal: number;
}

/**
 * 加速度を「乗客がどう振られるか」で示すメータ。
 *
 * 加速度の数値を角度へ直接変換すると、加速度が変わった瞬間に角度が飛んでしまい、
 * 加加速度（ジャーク）が見えない。ここでは物理コアが解いている**減衰振り子**
 * （車内に吊るした吊り革と同じ、固有周期 1.5 秒程度）の振れ角をそのまま描く。
 * 振り子は加速度に遅れて追従するので:
 *
 *  - ノッチを一気に動かす → 大きく振られて行き過ぎ、揺り戻しが出る
 *  - 一段ずつ刻む         → 同じ加速度でも静かに傾くだけ
 *
 * という運転の質の差が、そのまま絵になる。
 *
 * 表示は 3 つ:
 *
 *  1. **振れ盤** — 振り子の先端を真上から見た位置と、その軌跡。
 *     瞬時の平衡点（＝加速度そのものの向き）を薄い十字で重ねてあり、
 *     両者の隔たりが「まだ振れ切っていない量」になる。
 *  2. **前面図** — カントで傾いた軌道面、その上でロールした車体、
 *     さらにその中で振られる吊り革と立っている乗客。
 *  3. **側面図** — 勾配で傾いた床、車体のピッチング、前後に振られる吊り革。
 */
export class GMeter {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly trail: TrailPoint[] = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gmeter';
    container.append(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D を初期化できません');
    this.ctx = ctx;
  }

  clear(): void {
    this.trail.length = 0;
  }

  draw(sim: Simulation): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== WIDTH * dpr) {
      this.canvas.width = WIDTH * dpr;
      this.canvas.height = HEIGHT * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    const body = sim.dynamics.vehicles[0]!.body;
    const sway = body.sway;

    this.trail.push({ lateral: sway.lateral, longitudinal: sway.longitudinal });
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();

    ctx.fillStyle = 'rgba(13, 17, 23, 0.78)';
    roundRect(ctx, 0, 0, WIDTH, HEIGHT, 6);
    ctx.fill();
    ctx.strokeStyle = '#2a3440';
    ctx.stroke();

    this.drawSwayPlate(ctx, 8, 8, 138, sway);
    this.drawFrontView(ctx, 158, 10, 172, 92, body.absoluteRoll, body.trackRoll, sway.lateral);
    this.drawSideView(
      ctx,
      158,
      106,
      172,
      66,
      body.absolutePitch,
      body.trackPitch,
      sway.longitudinal,
    );
    this.drawReadout(ctx, 8, 154, body, sway);
  }

  /**
   * 振れ盤: 振り子の先端を真上から見た図。
   * 制動なら前（上）へ、力行なら後ろ（下）へ、曲線なら外側へ振れる。
   */
  private drawSwayPlate(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    sway: {
      lateral: number;
      longitudinal: number;
      equilibriumLateral: number;
      equilibriumLongitudinal: number;
    },
  ): void {
    const cx = x + size / 2;
    const cy = y + size / 2;
    const r = size / 2 - 6;
    // 角度 → 画面上の距離。目盛りは平衡角 tan θ = a/g で加速度に読み替える。
    const fullAngle = Math.atan2(FULL_SCALE, GRAVITY);
    const toPx = (angle: number) => (angle / fullAngle) * r;
    const ringAngle = (a: number) => Math.atan2(a, GRAVITY);

    ctx.save();
    ctx.strokeStyle = '#243040';
    ctx.lineWidth = 1;
    for (const level of [0.5, 1.0, 1.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, toPx(ringAngle(level)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    ctx.fillStyle = '#5c6b7d';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('前（制動）', cx, cy - toPx(ringAngle(1.0)) - 3);
    ctx.fillText('後（力行）', cx, cy + toPx(ringAngle(1.0)) + 10);
    ctx.textAlign = 'left';
    ctx.fillText('右', cx + toPx(ringAngle(1.0)) + 3, cy + 3);
    ctx.textAlign = 'right';
    ctx.fillText('左', cx - toPx(ringAngle(1.0)) - 3, cy + 3);

    // 瞬時の平衡点（加速度そのものの向き）。振り子はここへ向かって遅れて動く。
    const ex = cx + toPx(sway.equilibriumLateral);
    const ey = cy - toPx(sway.equilibriumLongitudinal);
    ctx.strokeStyle = 'rgba(255, 210, 63, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex - 4, ey);
    ctx.lineTo(ex + 4, ey);
    ctx.moveTo(ex, ey - 4);
    ctx.lineTo(ex, ey + 4);
    ctx.stroke();

    // 振り子の先端の軌跡（古いほど薄い）
    ctx.lineWidth = 1.5;
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1]!;
      const b = this.trail[i]!;
      const alpha = (i / this.trail.length) * 0.6;
      ctx.strokeStyle = `rgba(78, 163, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx + toPx(a.lateral), cy - toPx(a.longitudinal));
      ctx.lineTo(cx + toPx(b.lateral), cy - toPx(b.longitudinal));
      ctx.stroke();
    }

    // 平衡点から現在位置へ引いた線が「遅れ」そのもの
    const px = cx + toPx(sway.lateral);
    const py = cy - toPx(sway.longitudinal);
    ctx.strokeStyle = 'rgba(255, 210, 63, 0.3)';
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(px, py);
    ctx.stroke();

    const felt = Math.hypot(
      swayToAcceleration(sway.lateral),
      swayToAcceleration(sway.longitudinal),
    );
    ctx.fillStyle = felt > 1.2 ? '#ff6b6b' : felt > 0.7 ? '#ffb454' : '#7ddc8a';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 前面図: 軌道面のカント → 車体のロール → 吊り革と乗客の振れ */
  private drawFrontView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    roll: number,
    trackRoll: number,
    swing: number,
  ): void {
    const cx = x + w / 2;
    const cy = y + h / 2 + 6;

    drawHorizon(ctx, cx, cy, w);
    drawTrack(ctx, cx, cy, trackRoll * ATTITUDE_GAIN, [-22, 22]);

    ctx.save();
    ctx.translate(cx, cy);
    // 画面の y は下向きなので、右下がりのロールは時計回り＝正の回転になる
    ctx.rotate(roll * ATTITUDE_GAIN);
    drawCarBox(ctx, 66, 46);
    // 振れ角は車体に対する相対角なので、車体を回したあとの座標系で描く。
    // canvas の y は下向き → 右へ振れる（正）には負の回転を与える。
    drawStrap(ctx, 0, -46 / 2 + 6, -swing * ATTITUDE_GAIN, 20);
    drawStanding(ctx, -20, 46 / 2 - 4, swing * ATTITUDE_GAIN);
    ctx.restore();

    label(ctx, x, y + 10, `前方（カント → ロール → 振られ・角度 ${ATTITUDE_GAIN}倍）`);
  }

  /** 側面図: 勾配 → 車体のピッチング → 前後に振られる吊り革 */
  private drawSideView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    pitch: number,
    trackPitch: number,
    swing: number,
  ): void {
    const cx = x + w / 2;
    const cy = y + h / 2 + 4;

    drawHorizon(ctx, cx, cy, w);
    // 勾配。進行方向を右に描くので、前下がり（正）は反時計回りになる。
    drawTrack(ctx, cx, cy, -trackPitch * ATTITUDE_GAIN, [-40, 40]);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-pitch * ATTITUDE_GAIN);
    drawCarBox(ctx, 116, 30);
    // 進行方向を示す矢印
    ctx.strokeStyle = '#4ea3ff';
    ctx.beginPath();
    ctx.moveTo(44, 0);
    ctx.lineTo(54, 0);
    ctx.lineTo(50, -3);
    ctx.moveTo(54, 0);
    ctx.lineTo(50, 3);
    ctx.stroke();
    // 前（画面右）へ振れるのは反時計回り
    drawStrap(ctx, 10, -30 / 2 + 4, -swing * ATTITUDE_GAIN, 15);
    drawStanding(ctx, -34, 30 / 2 - 3, swing * ATTITUDE_GAIN, 14);
    ctx.restore();

    label(ctx, x, y + 8, `側面（勾配 → ピッチ → 振られ・${ATTITUDE_GAIN}倍）`);
  }

  private drawReadout(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    body: { feltLateral: number; feltLongitudinal: number; absoluteRoll: number },
    sway: { lateral: number; longitudinal: number; equilibriumLateral: number },
  ): void {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    // 振れ角を加速度へ読み替えた値（＝乗客が「今」感じている量）
    const swungLong = swayToAcceleration(sway.longitudinal);
    const swungLat = swayToAcceleration(sway.lateral);
    const lag = ((sway.equilibriumLateral - sway.lateral) * 180) / Math.PI;
    const rows: Array<[string, string, string]> = [
      [
        '前後',
        `${swungLong >= 0 ? '+' : ''}${swungLong.toFixed(2)} m/s²`,
        swungLong > 0.05 ? '前へ（制動）' : swungLong < -0.05 ? '後ろへ（力行）' : '—',
      ],
      [
        '左右',
        `${swungLat >= 0 ? '+' : ''}${swungLat.toFixed(2)} m/s²`,
        swungLat > 0.05 ? '右へ' : swungLat < -0.05 ? '左へ' : '—',
      ],
      [
        '振れ角',
        `${((Math.hypot(sway.lateral, sway.longitudinal) * 180) / Math.PI).toFixed(1)}°`,
        `遅れ ${lag >= 0 ? '+' : ''}${lag.toFixed(1)}°`,
      ],
      ['合成', `${(Math.hypot(swungLat, swungLong) / GRAVITY).toFixed(3)} G`, ''],
    ];
    let yy = y + 10;
    for (const [label_, value, note] of rows) {
      ctx.fillStyle = '#8a99ab';
      ctx.fillText(label_, x, yy);
      ctx.fillStyle = '#d7e0ea';
      ctx.fillText(value, x + 44, yy);
      if (note) {
        ctx.fillStyle = '#8a99ab';
        ctx.fillText(note, x + 108, yy);
      }
      yy += 14;
    }
  }
}

/** 重力の向きの基準となる水平線 */
function drawHorizon(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#3d4a58';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 4, 0);
  ctx.lineTo(w / 2 - 4, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 傾いた軌道面（カントまたは勾配）。車体の傾きの原因を目で追えるようにする。 */
function drawTrack(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  ties: readonly number[],
): void {
  const half = Math.max(...ties.map(Math.abs)) + 8;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = '#7d6a4a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-half, 30);
  ctx.lineTo(half, 30);
  ctx.stroke();
  for (const rx of ties) {
    ctx.beginPath();
    ctx.moveTo(rx, 30);
    ctx.lineTo(rx, 25);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCarBox(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = '#6f7d8c';
  ctx.fillStyle = 'rgba(60, 72, 86, 0.5)';
  ctx.lineWidth = 1.6;
  roundRect(ctx, -w / 2, -h / 2, w, h, 5);
  ctx.fill();
  ctx.stroke();
}

/** 吊り革（下向きの振り子） */
function drawStrap(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = '#d0b070';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, length);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, length + 4, 3.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 立っている乗客（支点が足元にある倒立振子）。
 *
 * 曲線では吊り革のリングも乗客の頭も同じ外側へ動く。ところが支点の位置が
 * 上下で逆なので、**同じ向きへ質量を動かすには回転の符号を逆にする**必要がある
 * （原点から下へ伸ばした線と上へ伸ばした線は、同じ角度で回すと先端が逆へ動く）。
 * `angle` には吊り革と符号を反転した値を渡すこと。
 */
function drawStanding(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  height = 18,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = '#9fd3ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -height);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -height - 4, 3.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  ctx.fillStyle = '#8a99ab';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 4, y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
