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
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 8, 6);
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

/** 頭と首と手（肌の色で塗る部位）。髪だけは暗く焼いておく。 */
function headParts(headY: number, tilt: number, hands: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 首
  parts.push(paint(limb([0, headY - 0.16, 0], [0, headY - 0.07, 0], 0.048, 0.045), 0xffffff));
  // 頭。人体計測の平均で頭幅 155mm・頭長（前後）200mm・頭高 230mm なので、
  // 球を左右に**細く**前後に長く潰す。ここを球のままにすると、顔を作らない
  // ぶんだけ余計に「きのこ」に見える。局所 +X が向いている向き。
  parts.push(paint(ball([0, headY, 0], 0.0775, [1.29, 1.45, 1.0]), 0xffffff));
  // 髪（頭のてっぺんを覆う殻）。服の色に引きずられないよう暗く焼く。
  const hair = new THREE.SphereGeometry(0.0795, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.56);
  hair.scale(1.29, 1.45, 1.0);
  hair.translate(0, headY, 0);
  parts.push(paint(hair, 0x2b2119));
  for (const hand of hands) parts.push(paint(hand, 0xffffff));
  const merged = mergeGeometries(parts, false)!;
  if (tilt !== 0) {
    merged.translate(0, -headY, 0);
    merged.rotateZ(tilt);
    merged.translate(0, headY, 0);
  }
  return merged;
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
  const shoulderY = 1.4;
  const hipY = 0.9;
  const shoulderZ = 0.19;
  const hipZ = 0.095;
  const top: THREE.BufferGeometry[] = [];
  const bottom: THREE.BufferGeometry[] = [];
  const hands: THREE.BufferGeometry[] = [];

  // 胴（腰から肩まで）。円柱を前後に潰して楕円断面にする。
  const torso = limb([0, hipY - 0.06, 0], [0, shoulderY + 0.02, 0], 0.17, 0.185, 8);
  torso.scale(0.66, 1, 1);
  top.push(paint(torso, 0xffffff));
  // 肩の丸み
  for (const s of [-1, 1] as const) top.push(paint(ball([0, shoulderY, s * shoulderZ], 0.06), 0xffffff)); // prettier-ignore

  for (const s of [-1, 1] as const) {
    const shoulder: [number, number, number] = [0, shoulderY, s * shoulderZ];
    if (raised && s > 0) {
      // 吊り革を握る腕。肘は外へ張り、手は頭の上あたりへ来る。
      const elbow: [number, number, number] = [0.02, 1.55, s * 0.25];
      const wrist: [number, number, number] = [0, 1.69, s * 0.15];
      top.push(paint(limb(shoulder, elbow, 0.05, 0.042), 0xffffff));
      top.push(paint(limb(elbow, wrist, 0.042, 0.034), 0xffffff));
      hands.push(ball(wrist, 0.042));
    } else {
      // 垂らした腕。体側にぴったり付けると板に見えるので、少し外へ開く。
      const elbow: [number, number, number] = [0.02, 1.1, s * (shoulderZ + 0.02)];
      const wrist: [number, number, number] = [0.06, 0.84, s * (shoulderZ + 0.03)];
      top.push(paint(limb(shoulder, elbow, 0.05, 0.042), 0xffffff));
      top.push(paint(limb(elbow, wrist, 0.042, 0.034), 0xffffff));
      hands.push(ball(wrist, 0.04));
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
 * 膝から先は通路へ出るため、**通路の広さは実際には座っている人の膝で決まる**。
 * 局所座標の +X は座っている人が向いている向き（通路側）。
 */
function seatedBody(): BodyParts {
  const seat = INTERIOR.seatHeight;
  const tilt = INTERIOR.seatBackTilt;
  const hip: [number, number, number] = [-0.06, seat + 0.04, 0];
  const shoulderY = seat + 0.58;
  const shoulderX = hip[0] - Math.sin(tilt) * 0.54;
  const shoulderZ = 0.17;
  const top: THREE.BufferGeometry[] = [];
  const bottom: THREE.BufferGeometry[] = [];
  const hands: THREE.BufferGeometry[] = [];

  // 胴。立っている人と同じく前後（局所 X）に潰して楕円断面にする。丸のままだと
  // 背中が座席の背ずりを突き抜け、膝が通路の半分まで出てしまう。
  const torso = limb(hip, [shoulderX, shoulderY + 0.02, 0], 0.175, 0.185, 8);
  torso.scale(0.66, 1, 1);
  top.push(paint(torso, 0xffffff));
  for (const s of [-1, 1] as const) top.push(paint(ball([shoulderX, shoulderY, s * shoulderZ], 0.06), 0xffffff)); // prettier-ignore

  for (const s of [-1, 1] as const) {
    const shoulder: [number, number, number] = [shoulderX, shoulderY, s * shoulderZ];
    // 腕は膝の上へ。座っている人はたいてい手を膝か鞄の上に置いている。
    const elbow: [number, number, number] = [-0.06, seat + 0.2, s * (shoulderZ + 0.02)];
    const wrist: [number, number, number] = [0.16, seat + 0.09, s * (shoulderZ - 0.02)];
    top.push(paint(limb(shoulder, elbow, 0.055, 0.045), 0xffffff));
    top.push(paint(limb(elbow, wrist, 0.045, 0.036), 0xffffff));
    hands.push(ball(wrist, 0.042));
  }

  // 膝から先は通路へ出る。座席の奥行きが 430mm しかないので、太ももが
  // 座面に収まりきらないのが実物である（座っている人が足を引くのはこのため）。
  for (const s of [-1, 1] as const) {
    const knee: [number, number, number] = [0.19, seat + 0.02, s * 0.11];
    bottom.push(paint(limb([hip[0], seat + 0.02, s * 0.1], knee, 0.09, 0.075), 0xffffff));
    bottom.push(paint(limb(knee, [0.21, 0.075, s * 0.115], 0.075, 0.05), 0xffffff));
    const shoe = new THREE.BoxGeometry(0.25, 0.07, 0.1);
    shoe.translate(0.24, 0.037, s * 0.115);
    bottom.push(paint(shoe, 0x1a1a1c));
  }

  // 頭は少し下を向く（座っている人はたいてい手元を見ている）
  return {
    skin: headParts(seat + 0.75, -tilt * 0.4, hands).translate(shoulderX, 0, 0),
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
  const makeMaterial = (roughness: number): THREE.MeshStandardMaterial => {
    const material = shadeWithVertexColor(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness,
        metalness: 0.02,
        // 車内と同じ考え方で、面そのものをわずかに光らせて「照らされている」
        // ことにする（`interior.ts` の `lit()` と同じ値の並び）
        emissive: 0xffffff,
        emissiveIntensity: 0.19,
      }),
    );
    materials.push(material);
    return material;
  };
  const skinMaterial = makeMaterial(0.72);
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
      for (const material of materials) material.emissiveIntensity = 0.19 * k;
    },
  };
}
