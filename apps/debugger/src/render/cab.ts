import * as THREE from 'three';
import { formatClock, mpsToKmh, paToKpa, type Simulation } from '@railsim/core';
import type { WiperMode } from '../input/driverState.ts';
import { CAB_DESK } from './dimensions.ts';
import {
  ATS_LAMPS,
  cabPanelTexture,
  DIAL_SWEEP,
  atsPanelTexture,
  createCabMonitor,
  dialTexture,
  labelTexture,
  timetableTexture,
} from './cabTextures.ts';

/**
 * 運転室の内装。
 *
 * カメラの子として取り付けるので、車体動揺でカメラが揺れても内装は視界の中で
 * 静止し、窓の外の景色だけが揺れる。これは実際に運転席から見える揺れ方と同じで、
 * 一人称視点で揺れを体感するうえで重要な点になる。
 *
 * ## 座標系と寸法の根拠
 *
 * 座標はカメラ局所系（-Z が前方、+X が右、+Y が上）で、原点は**運転士の目**。
 * 寸法は `dimensions.ts` の `CAB_DESK` にまとめてあり、根拠もそちらに書いてある。
 * 要点だけ再掲すると:
 *
 *  - 運転室の長さ 2050mm、床面はレール面上 1130mm、着座した目の高さは床上 1200mm。
 *  - 前面窓は床上 980mm から 1950mm。下端が目より下にあるので、15m ほど前の
 *    線路まで見下ろせる（ここを上げると停止位置合わせができなくなる）。
 *  - ハンドルを載せる机は床上 780mm。計器盤はその奥に立ち上がるが、上端は
 *    窓の下枠より低い（そうでないと前方視界を潰す）。盤は運転士の方へ 25 度倒れる。
 *  - 車体の内幅 2800mm。運転士は左に座るので、左の壁は 700mm、右（助士側）は
 *    2100mm 先にある。
 *
 * ## 何を置くか
 *
 * 運転台が運転台に見えるかどうかは、**計器の数ではなく文字と配置**で決まる。
 * 実物の通勤形の運転台には、正面に速度計、その右へ圧力計・電流計、さらに右へ
 * モニタ装置、左に ATS の表示器、机の上に主幹制御器とブレーキ設定器、右手前に
 * 車掌スイッチ、机の縁に前照灯・ワイパー・耐雪ブレーキなどのスイッチが並び、
 * どれにも銘板が付いている。ここではその配置をそのまま写している。
 */

const FRAME_COLOR = 0x2f343b;
const PANEL_COLOR = 0x39404a;
const DESK_COLOR = 0x2d333a;
const TRIM_COLOR = 0x4d545c;
const WALL_COLOR = 0x555c65;
const STAINLESS = 0x9aa1a8;

/** 運転室は日の当たらない箱なので、面をわずかに自己発光させて沈み込みを防ぐ */
function surface(
  color: number,
  roughness = 0.82,
  metalness = 0.05,
  glow = 0.06,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive: color,
    emissiveIntensity: glow,
  });
}

function panel(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.Mesh {
  const item = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    surface(color, 0.82, 0.05),
  );
  item.position.set(x, y, z);
  return item;
}

/**
 * 机と計器盤の面。
 *
 * 運転台の面は塗装ではなく**梨地（しぼ）の樹脂**で、細かい粒が見える。単色の
 * 板にすると「灰色の平面」にしか見えないので、地の模様だけ入れておく。
 */
function grained(color: number, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh { // prettier-ignore
  const map = cabPanelTexture();
  const item = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      map,
      color,
      roughness: 0.86,
      metalness: 0.06,
      emissive: color,
      emissiveIntensity: 0.06,
    }),
  );
  item.position.set(x, y, z);
  return item;
}

