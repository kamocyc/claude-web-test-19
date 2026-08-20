import * as THREE from 'three';
import { mpsToKmh, paToKpa, type Simulation } from '@railsim/core';
import { CAR } from './dimensions.ts';

/**
 * 運転席の内装。
 *
 * カメラの子として取り付けるので、車体動揺でカメラが揺れても内装は視界の中で
 * 静止し、窓の外の景色だけが揺れる。これは実際に運転席から見える揺れ方と同じで、
 * 一人称視点で揺れを体感するうえで重要な点になる。
 *
 * ## 座標系と寸法の根拠
 *
 * 座標はカメラ局所系（-Z が前方、+X が右、+Y が上）で、原点は**運転士の目**。
 * 実物の運転室から、目の位置を基準に測り直した寸法で組み立てている。
 *
 *  - 運転室の長さ 2050mm、床面はレール面上 1130mm、着座した目の高さは床上 1200mm。
 *    目は前面から 1550mm、車体中心から左へ 700mm。
 *  - 前面窓は床上 1070mm から 1950mm（目から見て −130mm 〜 +750mm）。
 *    下端が目より下にあるので、20m ほど前の線路まで見下ろせる。
 *  - ハンドルを載せる机は床上 780mm。計器盤はその奥に立ち上がるが、
 *    上端は窓の下枠より低い（そうでないと前方視界を潰す）。盤は運転士の方へ
 *    25 度倒れており、速度計は φ170mm ほどで正面に来る。
 *  - 車体の内幅 2800mm。運転士は左に座るので、左の壁は 700mm、
 *    右の壁（助士側）は 2100mm 先にある。
 *  - 主幹制御器は左手、ブレーキ設定器は右手。どちらも縦軸まわりに回すハンドルで、
 *    ノッチを刻むごとに手元が回る。
 */

const FRAME_COLOR = 0x2f343b;
const PANEL_COLOR = 0x3b424a;
const DESK_COLOR = 0x272c33;
const TRIM_COLOR = 0x4d545c;

/** 運転台の各部の位置（運転士の目を原点とした値） */
const CAB = {
  /** 前面窓のガラス面 */
  windshieldZ: -1.5,
  /**
   * 前面窓の下端・上端（床上 980mm 〜 1950mm）。
   * 下端が目より 8 度下にあるので、15m ほど先の線路まで見下ろせる。
   * ここを上げると近くの軌道が見えなくなり、停止位置合わせができなくなる。
   */
  windowBottom: -0.22,
  windowTop: 0.75,
  /** 運転室の後ろの仕切り */
  partitionZ: 0.5,
  /** 天井（床上 2200mm） */
  ceilingY: 1.0,
  /** 床（床上 0mm） */
  floorY: -CAR.eyeHeight,
  /** 左右の内壁 */
  leftWallX: -0.7,
  rightWallX: 2.1,
  /** 運転台の机（ハンドルを載せる面。床上 780mm）の高さと奥行き */
  deskY: -0.42,
  deskFrontZ: -1.36,
  deskBackZ: -0.72,
  /** 計器盤の傾き（鉛直から運転士側へ倒す角） */
  panelTilt: (25 * Math.PI) / 180,
} as const;

/** 指針の振れ角の全範囲（一般的な丸形計器と同じく約 270 度） */
const SWEEP = (270 * Math.PI) / 180;

function panel(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    // 運転台の内装はつや消しの塗装と樹脂。粗さを高くして映り込みを抑える
    new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.05 }),
  );
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * 丸形計器の文字板を描く。
 *
 * 目盛りだけでは「いま何 km/h か」が読めない。実物の速度計と同じく、
 * 主目盛りに数字を書き、下に単位を入れる。キャンバスに描いてテクスチャに
 * するので、外部の画像ファイルを持たずに済む。
 */
