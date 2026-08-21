import * as THREE from 'three';
import type { VehicleSpec } from '@railsim/core';
import { CAR, CATENARY } from './dimensions.ts';
import {
  carMarkingTexture,
  glowTexture,
  plateTexture,
  priorityStickerTexture,
  stainlessSurface,
} from './textures.ts';
import { hdrColor } from './postprocess.ts';

/**
 * 20m 級 4 扉通勤形電車の車体。
 *
 * 実物の通勤形電車の形を決めているのは、次の 4 つの寸法である。
 *
 *  - **連結面間 20000mm / 車体長 19500mm** — 連結面の隙間 500mm がそのまま
 *    車と車のあいだの黒い切れ目になる。
 *  - **車体幅 2950mm と裾絞り** — 腰部でいちばん広く、床下へ向かって 2800mm へ
 *    絞る。車両限界に収めつつ室内を広く取るための形で、side から見ると
 *    裾のところに折れ線が 1 本走る。
 *  - **床面高さ 1130mm** — ホーム（レール面上 1100mm）とほぼ同じ高さ。
 *    段差がないので、ホームと車内が一続きに見える。
 *  - **屋根高さ 3655mm・肩 R450mm** — 屋根は平らではなく、肩が丸い。
 *    冷房装置とパンタグラフがその上に乗る。
 *
 * 側面は 4 枚の側扉（幅 1300mm・中心間隔 4820mm）と、そのあいだの側窓で決まる。
 * この配置が「20m 4 扉」の見た目そのものになる。
 */

const BODY_COLOR = 0xc9ced3;
/** ステンレス車体のビード（側面に走る補強のすじ） */
const BEAD_COLOR = 0xb4bac0;
const GLASS_COLOR = 0x1b2b38;
const DOOR_COLOR = 0xd9dde1;
const ROOF_COLOR = 0x9299a0;
const UNDER_COLOR = 0x33383e;
const BOGIE_COLOR = 0x3a3f45;
const WHEEL_COLOR = 0x53585e;

/**
 * 車輪の左右間隔（車輪中心の軌道中心からの距離）。
 * 軌間 1067mm はレール頭部**内面**の寸法なので、レール中心はその外側へ
 * 頭部幅の半分だけ出る。車輪はそのレールの真上に載る。
 */
const WHEEL_OFFSET = (1.067 + 0.065) / 2;

/**
 * 車両の材質。
 *
 * 車両はほぼ全体が金属でできている。ステンレスの外板、塗装した屋根、
 * 錆止めを塗った台車、磨かれた車輪の踏面 — どれも金属度と粗さが違うので、
 * 同じ灰色でも光の当たり方が変わる。映り込みの元になる環境マップは
 * シーン側で与えているので、ここでは金属度と粗さだけを指定する。
 */
const metal = (color: number, roughness = 0.45, metalness = 0.7): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

/** 塗装・樹脂・ゴムの面（映り込みが弱い） */
const painted = (color: number, roughness = 0.6): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.1 });

/** 窓ガラス（空を映して黒く光る） */
const glass = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: GLASS_COLOR,
    roughness: 0.06,
    metalness: 0.9,
    side: THREE.DoubleSide,
  });

/**
 * 車体断面の輪郭（右半分）。`[半幅, レール面からの高さ]`。
 * 台枠下端から立ち上がり、裾を絞り、腰から幕板まで垂直、肩で丸めて屋根へ。
 */
function bodyHalfSection(): Array<[number, number]> {
  const half = CAR.bodyWidth / 2;
  const skirt = CAR.skirtWidth / 2;
  const shoulder = CAR.roofHeight - CAR.roofRadius;
  const points: Array<[number, number]> = [
    [0, CAR.underframeHeight],
    [skirt, CAR.underframeHeight],
    [skirt, CAR.floorHeight],
    [half, CAR.floorHeight + 0.59],
    [half, shoulder],
  ];
  // 肩の円弧（半径 450mm）
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const a = (Math.PI / 2) * (i / steps);
    points.push([
      half - CAR.roofRadius + CAR.roofRadius * Math.cos(a),
      shoulder + CAR.roofRadius * Math.sin(a),
    ]);
  }
  points.push([0, CAR.roofHeight]);
  return points;
}

const HALF_SECTION = bodyHalfSection();

/** 高さ y における車体の半幅（裾絞りと肩の丸みを線形に補間する） */
function halfWidthAt(y: number): number {
  const pts = HALF_SECTION;
  if (y <= pts[0]![1]) return pts[0]![0];
  for (let i = 1; i < pts.length; i++) {
    const [w0, y0] = pts[i - 1]!;
    const [w1, y1] = pts[i]!;
    if (y <= y1) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return w0 + (w1 - w0) * t;
    }
  }
  return pts[pts.length - 1]![0];
}