/** 銘板つきの面（スイッチの名札・注意書き） */
function plate(width: number, height: number, texture: THREE.Texture): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.8,
      metalness: 0.05,
      emissive: 0xffffff,
      emissiveIntensity: 0.12,
      emissiveMap: texture,
    }),
  );
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

  constructor(radius: number, texture: THREE.Texture) {
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.1, radius * 1.14, 0.035, 24),
      surface(0x14171b, 0.5, 0.35, 0.04),
    );
    bezel.rotation.x = Math.PI / 2;
    this.group.add(bezel);

    const face = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 36),
      new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.75,
        metalness: 0,
        // 計器の文字板は照明で照らされている（実物も内部照明を持つ）
        emissive: 0xffffff,
        emissiveIntensity: 0.28,
        emissiveMap: texture,
      }),
    );
    face.position.z = 0.019;
    this.group.add(face);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.1, radius * 0.1, 0.012, 12),
      surface(0x24282d, 0.5, 0.4, 0.04),
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.03;
    this.group.add(cap);
  }

  /** 指針を 1 本足す（圧力計は 2 本持つ） */
  addNeedle(radius: number, color: number, width = 0.008): number {
    const pivot = new THREE.Group();
    const needle = new THREE.Mesh(
      new THREE.BoxGeometry(width, radius * 0.88, 0.004),
      new THREE.MeshBasicMaterial({ color }),
    );
    // 回転の中心は根元側に置く（指針は中心から外へ伸びる）
    needle.position.y = radius * 0.35;
    pivot.add(needle);
    // 尻（指針の反対側の短い腕）。実物の指針にもあり、これが無いと
    // 「棒が 1 本刺さっている」ように見える。
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.2, radius * 0.16, 0.004),
      new THREE.MeshBasicMaterial({ color }),
    );
    tail.position.y = -radius * 0.11;
    pivot.add(tail);
    pivot.position.z = 0.024 + this.needles.length * 0.004;
    this.group.add(pivot);
    this.needles.push(pivot);
    return this.needles.length - 1;
  }

  /** 0..1 の割合で指針を振る */
  setRatio(index: number, ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    const needle = this.needles[index];
    if (needle) needle.rotation.z = DIAL_SWEEP / 2 - DIAL_SWEEP * r;
  }

  /** 計器盤に取り付ける（盤の傾きぶん倒す） */
  mount(x: number, y: number, z: number): this {
    this.group.position.set(x, y, z);
    this.group.rotation.x = -CAB_DESK.panelTilt;
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
  readonly wiper: WiperMode;
  /** 耐雪ブレーキ（表示灯だけ。制動力はブレーキ装置が出す） */
  readonly snowproof: boolean;
  /** 前照灯（入切と減光） */
  readonly headlight: boolean;
  readonly headlightHigh: boolean;
  /** 逆転ハンドル（前 / 中立 / 後） */
  readonly reverser: 1 | 0 | -1;
  /** 戸閉め（車掌スイッチの位置） */
  readonly doorsClosed: boolean;
}

export interface CabInterior {
  readonly group: THREE.Group;
  /**
   * 計器と表示灯をシミュレーションの状態に合わせる。
   * `dt` はシミュレーション時間の進み（ワイパーを動かすのに使う）。
   */
  update(sim: Simulation, handles: CabHandles, dt: number): void;
}

/** ワイパーの原位置（下枠に沿って畳まれている角度） */
const WIPER_PARK = 0.16;
/** ワイパーが振れる角度 */
const WIPER_SWEEP = 1.5;
/** 1 往復にかかる時間 [s] */
const WIPER_PERIOD: Readonly<Record<WiperMode, number>> = { off: 0, slow: 1.4, fast: 0.8 };

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
    surface(0x22262b, 0.7, 0.2),
  );
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.03, grip),
    surface(STAINLESS, 0.4, 0.7),
  );
  arm.position.set(0, 0.045, grip / 2);
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.038, 0.1, 12),
    surface(color, 0.6, 0.2, 0.1),
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
 * 力行、向こうへ押すほど強いブレーキで、切はその中間にある。力行とブレーキが
 * 1 本の軸に並ぶので、両方を同時に入れることが機構として起こり得ない。
 */
function buildOneHandle(x: number, y: number, z: number): THREE.Group {
  const pivot = new THREE.Group();
  // 軸受け（左右方向の軸のまわりに倒れる）
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.058, 0.13, 16),
    surface(0x1e2227, 0.7, 0.25),
  );
  hub.rotation.z = Math.PI / 2;
  // 腕。運転士の手が自然に載る高さまで立ち上げる。
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.05), surface(0x2b3037, 0.6, 0.3)); // prettier-ignore
  stem.position.y = 0.075;
  // 握り（左右に伸びる棒。手のひらで包んで前後に倒す）
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.135, 14),
    surface(0x1a1d21, 0.85, 0.05, 0.06),
  );
  grip.position.y = 0.155;
  grip.rotation.z = Math.PI / 2;
  // 握りの端の色帯（実車も端に色を入れて、暗い運転室でも位置が分かるようにする）
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.029, 0.029, 0.018, 14),
    surface(0x2f6fb5, 0.55, 0.2, 0.16),
  );
  collar.position.set(-0.058, 0.155, 0);
  collar.rotation.z = Math.PI / 2;
  // 握りの上のデッドマン（手を離すと戻る押しボタン）
  const dead = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.016, 10),
    surface(0xd8d2c0, 0.6, 0.1, 0.12),
  );
  dead.position.set(0.005, 0.178, 0.012);
  pivot.add(hub, stem, grip, collar, dead);
  pivot.position.set(x, y, z);
  return pivot;
}

/** 小さな押しボタン（照光式。点灯するものは `lamp` に入れて色を変える） */
function pushButton(radius: number, color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.016, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
}

/** 表示灯の玉 */
function lampBulb(radius: number, color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CircleGeometry(radius, 14),
    new THREE.MeshBasicMaterial({ color }),
  );
}

