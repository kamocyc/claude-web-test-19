import * as THREE from 'three';
import { CAR, INTERIOR } from './dimensions.ts';
import type { CarLayout, SeatBay } from './interior.ts';
import { mergeParts, shadeWithVertexColor } from './interiorShading.ts';

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
 * ## 部位の分け方（`InstancedMesh` の単位）
 *
 * 姿勢は 7 種類、髪型は 5 種類ある。これを「姿勢 × 髪型」で持つと 35 とおりの
 * 形が要るが、**頭は姿勢に依らない**（どの姿勢でも首から上は同じ形で、載る
 * 位置と傾きが違うだけ）。そこで
 *
 *  - 頭（首・顔・髪）… 髪型ごと。姿勢からは首の付け根の位置と傾きだけ受け取る
 *  - 手 … 開く／握るの 2 種。位置と向きは姿勢が決める
 *  - 胴と腕（服）… 姿勢ごと
 *  - 脚（ズボン）… 姿勢ごと
 *
 * と分けてある。掛け算にならないので、7 種類の姿勢と 5 種類の髪型があっても
 * 1 両あたりの描画は 20 回程度で収まる。
 *
 * ## 乗り降り
 *
 * 駅で扉が閉まるたびに `buildPassengers` を seed を変えて呼び直す（`main.ts`）。
 * 歩いて乗り降りする動きは作らないが、**顔ぶれと混み具合が駅ごとに変わる**
 * だけで「走っている電車に乗っている」感じになる。当たり判定
 * （`walk.ts` の `corridorBounds`）は `seatedOccupants()` から同じ seed で同じ
 * 割り付けを引くので、見えない膝に引っかかることはない。
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

/** 座っている人が座席の前縁から通路側へ寄っている量（背中を背ずりへ預けるぶん） */
const SEATED_HIP_INSET = 0.02;

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

/**
 * 髪の色と髪型。
 *
 * **髪は頭の輪郭をいちばん強く決める。**同じ形の殻を全員に被せると、顔を
 * 作り分けても全員が同じ人に見える（1〜3 周目がこれだった）。長さ・生え際・
 * 分け目・束ね方を振ると、それだけで別人になる。
 */
type HairStyle = 'short' | 'crop' | 'parted' | 'bun' | 'thin';
const HAIR_STYLES: readonly HairStyle[] = ['short', 'crop', 'parted', 'bun', 'thin'];
/** 髪の色（`instanceColor` の肌色を掛けても暗いままでいる程度に暗くする） */
const HAIR_COLOR = 0x241c15;
/** 薄い髪は地肌が透けるので、髪の色も明るいほうへ寄る */
const THIN_HAIR_COLOR = 0x4a3c30;
/** 目・眉・口。肌の色を掛けられても黒いままでいる暗さ。 */
const FEATURE_COLOR = 0x140f0c;

/** 姿勢の種類 */
type Posture =
  'seated' | 'seatedPhone' | 'seatedAsleep' | 'strap' | 'standBag' | 'standPhone' | 'pole';
const POSTURES: readonly Posture[] = [
  'seated',
  'seatedPhone',
  'seatedAsleep',
  'strap',
  'standBag',
  'standPhone',
  'pole',
];
const IS_SEATED: Readonly<Record<Posture, boolean>> = {
  seated: true,
  seatedPhone: true,
  seatedAsleep: true,
  strap: false,
  standBag: false,
  standPhone: false,
  pole: false,
};

/** 手 1 つの置き方（人の局所座標系） */
interface HandPose {
  readonly at: readonly [number, number, number];
  /** +Y まわりの向き（手のひらを向ける方向） */
  readonly yaw: number;
  /** +X まわりの傾き（手のひらを上下へ返す） */
  readonly roll: number;
  /** 握っているか（吊り革・手すり） */
  readonly grip: boolean;
}

/** 姿勢 1 つぶんの形と、頭・手の置き方 */
interface BodyParts {
  /** 胴と腕（上着の色） */
  readonly top: THREE.BufferGeometry;
  /** 脚と靴（ズボンの色） */
  readonly bottom: THREE.BufferGeometry;
  /** 首の付け根（ここに頭を載せる） */
  readonly neck: readonly [number, number, number];
  /** 頭の前後の傾き [rad]（正 = うつむく） */
  readonly headPitch: number;
  readonly hands: readonly HandPose[];
}

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
  readonly hair: HairStyle;
  /** 首の左右の振り [rad]（人はまっすぐ前ばかり見ていない） */
  readonly headTurn: number;
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
   * 駅ごとに組み直すので、前のぶんを捨てないと GPU 側の資源が積み上がる
   * （`THREE.Group` から外しただけでは解放されない）。
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
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
  );
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

