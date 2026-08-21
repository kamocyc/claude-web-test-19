import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR, INTERIOR } from './dimensions.ts';
import type { CarLayout, SeatBay } from './interior.ts';
import { shadeWithVertexColor } from './interiorShading.ts';

/**
 * 車内の乗客。
 *
 * ## なぜ人を置くのか
 *
 * この作品は**立っている乗客の姿勢を物理で解いている**（`packages/core/src/train/
 * passenger.ts` の倒立振子 + むだ時間を持つ姿勢制御）。その値を使わずに空っぽの
 * 車内を描くのは、いちばん見どころのある計算を捨てているのと同じである。加速の
 * たびに車内の人が**一斉に**同じ向きへ傾き、急に緩めると戻り遅れてよろける、
 * という絵は、加速度を人の姿勢へ通してはじめて出る。
 *
 * ## 座っている人と立っている人は動き方が違う
 *
 * 座っている人は背ずりと座面に体重を預けているので、比力が変わっても**ほとんど
 * 動かない**（首から上がわずかに振れるだけ）。立っている人は足首を支点にした
 * 倒立振子なので、上体ごと傾く。ここではその差をそのまま作り分けている
 * ——座席の人は傾きの 15% しか動かさない。
 *
 * ## 誇張について
 *
 * `core` が出す傾きは実物どおりで、常用最大の 3km/h/s でも 5 度ほどにしかならない。
 * 5 度は写真で見ると「ほとんどまっすぐ」で、絵としては何も起きていないように
 * 見える。そこで**描画側で `LEAN_GAIN` 倍に誇張している**。物理の値は一切
 * 書き換えていない（`core` は読むだけ）ので、記録・再生や状態ハッシュには影響しない。
 *
 * ## 費用
 *
 * 1 両に数十人置くので、体の部位ごとに `InstancedMesh` へまとめて 1 回の描画で
 * 出す。姿勢の違い（座る・吊り革・手すり）は形が違うので別の `InstancedMesh` に
 * なるが、それでも 1 両あたり 9 回で済む。顔は作らない——車内で他人の顔を
 * まじまじと見ることはないし、作れば作るほど「人形」に見える。
 */

/** 立っている人の傾きの誇張。実物の 5 度では絵として読めないため。 */
const LEAN_GAIN = 1.9;

/**
 * 座っている人の膝が、その人の原点（腰の位置）から通路側へ出ている量 [m]。
 *
 * ロングシートの奥行きは 430mm しかないのに大腿長は 400mm 前後あるので、
 * **座れば必ず膝が座席の前縁より前へ出る**。実物の通勤形で通路が狭く感じるのは
 * 座席の奥行きではなく、この膝のためである。歩くモードの当たり判定
 * （`walk.ts` の `corridorBounds`）も同じ値を見る——見えている膝を通り抜けたら
 * その場で嘘になる。
 */
export const SEATED_KNEE_REACH = 0.27;

/** 人 1 人が前後に占める幅の半分 [m]（肩幅の半分に少し余裕を見た値） */
export const SEATED_HALF_WIDTH = 0.24;
/** 座っている人は背ずりに預けているので、傾きはほとんど出ない */
const SEATED_LEAN_RATIO = 0.15;

/** mulberry32。座る位置・服の色は seed で決める（走行のたびに変わっては困る）。 */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 服の色。
 *
 * 通勤電車の車内は**暗い色が多い**（黒・紺・灰の上着に、ときどき明るい色が
 * 混じる）。全員を派手にすると花畑になり、全員を黒にすると影の塊になる。
 */
const COAT_COLORS = [
  0x23262b, 0x1c2735, 0x2f3238, 0x3a3f46, 0x4a4038, 0x1e3a34, 0x5a5048, 0x6b4a44, 0x8c8f94,
  0x2a3c52, 0xb0a89c, 0x7a3f46, 0x2b4a62, 0x40342c,
];
const TROUSER_COLORS = [
  0x1e2126, 0x24303f, 0x2c2f34, 0x38312a, 0x3f4247, 0x2a2d31, 0x4a4640, 0x1b2733,
];
/** 肌の色。日焼けの差ぶんだけ振る。 */
const SKIN_COLORS = [0xd9b193, 0xe4c1a4, 0xc9a082, 0xe8c8ac, 0xbf9070];