/** トグルスイッチ（銘板つき）。つまみの倒れ方で入切が分かる。 */
function toggleSwitch(): { group: THREE.Group; set(on: boolean): void } {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.018, 0.012, 12),
    surface(0x1b1f24, 0.6, 0.3),
  );
  base.rotation.x = Math.PI / 2;
  group.add(base);
  const lever = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.005, 0.007, 0.034, 8),
    surface(0xc8ccd0, 0.35, 0.75, 0.1),
  );
  stem.position.y = 0.017;
  lever.add(stem);
  lever.position.z = 0.008;
  group.add(lever);
  return {
    group,
    set(on: boolean): void {
      // 入で手前（下）へ倒れる。実物のスイッチも、入が下であることが多い。
      lever.rotation.x = on ? 0.7 : -0.7;
    },
  };
}

/**
 * 時刻表に載せる駅と時刻。
 *
 * 同梱の試験線（`packages/data/src/assets/testLine.ts`）の駅と時刻をそのまま
 * 書き写してある。モニタ装置と車内案内表示器が同じ駅名を出すので、運転台の
 * 紙と画面が食い違わない。
 */
const TIMETABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['試験台', '', '10:00'],
  ['中原', '10:03', '10:04'],
  ['稲田堤', '10:07', '10:08'],
  ['向ヶ丘', '10:11', '10:11'],
  ['登戸', '10:15', ''],
];

/**
 * 運転席の内装を組み立てる。
 *
 * 前方視界をできるだけ広く取りたいので、窓は大きく・枠は細くしてあるが、
 * 位置と大きさは実物の運転室から測った値のままである。
 */