function dialTexture(max: number, step: number, unit: string, redlineFrom?: number): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const r = size * 0.46;

  ctx.fillStyle = '#eef1f5';
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();

  /** 値 -> 文字板上の角（真上を 0 として時計回り） */
  const angleOf = (value: number): number => -SWEEP / 2 + SWEEP * (value / max);

  // 赤い危険域（最高速度の手前から）
  if (redlineFrom !== undefined) {
    ctx.strokeStyle = '#d0342c';
    ctx.lineWidth = size * 0.035;
    ctx.beginPath();
    ctx.arc(c, c, r * 0.82, angleOf(redlineFrom) - Math.PI / 2, angleOf(max) - Math.PI / 2);
    ctx.stroke();
  }

  ctx.strokeStyle = '#20262c';
  ctx.fillStyle = '#20262c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const minor = step / 2;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = angleOf(v) - Math.PI / 2;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const inner = r * (major ? 0.7 : 0.78);
    const outer = r * 0.9;
    ctx.lineWidth = size * (major ? 0.012 : 0.006);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
    ctx.lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
    ctx.stroke();
    if (major) {
      ctx.font = `bold ${Math.round(size * 0.1)}px sans-serif`;
      ctx.fillText(String(Math.round(v)), c + Math.cos(a) * r * 0.56, c + Math.sin(a) * r * 0.56);
    }
  }

  ctx.font = `${Math.round(size * 0.07)}px sans-serif`;
  ctx.fillStyle = '#4a5058';
  ctx.fillText(unit, c, c + r * 0.42);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 丸形計器。
 *
 * 実物と同じく、黒い縁（ベゼル）・文字板・指針・中心のキャップからなる。
 * 文字板は XY 平面に置いて法線を +Z にしてあるので、計器盤の傾きは
 * グループごと回してやればよい。指針は Z 軸まわりに振れる。
 */
class Gauge {
  readonly group = new THREE.Group();
  private readonly needles: THREE.Object3D[] = [];

  constructor(radius: number, max: number, step: number, unit: string, redlineFrom?: number) {
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.09, radius * 1.09, 0.03, 24),
      new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.55, metalness: 0.3 }),
    );
    bezel.rotation.x = Math.PI / 2;
    this.group.add(bezel);

    const face = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({ map: dialTexture(max, step, unit, redlineFrom) }),
    );
    face.position.z = 0.016;
    this.group.add(face);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.09, radius * 0.09, 0.012, 12),
      new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.5, metalness: 0.4 }),
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.026;
    this.group.add(cap);
  }

  /** 指針を 1 本足す（圧力計は元空気だめ圧とブレーキシリンダ圧の 2 本を持つ） */
  addNeedle(radius: number, color: number, width = 0.008): number {
    const pivot = new THREE.Group();
    const needle = new THREE.Mesh(
      new THREE.BoxGeometry(width, radius * 0.86, 0.004),
      new THREE.MeshBasicMaterial({ color }),
    );
    // 回転の中心は根元側に置く（指針は中心から外へ伸びる）
    needle.position.y = radius * 0.34;
    pivot.add(needle);
    pivot.position.z = 0.022 + this.needles.length * 0.004;
    this.group.add(pivot);
    this.needles.push(pivot);
    return this.needles.length - 1;
  }

  /** 0..1 の割合で指針を振る */
  setRatio(index: number, ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    const needle = this.needles[index];
    if (needle) needle.rotation.z = SWEEP / 2 - SWEEP * r;
  }

  /** 計器盤に取り付ける（盤の傾きぶん倒す） */
  mount(x: number, y: number, z: number): this {
    this.group.position.set(x, y, z);
    this.group.rotation.x = -CAB.panelTilt;
    return this;
  }
}

/** 運転士が握っているハンドルの位置 */
export interface CabHandles {
  readonly power: number;
  readonly brake: number;
  /** 抑速位置にあるか。ブレーキ側の切と B1 のあいだにある。 */
  readonly holding: boolean;
  readonly emergency: boolean;
  /** ワンハンドル運転台か（true ならハンドルは 1 本だけ立つ） */
  readonly oneHandle: boolean;
}

export interface CabInterior {
  readonly group: THREE.Group;
  /** 計器と表示灯をシミュレーションの状態に合わせる */
  update(sim: Simulation, handles: CabHandles): void;
}