/** 部位の分け方（`InstancedMesh` の単位） */
interface BodyParts {
  readonly skin: THREE.BufferGeometry;
  readonly top: THREE.BufferGeometry;
  readonly bottom: THREE.BufferGeometry;
}

/** 姿勢の種類 */
type Posture = 'seated' | 'strap' | 'stand';

/** 置いた 1 人 */
interface Placement {
  readonly posture: Posture;
  /** 車体局所系の位置（足元。床面は別に足す） */
  readonly x: number;
  readonly z: number;
  /** 向き（+Y まわり。0 で車体前方を向く） */
  readonly yaw: number;
  readonly coat: number;
  readonly trouser: number;
  readonly skin: number;
  /** 体格の差（背の高さの倍率） */
  readonly scale: number;
}

export interface CarPassengers {
  readonly group: THREE.Group;
  /**
   * 立っている人の姿勢を合わせる。
   *
   * @param lateralLean 左右の傾き [rad]（正 = 右へ倒れる）
   * @param longitudinalLean 前後の傾き [rad]（正 = 前へ倒れる）
   */
  update(lateralLean: number, longitudinalLean: number): void;
  /** 明るさを合わせる（車ごとに照明が少し違う） */
  setBrightness(k: number): void;
  /**
   * 形と材質を捨てる。
   *
   * シナリオを組み直すと乗客も組み直すので、前のぶんを捨てないと GPU 側の
   * 資源が積み上がる（`THREE.Group` から外しただけでは解放されない）。
   */
  dispose(): void;
}

// --- 体を組む -------------------------------------------------------------

/**
 * 2 点を結ぶ手足。
 *
 * 腕も脚も、実際には関節で折れた円錐台のつながりでしかない。端点で書ければ
 * 姿勢を数字で置けるので、角度で書くより間違えにくい。
 */
function limb(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  r0: number,
  r1: number,
  segments = 6,
): THREE.BufferGeometry {
  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const dir = b.clone().sub(a);
  const length = dir.length();
  const geometry = new THREE.CylinderGeometry(r1, r0, length, segments, 1);
  geometry.translate(0, length / 2, 0);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize(),
  );
  geometry.applyQuaternion(quaternion);
  geometry.translate(a.x, a.y, a.z);
  return geometry;
}

/** 球（頭・手・肩の丸み） */
function ball(
  at: readonly [number, number, number],
  radius: number,
  scale: readonly [number, number, number] = [1, 1, 1],
  segments = 8,
  rings = 6,
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, segments, rings);
  geometry.scale(scale[0], scale[1], scale[2]);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/**
 * 頂点色で部位を塗り分ける。
 *
 * `InstancedMesh` の色は 1 人につき 1 色しか持てないので、髪と靴のように
 * 「服の色に関係なく暗いもの」は形のほうへ焼いておく。ついでに**足元ほど
 * 暗く**しておく——車内の光は天井から来るので、実物でも人の足元は暗い。
 */
function paint(geometry: THREE.BufferGeometry, base: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color(base);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    // 天井から照らされているので、床に近いほど暗い（0.55 〜 1.0）
    const height = Math.min(1, Math.max(0, y / 1.35));
    const k = 0.55 + 0.45 * height * height;
    colors[i * 3] = color.r * k;
    colors[i * 3 + 1] = color.g * k;
    colors[i * 3 + 2] = color.b * k;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * 頭の後ろ半分を髪の色に塗り替える。
 *
 * 局所 +X が向いている向きなので、`x < 0` が後頭部にあたる。生え際のあたりで
 * 急に色が変わらないよう、境目は少しぼかす。
 */
function darkenBehind(geometry: THREE.BufferGeometry, headY: number): void {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  const hair = new THREE.Color(HAIR_COLOR);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    // 後ろほど、そして上ほど髪に寄せる（あごの下まで髪では覆われていない）
    const back = Math.min(1, Math.max(0, -x / 0.05));
    const high = Math.min(1, Math.max(0, (y - (headY - 0.06)) / 0.05));
    const k = back * high;
    if (k <= 0) continue;
    color.setXYZ(
      i,
      color.getX(i) * (1 - k) + hair.r * k,
      color.getY(i) * (1 - k) + hair.g * k,
      color.getZ(i) * (1 - k) + hair.b * k,
    );
  }
  color.needsUpdate = true;
}