/**
 * 側扉の中心位置（車体中心から前後へ。4 扉・中心間隔 4820mm）。
 *
 * 先頭車は前寄りに運転室があるぶん、扉の並び全体を運転室と反対側へ 550mm
 * ずらす。実物の先頭車も中間車と扉の位置が揃っておらず、こうしないと
 * いちばん前の扉が運転室に食い込む。
 */
function doorCentres(shift = 0): number[] {
  return [-1.5, -0.5, 0.5, 1.5].map((k) => k * CAR.doorPitch + shift);
}

/** 前面の灯具。前照灯と尾灯の点け方を外から与える。 */
export interface FrontLights {
  /** 前照灯（`high` が false なら減光） */
  setHeadlight(on: boolean, high: boolean): void;
  setTail(on: boolean): void;
}

export interface CarParts {
  readonly group: THREE.Group;
  /** 先頭車だけが持つ前面の灯具（中間車では `undefined`） */
  readonly lights: FrontLights | undefined;
}

/** 車体に入れる標記。編成の中でその車が何号車かで中身が変わる */
export interface CarMarking {
  /** 号車番号（1 から。省略すると号車札を付けない） */
  readonly index?: number;
  /** 編成の両数（弱冷房車をどこに置くか決めるのに使う） */
  readonly cars?: number;
}

/**
 * 1 両ぶんの車両を組み立てる。
 *
 * 動力車と付随車は塗り分けでは区別しない。実物と同じく、**屋根のパンタグラフと
 * 床下の主回路箱があるかどうか**で見分けられるようにしてある。
 *
 * @param spec 編成仕様の車両（長さ・台車中心間距離・車輪径をここから取る）
 * @param lead 先頭車（前面と運転室を付ける）
 * @param front 編成の前を向いているか（後端の先頭車は前面を後ろ向きに付ける）
 */
export function buildCar(
  spec: VehicleSpec,
  lead: boolean,
  front: boolean,
  marking: CarMarking = {},
): CarParts {
  const group = new THREE.Group();
  const bodyLength = spec.length - (CAR.couplerLength - CAR.bodyLength);
  const powered = spec.drivenAxleCount > 0;

  group.add(buildBody(bodyLength));
  group.add(buildSides(bodyLength, lead, front));
  group.add(buildMarkings(bodyLength, lead, front, powered, marking));
  group.add(buildRoof(bodyLength, powered));
  group.add(buildUnderframe(spec, bodyLength, powered));
  for (const sign of [-1, 1] as const) {
    group.add(buildBogie(spec, (sign * spec.bogieSpacing) / 2, powered));
  }
  let lights: FrontLights | undefined;
  if (lead) {
    const end = buildFrontEnd(bodyLength, front);
    group.add(end.group);
    lights = end.lights;
  }
  group.add(buildCouplers(spec.length, lead, front));

  return { group, lights };
}

/** 車体の外板。断面を車体長ぶん押し出す */
function buildBody(bodyLength: number): THREE.Mesh {
  const shape = new THREE.Shape();
  const pts = HALF_SECTION;
  shape.moveTo(0, pts[0]![1]);
  for (const [w, y] of pts) shape.lineTo(w, y);
  for (let i = pts.length - 1; i >= 0; i--) {
    const [w, y] = pts[i]!;
    if (w === 0) continue;
    shape.lineTo(-w, y);
  }
  shape.lineTo(0, pts[0]![1]);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: bodyLength,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -bodyLength / 2);
  // 押し出し方向（Z）を車両の前後方向（X）へ向ける
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  // ステンレスの外板。粗さを低めにすると、腰から上の平らな面が空を映して光る。
  // 圧延の目と雨だれのテクスチャを掛けると、同じ銀色でも「使われている車体」に
  // 見える。押し出した形状の UV は面ごとに大きさが違うので、実寸にはならないが、
  // 側面が画面のほとんどを占めるのでそこで合っていればよい。
  const maps = stainlessSurface().maps(2.4);
  const material = metal(BODY_COLOR, 0.32, 0.62);
  material.map = maps.map;
  material.normalMap = maps.normalMap;
  material.normalScale = new THREE.Vector2(0.35, 0.35);
  // 汚れたところは映り込みが鈍る。粗さにも同じ模様を掛けて、
  // 雨だれの筋だけつやが消えるようにする。
  material.roughnessMap = maps.map;
  return new THREE.Mesh(geometry, material);
}

/**
 * 車体表面に貼る帯。
 *
 * 断面の折れ線に沿わせるので、裾絞りの区間でも車体から浮かない。
 * 側扉・側窓・ビード・帯をすべてこれで作る。
 */