/** 直方体 */
function block(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/** 頂点色を 1 色で塗る（`instanceColor` はこの上から掛かる） */
function paint(geometry: THREE.BufferGeometry, base: number, shade = 1): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color(base);
  for (let i = 0; i < position.count; i++) {
    colors[i * 3] = color.r * shade;
    colors[i * 3 + 1] = color.g * shade;
    colors[i * 3 + 2] = color.b * shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * 頂点色を高さで暗くする。
 *
 * 車内の光は天井から来るので、実物でも人の足元は暗い。胴と脚にだけ掛ける
 * （頭と手は形の原点が床ではないので、こちらは掛けない）。
 */
function paintByHeight(geometry: THREE.BufferGeometry, base: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color(base);
  for (let i = 0; i < position.count; i++) {
    const height = Math.min(1, Math.max(0, position.getY(i) / 1.35));
    const k = 0.55 + 0.45 * height * height;
    colors[i * 3] = color.r * k;
    colors[i * 3 + 1] = color.g * k;
    colors[i * 3 + 2] = color.b * k;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// --- 頭 -------------------------------------------------------------------

/** 頭の楕円体の半径（前後・上下・左右）。人体計測の平均（頭長 200・頭高 230・頭幅 155mm）。 */
const HEAD_R = { x: 0.0961, y: 0.1085, z: 0.0775 } as const;
/** 首の付け根から頭の中心までの高さ */
const HEAD_RISE = 0.175;

/**
 * 髪。
 *
 * 頭の球にかぶせる殻の**深さ**（`thetaLength`）で長さを、別に足す塊で
 * 前髪・分け目・束ねた髪を作る。地肌との境目が生え際になる。
 */
function hairParts(style: HairStyle): THREE.BufferGeometry[] {
  const c: [number, number, number] = [0, HEAD_RISE, 0];
  const shell = (depth: number, grow: number, color = HAIR_COLOR): THREE.BufferGeometry => {
    const g = new THREE.SphereGeometry(0.0775 + grow, 8, 5, 0, Math.PI * 2, 0, Math.PI * depth);
    g.scale(HEAD_R.x / HEAD_R.z, HEAD_R.y / HEAD_R.z, 1);
    g.translate(c[0], c[1], c[2]);
    return paint(g, color);
  };
  switch (style) {
    case 'crop':
      // 刈り上げ。生え際が高く、後頭部も短い。
      return [shell(0.46, 0.004)];
    case 'parted':
      // 分け目つき。片側だけ前髪が額へ張り出す。
      return [
        shell(0.62, 0.005),
        // 前髪は額の上まで。眉まで下ろすと眉とつながって、
        // サングラスを掛けたような 1 本の黒い帯に見える。
        paint(ball([0.048, HEAD_RISE + 0.076, 0.03], 0.045, [0.9, 0.36, 1.1], 6, 4), HAIR_COLOR),
      ];
    case 'bun':
      // 後ろで束ねる。うなじまで下ろして、後頭部に団子を付ける。
      return [
        shell(0.8, 0.006),
        paint(ball([-0.1, HEAD_RISE + 0.01, 0], 0.045, [1, 1, 0.9], 6, 5), HAIR_COLOR),
      ];
    case 'thin':
      // 薄い。頭のてっぺんだけ、色も明るい。
      return [shell(0.34, 0.002, THIN_HAIR_COLOR)];
    case 'short':
    default:
      return [shell(0.6, 0.005)];
  }
}

/**
 * 頭（首・顔・髪）。原点は**首の付け根**で、+X が向いている向き。
 *
 * ## 顔を「のっぺらぼう」にしない
 *
 * 3 周目は目・鼻・耳の粒を置いたのに、1.5m 先から見ると真っさらな肌色の面に
 * 見えていた。理由は 2 つある。
 *
 *  1. **目が頭の中に埋まっていた。**楕円体の解析的な表面より 3mm しか外に
 *     出していなかったが、頭の球は 8 × 6 分割なので、実際に描かれる多面体の
 *     面は解析曲面よりさらに内側へ凹む。結果、目が頭に飲み込まれていた。
 *  2. **小さすぎた。**目 1 つが 22 × 14mm では、1.5m 先で 2 画素にしかならない。
 *
 * ここでは目を頭の表面から**確実に外へ出し**（外端で 8mm 以上）、大きさも
 * 実物の見た目（目尻から目頭まで 35mm、眉を入れて上下 30mm）に合わせてある。
 * 眉は目より外へ出す——実物の顔で最初に読めるのは眉であって目ではない。
 * 口は線 1 本で足りる。
 */
function headGeometry(style: HairStyle): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hy = HEAD_RISE;
  // 首。実物の首は前へ少し傾いていて、頭は背骨の真上より前に載る。
  parts.push(paint(limb([-0.014, 0, 0], [0, 0.085, 0], 0.05, 0.046), 0xffffff));
  // 頭。下すぼまり（顎）にするため、下半分を細くした楕円体を重ねる。
  parts.push(paint(ball([0, hy, 0], 0.0775, [HEAD_R.x / 0.0775, HEAD_R.y / 0.0775, 1]), 0xffffff));
  // 顎。頭の下端を前へ出して、顔の輪郭を作る（無いと首がそのまま頭に見える）。
  parts.push(paint(ball([0.022, hy - 0.072, 0], 0.052, [1.15, 0.75, 1.05], 6, 4), 0xffffff));

  // 眉。顔でいちばん先に読めるのはここ。目より前へ出す。
  // **目とのあいだを 25mm ほど空ける**——近づけると眉と目が 1 本の黒い帯に
  // つながって、サングラスを掛けたように見える。
  for (const s of [-1, 1] as const) {
    parts.push(paint(block([0.012, 0.009, 0.04], [0.088, hy + 0.052, s * 0.034]), FEATURE_COLOR));
  }
  // 目。目尻から目頭まで 35mm、上下 13mm の暗い楕円。**頭の表面より外へ出す。**
  for (const s of [-1, 1] as const) {
    parts.push(paint(ball([0.089, hy + 0.014, s * 0.034], 0.021, [0.42, 0.3, 0.86], 6, 4), FEATURE_COLOR)); // prettier-ignore
  }
  // 鼻。横顔の輪郭を決めるのはここで、無いと頭が球のままに見える。
  parts.push(paint(ball([0.09, hy - 0.008, 0], 0.02, [1.15, 1.0, 0.62], 5, 3), 0xffffff));
  // 口（線 1 本で足りる）
  parts.push(paint(block([0.01, 0.008, 0.032], [0.084, hy - 0.056, 0]), FEATURE_COLOR));
  // 耳（頭幅のいちばん外。髪より外に出るので輪郭に効く）
  for (const s of [-1, 1] as const) {
    parts.push(paint(ball([-0.014, hy + 0.004, s * 0.074], 0.026, [0.5, 1.2, 0.45], 5, 3), 0xffffff)); // prettier-ignore
  }
  parts.push(...hairParts(style));
  return mergeParts(parts, '乗客の頭')!;
}

/**
 * 手。原点は**手首**で、+X が手のひらの向き、指は -Y へ伸びる。
 *
 * 球 1 つでは「腕の先に付いた玉」にしかならない。手のひらの板と、そこから
 * 出る指の塊 2 つ（親指と残り 4 本）に分けるだけで手に見える。
 */
function handGeometry(grip: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [block([0.048, 0.078, 0.03], [0.01, -0.037, 0])];
  if (grip) {
    // 握った手。指は手のひらの前で丸まって、親指が反対から回る。
    parts.push(block([0.042, 0.05, 0.036], [0.038, -0.055, 0]));
    parts.push(block([0.026, 0.03, 0.024], [0.02, -0.028, -0.024]));
  } else {
    // 開いた手。指 4 本の塊と親指。
    parts.push(block([0.04, 0.056, 0.028], [0.014, -0.098, 0]));
    parts.push(block([0.028, 0.04, 0.02], [0.016, -0.056, -0.027]));
  }
  return paint(mergeParts(parts, '乗客の手')!, 0xffffff);
}

// --- 胴・腕・脚 -----------------------------------------------------------

/**
 * 上半身（骨盤・胴・肩・襟）。
 *
 * 1〜2 周目は**腰から肩まで太さの変わらない 1 本の円柱**だったので、近くで
 * 見ると幅の広い板にしか見えなかった。人の胴が板に見えないのは
 *
 *  - 腰（幅 280mm）より胸（320mm）が広く、肩（肩峰間 400mm）でさらに広がる
 *  - その肩の広がりは**胴ではなく肩の稜線**が作っていて、腕は胴の外側に垂れる
 *
 * という 2 つのためで、逆に言えばこの 2 つを作れば板には見えなくなる。
 * 前後（局所 X）は左右より薄いので、部位ごとに潰して楕円断面にする。
 *
 * 襟を付けてあるのは、**首が長く太く見えるのを防ぐ**ため。首は実際には
 * 100mm しか出ていないのだが、肩から上が全部肌色だと顎まで首に見える。
 *
 * @param hip   骨盤の中心
 * @param tilt  上体を後ろへ倒す角（座っている人は背ずりの角度だけ寝る）
 * @returns 形と、腕を生やす肩の位置・首の付け根
 */
function upperBody(
  hip: readonly [number, number],
  tilt: number,
): {
  parts: THREE.BufferGeometry[];
  shoulder: (side: number) => [number, number, number];
  neck: [number, number, number];
} {
  const parts: THREE.BufferGeometry[] = [];
  const [hx, hy] = hip;
  /** 上体を倒したときの、骨盤からの相対位置 */
  const up = (along: number): [number, number, number] => [
    hx - Math.sin(tilt) * along,
    hy + Math.cos(tilt) * along,
    0,
  ];
  const squash = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
    g.translate(-hx, -hy, 0);
    g.scale(k, 1, 1);
    g.translate(hx, hy, 0);
    return g;
  };

  // 骨盤 → 腰のくびれ → 胸 → 肩の付け根
  const cloth = (g: THREE.BufferGeometry): THREE.BufferGeometry => paintByHeight(g, 0xffffff);
  parts.push(cloth(squash(limb(up(-0.09), up(0.08), 0.145, 0.15, 8), 0.74)));
  parts.push(cloth(squash(limb(up(0.06), up(0.34), 0.138, 0.163, 8), 0.62)));
  parts.push(cloth(squash(limb(up(0.32), up(0.5), 0.163, 0.142, 8), 0.62)));

  // 肩の稜線。首の付け根から肩峰へ渡す 1 本の丸太で、これが人の輪郭のうち
  // いちばん人らしいところである（板の上端を水平に切ると衝立に見える）。
  const yoke = up(0.47);
  const bar = limb([yoke[0], yoke[1], -0.135], [yoke[0], yoke[1], 0.135], 0.072, 0.072, 6);
  bar.scale(0.78, 1, 1);
  parts.push(cloth(bar));
  for (const s of [-1, 1] as const) {
    parts.push(cloth(ball([yoke[0], yoke[1], s * 0.135], 0.075, [0.8, 1, 1], 6, 4)));
  }

  // 襟。首の付け根を囲む短い筒で、白い首が長く見えるのを止める。
  const neck = up(0.56);
  const collar = new THREE.CylinderGeometry(0.078, 0.09, 0.055, 8, 1, true);
  collar.scale(0.85, 1, 1);
  collar.rotateZ(-tilt);
  collar.translate(neck[0], neck[1] - 0.015, 0);
  // 襟は上着より少し暗い（折り返した内側が影になる）
  parts.push(paintByHeight(collar, 0xd0d0d0));

  return {
    parts,
    shoulder: (side: number) => [yoke[0], yoke[1] - 0.02, side * 0.175],
    neck,
  };
}

/** 腕 1 本（上腕・前腕）。手は別の `InstancedMesh` なので置き方だけ返す。 */
function armTo(
  shoulder: readonly [number, number, number],
  elbow: readonly [number, number, number],
  wrist: readonly [number, number, number],
  into: THREE.BufferGeometry[],
): void {
  into.push(paintByHeight(limb(shoulder, elbow, 0.052, 0.043), 0xffffff));
  into.push(paintByHeight(limb(elbow, wrist, 0.043, 0.033), 0xffffff));
}

/** 立っている人の脚。左右で前後に少しずらす（そろえると人形に見える）。 */
function standingLegs(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const hipY = 0.9;
  const hipZ = 0.095;
  for (const [i, s] of [-1, 1].entries()) {
    const offset = i === 0 ? 0.03 : -0.03;
    out.push(paintByHeight(limb([0, hipY, s * hipZ], [offset, 0.47, s * (hipZ + 0.01)], 0.085, 0.07), 0xffffff)); // prettier-ignore
    out.push(paintByHeight(limb([offset, 0.47, s * (hipZ + 0.01)], [offset, 0.075, s * (hipZ + 0.015)], 0.07, 0.05), 0xffffff)); // prettier-ignore
    // 靴（服の色に引きずられないよう暗く焼く）
    out.push(paint(block([0.24, 0.07, 0.1], [offset + 0.03, 0.037, s * (hipZ + 0.015)]), 0x1a1a1c));
  }
  return out;
}

/**
 * 座っている人の脚。
 *
 * 大腿と脛を膝で折る。座面の奥行き（430mm）より大腿長（400mm 前後）のほうが
 * 長いので、座れば必ず膝が前へ出る（`SEATED_KNEE_REACH`）。
 */
function seatedLegs(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const seat = INTERIOR.seatHeight;
  for (const s of [-1, 1] as const) {
    const knee: [number, number, number] = [SEATED_KNEE_REACH - 0.05, seat + 0.015, s * 0.105];
    out.push(paintByHeight(limb([-0.05, seat + 0.02, s * 0.095], knee, 0.095, 0.078), 0xffffff));
    out.push(paintByHeight(limb(knee, [SEATED_KNEE_REACH - 0.045, 0.075, s * 0.11], 0.078, 0.052), 0xffffff)); // prettier-ignore
    out.push(
      paint(block([0.25, 0.07, 0.1], [SEATED_KNEE_REACH - 0.01, 0.037, s * 0.11]), 0x1a1a1c),
    );
  }
  return out;
}

/**
 * 姿勢 1 つぶんの形を組む。
 *
 * 立ち方・座り方そのものより、**手が何をしているか**で人は見分けられる。
 * 吊り革を握る、鞄を提げる、手すりをつかむ、両手でスマートフォンを持つ、
 * 腕を組んで眠る——これらは実物の車内でいつでも同時に見られるもので、
 * 全員が同じ向きに直立している車内はどこにも無い。
 */
function buildBody(posture: Posture): BodyParts {
  const top: THREE.BufferGeometry[] = [];
  const bottom: THREE.BufferGeometry[] = [];
  const hands: HandPose[] = [];
  const hipY = 0.9;
  const seat = INTERIOR.seatHeight;
  const tilt = INTERIOR.seatBackTilt;

  if (IS_SEATED[posture]) {
    const body = upperBody([-0.055, seat + 0.09], tilt);
    top.push(...body.parts);
    bottom.push(...seatedLegs());
    let headPitch = -tilt * 0.4;

    if (posture === 'seatedPhone') {
      // 両手でスマートフォンを持ち、うつむいて見る。車内でいちばん多い姿。
      for (const s of [-1, 1] as const) {
        const wrist: [number, number, number] = [0.135, seat + 0.28, s * 0.085];
        armTo(body.shoulder(s), [-0.06, seat + 0.28, s * 0.2], wrist, top);
        hands.push({ at: wrist, yaw: 0, roll: -1.35, grip: false });
      }
      top.push(paint(block([0.012, 0.09, 0.055], [0.175, seat + 0.3, 0]), 0x101316));
      headPitch = 0.55;
    } else if (posture === 'seatedAsleep') {
      // 腕を組んで眠る。首が前へ落ち、頭が横へ傾く。
      for (const s of [-1, 1] as const) {
        const wrist: [number, number, number] = [0.035, seat + 0.31, -s * 0.11];
        armTo(body.shoulder(s), [-0.05, seat + 0.27, s * 0.205], wrist, top);
        hands.push({ at: wrist, yaw: s * 1.3, roll: -1.5, grip: false });
      }
      headPitch = 0.35;
    } else {
      // 手を腿の上へ。手首を腿から離すと、手だけが宙に浮いた白い塊に見える。
      for (const s of [-1, 1] as const) {
        const wrist: [number, number, number] = [0.055, seat + 0.145, s * 0.135];
        armTo(body.shoulder(s), [-0.075, seat + 0.26, s * 0.2], wrist, top);
        hands.push({ at: wrist, yaw: 0, roll: -0.35, grip: false });
      }
    }
    return {
      top: mergeParts(top, `乗客の胴（${posture}）`)!,
      bottom: mergeParts(bottom, `乗客の脚（${posture}）`)!,
      neck: body.neck,
      headPitch,
      hands,
    };
  }

  // --- 立っている人 ---
  const body = upperBody([0, hipY], 0);
  top.push(...body.parts);
  bottom.push(...standingLegs());
  let headPitch = 0;

  if (posture === 'strap') {
    // 吊り革を握る腕。肘は外へ張り、手は頭の上あたりで握りをつかむ。
    const wrist: [number, number, number] = [0.005, 1.68, 0.15];
    armTo(body.shoulder(1), [0.03, 1.55, 0.245], wrist, top);
    hands.push({ at: wrist, yaw: 0, roll: 2.9, grip: true });
    const low: [number, number, number] = [0.06, 0.83, -0.205];
    armTo(body.shoulder(-1), [0.025, 1.09, -0.2], low, top);
    hands.push({ at: low, yaw: 0, roll: 0, grip: false });
  } else if (posture === 'pole') {
    // 縦手すりを握る。腕を前へ伸ばし、握りは胸の高さ。
    const wrist: [number, number, number] = [0.3, 1.16, 0.08];
    armTo(body.shoulder(1), [0.14, 1.16, 0.2], wrist, top);
    hands.push({ at: wrist, yaw: -1.4, roll: 1.5, grip: true });
    const low: [number, number, number] = [0.06, 0.83, -0.205];
    armTo(body.shoulder(-1), [0.025, 1.09, -0.2], low, top);
    hands.push({ at: low, yaw: 0, roll: 0, grip: false });
  } else if (posture === 'standPhone') {
    // 両手でスマートフォンを持ち、うつむいて見る。
    for (const s of [-1, 1] as const) {
      const wrist: [number, number, number] = [0.185, 1.13, s * 0.085];
      armTo(body.shoulder(s), [0.03, 1.11, s * 0.205], wrist, top);
      hands.push({ at: wrist, yaw: 0, roll: -1.35, grip: false });
    }
    top.push(paint(block([0.012, 0.09, 0.055], [0.225, 1.15, 0]), 0x101316));
    headPitch = 0.5;
  } else {
    // 鞄を提げる。片手は鞄、もう片手は体側。
    const bagSide = 1;
    const wrist: [number, number, number] = [0.07, 0.85, bagSide * 0.21];
    armTo(body.shoulder(bagSide), [0.03, 1.1, bagSide * 0.205], wrist, top);
    hands.push({ at: wrist, yaw: 0, roll: 0, grip: true });
    // 鞄（服の色に引きずられないよう暗く焼く）
    top.push(paint(block([0.13, 0.3, 0.34], [0.07, 0.66, bagSide * 0.235]), 0x2a2420));
    const free: [number, number, number] = [0.06, 0.83, -0.205];
    armTo(body.shoulder(-1), [0.025, 1.09, -0.2], free, top);
    hands.push({ at: free, yaw: 0, roll: 0, grip: false });
  }

  return {
    top: mergeParts(top, `乗客の胴（${posture}）`)!,
    bottom: mergeParts(bottom, `乗客の脚（${posture}）`)!,
    neck: body.neck,
    headPitch,
    hands,
  };
}

// --- 置き方 ---------------------------------------------------------------

/**
 * 駅ごとの混み具合。
 *
 * 実物の通勤電車は、駅を過ぎるたびに混んだり空いたりする。シナリオが持つ
 * 混雑率を中心に振るだけだが、**駅ごとに変わる**というだけで「走っている
 * 電車に乗っている」感じが出る。
 *
 * @param base シナリオの混雑率
 * @param stop 停車の通し番号（発車前は 0）
 */
export function boardingLoadFactor(base: number, stop: number): number {
  const random = rng(stop * 2654435761 + 17);
  return Math.max(0.05, Math.min(1.1, base + (random() - 0.5) * 0.4));
}

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
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const person = (posture: Posture, x: number, z: number, yaw: number): Placement => ({
    posture,
    x,
    z,
    yaw,
    coat: pick(COAT_COLORS),
    trouser: pick(TROUSER_COLORS),
    skin: pick(SKIN_COLORS),
    hair: pick(HAIR_STYLES),
    // 首はまっすぐ前ばかり向いていない
    headTurn: (random() - 0.5) * 0.6,
    scale: 0.94 + random() * 0.12,
  });
  /** 座り方（うつむいてスマートフォン、眠る、ふつうに座る） */
  const seatedPosture = (): Posture => {
    const r = random();
    return r < 0.42 ? 'seatedPhone' : r < 0.6 ? 'seatedAsleep' : 'seated';
  };
  /** 立ち方（鞄・スマートフォン・手すり） */
  const standPosture = (): Posture => {
    const r = random();
    return r < 0.38 ? 'standPhone' : r < 0.62 ? 'pole' : 'standBag';
  };

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
        // 通路を向く。背中が背ずりに触れる位置に置く。
        out.push(person(seatedPosture(), cx, side * (inner - INTERIOR.seatDepth + SEATED_HIP_INSET), side > 0 ? Math.PI / 2 : -Math.PI / 2)); // prettier-ignore
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
        // 棒が右手側へ来るように向きを決める）。ただし体の向きまで揃っては
        // いないので、少しずつ振る。
        const x = a + i * pitch;
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
            standPosture(),
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
          standPosture(),
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
 * seed と混雑率だけで決まるので、**描画と当たり判定が別々に呼んでも必ず
 * 同じ答えになる**。人の居場所を持ち回す配線を増やさずに「見えている膝を
 * 通り抜けない」を成り立たせるのに、この決定論を使っている。
 *
 * 駅で顔ぶれが入れ替わっても、`main.ts` が両方へ同じ seed を渡すかぎり
 * この性質は保たれる。
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
  seed: number,
  loadFactor: number,
): SeatedOccupant[] {
  return placePassengers(layout, bays, loadFactor, seed + 1)
    .filter((p) => IS_SEATED[p.posture])
    .map((p) => ({
      x: p.x,
      side: p.z > 0 ? 1 : -1,
      // 局所 +X（座っている人が向いている向き）は通路側なので、車体中心から
      // 見た膝の位置は「腰の位置 − 膝の出っ張り」になる。
      kneeReach: Math.abs(p.z) - SEATED_KNEE_REACH,
    }));
}

// --- 組み立て -------------------------------------------------------------

/**
 * 体の形は**車にも駅にも依らない**ので、一度作って使い回す。
 *
 * 駅ごとに乗客を組み直すため（`main.ts` の `boardAt`）、ここで作り直していると
 * 扉が閉まるたびに数十人ぶんの形を作ることになり、その場で絵が止まる。
 * 変わるのは「誰がどこに何人いるか」だけなので、形は共有してよい。
 */
const BODY_CACHE = new Map<Posture, BodyParts>();
const HEAD_CACHE = new Map<HairStyle, THREE.BufferGeometry>();
const HAND_CACHE = new Map<boolean, THREE.BufferGeometry>();

function cachedBody(posture: Posture): BodyParts {
  let body = BODY_CACHE.get(posture);
  if (!body) {
    body = buildBody(posture);
    BODY_CACHE.set(posture, body);
  }
  return body;
}

function cachedHead(style: HairStyle): THREE.BufferGeometry {
  let head = HEAD_CACHE.get(style);
  if (!head) {
    head = headGeometry(style);
    HEAD_CACHE.set(style, head);
  }
  return head;
}

function cachedHand(grip: boolean): THREE.BufferGeometry {
  let hand = HAND_CACHE.get(grip);
  if (!hand) {
    hand = handGeometry(grip);
    HAND_CACHE.set(grip, hand);
  }
  return hand;
}

/** 部位ごとの `InstancedMesh` と、その中身 */
interface InstanceGroup {
  readonly mesh: THREE.InstancedMesh;
  /** この `InstancedMesh` の i 番目が誰か */
  readonly people: readonly Placement[];
  /**
   * 人の姿勢の行列に、さらに掛ける局所変換（頭の載り方・手の置き方）。
   * 胴と脚は人そのものなので `null`。
   */
  readonly local: ((index: number, out: THREE.Matrix4) => void) | null;
}

function instance(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  colorOf: (i: number) => number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // 視界のあちこちに散らばるので、まとめて視錐台の外と判定させない
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) mesh.setColorAt(i, color.setHex(colorOf(i)));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/**
 * 1 両ぶんの乗客を組む。
 *
 * @param layout 客室の割り付け
 * @param bays   座席の区画
 * @param seed   割り付けの種。編成の位置と停車回数から `main.ts` が作る
 *               （全車が同じ並びだと、貫通路ごしに同じ絵が続いて模型に見える）
 * @param loadFactor 混雑率
 */
export function buildPassengers(
  layout: CarLayout,
  bays: readonly SeatBay[],
  seed: number,
  loadFactor: number,
): CarPassengers {
  const group = new THREE.Group();
  const people = placePassengers(layout, bays, loadFactor, seed + 1);
  const floor = layout.floorHeight;

  const materials: THREE.MeshStandardMaterial[] = [];
  /** 車ごとの明るさを掛ける前の自己発光の強さ */
  const baseGlow: number[] = [];
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
    baseGlow.push(glow);
    return material;
  };
  // 肌は服より明るいので、同じ自己発光にすると顔だけが光って見える
  const skinMaterial = makeMaterial(0.72, 0.15);
  const clothMaterial = makeMaterial(0.92);

  const bodies = new Map<Posture, BodyParts>();
  for (const posture of POSTURES) {
    if (people.some((p) => p.posture === posture)) bodies.set(posture, cachedBody(posture));
  }

  const groups: InstanceGroup[] = [];
  const rotation = new THREE.Matrix4();

  // --- 胴と脚（姿勢ごと）---
  for (const [posture, body] of bodies) {
    const subset = people.filter((p) => p.posture === posture);
    for (const [geometry, colorOf] of [
      [body.top, (p: Placement) => p.coat],
      [body.bottom, (p: Placement) => p.trouser],
    ] as Array<[THREE.BufferGeometry, (p: Placement) => number]>) {
      const mesh = instance(geometry, clothMaterial, subset.length, (i) => colorOf(subset[i]!));
      group.add(mesh);
      groups.push({ mesh, people: subset, local: null });
    }
  }

  // --- 頭（髪型ごと）---
  // 頭は姿勢に依らない。どの姿勢でも首から上は同じ形で、載る位置（首の
  // 付け根）と傾きが違うだけなので、「姿勢 × 髪型」の掛け算にならずに済む。
  for (const style of HAIR_STYLES) {
    const subset = people.filter((p) => p.hair === style);
    if (subset.length === 0) continue;
    const mesh = instance(cachedHead(style), skinMaterial, subset.length, (i) => subset[i]!.skin);
    group.add(mesh);
    groups.push({
      mesh,
      people: subset,
      local: (index, out) => {
        const person = subset[index]!;
        const body = bodies.get(person.posture)!;
        out.makeTranslation(body.neck[0], body.neck[1], body.neck[2]);
        out.multiply(rotation.makeRotationY(person.headTurn));
        out.multiply(rotation.makeRotationZ(-body.headPitch));
      },
    });
  }

  // --- 手（握る／開くの 2 種。位置と向きは姿勢が決める）---
  for (const grip of [false, true]) {
    // 人 1 人につき手は 2 本あるので、手 1 本ずつを並べた表を作る
    const entries: Array<{ person: Placement; pose: HandPose }> = [];
    for (const person of people) {
      for (const pose of bodies.get(person.posture)!.hands) {
        if (pose.grip === grip) entries.push({ person, pose });
      }
    }
    if (entries.length === 0) continue;
    const mesh = instance(
      cachedHand(grip),
      skinMaterial,
      entries.length,
      (i) => entries[i]!.person.skin,
    );
    group.add(mesh);
    groups.push({
      mesh,
      people: entries.map((e) => e.person),
      local: (index, out) => {
        const pose = entries[index]!.pose;
        out.makeTranslation(pose.at[0], pose.at[1], pose.at[2]);
        out.multiply(rotation.makeRotationY(pose.yaw));
        out.multiply(rotation.makeRotationX(pose.roll));
      },
    });
  }

  const personMatrix = new THREE.Matrix4();
  const localMatrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const yawRotation = new THREE.Quaternion();
  const leanRotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scaleVector = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const leanAxis = new THREE.Vector3();

  /**
   * 傾きは**車体座標系**で掛ける。人ごとに向きが違うので、体の局所系で
   * 掛けると、通路を向いている人と前を向いている人が別々の向きへ倒れて
   * しまう。実際には全員が同じ向きの比力を受けているので、傾きの軸は
   * 車体に固定でなければならない。
   *
   * 座っている人と立っている人は同じ `InstancedMesh` に混ざりうる（頭と手は
   * 姿勢をまたいでまとめてある）ので、効き方は**人ごとに**決める。
   */
  const update = (lateralLean: number, longitudinalLean: number): void => {
    const standLateral = lateralLean * LEAN_GAIN;
    const standLongitudinal = longitudinalLean * LEAN_GAIN;
    for (const entry of groups) {
      for (let i = 0; i < entry.people.length; i++) {
        const p = entry.people[i]!;
        // 座っている人は背ずりに体重を預けているので、傾きはほとんど出ない
        const k = IS_SEATED[p.posture] ? 0.15 : 1;
        const lateral = standLateral * k;
        const longitudinal = standLongitudinal * k;
        // 前へ倒れる = +X へ倒れる = -Z 軸まわりの回転。
        // 右へ倒れる = +Z へ倒れる = +X 軸まわりの回転。
        const angle = Math.hypot(lateral, longitudinal);
        if (angle > 1e-6) leanAxis.set(lateral, 0, -longitudinal).normalize();
        leanRotation.setFromAxisAngle(angle > 1e-6 ? leanAxis : up, angle);
        yawRotation.setFromAxisAngle(up, p.yaw);
        quaternion.copy(leanRotation).multiply(yawRotation);
        position.set(p.x, floor, p.z);
        scaleVector.set(p.scale, p.scale, p.scale);
        personMatrix.compose(position, quaternion, scaleVector);
        if (entry.local) {
          entry.local(i, localMatrix);
          personMatrix.multiply(localMatrix);
        }
        entry.mesh.setMatrixAt(i, personMatrix);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
  };
  update(0, 0);

  return {
    group,
    update,
    setBrightness(k: number): void {
      for (const [i, material] of materials.entries()) {
        material.emissiveIntensity = baseGlow[i]! * k;
      }
    },
    dispose(): void {
      // 形は使い回すので捨てない（`BODY_CACHE` などが持っている）。
      // 捨てるのは、この車のためだけに作った描画の入れ物と材質だけ。
      group.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) node.dispose();
      });
      for (const material of materials) material.dispose();
    },
  };
}