/**
 * 運転台のハンドル（主幹制御器・ブレーキ設定器）。
 *
 * 実物のツーハンドル車は、どちらも**縦軸まわりに回す**ハンドルである。
 * 握りは運転士の方へ伸びていて、ノッチを進めるとその握りが手前から
 * 向こうへ（あるいはその逆へ）弧を描く。前後に倒すレバーではない。
 */
function buildHandle(x: number, y: number, z: number, grip: number, color: number): THREE.Group {
  const pivot = new THREE.Group();
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.085, 0.055, 16),
    new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7, metalness: 0.2 }),
  );
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.03, grip),
    new THREE.MeshStandardMaterial({ color: 0x8f959c, roughness: 0.4, metalness: 0.7 }),
  );
  arm.position.set(0, 0.045, grip / 2);
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.038, 0.1, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 }),
  );
  knob.position.set(0, 0.09, grip);
  pivot.add(hub, arm, knob);
  pivot.position.set(x, y, z);
  return pivot;
}

/**
 * ワンハンドルの主幹制御器。
 *
 * ツーハンドルの 2 本と違い、**前後に倒すレバー**である。手前へ引くほど強い
 * ブレーキ、向こうへ倒すほど強い力行で、切はその中間にある。力行とブレーキが
 * 1 本の軸に並ぶので、両方を同時に入れることが機構として起こり得ない。
 */
function buildOneHandle(x: number, y: number, z: number): THREE.Group {
  const pivot = new THREE.Group();
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.065, 0.05, 16),
    new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7, metalness: 0.2 }),
  );
  hub.rotation.z = Math.PI / 2;
  const stem = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.16, 0.035),
    new THREE.MeshStandardMaterial({ color: 0x8f959c, roughness: 0.4, metalness: 0.7 }),
  );
  stem.position.y = 0.08;
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038, 0.042, 0.11, 12),
    new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.6, metalness: 0.2 }),
  );
  knob.position.y = 0.17;
  knob.rotation.z = Math.PI / 2;
  pivot.add(hub, stem, knob);
  pivot.position.set(x, y, z);
  return pivot;
}

/**
 * 運転席の内装を組み立てる。
 *
 * 前方視界をできるだけ広く取りたいので、窓は大きく・枠は細くしてあるが、
 * 位置と大きさは実物の運転室から測った値のままである。
 */