function sidePanel(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  color: number,
  lift = 0.008,
): THREE.Mesh {
  const heights: number[] = [y0];
  for (const [, y] of HALF_SECTION) {
    if (y > y0 && y < y1) heights.push(y);
  }
  heights.push(y1);

  const positions: number[] = [];
  const indices: number[] = [];
  for (const side of [-1, 1] as const) {
    const base = positions.length / 3;
    for (const y of heights) {
      const z = side * (halfWidthAt(y) + lift);
      positions.push(x0, y, z, x1, y, z);
    }
    for (let i = 0; i < heights.length - 1; i++) {
      const a = base + i * 2;
      if (side < 0) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material =
    color === GLASS_COLOR
      ? glass()
      : new THREE.MeshStandardMaterial({
          color,
          roughness: 0.34,
          metalness: 0.55,
          side: THREE.DoubleSide,
        });
  return new THREE.Mesh(geometry, material);
}

/**
 * 側面（側扉・側窓・帯）。
 *
 * 側扉は床面（1130mm）から 1850mm、側窓は床面上 900mm から 860mm。
 * 先頭車の運転室のぶんだけ、前寄りの扉と窓を詰める。
 */
function buildSides(bodyLength: number, lead: boolean, front: boolean): THREE.Group {
  const group = new THREE.Group();
  const doorTop = CAR.floorHeight + CAR.doorHeight;
  const windowBottom = CAR.floorHeight + CAR.windowSill;
  const windowTop = windowBottom + CAR.windowHeight;
  const half = bodyLength / 2;
  /** 運転室のある側の端（先頭車ではそこから先が運転室） */
  const cabEdge = lead ? (front ? half - CAR.cabLength : -half + CAR.cabLength) : null;

  const shift = cabEdge === null ? 0 : (front ? -1 : 1) * 0.55;
  const doors = doorCentres(shift).filter(
    (x) =>
      Math.abs(x) + CAR.doorWidth / 2 < half - 0.6 &&
      (cabEdge === null ||
        (front ? x + CAR.doorWidth / 2 < cabEdge : x - CAR.doorWidth / 2 > cabEdge)),
  );

  for (const x of doors) {
    group.add(
      sidePanel(
        x - CAR.doorWidth / 2,
        x + CAR.doorWidth / 2,
        CAR.floorHeight + 0.02,
        doorTop,
        DOOR_COLOR,
      ),
    );
    // 扉の窓（2 枚。中央に細い柱が入る）
    for (const sign of [-1, 1] as const) {
      group.add(
        sidePanel(
          x + sign * 0.03,
          x + sign * (CAR.doorWidth / 2 - 0.1),
          windowBottom - 0.05,
          windowTop + 0.12,
          GLASS_COLOR,
          0.012,
        ),
      );
    }
  }

  // 側窓（扉と扉のあいだ、および車端）
  const edges: number[] = [
    -half + 0.35,
    ...doors.flatMap((x) => [x - CAR.doorWidth / 2, x + CAR.doorWidth / 2]),
    half - 0.35,
  ];
  for (let i = 0; i < edges.length; i += 2) {
    let a = edges[i]!;
    let b = edges[i + 1]!;
    if (cabEdge !== null) {
      if (front) b = Math.min(b, cabEdge);
      else a = Math.max(a, cabEdge);
    }
    // 戸袋のぶん（扉の脇 550mm）を空ける
    a += 0.55;
    b -= 0.55;
    if (b - a < 0.5) continue;
    // 幅の広い区間は 2 枚の窓に割る（実物も 1 枚窓は幅 1.5m 程度まで）
    const panes = Math.max(1, Math.round((b - a) / 1.5));
    for (let k = 0; k < panes; k++) {
      const pa = a + ((b - a) * k) / panes + 0.06;
      const pb = a + ((b - a) * (k + 1)) / panes - 0.06;
      group.add(sidePanel(pa, pb, windowBottom, windowTop, GLASS_COLOR, 0.012));
    }
  }

  // 先頭車の運転室側窓（下降窓。運転士が顔を出す窓）
  if (cabEdge !== null) {
    const x = front ? cabEdge + 0.55 : cabEdge - 0.55;
    group.add(
      sidePanel(x - 0.42, x + 0.42, windowBottom + 0.06, windowTop + 0.06, GLASS_COLOR, 0.012),
    );
  }

  // ステンレス車体のビードと帯（幕板と腰板）
  group.add(
    sidePanel(-half + 0.1, half - 0.1, windowTop + 0.16, windowTop + 0.36, 0x2f6fb5, 0.006),
  );
  group.add(
    sidePanel(
      -half + 0.1,
      half - 0.1,
      CAR.floorHeight + 0.06,
      CAR.floorHeight + 0.16,
      0x2f6fb5,
      0.006,
    ),
  );
  for (const y of [windowTop + 0.5, CAR.floorHeight + 0.32]) {
    group.add(sidePanel(-half + 0.1, half - 0.1, y, y + 0.03, BEAD_COLOR, 0.004));
  }

  return group;
}

/**
 * 車体側面の標記。
 *
 * 実物の通勤形の側面には、無地のところがほとんど無い。ここでは遠くからでも
 * 効く 5 つを入れる。**細かい文字は読めなくてよい**（読めない距離でも、
 * 面に濃淡があること自体が「実物」に見せる）。
 *
 *  - **号車番号** — 戸袋部の窓上、レール面上 2700mm に 220mm 角の札。
 *    ホームで並ぶ客が読むものなので、扉のすぐ脇にある。
 *  - **車号** — 車端の腰板、レール面上 1500mm に 1 行。形式（クハ/モハ/サハ）は
 *    運転室と電動機の有無で決まるので、先頭車・動力車の別からそのまま出す。
 *  - **所属標記** — 車号の下。区所名を丸で囲った略号（ここでは「中原」）。
 *  - **弱冷房車** — 冷房を弱めた 1 両の扉脇。実物では 4 号車前後に置くことが多い。
 *  - **優先席** — 車端の窓に貼るステッカー。車内からも車外からも同じ位置に見える。
 *
 * 貼り付けは側板（`sidePanel`）と同じ作りにする。車体は裾絞りがあるので、
 * 平らな板を貼ると隅が車体へ潜る。高さごとの半幅をたどれば面に沿う。
 */
function buildMarkings(
  bodyLength: number,
  lead: boolean,
  front: boolean,
  powered: boolean,
  marking: CarMarking,
): THREE.Group {
  const group = new THREE.Group();
  const half = bodyLength / 2;
  const index = marking.index;
  const cars = marking.cars ?? 0;

  /** 側面へ板を貼る（左右両側・車体の曲面に沿わせる） */
  const decal = (
    centre: number,
    width: number,
    bottom: number,
    height: number,
    material: THREE.Material,
  ): void => {
    group.add(
      texturedPanel(
        centre - width / 2,
        centre + width / 2,
        bottom,
        bottom + height,
        material,
        0.01,
      ),
    );
  };

  // --- 車号と所属標記 ---
  //
  // 形式記号は実物の付け方どおりに出す。運転室があれば制御車の「クハ」、
  // 電動機があれば「モハ」、どちらでもなければ付随車の「サハ」。
  const kind = lead ? 'クハ' : powered ? 'モハ' : 'サハ';
  const serial = 1000 + (index ?? 1) + (powered ? 100 : 0);
  const numberTexture = carMarkingTexture([`${kind}${serial}`], 'plate');
  const numberMaterial = new THREE.MeshStandardMaterial({
    map: numberTexture,
    roughness: 0.4,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
  // 車端（運転室と反対の端）の腰板。レール面上 1500mm、字高 100mm 級
  const numberAt = front ? -half + 0.9 : half - 0.9;
  decal(numberAt, 0.72, 1.5, 0.18, numberMaterial);

  const depotMaterial = new THREE.MeshStandardMaterial({
    map: carMarkingTexture(['都 中原'], 'plate'),
    roughness: 0.4,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
  decal(numberAt, 0.5, 1.28, 0.13, depotMaterial);

  /**
   * 戸袋（扉の脇の、窓の無い 550mm）の中心。
   *
   * 標記はここに貼る。窓の上へ回すと、実物では冷房の吹き出し口や
   * 車号灯が入っている場所と重なるし、絵としても窓に食い込む。
   * 扉の並びは先頭車で 550mm ずれる（`doorCentres` と同じ扱い）。
   */
  const pocketAt = (k: number, sign: 1 | -1): number => {
    const shift = lead ? (front ? -0.55 : 0.55) : 0;
    return k * CAR.doorPitch + shift + sign * (CAR.doorWidth / 2 + 0.27);
  };

  // --- 号車札 ---
  if (index !== undefined) {
    const label = new THREE.MeshStandardMaterial({
      map: carMarkingTexture([`${index}`], 'number'),
      roughness: 0.55,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    // 中央寄りの扉の戸袋。実物と同じ 220mm 角、床上 900mm あたり
    decal(pocketAt(front ? 0.5 : -0.5, front ? 1 : -1), 0.22, 2.02, 0.22, label);
  }

  // --- 弱冷房車 ---
  //
  // 編成の中の 1 両だけ。実物も「4 号車」など決まった号車に置き、
  // 客が号車で覚えられるようにしてある。
  if (index !== undefined && cars >= 4 && index === Math.min(4, cars)) {
    const weak = new THREE.MeshStandardMaterial({
      map: carMarkingTexture(['弱冷房車'], 'weak'),
      roughness: 0.5,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    // 4 つの扉のうち中ほどの 2 か所。客が扉ごとに見つけられるようにする
    for (const [k, sign] of [
      [-0.5, -1],
      [0.5, 1],
    ] as ReadonlyArray<[number, 1 | -1]>) {
      decal(pocketAt(k, sign), 0.4, 2.32, 0.15, weak);
    }
  }

  // --- 優先席のステッカー ---
  //
  // 車端の窓に貼る。編成の端の車では運転室と反対の端だけになる。
  const sticker = priorityStickerTexture();
  const stickerMaterial = new THREE.MeshStandardMaterial({
    map: sticker.map,
    alphaMap: sticker.alpha,
    alphaTest: 0.5,
    roughness: 0.25,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const windowTop = CAR.floorHeight + CAR.windowSill + CAR.windowHeight;
  for (const sign of [-1, 1] as const) {
    if (lead && (front ? sign > 0 : sign < 0)) continue;
    decal(sign * (half - 0.95), 0.46, windowTop - 0.34, 0.23, stickerMaterial);
  }

  return group;
}

/**
 * 側面へテクスチャ付きの板を貼る。
 *
 * `sidePanel()` と同じく高さごとの半幅をたどるが、こちらは UV を張って
 * 文字が読めるようにする（`sidePanel()` は無地の面しか作らない）。
 */
function texturedPanel(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  material: THREE.Material,
  lift: number,
): THREE.Mesh {
  const heights = [y0, y1];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const side of [-1, 1] as const) {
    const base = positions.length / 3;
    for (let i = 0; i < heights.length; i++) {
      const y = heights[i]!;
      const z = side * (halfWidthAt(y) + lift);
      positions.push(x0, y, z, x1, y, z);
      // 左右で前後が入れ替わるので、u も裏返す（裏側で鏡文字にならないように）
      const v = i / (heights.length - 1);
      if (side < 0) uvs.push(1, v, 0, v);
      else uvs.push(0, v, 1, v);
    }
    for (let i = 0; i < heights.length - 1; i++) {
      const a = base + i * 2;
      if (side < 0) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/**
 * 屋根まわり（冷房装置・ランボード・パンタグラフ）。
 *
 * パンタグラフはシングルアーム式で、舟体をトロリ線の高さ（レール面上 5000mm）まで
 * 上げた姿勢に組む。架線をこの高さで張ってあるので、外部視点から見ると
 * 舟体がちょうどトロリ線に触れる。
 */
function buildRoof(bodyLength: number, powered: boolean): THREE.Group {
  const group = new THREE.Group();
  const roofY = CAR.roofHeight;

  // 屋根板（肩の丸みの上に載る平らな部分）
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLength - 0.2, 0.04, (CAR.bodyWidth - CAR.roofRadius * 2) * 0.98),
    painted(ROOF_COLOR, 0.75),
  );
  roof.position.y = roofY + 0.01;
  group.add(roof);

  // 集中式冷房装置（AU726 相当。1 両に 1 台、屋根の中央）
  const cooler = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.42, 1.6), metal(0xb6bcc2, 0.5, 0.6));
  cooler.position.y = roofY + 0.23;
  group.add(cooler);
  const coolerLid = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.06, 1.3),
    metal(0x8d949b, 0.55, 0.6),
  );
  coolerLid.position.y = roofY + 0.46;
  group.add(coolerLid);

  // 雨樋（あまどい）。屋根の肩の縁に沿って前後に走る細い溝で、側面から見た
  // ときに**屋根と車体を分ける 1 本の線**になる。実物の通勤形はどれも持っていて、
  // これが無いと屋根が車体に溶けて丸太のように見える。
  for (const z of [-1, 1] as const) {
    const gutter = new THREE.Mesh(
      new THREE.BoxGeometry(bodyLength - 0.3, 0.07, 0.09),
      metal(0x8f959b, 0.55, 0.6),
    );
    gutter.position.set(0, CAR.roofHeight - CAR.roofRadius * 0.62, z * (CAR.bodyWidth / 2 - 0.1));
    group.add(gutter);
  }

  // ランボード（屋根上を歩くための板）
  for (const z of [-0.75, 0.75]) {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(bodyLength - 1.2, 0.05, 0.22),
      metal(0x9aa1a8, 0.5, 0.6),
    );
    board.position.set(0, roofY + 0.05, z);
    group.add(board);
  }

  if (powered) group.add(buildPantograph(-bodyLength / 2 + 3.6, roofY));
  return group;
}

/**
 * シングルアーム式パンタグラフ。
 *
 * 碍子で屋根から絶縁した台枠に、く の字の腕が 1 本立つ。腕の先の舟体が
 * トロリ線を押し上げながら擦る。舟体の幅は偏位（±200mm）を吸収できるよう
 * 1900mm ほどあり、両端は架線を引っ掛けないよう下へ曲げてある（ホーン）。
 */
function buildPantograph(x: number, roofY: number): THREE.Group {
  const group = new THREE.Group();
  const frameMetal = metal(0x8b9298, 0.35, 0.8);
  const dark = painted(0x3c4147, 0.55);

  // 碍子 4 個と台枠
  for (const dx of [-0.7, 0.7]) {
    for (const dz of [-0.8, 0.8]) {
      const insulator = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 0.24, 8),
        painted(0x6d5b52, 0.4),
      );
      insulator.position.set(dx, roofY + 0.12, dz);
      group.add(insulator);
    }
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.8), dark);
  frame.position.y = roofY + 0.28;
  group.add(frame);

  const baseY = roofY + 0.32;
  const headY = CATENARY.contactHeight;
  const elbowY = baseY + (headY - baseY) * 0.62;

  /** 2 点を結ぶ腕（X-Y 平面内） */
  const arm = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    z: number,
  ): THREE.Mesh => {
    const from = new THREE.Vector3(x0, y0, z);
    const to = new THREE.Vector3(x1, y1, z);
    const dir = new THREE.Vector3().subVectors(to, from);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 1.3, dir.length(), 6),
      frameMetal,
    );
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  };

  for (const z of [-0.55, 0.55]) {
    // 下枠（太い）と上枠（細い）で「く の字」を作る
    group.add(arm(0.55, baseY, -0.35, elbowY, 0.05, z));
    group.add(arm(-0.35, elbowY, 0.32, headY - 0.12, 0.032, z));
  }

  // 舟体（2 本のすり板と、両端の下向きホーン）
  for (const dx of [-0.09, 0.09]) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 1.9), dark);
    shoe.position.set(0.32 + dx, headY - 0.03, 0);
    group.add(shoe);
  }
  const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 1.7), frameMetal);
  cradle.position.set(0.32, headY - 0.1, 0);
  group.add(cradle);
  for (const dz of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6), frameMetal);
    horn.rotation.x = dz * 0.9;
    horn.position.set(0.32, headY - 0.12, dz * 1.05);
    group.add(horn);
  }

  group.position.x = x;
  return group;
}