export function createCabInterior(): CabInterior {
  const group = new THREE.Group();
  const D = CAB_DESK;
  /** ワイパーの腕（付け根で回る） */
  const wipers: THREE.Group[] = [];
  /** ワイパーの位相 0..1（1 で 1 往復） */
  let wiperPhase = 0;

  // --- 前面窓の枠 ---
  // 運転士側の窓（大きい）と助士側の窓を、中桟で仕切る 2 枚窓。
  // 運転士は左に座るので、中桟は目の右へ寄る。
  const z = D.windshieldZ;
  const t = 0.06;
  const frame = (w: number, h: number, x: number, y: number): void => {
    group.add(panel(w, h, 0.09, x, y, z, FRAME_COLOR));
  };
  const winMidY = (D.windowTop + D.windowBottom) / 2;
  const winHeight = D.windowTop - D.windowBottom;
  frame(D.windowRight - D.windowLeft + t * 2, t, (D.windowLeft + D.windowRight) / 2, D.windowTop);
  frame(D.windowRight - D.windowLeft + t * 2, t * 1.6, (D.windowLeft + D.windowRight) / 2, D.windowBottom); // prettier-ignore
  frame(t, winHeight + t * 2, D.windowLeft, winMidY);
  frame(t, winHeight + t * 2, D.windowRight, winMidY);
  frame(D.pillarRight - D.pillarLeft, winHeight, (D.pillarLeft + D.pillarRight) / 2, winMidY);

  // 前面窓の上の日除け（巻き上げ式。運転士側だけ少し下ろしてある）。
  // 朝夕の低い日射しは前面窓の上半分から入るので、実物でもここを下ろす。
  const visor = panel(D.pillarLeft - D.windowLeft - 0.04, 0.16, 0.03, (D.windowLeft + D.pillarLeft) / 2, D.windowTop - 0.11, z + 0.05, 0x2b2f34); // prettier-ignore
  group.add(visor);
  group.add(panel(D.windowRight - D.pillarRight - 0.04, 0.05, 0.03, (D.pillarRight + D.windowRight) / 2, D.windowTop - 0.04, z + 0.05, 0x2b2f34)); // prettier-ignore

  // ワイパー（窓の外側。使っていないときは下枠に沿って畳まれている）。
  // 実物と同じく腕の付け根で回るので、ブレードはピボットから外へ伸ばす。
  for (const x of [0.05, 1.4]) {
    const pivot = new THREE.Group();
    pivot.position.set(x - 0.3, D.windowBottom + 0.02, z - 0.06);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.016, 0.016),
      surface(0x1b1e22, 0.85, 0.05, 0),
    );
    blade.position.x = 0.3;
    pivot.add(blade);
    pivot.rotation.z = WIPER_PARK;
    wipers.push(pivot);
    group.add(pivot);
  }

  // --- 天井・側面・仕切り ---
  group.add(panel(3.2, 0.1, 2.3, 0.7, D.ceilingY, -0.4, PANEL_COLOR));
  group.add(panel(0.1, 2.2, 2.3, D.rightWallX, 0.0, -0.4, WALL_COLOR));
  group.add(panel(3.2, 0.08, 2.3, 0.7, D.floorY, -0.4, 0x23272c));
  // 天井の照明（運転室灯。実物は減光して使う）
  const cabLamp = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.14),
    new THREE.MeshBasicMaterial({ color: 0xffeccd }),
  );
  cabLamp.rotation.x = Math.PI / 2;
  cabLamp.position.set(0.4, D.ceilingY - 0.055, -0.15);
  group.add(cabLamp);

  // 仕切り壁（後ろ）と、客室へ通じる仕切り扉
  group.add(panel(3.2, 2.2, 0.08, 0.7, 0.0, D.partitionZ, PANEL_COLOR));
  group.add(panel(0.74, 1.9, 0.05, 1.35, -0.25, D.partitionZ - 0.05, TRIM_COLOR));
  // 仕切り扉の窓（客室が透けて見える）。遮光幕が下りているので暗い。
  group.add(panel(0.5, 0.42, 0.03, 1.35, 0.45, D.partitionZ - 0.08, 0x0e1216));
  // 仕切り扉の握り
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.11, 8),
    surface(STAINLESS, 0.35, 0.75, 0.08),
  );
  knob.position.set(1.02, -0.25, D.partitionZ - 0.1);
  group.add(knob);

  // 運転士側の側窓（下降窓）。
  // ここは板を貼るのではなく**壁に開けた穴**にする。実物の運転士はこの窓から
  // 顔を出してホームの安全確認をするので、外が見えないと役に立たない。
  const sw = {
    front: D.sideWindowFront,
    back: D.sideWindowBack,
    bottom: D.sideWindowBottom,
    top: D.sideWindowTop,
  };
  const wallSegments: Array<[number, number, number, number]> = [
    // [z の中心, z の長さ, y の中心, y の高さ]
    [(D.windshieldZ + sw.front) / 2, Math.abs(D.windshieldZ - sw.front), 0, 2.2],
    [(sw.back + D.partitionZ) / 2, D.partitionZ - sw.back, 0, 2.2],
    [
      (sw.front + sw.back) / 2,
      sw.back - sw.front,
      (D.floorY + sw.bottom) / 2,
      sw.bottom - D.floorY,
    ],
    [(sw.front + sw.back) / 2, sw.back - sw.front, (sw.top + D.ceilingY) / 2, D.ceilingY - sw.top],
  ];
  for (const [cz, dz, cy, dy] of wallSegments) {
    group.add(panel(0.1, dy, dz, D.leftWallX, cy, cz, WALL_COLOR));
  }
  for (const [cz, dz, cy, dy] of [
    [(sw.front + sw.back) / 2, sw.back - sw.front, sw.bottom, 0.05],
    [(sw.front + sw.back) / 2, sw.back - sw.front, sw.top, 0.05],
    [sw.front, 0.05, (sw.top + sw.bottom) / 2, sw.top - sw.bottom],
    [sw.back, 0.05, (sw.top + sw.bottom) / 2, sw.top - sw.bottom],
  ] as Array<[number, number, number, number]>) {
    group.add(panel(0.12, dy, dz, D.leftWallX, cy, cz, FRAME_COLOR));
  }

  // --- 運転台（机と計器盤） ---
  /** 計器盤の中心（床上 870mm あたり）。上端が窓の下枠のすぐ下に来る高さ */
  const panelCentreY = -0.34;
  const deskDepth = D.deskBackZ - D.deskFrontZ;
  const desk = grained(DESK_COLOR, 0.42, D.deskY, (D.deskFrontZ + D.deskBackZ) / 2, 2.6, 0.06, deskDepth); // prettier-ignore
  // 机の面は運転士側がわずかに低くなるよう傾ける
  desk.rotation.x = 0.1;
  group.add(desk);
  // 机の縁（手前のふち。ここに肘や手首を置く）。少し明るい別部材にしておくと、
  // 机が「1 枚の灰色の板」に見えなくなる。
  const deskLip = panel(2.6, 0.05, 0.07, 0.42, D.deskY - 0.012, D.deskBackZ + 0.02, 0x3a4149);
  deskLip.rotation.x = 0.1;
  group.add(deskLip);
  // 机の前垂れ（膝の前の板）と、その下の足元の暗がり
  group.add(panel(2.6, 0.58, 0.06, 0.42, D.deskY - 0.32, D.deskBackZ + 0.03, DESK_COLOR));
  group.add(panel(2.6, 0.06, 0.5, 0.42, D.deskY - 0.6, D.deskBackZ - 0.25, 0x1b1f24));
  // 計器盤と机のあいだの段（盤の土台）
  group.add(panel(2.6, 0.07, 0.1, 0.42, D.deskY + 0.03, D.deskFrontZ + 0.03, 0x30363d));

  // 計器盤（机の奥から立ち上がり、運転士の方へ 25 度倒れている）
  const panelCentreZ = D.deskFrontZ + 0.06;
  const instrumentPanel = grained(PANEL_COLOR, 0.42, panelCentreY, panelCentreZ, 2.6, D.panelHeight, 0.06); // prettier-ignore
  instrumentPanel.rotation.x = -D.panelTilt;
  group.add(instrumentPanel);

  /**
   * 計器盤の面に載せる位置。
   * `dx` は盤の中心からの横、`du` は傾いた盤の面に沿って上へ測った量。
   * 盤は X 軸まわりに `-panelTilt` 回してあるので、盤の局所 (dx, du, 0.045) が
   * この式で世界座標に移る。
   */
  const onPanel = (dx: number, du: number, lift = 0.045): [number, number, number] => [
    0.42 + dx,
    panelCentreY + du * Math.cos(D.panelTilt) + lift * Math.sin(D.panelTilt),
    panelCentreZ - du * Math.sin(D.panelTilt) + lift * Math.cos(D.panelTilt),
  ];
  /** 盤に貼り付ける板（盤と同じ角度に倒す） */
  const onPanelPlate = (
    width: number,
    height: number,
    texture: THREE.Texture,
    dx: number,
    du: number,
  ): THREE.Mesh => {
    const item = plate(width, height, texture);
    item.position.set(...onPanel(dx, du, 0.048));
    item.rotation.x = -D.panelTilt;
    return item;
  };

  // 速度計（運転士の正面。φ170mm、120km/h まで 20 刻み）
  const speedGauge = new Gauge(
    D.speedDialDiameter / 2,
    dialTexture(120, 20, 'km/h', { redlineFrom: 110, caption: '速度計' }),
  );
  const speedNeedle = speedGauge.addNeedle(D.speedDialDiameter / 2, 0xd02318, 0.009);
  speedGauge.mount(...onPanel(-0.42, 0.01));
  group.add(speedGauge.group);

  // 圧力計 2 個。
  //  - 左: 元空気だめ圧（黒針）とブレーキ管圧（赤針）
  //  - 右: ブレーキシリンダ圧（黒針）と釣り合い空気だめ圧（赤針）
  // 実物の運転台にもこの 2 個が並んでいて、**元空気だめが減っていないか**と
  // **シリンダに入っているか**を別々の計器で見る。
  const small = D.smallDialDiameter / 2;
  const mrGauge = new Gauge(small, dialTexture(1000, 200, 'kPa', { caption: 'MR / BP' }));
  const mrNeedle = mrGauge.addNeedle(small, 0x1a1d21, 0.006);
  const bpNeedle = mrGauge.addNeedle(small, 0xd02318, 0.005);
  mrGauge.mount(...onPanel(-0.16, 0.01));
  group.add(mrGauge.group);

  const bcGauge = new Gauge(small, dialTexture(500, 100, 'kPa', { caption: 'BC / ER' }));
  const bcNeedle = bcGauge.addNeedle(small, 0x1a1d21, 0.006);
  const erNeedle = bcGauge.addNeedle(small, 0xd02318, 0.005);
  bcGauge.mount(...onPanel(0.02, 0.01));
  group.add(bcGauge.group);

  // 電流計（力行で右、回生で左に振れるので中央が 0）
  const currentGauge = new Gauge(small, dialTexture(1200, 300, 'A', { caption: '電流計', centreZero: true })); // prettier-ignore
  const currentNeedle = currentGauge.addNeedle(small, 0x1a1d21, 0.006);
  currentGauge.mount(...onPanel(0.2, 0.01));
  group.add(currentGauge.group);

  // ATS-P 表示器（速度計の左）。面板に名前を書き、その上に光る玉を並べる。
  const atsPlate = onPanelPlate(0.3, 0.225, atsPanelTexture(), -0.72, 0.01);
  group.add(atsPlate);
  const atsLamps = ATS_LAMPS.map((_, i) => {
    const bulb = lampBulb(0.011, 0x2a2f35);
    const row = i % 3;
    const col = i < 3 ? 0 : 1;
    bulb.position.set(...onPanel(-0.72 - 0.115 + col * 0.147 + 0.022, 0.077 - row * 0.048, 0.052));
    bulb.rotation.x = -D.panelTilt;
    group.add(bulb);
    return bulb;
  });

  // モニタ装置（車両情報表示装置）。助士側寄りに置く。
  const monitor = createCabMonitor();
  const monitorFrame = panel(0.42, 0.32, 0.03, 0, 0, 0, 0x0b0f13);
  const [mx, my, mz] = onPanel(0.62, 0.01, 0.04);
  monitorFrame.position.set(mx, my, mz);
  monitorFrame.rotation.x = -D.panelTilt;
  group.add(monitorFrame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.37, 0.278),
    new THREE.MeshBasicMaterial({ map: monitor.texture }),
  );
  screen.position.set(...onPanel(0.62, 0.01, 0.062));
  screen.rotation.x = -D.panelTilt;
  group.add(screen);

  // 表示灯の列（盤の上端）。左から 戸閉・力行・回生・非常・耐雪。
  const indicatorNames = ['戸閉', '力行', '回生', '非常', '耐雪'];
  const indicators = indicatorNames.map((name, i) => {
    const dx = -0.42 + (i - 2) * 0.072;
    const bulb = lampBulb(0.015, 0x2a2f35);
    bulb.position.set(...onPanel(dx, 0.115, 0.052));
    bulb.rotation.x = -D.panelTilt;
    group.add(bulb);
    group.add(onPanelPlate(0.068, 0.018, labelTexture(name), dx, 0.09));
    return bulb;
  });

  // 押しボタンの列（盤の下端）。確認・戸閉知らせ・警報持続・復帰。
  for (const [i, name] of ['確認', '知らせ', '警報', '復帰'].entries()) {
    const dx = 0.32 + i * 0.075;
    const button = pushButton(0.017, i === 3 ? 0xc7503f : 0x2b3037);
    button.rotation.x = Math.PI / 2 - D.panelTilt;
    button.position.set(...onPanel(dx, -0.09, 0.05));
    group.add(button);
    group.add(onPanelPlate(0.066, 0.016, labelTexture(name), dx, -0.122));
  }

  // 時刻表差し。左の壁の窓の下、机の左端の奥に立てる。実物もここか
  // 前面窓の脇にあり、**運転しながら視線をほとんど動かさずに読める**位置に置く。
  const timetable = plate(0.15, 0.22, timetableTexture(TIMETABLE));
  timetable.position.set(-0.55, D.deskY + 0.14, D.deskFrontZ + 0.12);
  timetable.rotation.set(-0.28, 0.5, 0);
  group.add(timetable);
  const holder = panel(0.19, 0.03, 0.06, -0.55, D.deskY + 0.035, D.deskFrontZ + 0.15, 0x1b1f24);
  holder.rotation.y = 0.5;
  group.add(holder);

  // --- 机の上のスイッチ ---
  // 前照灯・尾灯・ワイパー・耐雪ブレーキ。実物と同じく銘板を添える。
  const switchNames = ['前照灯', '減光', 'ワイパー', '耐雪'];
  const switches = switchNames.map((name, i) => {
    const sw2 = toggleSwitch();
    const x = 0.82 + i * 0.13;
    sw2.group.position.set(x, D.deskY + 0.04, D.deskBackZ - 0.16);
    sw2.group.rotation.x = -0.1;
    group.add(sw2.group);
    const label = plate(0.115, 0.032, labelTexture(name));
    label.position.set(x, D.deskY + 0.033, D.deskBackZ - 0.09);
    label.rotation.x = -Math.PI / 2 + 0.1;
    group.add(label);
    return sw2;
  });

  // 車掌スイッチ（戸閉め。右手の届くところにある鍵つきのスイッチ）
  const conductorBase = panel(0.16, 0.06, 0.14, 1.28, D.deskY + 0.04, D.deskBackZ - 0.2, 0x1b1f24);
  group.add(conductorBase);
  const conductorLever = new THREE.Group();
  const conductorStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.011, 0.09, 10),
    surface(STAINLESS, 0.35, 0.75, 0.1),
  );
  conductorStem.position.y = 0.045;
  const conductorKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 10, 8),
    surface(0x2b2f34, 0.6, 0.2, 0.08),
  );
  conductorKnob.position.y = 0.095;
  conductorLever.add(conductorStem, conductorKnob);
  conductorLever.position.set(1.28, D.deskY + 0.06, D.deskBackZ - 0.2);
  group.add(conductorLever);
  const conductorLabel = plate(0.14, 0.033, labelTexture('車掌スイッチ'));
  conductorLabel.position.set(1.28, D.deskY + 0.033, D.deskBackZ - 0.1);
  conductorLabel.rotation.x = -Math.PI / 2 + 0.1;
  group.add(conductorLabel);

  // --- ハンドル ---
  // 主幹制御器（左手）とブレーキ設定器（右手）。机の上に台座ごと載る。
  const handleY = D.deskY + 0.05;
  const handleZ = D.deskBackZ - 0.24;
  const mascon = buildHandle(-0.42, handleY, handleZ, 0.2, 0x2f6fb5);
  const brakeHandle = buildHandle(0.52, handleY, handleZ, 0.2, 0x9aa0a8);
  group.add(mascon, brakeHandle);
  const twoHandlePlates: THREE.Object3D[] = [];
  for (const x of [-0.42, 0.52]) {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.19, 0.02, 20),
      surface(0x1c2025, 0.8, 0.05),
    );
    base.position.set(x, D.deskY + 0.02, handleZ);
    twoHandlePlates.push(base);
    group.add(base);
    // ノッチの刻み目（実物のハンドル台にも段の位置が刻んである）
    for (let k = 0; k <= 8; k++) {
      const a = -0.9 + (k / 8) * 1.8;
      const notch = new THREE.Mesh(
        new THREE.BoxGeometry(0.006, 0.004, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x8f959c }),
      );
      notch.position.set(x + Math.sin(a) * 0.155, D.deskY + 0.031, handleZ + Math.cos(a) * 0.155);
      notch.rotation.y = a;
      twoHandlePlates.push(notch);
      group.add(notch);
    }
  }
  // ワンハンドルはツーハンドルの主幹制御器の位置に立て、選ばれた側だけを見せる
  const oneHandle = buildOneHandle(-0.42, D.deskY + 0.05, handleZ);
  const oneHandleBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.19, 0.05, 0.3),
    surface(0x1c2025, 0.8, 0.05),
  );
  oneHandleBase.position.set(-0.42, D.deskY + 0.025, handleZ);
  // ノッチの並びを刻んだ板（手元で段の位置が読めるように、握りの右脇へ寝かせる）
  const oneHandleScale = plate(0.045, 0.22, labelTexture('P  N  B'));
  oneHandleScale.position.set(-0.28, D.deskY + 0.052, handleZ);
  oneHandleScale.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  group.add(oneHandle, oneHandleBase, oneHandleScale);

  // 逆転ハンドル（主幹制御器の左手前。前・中立・後の 3 位置）
  const reverserPivot = new THREE.Group();
  const reverserBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.06, 0.03, 14),
    surface(0x1c2025, 0.8, 0.05),
  );
  reverserBase.position.set(-0.68, D.deskY + 0.03, handleZ + 0.02);
  const reverserLever = new THREE.Mesh(
    new THREE.BoxGeometry(0.028, 0.026, 0.13),
    surface(0x8f959c, 0.4, 0.7, 0.08),
  );
  reverserLever.position.z = 0.06;
  reverserPivot.add(reverserLever);
  reverserPivot.position.set(-0.68, D.deskY + 0.055, handleZ + 0.02);
  group.add(reverserBase, reverserPivot);

  // 警笛のペダル（足元。空気笛と電子警報の 2 つ）
  for (const [i, px] of [-0.5, -0.28].entries()) {
    const pedal = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.02, 0.2),
      surface(i === 0 ? 0x2b2f34 : 0x3b3026, 0.85, 0.1),
    );
    pedal.position.set(px, D.floorY + 0.05, D.deskBackZ - 0.35);
    pedal.rotation.x = -0.25;
    group.add(pedal);
  }

  // --- 運転席の椅子 ---
  // 背もたれの上端と肘掛けだけが視界の下の隅に入る。折りたたみ式の座面を
  // 支える柱が床から立っている。
  const seatY = D.floorY + D.seatHeight;
  group.add(panel(0.46, 0.1, 0.44, -0.02, seatY, 0.24, 0x2a2f35));
  group.add(panel(0.5, 0.5, 0.1, -0.02, seatY + 0.3, 0.44, 0x2a2f35));
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.06, D.seatHeight, 12),
    surface(0x1b1f24, 0.7, 0.3),
  );
  column.position.set(-0.02, D.floorY + D.seatHeight / 2, 0.24);
  group.add(column);
  for (const ax of [-0.26, 0.22]) {
    group.add(panel(0.05, 0.05, 0.34, ax, seatY + 0.16, 0.22, 0x23272c));
  }

  // 消火器（助士側の隅。実物も運転室に 1 本ある）
  const extinguisher = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.32, 12),
    surface(0xc03a2c, 0.55, 0.2, 0.1),
  );
  extinguisher.position.set(1.9, D.floorY + 0.16, 0.28);
  group.add(extinguisher);

  group.renderOrder = 10;

  return {
    group,
    update(sim: Simulation, handles: CabHandles, dt: number): void {
      const snap = sim.snapshot();
      const speedKmh = mpsToKmh(snap.speed);
      speedGauge.setRatio(speedNeedle, speedKmh / 120);
      // 元空気だめ圧は圧縮機が 780〜880kPa のあたりで保つ。ブレーキ管は
      // 電気指令式なので常用圧のまま（元空気だめから減圧弁で作る）。
      const mr = paToKpa(snap.compressor.pressure);
      mrGauge.setRatio(mrNeedle, mr / 1000);
      mrGauge.setRatio(bpNeedle, 490 / 1000);
      const bc = paToKpa(snap.cylinderPressure);
      bcGauge.setRatio(bcNeedle, bc / 500);
      // 釣り合い空気だめ圧は指令そのもの。BC 圧が遅れて追いつく先を示す。
      const brakeCount = Math.max(1, sim.scenario.consist.brake.notchCount);
      const command = snap.emergency ? 1 : snap.brakeNotch / brakeCount;
      bcGauge.setRatio(erNeedle, (command * 440) / 500);
      currentGauge.setRatio(currentNeedle, 0.5 + snap.motorCurrent / 2400);

      // ハンドルの角度は「手元の位置」に連動させる。実効ノッチ（保安装置で
      // 力行がカットされた後の値）を使うと、動かしたハンドルが動かなく見えてしまう。
      const powerRatio = handles.power / Math.max(1, sim.scenario.consist.traction.notchCount);
      // 抑速は切と B1 のあいだにある位置なので、半段ぶんとして同じ軸へ乗せる
      const brakeRatio = handles.emergency
        ? 1.15
        : (handles.holding ? 0.5 : handles.brake) / brakeCount;

      mascon.visible = !handles.oneHandle;
      brakeHandle.visible = !handles.oneHandle;
      for (const item of twoHandlePlates) item.visible = !handles.oneHandle;
      oneHandle.visible = handles.oneHandle;
      oneHandleBase.visible = handles.oneHandle;
      oneHandleScale.visible = handles.oneHandle;

      // ツーハンドルは縦軸まわりに回すので Y 軸の回転。ノッチが進むほど握りが外へ回る
      mascon.rotation.y = powerRatio * 0.85;
      brakeHandle.rotation.y = -brakeRatio * 0.9;
      // ワンハンドルは前後に倒すレバー。実物と同じく、力行は手前へ引き、ブレーキは
      // 向こうへ押す（+X まわりの回転は握りを +Z ＝ 運転士の側へ倒す）。
      oneHandle.rotation.x = (powerRatio - brakeRatio) * 0.5;
      // 逆転ハンドルは前・中立・後の 3 位置
      reverserPivot.rotation.x = handles.reverser * 0.35;

      // 表示灯: 戸閉・力行・回生・非常・耐雪
      setLamp(indicators[0]!, snap.doors.interlocked, 0x2fd45f);
      setLamp(indicators[1]!, snap.tractiveEffort > 1000, 0xffb400);
      setLamp(indicators[2]!, snap.electricBrakeForce > 1000, 0x4fc3f7);
      setLamp(indicators[3]!, snap.safety.emergencyBrake || snap.emergency, 0xff3b30);
      setLamp(indicators[4]!, handles.snowproof, 0x9ad0ff);

      // ATS-P 表示器: 電源・パターン接近・ブレーキ動作・故障・開放・ATS-SN
      const ind = snap.safety.indication;
      setLamp(atsLamps[0]!, true, 0x2fd45f);
      setLamp(atsLamps[1]!, ind.patternApproach || ind.bell || ind.chime, 0xffb400);
      setLamp(atsLamps[2]!, ind.brakeApplied || snap.safety.emergencyBrake, 0xff3b30);
      setLamp(atsLamps[3]!, false, 0xff3b30);
      setLamp(atsLamps[4]!, false, 0xffb400);
      setLamp(atsLamps[5]!, ind.patternSpeed === null, 0x9ad0ff);

      // 机の上のスイッチ
      switches[0]?.set(handles.headlight);
      switches[1]?.set(handles.headlight && !handles.headlightHigh);
      switches[2]?.set(handles.wiper !== 'off');
      switches[3]?.set(handles.snowproof);
      // 車掌スイッチは戸閉めで倒れる
      conductorLever.rotation.x = handles.doorsClosed ? -0.5 : 0.5;

      monitor.update({
        speed: speedKmh,
        limit: mpsToKmh(Math.min(snap.speedLimit, sim.scenario.route.maxSpeed)),
        notch: notchLabel(handles),
        cylinder: bc,
        reservoir: mr,
        current: snap.motorCurrent,
        doorsClosed: snap.doors.interlocked,
        nextStation: snap.nextStationName ?? '—',
        distance: snap.distanceToStop ?? 0,
        clock: formatClock(snap.time),
      });

      // ワイパーは往復する 1 自由度の運動。切ったあとも原位置まで戻ってから
      // 止まる（実物も途中では止まらない）。
      const period = WIPER_PERIOD[handles.wiper];
      if (period > 0) wiperPhase = (wiperPhase + dt / period) % 1;
      else if (wiperPhase > 0) {
        const next = wiperPhase + dt / WIPER_PERIOD.slow;
        wiperPhase = next >= 1 ? 0 : next;
      }
      const sweep = 0.5 - 0.5 * Math.cos(2 * Math.PI * wiperPhase);
      for (const wiper of wipers) wiper.rotation.z = WIPER_PARK + sweep * WIPER_SWEEP;
    },
  };
}

/** モニタ装置に出すノッチの表示（HUD と同じ書き方） */
function notchLabel(handles: CabHandles): string {
  if (handles.emergency) return '非常';
  if (handles.brake > 0) return `B${handles.brake}`;
  if (handles.holding) return '抑速';
  return handles.power > 0 ? `P${handles.power}` : 'N';
}

function setLamp(lamp: THREE.Mesh, on: boolean, color: number): void {
  const material = lamp.material as THREE.MeshBasicMaterial;
  material.color.setHex(on ? color : 0x2a2f35);
}