/** 髪の色（`instanceColor` の肌色を掛けても暗いままでいる程度に暗くする） */
const HAIR_COLOR = 0x2b2119;

/**
 * 頭。
 *
 * 人体計測の平均で頭幅 155mm・頭長（前後）200mm・頭高 230mm。顔は作り込まないが、
 * **目・鼻・耳の当たりだけは置く**——正面から見て肌色の面で終わると、人ではなく
 * マネキンに見える。逆に言えば、この 3 つがあれば 1m の距離でも人の頭に見える。
 * 目は `instanceColor`（肌の色）を掛けられても暗いままの色で焼いてある。
 */
function headParts(
  headY: number,
  tilt: number,
  hands: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wide = 1.24;
  const tall = 1.4;
  // 首。実物の首は前へ少し傾いていて、頭は背骨の真上より前に載る。
  parts.push(paint(limb([-0.012, headY - 0.17, 0], [0, headY - 0.07, 0], 0.05, 0.046), 0xffffff));
  const head = paint(ball([0, headY, 0], 0.0775, [wide, tall, 1.0]), 0xffffff);
  // 後頭部は髪に覆われている。**顔を作らないので、頭のどこまでが髪かで
  // 「どちらを向いているか」を読ませる**——顔の無い肌色の球がこちらを向いて
  // いるより、後頭部の黒がこちらを向いているほうが人に見える。
  darkenBehind(head, headY);
  parts.push(head);
  // 髪（頭のてっぺんを覆う殻）
  const hair = new THREE.SphereGeometry(0.0795, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62);
  hair.scale(wide, tall, 1.0);
  hair.translate(0, headY, 0);
  parts.push(paint(hair, HAIR_COLOR));
  // 目（瞳孔まで作らない。眼窩の影に見える程度の暗い粒で足りる）
  for (const s of [-1, 1] as const) {
    parts.push(paint(ball([0.083, headY + 0.012, s * 0.032], 0.016, [0.45, 0.7, 1.25], 5, 3), 0x2a231e)); // prettier-ignore
  }
  // 鼻。横顔の輪郭を決めるのはここで、無いと頭が球のままに見える。
  parts.push(paint(ball([0.096, headY - 0.014, 0], 0.017, [1.1, 0.95, 0.65], 5, 3), 0xffffff));
  // 耳（頭幅のいちばん外。帽子や髪より外に出るので輪郭に効く）
  for (const s of [-1, 1] as const) {
    parts.push(paint(ball([-0.012, headY + 0.004, s * 0.077], 0.023, [0.5, 1.25, 0.45], 5, 3), 0xffffff)); // prettier-ignore
  }
  for (const hand of hands) parts.push(hand);
  const merged = mergeGeometries(parts, false)!;
  if (tilt !== 0) {
    merged.translate(0, -headY, 0);
    merged.rotateZ(tilt);
    merged.translate(0, headY, 0);
  }
  return merged;
}

/**
 * 手。
 *
 * 球 1 つでは「腕の先に付いた玉」にしかならない。手のひらの板と、そこから
 * 出る指の塊 2 つ（親指と残り 4 本）に分けるだけで手に見える。`grip` を
 * 立てると、吊り革や手すりを握った形（指を丸める）になる。
 *
 * @param at 手首の位置
 * @param dir 手のひらが向いている向き（+1 = 局所 +X 側）
 */