/**
 * 床下機器。
 *
 * 動力車には主変換装置（VVVF インバータ）と主電動機の送風、付随車には
 * 補助電源装置と空気圧縮機、どちらにも蓄電池箱と制御箱が付く。台車のあいだの
 * 台枠下面にぶら下がるので、側面から見ると床下が黒い箱で埋まる。
 */
function buildUnderframe(spec: VehicleSpec, bodyLength: number, powered: boolean): THREE.Group {
  const group = new THREE.Group();
  const material = painted(UNDER_COLOR, 0.75);

  // 台枠
  const underframe = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLength - 0.4, 0.16, CAR.skirtWidth - 0.2),
    metal(0x4a4f55, 0.6, 0.5),
  );
  underframe.position.y = CAR.underframeHeight - 0.08;
  group.add(underframe);

  /** 機器箱を台枠の下にぶら下げる */
  const box = (x: number, length: number, height: number, width: number, z = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), material);
    mesh.position.set(x, CAR.underframeHeight - 0.16 - height / 2, z);
    return mesh;
  };

  const inner = spec.bogieSpacing / 2 - 1.6;
  if (powered) {
    // 主変換装置（大きい）と主電動機の冷却風道
    group.add(box(-inner * 0.55, 3.0, 0.62, 1.5, -0.5));
    group.add(box(inner * 0.5, 2.2, 0.55, 1.1, 0.6));
  } else {
    // 補助電源装置と空気圧縮機
    group.add(box(-inner * 0.5, 2.4, 0.58, 1.3, -0.55));
    group.add(box(inner * 0.55, 1.8, 0.5, 1.0, 0.65));
  }
  // 蓄電池箱と制御箱（どの車にもある）
  group.add(box(0, 1.4, 0.42, 0.9, 0.75));
  group.add(box(inner * 0.9, 1.0, 0.4, 0.8, -0.7));
  return group;
}

