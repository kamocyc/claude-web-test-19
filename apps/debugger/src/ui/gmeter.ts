import { GRAVITY, type Simulation } from '@railsim/core';

const WIDTH = 340;
const HEIGHT = 214;
/** G サークルの外周が表す加速度 [m/s^2] */
const FULL_SCALE = 1.6;
const TRAIL_LENGTH = 90;

interface TrailPoint {
  readonly lateral: number;
  readonly longitudinal: number;
}

/**
 * 加速度を直感的に示すメータ。
 *
 * 数値だけでは体感が伝わらないので、次の 3 つを並べて表示する:
 *
 *  1. **G サークル** — 前後 G と左右 G を 1 点で表し、軌跡を残す。
 *     力行・制動は縦に、曲線通過は横に振れる。円は 0.5 / 1.0 / 1.5 m/s²。
 *  2. **前面図** — 車体をロール角ぶん傾けて描き、その中に吊り革を吊るす。
 *     吊り革は「車体座標系での重力 + 慣性力」の向きに垂れるので、
 *     乗客が実際にどちらへ振られるかがそのまま見える。
 *  3. **側面図** — ピッチングと、前後方向に振られる吊り革。
 *
 * 車体がロールすると重力の横成分が加わるため、吊り革の傾きは
 * 軌道面の非平衡横加速度から計算した角度より大きくなる。
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
    // 乗客が感じる比力（正: 右へ押される / 後ろへ押される）
    const lateral = body.feltLateral;
    const longitudinal = body.feltLongitudinal;
    const vertical = body.feltVertical;

    this.trail.push({ lateral, longitudinal });
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();

    ctx.fillStyle = 'rgba(13, 17, 23, 0.78)';
    roundRect(ctx, 0, 0, WIDTH, HEIGHT, 6);
    ctx.fill();
    ctx.strokeStyle = '#2a3440';
    ctx.stroke();

    this.drawCircle(ctx, 8, 8, 138, lateral, longitudinal);
    // 前面図は水平面に対する姿勢で描く。車体は「カントで傾いた軌道面」の上で
    // さらにロールするので、その 2 段構えがそのまま見えるようにする。
    this.drawFrontView(ctx, 158, 10, 172, 92, body.absoluteRoll, body.trackRoll, lateral, vertical);
    this.drawSideView(ctx, 158, 106, 172, 66, body.pitch, longitudinal, vertical);
    this.drawReadout(ctx, 8, 154, lateral, longitudinal, body.absoluteRoll);
  }

  /** 前後 G・左右 G の 2 次元表示 */
  private drawCircle(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    lateral: number,
    longitudinal: number,
  ): void {
    const cx = x + size / 2;
    const cy = y + size / 2;
    const r = size / 2 - 6;
    const toPx = (v: number) => (v / FULL_SCALE) * r;

    ctx.save();
    ctx.strokeStyle = '#243040';
    ctx.lineWidth = 1;
    for (const level of [0.5, 1.0, 1.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, toPx(level), 0, Math.PI * 2);
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
    // 点は「乗客が押される向き」に動く。制動なら前（上）、力行なら後ろ（下）。
    ctx.fillText('前（制動）', cx, cy - toPx(1.0) - 3);
    ctx.fillText('後（力行）', cx, cy + toPx(1.0) + 10);
    ctx.textAlign = 'left';
    ctx.fillText('右', cx + toPx(1.0) + 3, cy + 3);
    ctx.textAlign = 'right';
    ctx.fillText('左', cx - toPx(1.0) - 3, cy + 3);

    // 軌跡（古いほど薄い）
    ctx.lineWidth = 1.5;
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1]!;
      const b = this.trail[i]!;
      const alpha = (i / this.trail.length) * 0.55;
      ctx.strokeStyle = `rgba(78, 163, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx + toPx(a.lateral), cy - toPx(a.longitudinal));
      ctx.lineTo(cx + toPx(b.lateral), cy - toPx(b.longitudinal));
      ctx.stroke();
    }

    const px = cx + toPx(lateral);
    const py = cy - toPx(longitudinal);
    const magnitude = Math.hypot(lateral, longitudinal);
    ctx.fillStyle = magnitude > 1.2 ? '#ff6b6b' : magnitude > 0.7 ? '#ffb454' : '#7ddc8a';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 前面図: 車体のロールと、左右へ振られる吊り革 */
  private drawFrontView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    roll: number,
    trackRoll: number,
    lateral: number,
    vertical: number,
  ): void {
    const cx = x + w / 2;
    const cy = y + h / 2 + 6;

    // 水平線（重力の向きの基準）。これが無いとカントで車体が傾いていることが分からない。
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

    // 軌道面（カントで傾いたレール）。車体の傾きの原因を目で追えるようにする。
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(trackRoll);
    ctx.strokeStyle = '#7d6a4a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-30, 30);
    ctx.lineTo(30, 30);
    ctx.stroke();
    for (const rx of [-22, 22]) {
      ctx.beginPath();
      ctx.moveTo(rx, 30);
      ctx.lineTo(rx, 25);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    // 画面の y は下向きなので、右下がりのロールは時計回り＝正の回転になる
    ctx.rotate(roll);

    const bw = 66;
    const bh = 46;
    ctx.strokeStyle = '#6f7d8c';
    ctx.fillStyle = 'rgba(60, 72, 86, 0.5)';
    ctx.lineWidth = 1.6;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 6);
    ctx.fill();
    ctx.stroke();

    // 吊り革は「重力 + 慣性力」の向きに垂れる
    // canvas は y が下向きなので、右へ振れる（正の lateral）には負の回転を与える
    const swingAngle = -Math.atan2(lateral, Math.max(vertical, 1));
    ctx.save();
    ctx.translate(0, -bh / 2 + 6);
    ctx.rotate(swingAngle);
    ctx.strokeStyle = '#d0b070';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 20);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 24, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 立っている乗客（同じ角度で傾く）
    ctx.save();
    ctx.translate(-20, bh / 2 - 4);
    ctx.rotate(swingAngle);
    ctx.strokeStyle = '#9fd3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -18);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -22, 3.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    ctx.fillStyle = '#8a99ab';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('前方を見た図（ロールと左右の振られ）', x + 4, y + 10);
  }

  /** 側面図: ピッチングと、前後へ振られる吊り革 */
  private drawSideView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    pitch: number,
    longitudinal: number,
    vertical: number,
  ): void {
    const cx = x + w / 2;
    const cy = y + h / 2 + 4;
    ctx.save();
    ctx.translate(cx, cy);
    // 前下がりのピッチは、進行方向を右に描くと時計回りになる
    ctx.rotate(pitch);

    const bw = 116;
    const bh = 30;
    ctx.strokeStyle = '#6f7d8c';
    ctx.fillStyle = 'rgba(60, 72, 86, 0.5)';
    ctx.lineWidth = 1.6;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 5);
    ctx.fill();
    ctx.stroke();
    // 進行方向を示す矢印
    ctx.strokeStyle = '#4ea3ff';
    ctx.beginPath();
    ctx.moveTo(bw / 2 - 14, 0);
    ctx.lineTo(bw / 2 - 4, 0);
    ctx.lineTo(bw / 2 - 8, -3);
    ctx.moveTo(bw / 2 - 4, 0);
    ctx.lineTo(bw / 2 - 8, 3);
    ctx.stroke();

    // 前後方向の吊り革。加速中は後ろ（画面左）へ振られる
    const swing = Math.atan2(longitudinal, Math.max(vertical, 1));
    ctx.save();
    ctx.translate(10, -bh / 2 + 4);
    ctx.rotate(-swing);
    ctx.strokeStyle = '#d0b070';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 19, 3.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    ctx.fillStyle = '#8a99ab';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('側面（ピッチと前後の振られ）', x + 4, y + 8);
  }

  private drawReadout(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    lateral: number,
    longitudinal: number,
    roll: number,
  ): void {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const rows: Array<[string, string, string]> = [
      [
        '前後',
        `${longitudinal >= 0 ? '+' : ''}${longitudinal.toFixed(2)} m/s²`,
        longitudinal > 0.05 ? '前へ（制動）' : longitudinal < -0.05 ? '後ろへ（力行）' : '—',
      ],
      [
        '左右',
        `${lateral >= 0 ? '+' : ''}${lateral.toFixed(2)} m/s²`,
        lateral > 0.05 ? '右へ' : lateral < -0.05 ? '左へ' : '—',
      ],
      ['ロール', `${((roll * 180) / Math.PI).toFixed(2)}°`, ''],
      ['合成', `${(Math.hypot(lateral, longitudinal) / GRAVITY).toFixed(3)} G`, ''],
    ];
    let yy = y + 10;
    for (const [label, value, note] of rows) {
      ctx.fillStyle = '#8a99ab';
      ctx.fillText(label, x, yy);
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