function handParts(
  at: readonly [number, number, number],
  dir: number,
  grip: boolean,
): THREE.BufferGeometry {
  const [x, y, z] = at;
  const parts: THREE.BufferGeometry[] = [];
  const palm = new THREE.BoxGeometry(0.048, 0.078, 0.03);
  palm.translate(x + dir * 0.01, y - 0.037, z);
  parts.push(palm);
  if (grip) {
    // 握った手。指は手のひらの前で丸まって、親指が反対から回る。
    const fingers = new THREE.BoxGeometry(0.042, 0.05, 0.036);
    fingers.translate(x + dir * 0.038, y - 0.055, z);
    parts.push(fingers);
    const thumb = new THREE.BoxGeometry(0.026, 0.03, 0.024);
    thumb.translate(x + dir * 0.02, y - 0.028, z - 0.024);
    parts.push(thumb);
  } else {
    // 開いた手。指 4 本の塊と親指。
    const fingers = new THREE.BoxGeometry(0.044, 0.062, 0.03);
    fingers.translate(x + dir * 0.016, y - 0.107, z);
    parts.push(fingers);
    const thumb = new THREE.BoxGeometry(0.03, 0.045, 0.022);
    thumb.translate(x + dir * 0.018, y - 0.06, z - 0.03);
    parts.push(thumb);
  }
  return paint(mergeGeometries(parts, false)!, 0xffffff);
}

/**
 * 上半身（骨盤・胴・肩・首の付け根）。
 *
 * 1 周目・2 周目は**腰から肩まで太さの変わらない 1 本の円柱**だったので、
 * 近くで見ると幅の広い板にしか見えなかった。人の胴が板に見えないのは
 *
 *  - 腰（幅 280mm）より胸（320mm）が広く、肩（肩峰間 400mm）でさらに広がる
 *  - その肩の広がりは**胴ではなく肩の稜線**が作っていて、腕は胴の外側に垂れる
 *
 * という 2 つのためで、逆に言えばこの 2 つを作れば板には見えなくなる。
 * 前後（局所 X）は左右より薄いので、部位ごとに潰して楕円断面にする。
 *
 * @param hip   骨盤の中心
 * @param tilt  上体を後ろへ倒す角（座っている人は背ずりの角度だけ寝る）
 * @returns 形と、腕を生やす肩の位置
 */
function upperBody(
  hip: readonly [number, number],
  tilt: number,
): { parts: THREE.BufferGeometry[]; shoulder: (side: number) => [number, number, number] } {
  const parts: THREE.BufferGeometry[] = [];
  const [hx, hy] = hip;
  /** 上体を倒したときの、骨盤からの相対位置 */
  const up = (along: number, out = 0): [number, number, number] => [
    hx - Math.sin(tilt) * along + Math.cos(tilt) * out,
    hy + Math.cos(tilt) * along + Math.sin(tilt) * out,
    0,
  ];
  const squash = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
    g.translate(-hx, -hy, 0);
    g.scale(k, 1, 1);
    g.translate(hx, hy, 0);
    return g;
  };

  // 骨盤（いちばん下。座っていても立っていても幅は変わらない）
  parts.push(paint(squash(limb(up(-0.09), up(0.08), 0.145, 0.15, 8), 0.74), 0xffffff));
  // 腰（くびれ）から胸へ
  parts.push(paint(squash(limb(up(0.06), up(0.34), 0.138, 0.163, 8), 0.62), 0xffffff));
  // 胸から肩の付け根へ（肩へ向かって少し細る）
  parts.push(paint(squash(limb(up(0.32), up(0.5), 0.163, 0.142, 8), 0.62), 0xffffff));

  // 肩の稜線。首の付け根から肩峰へ渡す 1 本の丸太で、これが人の輪郭のうち
  // いちばん人らしいところである（板の上端を水平に切ると衝立に見える）。
  const yokeY = up(0.47);
  const yoke = limb([yokeY[0], yokeY[1], -0.135], [yokeY[0], yokeY[1], 0.135], 0.072, 0.072, 6);
  yoke.scale(0.78, 1, 1);
  parts.push(paint(yoke, 0xffffff));
  for (const s of [-1, 1] as const) {
    parts.push(paint(ball([yokeY[0], yokeY[1], s * 0.135], 0.075, [0.8, 1, 1], 6, 4), 0xffffff));
  }

  return {
    parts,
    shoulder: (side: number) => [yokeY[0], yokeY[1] - 0.02, side * 0.175],
  };
}

/** 腕 1 本（上腕・前腕・手）。手だけは肌の側へ渡す。 */
function arm(
  shoulder: readonly [number, number, number],
  elbow: readonly [number, number, number],
  wrist: readonly [number, number, number],
  into: THREE.BufferGeometry[],
  hands: THREE.BufferGeometry[],
  grip: boolean,
): void {
  into.push(paint(limb(shoulder, elbow, 0.052, 0.043), 0xffffff));
  into.push(paint(limb(elbow, wrist, 0.043, 0.033), 0xffffff));
  hands.push(handParts(wrist, 1, grip));
}