/**
 * ボルスタレス台車。
 *
 * 実物の通勤形は、側ばりと横ばりを溶接した H 形の台車枠を、2 組の輪軸が
 * 軸ばねで支え、その上に空気ばね 2 個を置いて車体を受ける。固定軸距 2100mm、
 * 車輪径 860mm。動力車には主電動機と歯車箱が輪軸のあいだに入る。
 */
function buildBogie(spec: VehicleSpec, x: number, powered: boolean): THREE.Group {
  const group = new THREE.Group();
  const frameMaterial = painted(BOGIE_COLOR, 0.72);
  // 踏面は毎日レールに磨かれるので、台車枠よりずっと光る
  const wheelMaterial = metal(WHEEL_COLOR, 0.32, 0.85);
  const radius = spec.wheelDiameter / 2;
  const halfBase = spec.bogieWheelbase / 2;

  // 側ばり（左右）と横ばり
  for (const z of [-0.99, 0.99]) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(spec.bogieWheelbase + 0.9, 0.26, 0.16),
      frameMaterial,
    );
    beam.position.set(0, radius + 0.12, z);
    group.add(beam);
  }
  const transom = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 2.0), frameMaterial);
  transom.position.y = radius + 0.12;
  group.add(transom);

  // 輪軸（車輪 2 枚 + 車軸）と軸箱
  for (const dx of [-halfBase, halfBase]) {
    for (const z of [-WHEEL_OFFSET, WHEEL_OFFSET]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.085, 20),
        wheelMaterial,
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(dx, radius, z);
      group.add(wheel);
      // 踏面の外側にフランジ（内側に出る輪縁）
      const flange = new THREE.Mesh(
        new THREE.CylinderGeometry(radius + 0.027, radius + 0.027, 0.02, 20),
        wheelMaterial,
      );
      flange.rotation.x = Math.PI / 2;
      flange.position.set(dx, radius, z - Math.sign(z) * 0.053);
      group.add(flange);
    }
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 10), wheelMaterial);
    axle.rotation.x = Math.PI / 2;
    axle.position.set(dx, radius, 0);
    group.add(axle);

    for (const z of [-0.99, 0.99]) {
      const journal = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.24), frameMaterial);
      journal.position.set(dx, radius, z);
      group.add(journal);
      // 軸ばね（コイルばね）
      const spring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 0.18, 8),
        metal(0x6b7076, 0.5, 0.6),
      );
      spring.position.set(dx, radius + 0.2, z);
      group.add(spring);
    }
  }

  // 空気ばね（車体を支える。ここが伸び縮みして上下動を吸収する）
  for (const z of [-0.95, 0.95]) {
    const airSpring = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.26, 0.24, 12),
      painted(0x2b2f34, 0.85),
    );
    airSpring.position.set(0, radius + 0.38, z);
    group.add(airSpring);
  }

  if (powered) {
    // 主電動機と歯車箱（輪軸のあいだ、片側に寄せて吊る）
    for (const dx of [-halfBase, halfBase]) {
      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.19, 0.19, 0.62, 10),
        metal(0x40454b, 0.55, 0.6),
      );
      motor.rotation.x = Math.PI / 2;
      motor.position.set(dx + Math.sign(dx) * 0.36, radius, 0.25);
      group.add(motor);
      const gearbox = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.34, 0.26),
        metal(0x4a4f55, 0.55, 0.6),
      );
      gearbox.position.set(dx, radius - 0.02, -0.15);
      group.add(gearbox);
    }
  }

  // 基礎ブレーキ（ユニットブレーキ）
  for (const dx of [-halfBase, halfBase]) {
    for (const z of [-0.7, 0.7]) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.14), metal(0x585d63, 0.6, 0.5));
      unit.position.set(dx + Math.sign(dx) * 0.28, radius + 0.05, z);
      group.add(unit);
    }
  }

  group.position.x = x;
  return group;
}

