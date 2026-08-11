import {
  GRAVITY,
  swayToAcceleration,
  type BalanceAxisState,
  type Simulation,
  type StanceState,
} from '@railsim/core';

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
 * 加速度を「車内の人と物がどう動くか」で示すメータ。
 *
 * 加速度の数値を角度へ直接変換すると、加速度が変わった瞬間に角度が飛んでしまい、
 * 加加速度（ジャーク）が見えない。ここでは物理コアが解いている 2 つの模型を描く。
 *
 *  - **吊り革** — 減衰振り子（固有周期 1.5 秒）。比力に遅れて追従する物。
 *  - **立っている乗客** — 足首を支点とした倒立振子に、0.14 秒のむだ時間を持つ
 *    姿勢制御を載せた人。加速度が緩やかに変われば押される向きへ**よりかかる**
 *    だけで済み、急に変われば取り残されて倒れ、足が出る。
 *
 * 同じ加減速でも**変え方**で絵が変わる、というのがこのメータの目的である。
 *
 * 表示は 3 つ:
 *
 *  1. **振れ盤** — 吊り革の先端を真上から見た位置と、その軌跡。
 *     瞬時の平衡点（＝加速度そのものの向き）を薄い十字で重ねてあり、
 *     両者の隔たりが「まだ振れ切っていない量」になる。乗客の足圧中心も重ねる。
 *  2. **前面図** — カントで傾いた軌道面、その上でロールした車体、
 *     さらにその中で振られる吊り革と、踏ん張っている乗客。
 *  3. **側面図** — 勾配で傾いた床、車体のピッチング、前後の吊り革と乗客。
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
    const sway = body.passenger.strap;
    const stance = body.passenger.stance;

    this.trail.push({ lateral: sway.lateral, longitudinal: sway.longitudinal });
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();

    ctx.fillStyle = 'rgba(13, 17, 23, 0.78)';
    roundRect(ctx, 0, 0, WIDTH, HEIGHT, 6);
    ctx.fill();
    ctx.strokeStyle = '#2a3440';
    ctx.stroke();

    this.drawSwayPlate(ctx, 8, 8, 138, sway, stance);
    this.drawFrontView(
      ctx,
      158,
      10,
      172,
      92,
      body.absoluteRoll,
      body.trackRoll,
      sway.lateral,
      stance.lateral,
    );
    this.drawSideView(
      ctx,
      158,
      106,
      172,
      66,
      body.absolutePitch,
      body.trackPitch,
      sway.longitudinal,
      stance.longitudinal,
    );
    this.drawReadout(ctx, 8, 154, stance);
  }

  /**
   * 振れ盤: 吊り革の先端を真上から見た図。
   * 制動なら前（上）へ、力行なら後ろ（下）へ、曲線なら外側へ振れる。
   *
   * 立っている乗客の**支持余裕**（外挿重心が支持基底面のどこにあるか）も、
   * 同じ真上から見た図として重ねる。外周の円が「これ以上は足を出すしかない」縁で、
   * 縁に触れた瞬間に足が出る。吊り革が外側へ振れる向きと、乗客が踏ん張る向きが
   * 逆であることが一目で分かる。
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
    stance: StanceState,
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

    // --- 立っている乗客の支持余裕 ---
    // 外挿重心を支持基底面の縁で正規化した量なので、半径 1 の円が「縁」になる。
    // 盤の半径をそのまま 1 として重ねる。
    const balanceR = r * 0.72;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = 'rgba(125, 220, 138, 0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, balanceR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 前後は爪先側が広く踵側が狭い。倒れる向きと支える向きが逆なので符号を反転する。
    const bx = cx + clampUnit(stance.lateral.margin * signOf(stance.lateral.error)) * balanceR;
    const by =
      cy - clampUnit(stance.longitudinal.margin * signOf(stance.longitudinal.error)) * balanceR;
    ctx.fillStyle = stance.stagger > 1 ? '#ff6b6b' : stance.stagger > 0.6 ? '#ffb454' : '#7ddc8a';
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 前面図: 軌道面のカント → 車体のロール → 吊り革の振れと乗客の踏ん張り */
  private drawFrontView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    roll: number,
    trackRoll: number,
    swing: number,
    stance: BalanceAxisState,
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
    drawStanding(ctx, -20, 46 / 2 - 4, stance);
    ctx.restore();

    label(ctx, x, y + 10, `前方（カント → ロール → 振られ・角度 ${ATTITUDE_GAIN}倍）`);
  }

  /** 側面図: 勾配 → 車体のピッチング → 前後の吊り革と乗客 */
  private drawSideView(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    pitch: number,
    trackPitch: number,
    swing: number,
    stance: BalanceAxisState,
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
    drawStanding(ctx, -34, 30 / 2 - 3, stance, 14);
    ctx.restore();

    label(ctx, x, y + 8, `側面（勾配 → ピッチ → 振られ・${ATTITUDE_GAIN}倍）`);
  }

  /**
   * 数値の読み出し。
   *
   * 「いま何 m/s² か」ではなく「乗客がどれだけ持ちこたえているか」を主役にする。
   * 傾きは押される向きへ**よりかかっている**量で、目標との差（追従の遅れ）が
   * そのままよろけの原因になる。
   */
  private drawReadout(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    stance: StanceState,
  ): void {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const lat = stance.lateral;
    const lon = stance.longitudinal;
    // 目標の傾きを加速度に読み替える（tan θ* = a / g）
    const aLong = -swayToAcceleration(lon.target);
    const aLat = -swayToAcceleration(lat.target);
    const effort = Math.max(lat.effort, lon.effort);
    const rows: Array<[string, string, string]> = [
      // 傾きは「正 = 前／右へ倒れている」。押される向きと逆へよりかかるので、
      // 比力と符号が逆になる。ずれ（= 傾き − 目標）が追従の遅れそのもの。
      [
        '前後',
        `${aLong >= 0 ? '+' : ''}${aLong.toFixed(2)} m/s²`,
        `よりかかり ${deg1(lon.target)}° / ずれ ${deg1(lon.error)}°`,
      ],
      [
        '左右',
        `${aLat >= 0 ? '+' : ''}${aLat.toFixed(2)} m/s²`,
        `よりかかり ${deg1(lat.target)}° / ずれ ${deg1(lat.error)}°`,
      ],
      [
        'よろけ',
        `${(stance.stagger * 100).toFixed(0)} %`,
        `踏ん張り ${(effort * 100).toFixed(0)}%` +
          (lat.stepping || lon.stepping ? ' 踏み出し中' : ''),
      ],
      [
        '合成',
        `${(Math.hypot(aLat, aLong) / GRAVITY).toFixed(3)} G`,
        stance.steps > 0 ? `足が出た ${stance.steps} 回` : '',
      ],
    ];
    let yy = y + 10;
    for (const [label_, value, note] of rows) {
      ctx.fillStyle = '#8a99ab';
      ctx.fillText(label_, x, yy);
      ctx.fillStyle = label_ === 'よろけ' && stance.stagger > 1 ? '#ff6b6b' : '#d7e0ea';
      ctx.fillText(value, x + 44, yy);
      if (note) {
        ctx.fillStyle = '#8a99ab';
        ctx.fillText(note, x + 108, yy);
      }
      yy += 14;
    }
  }
}