/**
 * 立っている人。
 *
 * 寸法は日本人成人男性の平均（身長 1690mm）を基準に、肩峰高 1400mm・
 * 大転子高 900mm・膝高 480mm という人体計測の標準値で関節を置いている。
 * 目の高さ 1600mm は `INTERIOR.eyeHeight` と揃えてある（歩くモードのカメラと
 * 同じ高さに人の目が来る）。
 *
 * @param raised 片手を吊り革へ上げるか
 */
function standingBody(raised: boolean): BodyParts {
  const hipY = 0.9;
  const hipZ = 0.095;
  const top: THREE.BufferGeometry[] = [];
  const bottom: THREE.BufferGeometry[] = [];
  const hands: THREE.BufferGeometry[] = [];

  const body = upperBody([0, hipY], 0);
  top.push(...body.parts);

  for (const s of [-1, 1] as const) {
    const shoulder = body.shoulder(s);
    if (raised && s > 0) {
      // 吊り革を握る腕。肘は外へ張り、手は頭の上あたりで握りをつかむ。
      arm(shoulder, [0.03, 1.55, s * 0.245], [0.005, 1.68, s * 0.15], top, hands, true);
    } else {
      // 垂らした腕。**胴の外側**へ出す（胴の中に埋めると腕が消えて板に見える）。
      arm(shoulder, [0.025, 1.09, s * 0.2], [0.06, 0.83, s * 0.205], top, hands, false);
    }
  }

  // 脚。左右で前後に少しずらす（そろえると人形に見える）
  for (const [i, s] of [-1, 1].entries()) {
    const offset = i === 0 ? 0.03 : -0.03;
    bottom.push(paint(limb([0, hipY, s * hipZ], [offset, 0.47, s * (hipZ + 0.01)], 0.085, 0.07), 0xffffff)); // prettier-ignore
    bottom.push(paint(limb([offset, 0.47, s * (hipZ + 0.01)], [offset, 0.075, s * (hipZ + 0.015)], 0.07, 0.05), 0xffffff)); // prettier-ignore
    // 靴（服の色に引きずられないよう暗く焼く）
    const shoe = new THREE.BoxGeometry(0.24, 0.07, 0.1);
    shoe.translate(offset + 0.03, 0.037, s * (hipZ + 0.015));
    bottom.push(paint(shoe, 0x1a1a1c));
  }

  return {
    skin: headParts(1.575, 0, hands),
    top: mergeGeometries(top, false)!,
    bottom: mergeGeometries(bottom, false)!,
  };
}

/**
 * 座っている人。
 *
 * ロングシートは座面 430mm・奥行き 430mm と浅く、背ずりが 12 度倒れている
 * （`INTERIOR.seatBackTilt`）ので、背中を預けると上体もその角度で寝る。
 * **膝から先は通路へ出る**——座面の奥行きより大腿長（約 400mm）のほうが長いので、
 * 座れば必ず膝が前へ出る。この出っ張りは歩くときの当たり判定にも効くので、
 * `SEATED_KNEE_REACH` として外へ出してある。
 *
 * 局所座標の +X は座っている人が向いている向き（通路側）。
 */