/**
 * 先頭部。
 *
 * 通勤形の前面は、上半分が黒い窓まわり、下半分が車体色、その下に排障器という
 * 三段構成になる。前面窓は運転士側が大きく、助士側と行先表示器が並ぶ。
 * 前照灯（白）と尾灯（赤）は左右の下寄りに 1 組ずつ付く。
 */
function buildFrontEnd(
  bodyLength: number,
  front: boolean,
): { group: THREE.Group; lights: FrontLights } {
  const group = new THREE.Group();
  const heads: THREE.Mesh[] = [];
  const halos: THREE.Mesh[] = [];
  const tails: THREE.Mesh[] = [];
  const x = front ? bodyLength / 2 : -bodyLength / 2;
  const outward = front ? 1 : -1;

  /** 前面に貼る板（`dx` は前面からの張り出し） */
  const face = (
    width: number,
    height: number,
    y: number,
    z: number,
    color: number,
    dx = 0.02,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, height, width),
      color === GLASS_COLOR ? glass() : metal(color, 0.36, 0.5),
    );
    mesh.position.set(x + outward * dx, y, z);
    return mesh;
  };

  const windowTop = CAR.floorHeight + CAR.windowSill + CAR.windowHeight;

  // 窓まわりの黒い面
  group.add(face(2.7, 1.05, windowTop - 0.15, 0, 0x15191d, 0.015));
  // 前面窓（運転士側が広い。運転士は左に座るので、前を向いたとき左側が大きい）
  group.add(face(1.35, 0.78, windowTop - 0.2, outward * -0.62, GLASS_COLOR, 0.035));
  group.add(face(0.85, 0.72, windowTop - 0.23, outward * 0.72, GLASS_COLOR, 0.035));
  // 行先表示器（種別 + 行先）。実物は幕か LED で、昼間でも読めるだけの
  // 明るさで光っている。自ら光る面にしておくと、後処理のブルームで
  // わずかに滲み、遠くからでも「そこに表示がある」と分かる。
  const destination = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.26, 0.9),
    new THREE.MeshStandardMaterial({
      map: plateTexture(['各駅停車 登戸'], {
        background: '#101418',
        color: '#f2e6b4',
        aspect: 3.4,
      }),
      emissive: 0xffffff,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    }),
  );
  destination.position.set(x + outward * 0.03, windowTop + 0.5, outward * 0.5);
  // 板の絵は進行方向の外側から読む。裏返っている側は 180 度回す
  if (outward < 0) destination.rotation.y = Math.PI;
  group.add(destination);

  // 前照灯（下部左右）と尾灯
  for (const dz of [-1, 1]) {
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.06, 12),
      new THREE.MeshBasicMaterial({ color: hdrColor(HEAD_LAMP_OFF, 1) }),
    );
    head.rotation.z = Math.PI / 2;
    head.position.set(x + outward * 0.04, CAR.floorHeight + 0.42, dz * 1.05);
    heads.push(head);
    group.add(head);

    // 前照灯のにじみ。灯具そのものより一回り大きく光って見える
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: 0xfff2cf,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.rotation.y = outward > 0 ? Math.PI / 2 : -Math.PI / 2;
    halo.position.set(x + outward * 0.08, CAR.floorHeight + 0.42, dz * 1.05);
    halos.push(halo);
    group.add(halo);

    const tail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10),
      new THREE.MeshBasicMaterial({ color: hdrColor(TAIL_LAMP_OFF, 1) }),
    );
    tail.rotation.z = Math.PI / 2;
    tail.position.set(x + outward * 0.04, CAR.floorHeight + 0.42, dz * 0.78);
    tails.push(tail);
    group.add(tail);
  }

  // 排障器（スカート）
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 2.5), painted(0x4b5158, 0.6));
  skirt.position.set(x + outward * 0.05, CAR.underframeHeight - 0.34, 0);
  group.add(skirt);

  const lights: FrontLights = {
    setHeadlight(on, high) {
      // 点灯している灯具は画面の白より明るい。倍率を掛けておくと、後処理の
      // ブルームがしきい値（1.3）を超えたぶんだけ滲ませる（`postprocess.ts`）。
      // 減光では倍率も落ちるので、滲みの大きさで前照灯と減光が見分けられる。
      const color = on
        ? hdrColor(high ? HEAD_LAMP_HIGH : HEAD_LAMP_LOW, high ? HEAD_GAIN : HEAD_GAIN * 0.35)
        : hdrColor(HEAD_LAMP_OFF, 1);
      for (const head of heads) (head.material as THREE.MeshBasicMaterial).color.copy(color);
      for (const halo of halos) {
        halo.visible = on;
        // 減光では滲みも小さくする（灯具そのものより周りの明るさで差が分かる）
        halo.scale.setScalar(high ? 1 : 0.55);
      }
    },
    setTail(on) {
      for (const tail of tails) {
        (tail.material as THREE.MeshBasicMaterial).color.copy(
          on ? hdrColor(TAIL_LAMP_ON, TAIL_GAIN) : hdrColor(TAIL_LAMP_OFF, 1),
        );
      }
    },
  };
  // 既定は消灯（運転士が前照灯を入れるまで点かない）
  lights.setHeadlight(false, true);
  lights.setTail(false);

  return { group, lights };
}