export function createCabInterior(): CabInterior {
  const group = new THREE.Group();

  // --- 前面窓の枠 ---
  // 運転士側の窓（大きい）と助士側の窓を、中桟で仕切る 2 枚窓。
  // 運転士は左に座るので、中桟は目の右へ寄る。
  const z = CAB.windshieldZ;
  const winLeft = -0.68;
  const winRight = 1.9;
  const pillarLeft = 0.76;
  const pillarRight = 1.0;
  const t = 0.06;

  const frame = (w: number, h: number, x: number, y: number): void => {
    group.add(panel(w, h, 0.09, x, y, z, FRAME_COLOR));
  };
  frame(winRight - winLeft + t * 2, t, (winLeft + winRight) / 2, CAB.windowTop);
  frame(winRight - winLeft + t * 2, t * 1.6, (winLeft + winRight) / 2, CAB.windowBottom);
  frame(
    t,
    CAB.windowTop - CAB.windowBottom + t * 2,
    winLeft,
    (CAB.windowTop + CAB.windowBottom) / 2,
  );
  frame(
    t,
    CAB.windowTop - CAB.windowBottom + t * 2,
    winRight,
    (CAB.windowTop + CAB.windowBottom) / 2,
  );
  frame(
    pillarRight - pillarLeft,
    CAB.windowTop - CAB.windowBottom,
    (pillarLeft + pillarRight) / 2,
    (CAB.windowTop + CAB.windowBottom) / 2,
  );

  // ワイパー（窓の外側。使っていないときは下枠に沿って畳まれている）
  for (const x of [0.05, 1.4]) {
    const wiper = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.016, 0.016),
      new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.8, metalness: 0.05 }),
    );
    wiper.position.set(x, CAB.windowBottom + 0.05, z - 0.06);
    wiper.rotation.z = 0.16;
    group.add(wiper);
  }

  // --- 天井・側面・仕切り ---
  group.add(panel(3.2, 0.1, 2.3, 0.7, CAB.ceilingY, -0.4, PANEL_COLOR));
  group.add(panel(0.1, 2.2, 2.3, CAB.rightWallX, 0.0, -0.4, PANEL_COLOR));
  group.add(panel(3.2, 2.2, 0.08, 0.7, 0.0, CAB.partitionZ, PANEL_COLOR));
  group.add(panel(3.2, 0.08, 2.3, 0.7, CAB.floorY, -0.4, 0x23272c));

  // 運転士側の側窓（下降窓）。
  // ここは板を貼るのではなく**壁に開けた穴**にする。実物の運転士はこの窓から
  // 顔を出してホームの安全確認をするので、外が見えないと役に立たない。
  const sideWindow = { front: -1.4, back: -0.62, bottom: -0.08, top: 0.5 };
  const wallSegments: Array<[number, number, number, number]> = [
    // [z の中心, z の長さ, y の中心, y の高さ]
    [
      (CAB.windshieldZ + sideWindow.front) / 2,
      Math.abs(CAB.windshieldZ - sideWindow.front),
      0,
      2.2,
    ],
    [(sideWindow.back + CAB.partitionZ) / 2, CAB.partitionZ - sideWindow.back, 0, 2.2],
    [
      (sideWindow.front + sideWindow.back) / 2,
      sideWindow.back - sideWindow.front,
      (CAB.floorY + sideWindow.bottom) / 2,
      sideWindow.bottom - CAB.floorY,
    ],
    [
      (sideWindow.front + sideWindow.back) / 2,
      sideWindow.back - sideWindow.front,
      (sideWindow.top + CAB.ceilingY) / 2,
      CAB.ceilingY - sideWindow.top,
    ],
  ];
  for (const [cz, dz, cy, dy] of wallSegments) {
    group.add(panel(0.1, dy, dz, CAB.leftWallX, cy, cz, PANEL_COLOR));
  }
  // 窓枠（開口の縁を回す）
  for (const [cz, dz, cy, dy] of [
    [
      (sideWindow.front + sideWindow.back) / 2,
      sideWindow.back - sideWindow.front,
      sideWindow.bottom,
      0.05,
    ],
    [
      (sideWindow.front + sideWindow.back) / 2,
      sideWindow.back - sideWindow.front,
      sideWindow.top,
      0.05,
    ],
    [
      sideWindow.front,
      0.05,
      (sideWindow.top + sideWindow.bottom) / 2,
      sideWindow.top - sideWindow.bottom,
    ],
    [
      sideWindow.back,
      0.05,
      (sideWindow.top + sideWindow.bottom) / 2,
      sideWindow.top - sideWindow.bottom,
    ],
  ] as Array<[number, number, number, number]>) {
    group.add(panel(0.12, dy, dz, CAB.leftWallX, cy, cz, FRAME_COLOR));
  }

  // 仕切り窓（客室が透けて見える小窓）と仕切り扉
  group.add(panel(0.7, 0.5, 0.03, 1.55, 0.42, CAB.partitionZ - 0.05, 0x0e1216));
  group.add(panel(0.72, 1.9, 0.05, 0.1, -0.25, CAB.partitionZ - 0.05, TRIM_COLOR));

  // --- 運転台（机と計器盤） ---
  /** 計器盤の中心（床上 840mm あたり）。上端が窓の下枠のすぐ下に来る高さ */
  const panelCentreY = -0.36;
  /** 計器盤の高さ（傾いた面に沿って測った値） */
  const panelHeight = 0.26;

  const deskDepth = CAB.deskBackZ - CAB.deskFrontZ;
  const desk = panel(
    2.0,
    0.06,
    deskDepth,
    0.42,
    CAB.deskY,
    (CAB.deskFrontZ + CAB.deskBackZ) / 2,
    DESK_COLOR,
  );
  // 机の面は運転士側がわずかに低くなるよう傾ける
  desk.rotation.x = 0.1;
  group.add(desk);
  // 机の前垂れ（膝の前の板）
  group.add(panel(2.0, 0.55, 0.06, 0.42, CAB.deskY - 0.3, CAB.deskBackZ, DESK_COLOR));

  // 計器盤（机の奥から立ち上がり、運転士の方へ 25 度倒れている）
  const panelCentreZ = CAB.deskFrontZ + 0.06;
  const instrumentPanel = panel(
    2.0,
    panelHeight,
    0.06,
    0.42,
    panelCentreY,
    panelCentreZ,
    PANEL_COLOR,
  );
  instrumentPanel.rotation.x = -CAB.panelTilt;
  group.add(instrumentPanel);

  /**
   * 計器盤の面に載せる位置。
   * `dx` は盤の中心からの横、`du` は傾いた盤の面に沿って上へ測った量。
   * 盤は X 軸まわりに `-panelTilt` 回してあるので、盤の局所 (dx, du, 0.045) が
   * この式で世界座標に移る。
   */
  const onPanel = (dx: number, du: number): [number, number, number] => [
    0.42 + dx,
    panelCentreY + du * Math.cos(CAB.panelTilt) + 0.045 * Math.sin(CAB.panelTilt),
    panelCentreZ - du * Math.sin(CAB.panelTilt) + 0.045 * Math.cos(CAB.panelTilt),
  ];

  // 速度計（運転士の正面。実物と同じ φ170mm 程度、120km/h まで 20 刻み）
  const speedGauge = new Gauge(0.085, 120, 20, 'km/h', 110);
  const speedNeedle = speedGauge.addNeedle(0.085, 0xd02318, 0.008);
  speedGauge.mount(...onPanel(-0.42, 0));
  group.add(speedGauge.group);

  // 圧力計（2 針式。黒針が元空気だめ圧、赤針がブレーキシリンダ圧）
  const pressureGauge = new Gauge(0.058, 1000, 200, 'kPa');
  const mrNeedle = pressureGauge.addNeedle(0.058, 0x1a1d21, 0.006);
  const bcNeedle = pressureGauge.addNeedle(0.058, 0xd02318, 0.006);
  pressureGauge.mount(...onPanel(-0.2, 0));
  group.add(pressureGauge.group);

  // 電流計（力行で正、回生で負に振れるので中央が 0）
  const currentGauge = new Gauge(0.058, 1200, 300, 'A');
  const currentNeedle = currentGauge.addNeedle(0.058, 0x1a1d21, 0.006);
  currentGauge.mount(...onPanel(-0.05, 0));
  group.add(currentGauge.group);

  // モニタ装置（車両の状態を出す画面。助士側寄りにある）
  const [mx, my, mz] = onPanel(0.3, 0);
  const monitor = panel(0.3, 0.21, 0.02, mx, my, mz, 0x0b1015);
  monitor.rotation.x = -CAB.panelTilt;
  group.add(monitor);

  // 表示灯（ATS 電源・警報・非常）。計器の右に縦に 3 個並ぶ
  const lampColors = [0x2fd45f, 0xffb400, 0xff3b30];
  const lamps = lampColors.map((color, i) => {
    const lamp = new THREE.Mesh(
      new THREE.CircleGeometry(0.02, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    const [lx, ly, lz] = onPanel(0.6, 0.06 - i * 0.06);
    lamp.position.set(lx, ly, lz);
    lamp.rotation.x = -CAB.panelTilt;
    group.add(lamp);
    return lamp;
  });

  // --- ハンドル ---
  // 主幹制御器（左手）とブレーキ設定器（右手）。机の上に台座ごと載る。
  const handleY = CAB.deskY + 0.05;
  const handleZ = CAB.deskBackZ - 0.24;
  const mascon = buildHandle(-0.42, handleY, handleZ, 0.2, 0x2f6fb5);
  const brakeHandle = buildHandle(0.52, handleY, handleZ, 0.2, 0x9aa0a8);
  group.add(mascon, brakeHandle);
  // ノッチの刻み目を示す台座（ハンドルの回る扇形の板）
  const twoHandlePlates: THREE.Object3D[] = [];
  for (const x of [-0.42, 0.52]) {
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.19, 0.02, 20),
      new THREE.MeshStandardMaterial({ color: 0x1c2025, roughness: 0.8, metalness: 0.05 }),
    );
    plate.position.set(x, CAB.deskY + 0.02, handleZ);
    twoHandlePlates.push(plate);
    group.add(plate);
  }
  // ワンハンドルはツーハンドルの主幹制御器の位置に立て、選ばれた側だけを見せる
  const oneHandle = buildOneHandle(-0.42, CAB.deskY + 0.05, handleZ);
  const oneHandleBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.05, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x1c2025, roughness: 0.8, metalness: 0.05 }),
  );
  oneHandleBase.position.set(-0.42, CAB.deskY + 0.025, handleZ);
  group.add(oneHandle, oneHandleBase);

  // 運転士の椅子（背もたれの上端だけが視界の下に入る）
  group.add(panel(0.52, 0.5, 0.08, 0.0, CAB.floorY + 0.85, 0.34, 0x2a2f35));

  group.renderOrder = 10;

  return {
    group,
    update(sim: Simulation, handles: CabHandles): void {
      const snap = sim.snapshot();
      // 文字板は 120km/h いっぱいで作ってあるので、割合もその全尺で取る
      speedGauge.setRatio(speedNeedle, mpsToKmh(snap.speed) / 120);
      // 元空気だめ圧は 780〜880kPa のあたりで保たれる
      pressureGauge.setRatio(mrNeedle, 0.83);
      pressureGauge.setRatio(bcNeedle, paToKpa(snap.cylinderPressure) / 1000);
      // 電流計は中央が 0。力行で右、回生で左へ振れる
      currentGauge.setRatio(currentNeedle, 0.5 + snap.motorCurrent / 2400);

      // ハンドルの角度は「手元の位置」に連動させる。実効ノッチ（保安装置で
      // 力行がカットされた後の値）を使うと、動かしたハンドルが動かなく見えてしまう。
      const brakeCount = Math.max(1, sim.scenario.consist.brake.notchCount);
      const powerRatio = handles.power / Math.max(1, sim.scenario.consist.traction.notchCount);
      // 抑速は切と B1 のあいだにある位置なので、半段ぶんとして同じ軸へ乗せる
      const brakeRatio = handles.emergency
        ? 1.15
        : (handles.holding ? 0.5 : handles.brake) / brakeCount;

      mascon.visible = !handles.oneHandle;
      brakeHandle.visible = !handles.oneHandle;
      for (const plate of twoHandlePlates) plate.visible = !handles.oneHandle;
      oneHandle.visible = handles.oneHandle;
      oneHandleBase.visible = handles.oneHandle;

      // ツーハンドルは縦軸まわりに回すので Y 軸の回転。ノッチが進むほど握りが外へ回る
      mascon.rotation.y = powerRatio * 0.85;
      brakeHandle.rotation.y = -brakeRatio * 0.9;
      // ワンハンドルは前後に倒すレバー。力行で向こうへ、ブレーキで手前へ傾く
      oneHandle.rotation.x = (brakeRatio - powerRatio) * 0.5;

      // 表示灯: 進行（緑）・警報/パターン接近（橙）・非常（赤）
      const ind = snap.safety.indication;
      setLamp(lamps[0]!, !ind.bell && !snap.safety.emergencyBrake, 0x2fd45f);
      setLamp(lamps[1]!, ind.bell || ind.patternApproach || ind.chime, 0xffb400);
      setLamp(lamps[2]!, snap.safety.emergencyBrake || snap.emergency, 0xff3b30);
    },
  };
}

function setLamp(lamp: THREE.Mesh, on: boolean, color: number): void {
  const material = lamp.material as THREE.MeshBasicMaterial;
  material.color.setHex(on ? color : 0x2a2f35);
}