/** ラジアンを 1 桁の度の文字列に（符号つき） */
const deg1 = (rad: number): string => {
  const d = (rad * 180) / Math.PI;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
};

const clampUnit = (x: number): number => (x < -1.15 ? -1.15 : x > 1.15 ? 1.15 : x);

const signOf = (x: number): number => (x >= 0 ? 1 : -1);

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
 * 立っている乗客（足首を支点とした倒立振子）。
 *
 * 吊り革と違い、**押される向きへよりかかる**ので上体は加速度と逆へ傾く。
 * 描き分けるのは 3 つ。
 *
 *  - 上体の傾き（`lean`。正 = その向きへ倒れる。canvas の y は下向きなので、
 *    原点から上へ伸ばした線を正の角度で回すと先端は +x へ動く）
 *  - 足圧中心（足元の短い横線）。踏ん張るほど支持基底面の縁へ寄る
 *  - 踏み出し中は赤くして、出した足を描く
 */
function drawStanding(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  stance: BalanceAxisState,
  height = 18,
): void {
  ctx.save();
  ctx.translate(x, y);
  // 支持基底面と足圧中心（1m = 40px 相当。足元の数 cm を読めるようにする）
  const scale = 40;
  ctx.strokeStyle = '#4b5b6b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-stance.copLimit * scale, 1.5);
  ctx.lineTo(stance.copLimit * scale, 1.5);
  ctx.stroke();
  ctx.strokeStyle = stance.effort > 0.95 ? '#ff6b6b' : '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(stance.cop * scale, -1);
  ctx.lineTo(stance.cop * scale, 3.5);
  ctx.stroke();

  // 踏み出した足（着地するまでのあいだ、倒れる向きへ伸びている）
  if (stance.stepping) {
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(stance.stepDirection * scale * 0.18, 2);
    ctx.stroke();
  }

  ctx.rotate(stance.lean * ATTITUDE_GAIN);
  ctx.strokeStyle = stance.stepping ? '#ff8a8a' : '#9fd3ff';
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