/** 点灯した前照灯・尾灯の輝度倍率（ブルームのしきい値 1.3 を超えるように） */
const HEAD_GAIN = 3.6;
const TAIL_GAIN = 2.6;

/** 前照灯（点灯・減光・消灯）と尾灯（点灯・消灯）の色 */
const HEAD_LAMP_HIGH = 0xfff6d8;
const HEAD_LAMP_LOW = 0xb8a884;
const HEAD_LAMP_OFF = 0x2b2c28;
const TAIL_LAMP_ON = 0xd4241d;
const TAIL_LAMP_OFF = 0x5a1512;

/**
 * 連結器（密着連結器）。
 * 先頭の前面には電気連結器を付けた頭が出る。中間の連結面では、
 * 隣の車とのあいだの 500mm の隙間に胴受と幌が収まる。
 */
function buildCouplers(length: number, lead: boolean, front: boolean): THREE.Group {
  const group = new THREE.Group();
  const material = metal(0x3a3f45, 0.6, 0.6);
  const bodyLength = length - (CAR.couplerLength - CAR.bodyLength);

  for (const sign of [-1, 1] as const) {
    const outer = lead && (front ? sign > 0 : sign < 0);
    const x = (sign * bodyLength) / 2;
    if (outer) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.42), material);
      head.position.set(x + sign * 0.28, 0.66, 0);
      group.add(head);
      const electric = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.4), material);
      electric.position.set(x + sign * 0.5, 0.48, 0);
      group.add(electric);
    } else {
      // 幌（連結面の隙間を塞ぐ蛇腹）
      const bellows = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 2.0, 1.5),
        painted(0x23272b, 0.95),
      );
      bellows.position.set(x + sign * 0.13, CAR.floorHeight + 1.05, 0);
      group.add(bellows);
      const draft = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.36), material);
      draft.position.set(x + sign * 0.15, 0.68, 0);
      group.add(draft);
    }
  }
  return group;
}