function seatedBody(): BodyParts {
  const seat = INTERIOR.seatHeight;
  const tilt = INTERIOR.seatBackTilt;
  const top: THREE.BufferGeometry[] = [];
  const bottom: THREE.BufferGeometry[] = [];
  const hands: THREE.BufferGeometry[] = [];

  // 尻は座面の上。背中を背ずりへ預けるので、骨盤は座面の奥寄りに来る。
  const body = upperBody([-0.055, seat + 0.09], tilt);
  top.push(...body.parts);

  for (const s of [-1, 1] as const) {
    const shoulder = body.shoulder(s);
    // 肘は体側、手は**腿の上**。座っている人はたいてい手を膝か鞄の上に置いて
    // いる。手首を腿から離すと、手だけが宙に浮いた白い塊に見える。
    arm(shoulder, [-0.075, seat + 0.26, s * 0.2], [0.055, seat + 0.145, s * 0.135], top, hands, false); // prettier-ignore
  }

  // 大腿と脛を分けて折る。座面の前縁で折れて、膝から下は床へ落ちる。
  for (const s of [-1, 1] as const) {
    const knee: [number, number, number] = [SEATED_KNEE_REACH - 0.05, seat + 0.015, s * 0.105];
    bottom.push(paint(limb([-0.05, seat + 0.02, s * 0.095], knee, 0.095, 0.078), 0xffffff));
    bottom.push(paint(limb(knee, [SEATED_KNEE_REACH - 0.045, 0.075, s * 0.11], 0.078, 0.052), 0xffffff)); // prettier-ignore
    const shoe = new THREE.BoxGeometry(0.25, 0.07, 0.1);
    shoe.translate(SEATED_KNEE_REACH - 0.01, 0.037, s * 0.11);
    bottom.push(paint(shoe, 0x1a1a1c));
  }

  // 頭は少し下を向く（座っている人はたいてい手元を見ている）
  const head = headParts(seat + 0.79, -tilt * 0.4, hands);
  head.translate(-0.055 - Math.sin(tilt) * 0.62, 0, 0);
  return {
    skin: head,
    top: mergeGeometries(top, false)!,
    bottom: mergeGeometries(bottom, false)!,
  };
}

// --- 置き方 ---------------------------------------------------------------

/**
 * 座席と立ち位置を割り付ける。
 *
 * 混雑率（`loadFactor`）が席数に対する割合として効く。実物の乗り方と同じで、
 * **端から埋まる**（袖仕切りの脇が真っ先に埋まり、真ん中が最後に残る）ように
 * 重みを付けてある。立客は扉の前と吊り革の下に溜まる。
 */
function placePassengers(
  layout: CarLayout,
  bays: readonly SeatBay[],
  loadFactor: number,
  seed: number,
): Placement[] {
  const random = rng(seed * 7919 + 13);
  const out: Placement[] = [];
  const inner = INTERIOR.width / 2;
  const pick = (list: readonly number[]): number => list[Math.floor(random() * list.length)]!;
  const person = (posture: Posture, x: number, z: number, yaw: number): Placement => ({
    posture,
    x,
    z,
    yaw,
    coat: pick(COAT_COLORS),
    trouser: pick(TROUSER_COLORS),
    skin: pick(SKIN_COLORS),
    scale: 0.94 + random() * 0.12,
  });

  // --- 座席 ---
  for (const side of [-1, 1] as const) {
    for (const bay of bays) {
      const a = bay.from + INTERIOR.armPartitionThickness + 0.09;
      const b = bay.to - INTERIOR.armPartitionThickness - 0.09;
      const width = b - a;
      if (width < INTERIOR.seatPitch) continue;
      const seats = Math.max(1, Math.round(width / INTERIOR.seatPitch));
      const pitch = width / seats;
      for (let k = 0; k < seats; k++) {
        // 端の席から埋まる。中央ほど空きやすいので、席ごとに閾値を変える。
        const toEnd = Math.min(k, seats - 1 - k) / Math.max(1, (seats - 1) / 2);
        const chance = loadFactor * (1.35 - 0.55 * toEnd);
        if (random() > chance) continue;
        const cx = a + pitch * (k + 0.5);
        // 通路を向く。右側（+Z）の席は -Z を、左側は +Z を向く。
        // 背中が背ずりに触れる位置に置く（胴の奥行きの半分ぶんだけ手前）
        out.push(person('seated', cx, side * (inner - INTERIOR.seatDepth + 0.02), side > 0 ? Math.PI / 2 : -Math.PI / 2)); // prettier-ignore
      }
    }
  }

  // --- 立客 ---
  // 吊り革の下（棒の真下に立つと手が握りに届く）
  for (const side of [-1, 1] as const) {
    for (const bay of bays) {
      const a = bay.from + 0.22;
      const b = bay.to - 0.22;
      if (b - a < INTERIOR.strapPitch) continue;
      const count = Math.floor((b - a) / INTERIOR.strapPitch) + 1;
      const pitch = count > 1 ? (b - a) / (count - 1) : 0;
      for (let i = 0; i < count; i++) {
        if (random() > loadFactor * 0.55) continue;
        // 吊り革を握る人は棒の真下を向いて立つ（右手が上がる作りなので、
        // 棒が右手側へ来るように向きを決める）
        const x = a + i * pitch;
        // 吊り革につかまっていても、体の向きまで揃っているわけではない。
        // 全員が真横を向いていると兵隊の列に見えるので、少しずつ振る。
        const turn = (random() - 0.5) * 0.7;
        out.push(person('strap', x - 0.04, side * (INTERIOR.strapBarOffset - 0.16), (side > 0 ? Math.PI / 2 : -Math.PI / 2) + turn)); // prettier-ignore
      }
    }
  }
  // 扉の前（乗り降りの流れの中で立っている人。扉に体を向けていることが多い）
  for (const centre of layout.doorCentres) {
    for (const side of [-1, 1] as const) {
      for (const dx of [-0.5, 0.5]) {
        if (random() > loadFactor * 0.85) continue;
        out.push(
          person(
            'stand',
            centre + dx * (CAR.doorWidth / 2 - 0.08),
            side * (inner - 0.55 - random() * 0.25),
            (side > 0 ? Math.PI / 2 : -Math.PI / 2) + (random() - 0.5) * 0.9,
          ),
        );
      }
    }
  }
  // 通路の中ほど（混んでくるとここまで詰まる）
  for (const bay of bays) {
    if (bay.to - bay.from < 3) continue;
    for (const ratio of [0.3, 0.7]) {
      if (random() > (loadFactor - 0.35) * 1.6) continue;
      out.push(
        person(
          'stand',
          bay.from + (bay.to - bay.from) * ratio,
          (random() - 0.5) * 0.5,
          random() < 0.5 ? 0.4 : Math.PI - 0.4,
        ),
      );
    }
  }
  return out;
}

/**
 * 座っている人の居場所（当たり判定用）。
 *
 * `buildPassengers` が置くのとまったく同じ割り付けを返す。割り付けは
 * seed（＝編成の何両目か）と混雑率だけで決まるので、**描画と当たり判定が
 * 別々に呼んでも必ず同じ答えになる**。人の居場所を持ち回す配線を増やさずに
 * 「見えている膝を通り抜けない」を成り立たせるのに、この決定論を使っている。
 */
export interface SeatedOccupant {
  /** 車体局所系の前後位置 [m] */
  readonly x: number;
  /** どちら側の座席か（+1 = 右 / -1 = 左） */
  readonly side: -1 | 1;
  /** 膝の前縁の位置（車体中心からの距離）[m] */
  readonly kneeReach: number;
}

export function seatedOccupants(
  layout: CarLayout,
  bays: readonly SeatBay[],
  index: number,
  loadFactor: number,
): SeatedOccupant[] {
  return placePassengers(layout, bays, loadFactor, index + 1)
    .filter((p) => p.posture === 'seated')
    .map((p) => ({
      x: p.x,
      side: p.z > 0 ? 1 : -1,
      // 局所 +X（座っている人が向いている向き）は通路側なので、車体中心から
      // 見た膝の位置は「腰の位置 − 膝の出っ張り」になる。
      kneeReach: Math.abs(p.z) - SEATED_KNEE_REACH,
    }));
}

// --- 組み立て -------------------------------------------------------------

/** 部位ごとの `InstancedMesh` を作る */
function instance(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  people: readonly Placement[],
  colorOf: (p: Placement) => number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, people.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // 視界のあちこちに散らばるので、まとめて視錐台の外と判定させない
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const color = new THREE.Color();
  for (let i = 0; i < people.length; i++) mesh.setColorAt(i, color.setHex(colorOf(people[i]!)));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/**
 * 1 両ぶんの乗客を組む。
 *
 * @param layout 客室の割り付け
 * @param bays   座席の区画
 * @param index  編成の中での位置（座り方の seed。全車が同じ並びだと、貫通路
 *               ごしに同じ絵が続いて模型に見える）
 * @param loadFactor 混雑率（`sim.scenario.loadFactor`）
 */
export function buildPassengers(
  layout: CarLayout,
  bays: readonly SeatBay[],
  index: number,
  loadFactor: number,
): CarPassengers {
  const group = new THREE.Group();
  const people = placePassengers(layout, bays, loadFactor, index + 1);
  const floor = layout.floorHeight;

  const bodies: Record<Posture, BodyParts> = {
    seated: seatedBody(),
    strap: standingBody(true),
    stand: standingBody(false),
  };
  const materials: THREE.MeshStandardMaterial[] = [];
  /** 車ごとの明るさを掛ける前の自己発光の強さ */
  const base: number[] = [];
  const makeMaterial = (roughness: number, glow = 0.19): THREE.MeshStandardMaterial => {
    const material = shadeWithVertexColor(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness,
        metalness: 0.02,
        // 車内と同じ考え方で、面そのものをわずかに光らせて「照らされている」
        // ことにする（`interior.ts` の `lit()` と同じ値の並び）
        emissive: 0xffffff,
        emissiveIntensity: glow,
      }),
    );
    materials.push(material);
    base.push(glow);
    return material;
  };
  // 肌は服より明るいので、同じ自己発光にすると顔だけが光って見える
  const skinMaterial = makeMaterial(0.72, 0.15);
  const clothMaterial = makeMaterial(0.92);

  const standing: Array<{ mesh: THREE.InstancedMesh; people: Placement[] }> = [];
  const seated: Array<{ mesh: THREE.InstancedMesh; people: Placement[] }> = [];

  for (const posture of ['seated', 'strap', 'stand'] as const) {
    const subset = people.filter((p) => p.posture === posture);
    if (subset.length === 0) continue;
    const body = bodies[posture];
    const meshes = [
      instance(body.skin, skinMaterial, subset, (p) => p.skin),
      instance(body.top, clothMaterial, subset, (p) => p.coat),
      instance(body.bottom, clothMaterial, subset, (p) => p.trouser),
    ];
    for (const mesh of meshes) {
      group.add(mesh);
      (posture === 'seated' ? seated : standing).push({ mesh, people: subset });
    }
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const yawRotation = new THREE.Quaternion();
  const leanRotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const leanAxis = new THREE.Vector3();

  /**
   * 傾きは**車体座標系**で掛ける。人ごとに向きが違うので、体の局所系で
   * 掛けると、通路を向いている人と前を向いている人が別々の向きへ倒れて
   * しまう。実際には全員が同じ向きの比力を受けているので、傾きの軸は
   * 車体に固定でなければならない。
   */
  const applyLean = (
    entries: ReadonlyArray<{ mesh: THREE.InstancedMesh; people: Placement[] }>,
    lateral: number,
    longitudinal: number,
  ): void => {
    // 前へ倒れる = +X へ倒れる = -Z 軸まわりの回転。右へ倒れる = +Z へ = +X 軸まわり。
    const angle = Math.hypot(lateral, longitudinal);
    if (angle > 1e-6) leanAxis.set(lateral, 0, -longitudinal).normalize();
    leanRotation.setFromAxisAngle(angle > 1e-6 ? leanAxis : up, angle);
    for (const entry of entries) {
      for (let i = 0; i < entry.people.length; i++) {
        const p = entry.people[i]!;
        yawRotation.setFromAxisAngle(up, p.yaw);
        quaternion.copy(leanRotation).multiply(yawRotation);
        position.set(p.x, floor, p.z);
        scale.set(p.scale, p.scale, p.scale);
        matrix.compose(position, quaternion, scale);
        entry.mesh.setMatrixAt(i, matrix);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
  };

  const update = (lateralLean: number, longitudinalLean: number): void => {
    applyLean(standing, lateralLean * LEAN_GAIN, longitudinalLean * LEAN_GAIN);
    applyLean(
      seated,
      lateralLean * LEAN_GAIN * SEATED_LEAN_RATIO,
      longitudinalLean * LEAN_GAIN * SEATED_LEAN_RATIO,
    );
  };
  update(0, 0);

  return {
    group,
    update,
    setBrightness(k: number): void {
      for (const [i, material] of materials.entries()) material.emissiveIntensity = base[i]! * k;
    },
    dispose(): void {
      group.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
          node.geometry.dispose();
          node.dispose();
        }
      });
      for (const material of materials) material.dispose();
    },
  };
}
