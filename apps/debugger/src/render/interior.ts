import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from '@railsim/core';
import { CAR, INTERIOR } from './dimensions.ts';
import {
  adTexture,
  createCarDisplay,
  doorStickerTexture,
  floorSheetTexture,
  moquetteTexture,
  noticeTexture,
  panelTexture,
  priorityStickerTexture,
  rackMeshTexture,
  type CarDisplay,
} from './interiorTextures.ts';
import { buildPassengers, type CarPassengers } from './interiorPassengers.ts';
import { OcclusionField, shadeWithVertexColor, tintVertices } from './interiorShading.ts';

/**
 * 客室の内装。
 *
 * 外板（`vehicle.ts`）が車体の**外から見える形**を作るのに対し、こちらは
 * **中から見える形**を作る。運転席視点では見えないが、車内を歩くモード
 * （`walk.ts`）ではここが視界のすべてになる。
 *
 * 内装の寸法は `dimensions.ts` の `INTERIOR` にまとめてある。床面高さ 1130mm・
 * 内法幅 2790mm・天井高さ 2300mm という 3 つの寸法が客室の広さを決めていて、
 * そこからロングシートの奥行き（430mm）を両側で引いた 1930mm が通路になる。
 *
 * 車体（`buildCar`）の局所座標系にそのまま乗る:
 *
 *  - X = 前後（+ が前）、Y = 上（レール面が 0）、Z = 右
 *
 * すなわち床面は `y = CAR.floorHeight`、天井は `y = CAR.floorHeight +
 * INTERIOR.ceilingHeight` にある。
 *
 * ## 「閉じた箱」であること
 *
 * 車体の外板は押し出した 1 枚の殻で、法線が外を向いている（`FrontSide`）。
 * つまり**車内から見ると外板は消えている**。したがって内装は、床・両側の内壁・
 * 天井・妻面で客室をぐるりと閉じていなければならず、どこか 1 か所でも塞ぎ忘れると
 * そこから外の景色が漏れて見える。側窓と側扉の開口だけが、外板に貼ってあるガラスと
 * ぴったり重なるように空いている（`windowPanes()` が `vehicle.ts` と同じ式で
 * 窓の位置を出しているのはこのためで、片方だけ動かすと必ず穴が開く）。
 *
 * ## 明るさ
 *
 * 車内は蛍光灯で照らされた空間だが、1 両に何本も光源を置くと描画が持たない。
 * そこで面そのものをわずかに自己発光させ（`lit()`）、照明のカバーだけを
 * 本当に光る面（`MeshBasicMaterial`）にしてある。影の落ち方は失われるが、
 * 車内はもともとほぼ拡散光だけの空間なので釣り合いは取れる。
 */

/** 客室の割り付け。歩くモードの当たり判定もこの寸法を見る。 */
export interface CarLayout {
  /** 車体長の半分（妻面の位置） */
  readonly halfLength: number;
  /** 客室として歩ける前後の範囲（車体中心からの距離）[m] */
  readonly walkableFrom: number;
  readonly walkableTo: number;
  /** 側扉の中心（前後位置）。左右とも同じ位置にある。 */
  readonly doorCentres: readonly number[];
  /** 床面高さ（レール面上）[m] */
  readonly floorHeight: number;
  /** 運転室のある側（+1 = 前寄り / -1 = 後ろ寄り / 0 = 中間車） */
  readonly cabSide: -1 | 0 | 1;
}

/** 内装をシミュレーションの状態へ合わせるために渡す量 */
export interface InteriorUpdate {
  /** 側扉の開き具合 0（全閉）..1（全開） */
  readonly doorPosition: number;
  /** 吊り革の左右の振れ角 [rad]（正 = 右へ振られる） */
  readonly strapLateral: number;
  /** 吊り革の前後の振れ角 [rad]（正 = 前へ振られる＝制動中） */
  readonly strapLongitudinal: number;
  /** 立っている乗客の左右の傾き [rad]（正 = 右へ倒れる） */
  readonly standLateral: number;
  /** 立っている乗客の前後の傾き [rad]（正 = 前へ倒れる） */
  readonly standLongitudinal: number;
  /** 次の停車駅の駅名（案内表示器に出す） */
  readonly nextStation: string;
  /** 列車種別 */
  readonly kind: string;
  /** 行先 */
  readonly destination: string;
  /** まもなく到着か */
  readonly arriving: boolean;
}

export interface CarInterior {
  readonly group: THREE.Group;
  /**
   * 床の高さ（レール面上）[m]。歩くモードが足を置く面。
   * 車体の局所座標系での値なので、車体動揺はこの外側で掛かる。
   */
  readonly floorHeight: number;
  /** 客室として歩ける前後の範囲（車体中心からの距離）[m] */
  readonly walkableFrom: number;
  readonly walkableTo: number;
  /** 割り付け（当たり判定に使う） */
  readonly layout: CarLayout;
  /** 扉の開閉・吊り革の振れ・案内表示を毎フレーム合わせる */
  update(state: InteriorUpdate): void;
  /**
   * 編成の中での位置を教える。
   *
   * これを呼ぶまで車内に乗客はいない。`buildCarInterior` は `scene.ts` が
   * 呼ぶもので編成の何両目かを知らないが、乗客の座り方と車内の明るさは
   * **車ごとに違わなければならない**（全車が同じだと、貫通路ごしに同じ絵が
   * 並んで模型に見える）ので、後から教える形にしてある。
   *
   * @param index 先頭からの番号
   * @param loadFactor 混雑率（`sim.scenario.loadFactor`）
   */
  setPlacement(index: number, loadFactor: number): void;
}

// --- 色 -------------------------------------------------------------------
// 20m 級通勤形の車内は、白系の化粧板・灰色の床・青系のモケットという 3 色で
// できている。優先席だけ別の色にするのは、遠くからでも席の性格が分かるように
// するためで、実物も柄ではなく色で区別している。
const WALL_COLOR = 0xdcd7cb;
const CEILING_COLOR = 0xeceae4;
const FLOOR_COLOR = 0x827d73;
const DOORWAY_FLOOR_COLOR = 0x5d6b76;
const DOOR_COLOR = 0xd7dbdf;
const STAINLESS = 0xbcc2c8;
const SEAT_COLOR = 0x2f6b8a;
const SEAT_FLECK = 0x8fc0dc;
const PRIORITY_COLOR = 0x6e4a86;
const PRIORITY_FLECK = 0xb69ccc;
const STRAP_COLOR = 0xe7e8ea;
const PRIORITY_STRAP_COLOR = 0xe8a13c;
const LAMP_COLOR = 0xfff4e0;

/** 内壁の板厚（内張りそのものの厚み） */
const WALL_PANEL = 0.03;
/** 戸袋の内張りが通路側へ出ている量（開いた戸はこの奥に納まる） */
const POCKET_STEP = 0.0725;
/** 側扉 1 枚の厚さと、その中心の内壁からの奥まり */
const LEAF_THICKNESS = 0.03;
const LEAF_INSET = 0.045;

/**
 * 車内の明るさ。
 *
 * 客室は蛍光灯で照らされた閉じた箱だが、1 両に何本も光源を置くと描画が持たない。
 * 代わりに面そのものを自己発光させて「照らされている」状態を作る。発光色は
 * **その面の色に蛍光灯の色を掛けたもの**にしてある — 照り返しは反射率に比例
 * するので、白い天井は明るく光り、紺のモケットは暗いままになる。全部を同じ
 * 白で光らせると、座席まで白熱電球のように光ってしまう。
 *
 * この一手間が要るのは、シーンの環境光が**半球光**だからである。下を向いた面
 * （天井・荷棚の裏）は地面側の色（草の緑）を拾うので、放っておくと車内が
 * 緑がかる。実際の車内で天井が白く見えるのは蛍光灯が照らしているからで、
 * その光をここで足している。
 */
const CABIN_LIGHT = 1.5;
/** 蛍光灯の色（昼白色。純白より少しだけ暖かい） */
const LAMP_TINT = new THREE.Color(0xfff1dc);

function lit(
  color: number,
  roughness = 0.72,
  metalness = 0.04,
  glow = 0.14,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive: new THREE.Color(color).multiply(LAMP_TINT),
    emissiveIntensity: glow * CABIN_LIGHT,
  });
}

function textured(map: THREE.Texture, roughness = 0.75, glow = 0.13): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    roughness,
    metalness: 0.03,
    // 発光の分布は模様そのもの（`emissiveMap`）が持つので、色は蛍光灯の色でよい
    emissive: LAMP_TINT,
    emissiveIntensity: glow * CABIN_LIGHT,
    emissiveMap: map,
  });
}

/** 広告・標記のように「紙が貼ってある」面 */
function printed(map: THREE.Texture, glow = 0.16): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    roughness: 0.86,
    metalness: 0,
    emissive: LAMP_TINT,
    emissiveIntensity: glow * CABIN_LIGHT,
    emissiveMap: map,
  });
}

/**
 * 直方体（中心と大きさで置く。内装の板はほとんどこれで足りる）。
 *
 * `spacing` を渡すと、その間隔で面を分割する。**接地の陰を頂点色へ焼く
 * （`interiorShading.ts`）には、陰が濃くなるところに頂点が要る**ためで、
 * 1 枚の板を 8 頂点で作ってしまうと床際だけを暗くすることができない。
 * 分割は費用に直結するので、陰の出るところ（床・壁・天井・座席）にだけ渡す。
 */
function box(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  spacing?: readonly [number, number, number],
): THREE.BufferGeometry {
  const seg = (length: number, step: number | undefined): number =>
    step === undefined || step <= 0 ? 1 : Math.max(1, Math.min(48, Math.round(length / step)));
  const geometry = new THREE.BoxGeometry(
    size[0],
    size[1],
    size[2],
    seg(size[0], spacing?.[0]),
    seg(size[1], spacing?.[1]),
    seg(size[2], spacing?.[2]),
  );
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/** 円柱（手すり・パイプ用。`axis` の向きに寝かせる） */
function tube(
  radius: number,
  length: number,
  at: readonly [number, number, number],
  axis: 'x' | 'y' | 'z',
  segments = 8,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
  if (axis === 'x') geometry.rotateZ(Math.PI / 2);
  if (axis === 'z') geometry.rotateX(Math.PI / 2);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/**
 * 板 1 枚（法線が ±X / ±Y / ±Z を向く長方形）。
 * 広告・標記・窓ガラスのように「厚みを持たない面」に使う。
 */
function quad(
  width: number,
  height: number,
  at: readonly [number, number, number],
  facing: 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz',
  spacing?: readonly [number, number],
): THREE.BufferGeometry {
  const seg = (length: number, step: number | undefined): number =>
    step === undefined || step <= 0 ? 1 : Math.max(1, Math.min(96, Math.round(length / step)));
  const geometry = new THREE.PlaneGeometry(
    width,
    height,
    seg(width, spacing?.[0]),
    seg(height, spacing?.[1]),
  );
  switch (facing) {
    case 'px':
      geometry.rotateY(Math.PI / 2);
      break;
    case 'nx':
      geometry.rotateY(-Math.PI / 2);
      break;
    case 'py':
      geometry.rotateX(-Math.PI / 2);
      break;
    case 'ny':
      geometry.rotateX(Math.PI / 2);
      break;
    case 'nz':
      geometry.rotateY(Math.PI);
      break;
    case 'pz':
      break;
  }
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

/** まとめて 1 つのメッシュにする（描画呼び出しを減らす） */
function meshOf(
  parts: readonly THREE.BufferGeometry[],
  material: THREE.Material,
): THREE.Mesh | null {
  if (parts.length === 0) return null;
  return new THREE.Mesh(mergeGeometries(parts as THREE.BufferGeometry[], false)!, material);
}

/**
 * まとめて 1 つのメッシュにし、**接地の陰を頂点色へ焼く**。
 *
 * 焼く強さを面ごとに変えられるようにしてあるのは、同じ距離でも実物の暗くなり方が
 * 違うからである。床とけこみの奥は真っ暗になるが、白い天井は照り返しが回るので
 * それほど落ちない。
 */
function shadedMesh(
  parts: readonly THREE.BufferGeometry[],
  material: THREE.Material,
  field: OcclusionField,
  strength = 0.55,
): THREE.Mesh | null {
  if (parts.length === 0) return null;
  const geometry = mergeGeometries(parts as THREE.BufferGeometry[], false)!;
  field.bake(geometry, strength);
  return new THREE.Mesh(geometry, shadeWithVertexColor(material));
}

/** UV を実寸に合わせて引き伸ばす（模様の大きさを面の大小で変えないため） */
function scaleUv(geometry: THREE.BufferGeometry, u: number, v: number): void {
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
}

/**
 * 区間 `[from, to]` から `gaps` を取り除いた残り。
 *
 * 内壁は「開口以外のところ」に立つので、扉と窓の開口を引いた区間がそのまま
 * 壁になる。純粋な計算なので試験できる（`apps/debugger/test/interior.test.ts`）。
 */
export function subtractSpans(
  from: number,
  to: number,
  gaps: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const sorted = gaps
    .map((g) => [Math.min(g[0], g[1]), Math.max(g[0], g[1])] as [number, number])
    .filter((g) => g[1] > from && g[0] < to)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const [a, b] of sorted) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) out.push([cursor, to]);
  return out.filter(([a, b]) => b - a > 1e-4);
}

/**
 * 側扉の中心位置。**`vehicle.ts` と同じ式**でなければならない。
 * 片方だけ動かすと、内側の開口と外板のガラスがずれて穴が開く。
 */
function doorCentresOf(shift: number): number[] {
  return [-1.5, -0.5, 0.5, 1.5].map((k) => k * CAR.doorPitch + shift);
}

/** 客室の割り付けを決める（`vehicle.ts` の側面の割り付けと同じ手順） */
export function carLayout(spec: VehicleSpec, lead: boolean, front: boolean): CarLayout {
  const bodyLength = spec.length - (CAR.couplerLength - CAR.bodyLength);
  const half = bodyLength / 2;
  const cabEdge = lead ? (front ? half - CAR.cabLength : -half + CAR.cabLength) : null;
  const shift = cabEdge === null ? 0 : (front ? -1 : 1) * 0.55;
  const doorCentres = doorCentresOf(shift).filter(
    (x) =>
      Math.abs(x) + CAR.doorWidth / 2 < half - 0.6 &&
      (cabEdge === null ||
        (front ? x + CAR.doorWidth / 2 < cabEdge : x - CAR.doorWidth / 2 > cabEdge)),
  );
  return {
    halfLength: half,
    walkableFrom: cabEdge !== null && !front ? cabEdge : -half + INTERIOR.endWallInset,
    walkableTo: cabEdge !== null && front ? cabEdge : half - INTERIOR.endWallInset,
    doorCentres,
    floorHeight: CAR.floorHeight,
    cabSide: lead ? (front ? 1 : -1) : 0,
  };
}

/**
 * 側窓のガラス 1 枚ずつの前後位置。**`vehicle.ts` の `buildSides` と同じ式**。
 *
 * 扉と扉のあいだから戸袋ぶん（550mm）を除いた区間を、1 枚 1.5m を目安に割る。
 * 車端の短い区間には窓が入らない（実物も戸袋と妻面に挟まれて窓を取れない）。
 */
export function windowPanes(layout: CarLayout): Array<[number, number]> {
  const half = layout.halfLength;
  const cabEdge =
    layout.cabSide === 0 ? null : layout.cabSide > 0 ? half - CAR.cabLength : -half + CAR.cabLength;
  const edges: number[] = [
    -half + 0.35,
    ...layout.doorCentres.flatMap((x) => [x - CAR.doorWidth / 2, x + CAR.doorWidth / 2]),
    half - 0.35,
  ];
  const panes: Array<[number, number]> = [];
  for (let i = 0; i < edges.length; i += 2) {
    let a = edges[i]!;
    let b = edges[i + 1]!;
    if (cabEdge !== null) {
      if (layout.cabSide > 0) b = Math.min(b, cabEdge);
      else a = Math.max(a, cabEdge);
    }
    a += 0.55;
    b -= 0.55;
    if (b - a < 0.5) continue;
    const count = Math.max(1, Math.round((b - a) / 1.5));
    for (let k = 0; k < count; k++) {
      panes.push([a + ((b - a) * k) / count + 0.06, a + ((b - a) * (k + 1)) / count - 0.06]);
    }
  }
  return panes;
}

/** ロングシートを置ける区間（扉と扉のあいだ・扉と妻面のあいだ） */
export interface SeatBay {
  readonly from: number;
  readonly to: number;
  /** 優先席か（車端の 1 区画） */
  readonly priority: boolean;
}

export function seatBays(layout: CarLayout): SeatBay[] {
  const bounds: number[] = [layout.walkableFrom];
  for (const c of layout.doorCentres) {
    bounds.push(c - CAR.doorWidth / 2, c + CAR.doorWidth / 2);
  }
  bounds.push(layout.walkableTo);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < bounds.length; i += 2) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    // 2 人掛けに満たない区画は座席にしない（立って待つだけの空間になる）
    if (b - a >= 2 * INTERIOR.seatPitch + 2 * 0.15) spans.push([a, b]);
  }
  return spans.map(([from, to], i) => ({
    from,
    to,
    // 優先席は車端に置く。乗降の流れから外れていて、揺れも小さい位置である。
    priority: i === 0 || i === spans.length - 1,
  }));
}

/**
 * 客室を作っている「塊」を登録する。
 *
 * 接地の陰（`interiorShading.ts`）は**面ではなく塊**で決まる。座席が床を暗く
 * するのは座席が場所を占めているからで、座席の面がそこにあるからではない。
 * したがって、細かい造作は無視して、光を遮っている大きさだけを登録する。
 *
 * 登録した塊は「その塊自身の面」を暗くしない（表面に乗った頂点は数えない）
 * ので、実際の部品と同じ位置・同じ大きさで置いてよい。
 */
function registerOccluders(c: Ctx, field: OcclusionField): void {
  const from = c.layout.walkableFrom;
  const to = c.layout.walkableTo;
  const length = to - from;
  const mid = (from + to) / 2;

  // 床（この上に立つものが床を暗くする。床そのものは自分では暗くならない）
  field.add([mid, c.floor - 0.03, 0], [length, 0.06, INTERIOR.width], 1.0, 0.26);
  // 天井（見上げる面の取り合いを暗くする）
  field.add([mid, c.ceiling + 0.04, 0], [length, 0.08, INTERIOR.ceilingFlatWidth], 0.7, 0.3);

  for (const side of [-1, 1] as const) {
    // 側の内壁（腰から上）。床際・座席の裏を暗くする。
    field.add(
      [mid, (c.floor + c.doorTop) / 2, side * (c.inner - 0.015)],
      [length, c.doorTop - c.floor, 0.03],
      1.0,
      0.26,
    );
    // 肩（天井の斜面）。荷棚の上を暗くする。
    field.add(
      [mid, (c.ceilingSide + c.ceiling) / 2, side * (c.inner - 0.12)],
      [length, c.ceiling - c.ceilingSide, 0.24],
      0.6,
      0.24,
    );

    for (const bay of c.bays) {
      const width = bay.to - bay.from;
      if (width < INTERIOR.seatPitch) continue;
      // 座席の塊（けこみの前面から壁まで、床から背ずりの上端まで）。
      // これが床に落とす陰が、座席が「置いてある」ことを決める。
      const seatTop = c.floor + INTERIOR.seatBackHeight;
      field.add(
        [(bay.from + bay.to) / 2, (c.floor + seatTop) / 2, side * (c.inner - INTERIOR.seatDepth / 2)], // prettier-ignore
        [width, seatTop - c.floor, INTERIOR.seatDepth],
        1.15,
        0.24,
      );
      // 座面のひさし（けこみが奥まっているぶん、その下は深い陰になる）
      field.add(
        [(bay.from + bay.to) / 2, c.floor + INTERIOR.seatHeight - 0.02, side * (c.inner - INTERIOR.seatDepth / 2)], // prettier-ignore
        [width, 0.06, INTERIOR.seatDepth],
        0.9,
        0.16,
      );
      // 袖仕切り（座席の端に立つ板。根元が暗くなる）
      for (const end of [bay.from, bay.to]) {
        field.add(
          [end, c.floor + INTERIOR.armPartitionHeight / 2, side * (c.inner - INTERIOR.armPartitionDepth / 2)], // prettier-ignore
          [INTERIOR.armPartitionThickness + 0.04, INTERIOR.armPartitionHeight, INTERIOR.armPartitionDepth], // prettier-ignore
          1.0,
          0.2,
        );
      }
      // 荷棚（下は必ず暗い。実物でも荷棚の下の広告が読みにくいのはこのため）
      field.add(
        [(bay.from + bay.to) / 2, c.floor + INTERIOR.rackHeight + 0.02, side * (c.inner - INTERIOR.rackDepth / 2)], // prettier-ignore
        [width, 0.05, INTERIOR.rackDepth],
        1.0,
        0.22,
      );
      // 吊り革棒（天井との取り合いに細い陰が落ちる）
      field.add(
        [(bay.from + bay.to) / 2, c.floor + INTERIOR.strapBarHeight, side * INTERIOR.strapBarOffset],
        [width, INTERIOR.strapBarDiameter, INTERIOR.strapBarDiameter],
        0.5,
        0.12,
      );
    }

    // 戸袋の内張り（通路側へ出ているので、その脇に段の陰ができる）
    for (const [a, b] of c.pockets) {
      field.add(
        [(a + b) / 2, (c.floor + c.doorTop) / 2, side * (c.inner - POCKET_STEP / 2)],
        [b - a, c.doorTop - c.floor, POCKET_STEP],
        0.55,
        0.14,
      );
    }
    // 扉の縦手すり（根元が暗くなる）
    for (const centre of c.layout.doorCentres) {
      for (const dx of [-1, 1] as const) {
        field.add(
          [centre + dx * (CAR.doorWidth / 2 + 0.085), (c.floor + c.doorTop) / 2, side * (c.inner - 0.14)], // prettier-ignore
          [INTERIOR.poleDiameter, c.doorTop - c.floor, INTERIOR.poleDiameter],
          0.5,
          0.12,
        );
      }
    }
  }

  // 妻面（車端の壁）。貫通路の脇が暗くなる。
  for (const end of [-1, 1] as const) {
    const x = end > 0 ? to : from;
    field.add(
      [x + end * 0.05, (c.floor + c.ceiling) / 2, 0],
      [0.1, c.ceiling - c.floor, INTERIOR.width],
      0.9,
      0.26,
    );
  }
}

/** 戸袋（開いた扉が納まる部分）の区間 */
function pocketSpansOf(layout: CarLayout): Array<[number, number]> {
  return layout.doorCentres.flatMap(
    (c) =>
      [
        [c - CAR.doorWidth / 2 - INTERIOR.doorPocketWidth, c - CAR.doorWidth / 2],
        [c + CAR.doorWidth / 2, c + CAR.doorWidth / 2 + INTERIOR.doorPocketWidth],
      ] as Array<[number, number]>,
  );
}

/**
 * 1 両ぶんの内装を組み立てる。
 *
 * @param spec 車両仕様（長さをここから取る）
 * @param lead 先頭車（運転室の仕切りが客室の端になる）
 * @param front 編成の前を向いているか（運転室が前寄りか後ろ寄りか）
 */
export function buildCarInterior(spec: VehicleSpec, lead: boolean, front: boolean): CarInterior {
  const layout = carLayout(spec, lead, front);
  const group = new THREE.Group();

  const floor = layout.floorHeight;
  const inner = INTERIOR.width / 2;
  const ceiling = floor + INTERIOR.ceilingHeight;
  const ceilingSide = floor + INTERIOR.ceilingSideHeight;
  const doorTop = floor + CAR.doorHeight;
  const windowBottom = floor + CAR.windowSill;
  const windowTop = windowBottom + CAR.windowHeight;
  const bays = seatBays(layout);
  const pockets = pocketSpansOf(layout);
  const doorSpans: Array<[number, number]> = layout.doorCentres.map((c) => [
    c - CAR.doorWidth / 2,
    c + CAR.doorWidth / 2,
  ]);

  /**
   * 内側から見た窓の開口。戸袋の内張りに隠れるぶんだけ外板のガラスより狭い。
   * 狭いのは構わないが、**広くしてはいけない**（外板のガラスからはみ出た部分が
   * そのまま外への穴になる）。
   */
  const openings: Array<[number, number]> = [];
  for (const [a, b] of windowPanes(layout)) {
    let from = a;
    let to = b;
    for (const [pa, pb] of pockets) {
      if (pb > from && pb < to) from = pb;
      if (pa < to && pa > from) to = pa;
    }
    if (to - from > 0.1) openings.push([from, to]);
  }

  const field = new OcclusionField();
  const ctx: Ctx = {
    layout,
    floor,
    inner,
    ceiling,
    ceilingSide,
    doorTop,
    windowBottom,
    windowTop,
    bays,
    pockets,
    doorSpans,
    openings,
    field,
  };
  // 塊を先にすべて登録してから面を組む。組みながら登録すると、先に組んだ面が
  // 後から置かれた塊の陰を受け取れない。
  registerOccluders(ctx, field);

  group.add(buildFloor(ctx));
  group.add(buildSideWalls(ctx));
  group.add(buildWindowTrim(ctx));
  group.add(buildCeiling(ctx));
  group.add(buildRacks(ctx));
  group.add(buildSeats(ctx));
  group.add(buildStanchions(ctx));
  group.add(buildEndWalls(ctx));
  group.add(buildAds(ctx));
  group.add(buildEquipment(ctx));

  const doors = buildDoors(ctx);
  group.add(doors.group);
  const straps = buildStraps(ctx);
  group.add(straps.group);

  const lighting = collectLighting(group);
  let passengers: CarPassengers | null = null;

  return {
    group,
    floorHeight: floor,
    walkableFrom: layout.walkableFrom,
    walkableTo: layout.walkableTo,
    layout,
    update(state: InteriorUpdate): void {
      doors.update(state.doorPosition);
      straps.update(state.strapLateral, state.strapLongitudinal);
      passengers?.update(state.standLateral, state.standLongitudinal);
      for (const display of doors.displays) {
        display.update(state.nextStation, state.kind, state.destination, state.arriving);
      }
    },
    setPlacement(index: number, loadFactor: number): void {
      if (passengers) group.remove(passengers.group);
      passengers = buildPassengers(layout, bays, index, loadFactor);
      group.add(passengers.group);
      const brightness = CAR_BRIGHTNESS[index % CAR_BRIGHTNESS.length]!;
      lighting.setBrightness(brightness);
      passengers.setBrightness(brightness);
    },
  };
}

/**
 * 車ごとの明るさ。
 *
 * **1 両ごとに別の照明で照らされている**ので、実物でも隣の車は明るさが少し違う
 * （蛍光灯の経年と本数、そのときの負荷で変わる）。全車を同じ明るさにすると、
 * 貫通路の先が手前と同じ調子になって奥行きが読めない——1 周目の絵で貫通路の先が
 * 白く潰れて見えたのはこれが理由である。
 *
 * 走行のたびに変わっては困るので、乱数ではなく編成の位置で決める。
 */
const CAR_BRIGHTNESS = [1.0, 0.86, 1.06, 0.78, 0.94, 1.02];

/**
 * 車内の面の明るさをまとめて動かせるようにする。
 *
 * 面そのものを自己発光させて照明の代わりにしているので（`lit()`）、明るさを
 * 変えるとは `emissiveIntensity` を変えることである。照明のカバーだけは
 * 自ら光る面（`MeshBasicMaterial`）なので、そちらは色を直接動かす。
 */
function collectLighting(root: THREE.Object3D): { setBrightness(k: number): void } {
  const standard: Array<{ material: THREE.MeshStandardMaterial; base: number }> = [];
  const basic: Array<{ material: THREE.MeshBasicMaterial; base: THREE.Color }> = [];
  const seen = new Set<THREE.Material>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(material)) continue;
      seen.add(material);
      if (material instanceof THREE.MeshStandardMaterial) {
        standard.push({ material, base: material.emissiveIntensity });
      } else if (material instanceof THREE.MeshBasicMaterial) {
        basic.push({ material, base: material.color.clone() });
      }
    }
  });
  return {
    setBrightness(k: number): void {
      for (const entry of standard) entry.material.emissiveIntensity = entry.base * k;
      // カバーの光り方は明るさの差ほどは変わらない（飽和して白く見えるため）
      for (const entry of basic) {
        entry.material.color.copy(entry.base).multiplyScalar(0.75 + 0.25 * k);
      }
    },
  };
}

/** 組み立ての各段が共通に使う寸法一式 */
interface Ctx {
  readonly layout: CarLayout;
  readonly floor: number;
  readonly inner: number;
  readonly ceiling: number;
  readonly ceilingSide: number;
  readonly doorTop: number;
  readonly windowBottom: number;
  readonly windowTop: number;
  readonly bays: readonly SeatBay[];
  readonly pockets: ReadonlyArray<[number, number]>;
  readonly doorSpans: ReadonlyArray<[number, number]>;
  readonly openings: ReadonlyArray<[number, number]>;
  /** 接地の陰を焼くための「塊」の一覧 */
  readonly field: OcclusionField;
}

/**
 * 床。
 *
 * 通勤形の床は塩化ビニルの長尺シートで、**扉の前だけ色を変えて**乗降位置を
 * 示す。歩いているとこの色分けが「次の扉まであとどれくらいか」の目安になる。
 */
function buildFloor(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const from = c.layout.walkableFrom - 0.02;
  const to = c.layout.walkableTo + 0.02;
  // 頂点の割りは左右を細かく取る。陰も磨り減りも**左右方向に変わる**（座席の
  // 下が暗く、通路の中央が薄い）ので、前後は粗くてよい。
  const sheet = quad(to - from, INTERIOR.width, [(from + to) / 2, c.floor, 0], 'py', [0.5, 0.09]);
  // 模様は 1.2m 角で 1 枚。車両の長短で柄の大きさが変わらないよう実寸で割る。
  scaleUv(sheet, (to - from) / 1.2, INTERIOR.width / 1.2);
  c.field.bake(sheet, 0.76);
  /**
   * 通路の中央だけ色が薄い。
   *
   * 塩ビ長尺シートは何万人にも踏まれて表面の艶と色が落ちる。落ちるのは
   * **人が歩くところだけ**なので、実物の通勤形の床は通路の中央が白茶けて、
   * 座席の下と戸袋の隅に元の色が残っている。この差は床の模様よりも
   * 「使われている車」に見せる力が強い。
   */
  tintVertices(sheet, (_x, _y, z) => 1 + 0.13 * Math.exp(-((z / 0.62) ** 2)));
  g.add(
    new THREE.Mesh(
      sheet,
      shadeWithVertexColor(textured(floorSheetTexture(FLOOR_COLOR, 11), 0.92, 0.1)),
    ),
  );

  /**
   * シートの継ぎ目。
   *
   * 長尺シートは幅 1820mm の巻き物なので、20m の車では**車体を横切る継ぎ目**が
   * 1.8m ごとに並ぶ。溶接棒で埋めた線が細く残り、床が単なる 1 枚の面ではない
   * ことを目に伝える。
   */
  const seams: THREE.BufferGeometry[] = [];
  for (let x = from + 0.9; x < to; x += 1.82) {
    seams.push(quad(0.012, INTERIOR.width, [x, c.floor + 0.002, 0], 'py'));
  }
  const seamMesh = meshOf(seams, lit(0x6a665e, 0.95, 0.02, 0.08));
  if (seamMesh) g.add(seamMesh);

  const zones: THREE.BufferGeometry[] = [];
  const edges: THREE.BufferGeometry[] = [];
  const sills: THREE.BufferGeometry[] = [];
  for (const centre of c.layout.doorCentres) {
    // 乗降位置の色分けは扉幅より少し広く取る（実物も戸口の前を広めに塗る）
    const zoneWidth = CAR.doorWidth + 0.3;
    zones.push(quad(zoneWidth, 0.95, [centre, c.floor + 0.004, 0], 'py', [0.4, 0.09]));
    // 色分けの縁。実物は別の色のシートを溶接して継ぐので、境目に細い線が出る。
    for (const dx of [-1, 1] as const) {
      edges.push(quad(0.02, 0.95, [centre + dx * zoneWidth * 0.5, c.floor + 0.006, 0], 'py'));
    }
    // 敷居（ドアレール）。ステンレスの細い帯で、踏むとよく分かる
    for (const side of [-1, 1] as const) {
      sills.push(
        box(
          [CAR.doorWidth + 0.1, 0.014, INTERIOR.doorSillWidth],
          [centre, c.floor + 0.007, side * (c.inner - LEAF_INSET)],
        ),
      );
    }
  }
  const zoneMesh = shadedMesh(zones, lit(DOORWAY_FLOOR_COLOR, 0.85, 0.05, 0.12), c.field, 0.76);
  const edgeMesh = meshOf(edges, lit(0x3d4750, 0.9, 0.02, 0.08));
  const sillMesh = meshOf(sills, lit(STAINLESS, 0.32, 0.75, 0.1));
  for (const mesh of [zoneMesh, edgeMesh, sillMesh]) if (mesh) g.add(mesh);
  return g;
}

/**
 * 側の内壁。
 *
 * 窓と扉の開口を除いた残りを帯状に埋める。腰板（窓の下）・幕板（窓の上）・
 * 戸袋の内張りが同じ面に並ぶが、戸袋だけは扉が納まるぶん通路側へ出ている。
 * この段差は実物にもあり、扉が壁より奥まって見える理由でもある。
 */
function buildSideWalls(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const pocketParts: THREE.BufferGeometry[] = [];
  const from = c.layout.walkableFrom;
  const to = c.layout.walkableTo;

  for (const side of [-1, 1] as const) {
    const z = side * (c.inner - WALL_PANEL / 2);
    const band = (a: number, b: number, y0: number, y1: number): void => {
      if (b - a < 1e-4 || y1 - y0 < 1e-4) return;
      // 上下を細かく割る（床際と荷棚の下の陰がここに乗る）
      parts.push(box([b - a, y1 - y0, WALL_PANEL], [(a + b) / 2, (y0 + y1) / 2, z], [0.6, 0.1, 0])); // prettier-ignore
    };
    // 腰板（床から窓の下端まで）— 扉の開口だけ抜く
    for (const [a, b] of subtractSpans(from, to, c.doorSpans)) {
      band(a, b, c.floor, c.windowBottom);
    }
    // 窓の帯 — 窓と扉の両方を抜く
    for (const [a, b] of subtractSpans(from, to, [...c.doorSpans, ...c.openings])) {
      band(a, b, c.windowBottom, c.windowTop);
    }
    // 窓の上から鴨居まで — 扉の開口だけ抜く
    for (const [a, b] of subtractSpans(from, to, c.doorSpans)) {
      band(a, b, c.windowTop, c.doorTop);
    }
    // 鴨居から肩まで — 扉の上も塞ぐ
    band(from, to, c.doorTop, c.ceilingSide);
    // 戸袋の内張り
    for (const [a, b] of c.pockets) {
      pocketParts.push(
        box(
          [b - a, c.doorTop - c.floor, 0.015],
          [(a + b) / 2, (c.floor + c.doorTop) / 2, side * (c.inner - POCKET_STEP)],
          [0.3, 0.12, 0],
        ),
      );
    }
  }
  const wall = shadedMesh(parts, textured(panelTexture(WALL_COLOR, 3), 0.78, 0.12), c.field, 0.68);
  const pocket = shadedMesh(pocketParts, lit(0xd2cfc7, 0.62, 0.12, 0.12), c.field, 0.68);
  for (const mesh of [wall, pocket]) if (mesh) g.add(mesh);
  return g;
}

/**
 * 窓まわりの造作。
 *
 * 窓の桟（開口の縁）と窓台、それに日除け。日除けは実物と同じく巻き上げ式で、
 * 上端に巻き取り箱があり、下ろした量だけ窓を覆う。何枚かだけ下ろしておくと
 * 「誰かが乗っていた車内」に見える。
 */
function buildWindowTrim(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const frame: THREE.BufferGeometry[] = [];
  const sill: THREE.BufferGeometry[] = [];
  const blinds: THREE.BufferGeometry[] = [];
  const height = c.windowTop - c.windowBottom;
  const mid = (c.windowBottom + c.windowTop) / 2;
  for (const side of [-1, 1] as const) {
    const z = side * (c.inner - 0.035);
    for (let i = 0; i < c.openings.length; i++) {
      const [a, b] = c.openings[i]!;
      // 桟（開口を一周する細い枠）
      frame.push(box([b - a + 0.06, 0.03, 0.06], [(a + b) / 2, c.windowBottom - 0.015, z]));
      frame.push(box([b - a + 0.06, 0.03, 0.06], [(a + b) / 2, c.windowTop + 0.015, z]));
      frame.push(box([0.03, height, 0.06], [a - 0.015, mid, z]));
      frame.push(box([0.03, height, 0.06], [b + 0.015, mid, z]));
      // 窓台（腰掛けたり物を置いたりする棚）
      sill.push(
        box([b - a + 0.12, 0.025, 0.08], [(a + b) / 2, c.windowBottom - 0.042, side * (c.inner - 0.05)]), // prettier-ignore
      );
      // 日除けの巻き取り箱
      blinds.push(box([b - a + 0.07, 0.055, 0.05], [(a + b) / 2, c.windowTop + 0.055, z]));
      // 何枚かだけ下ろしておく。位置で決めているので走行のたびに変わることはない
      // （決定論を壊さない）。
      const drop = [0, 0.34, 0, 0.55, 0.2, 0][(i + (side > 0 ? 1 : 0)) % 6] ?? 0;
      if (drop > 0) {
        blinds.push(box([b - a, drop, 0.012], [(a + b) / 2, c.windowTop - drop / 2, z - side * 0.012])); // prettier-ignore
      }
    }
  }
  const frameMesh = shadedMesh(frame, lit(0xa9aeb4, 0.55, 0.4, 0.12), c.field, 0.5);
  const sillMesh = shadedMesh(sill, lit(0xc8ccd0, 0.5, 0.35, 0.13), c.field, 0.5);
  const blindMesh = shadedMesh(blinds, lit(0xcfc6ad, 0.85, 0.02, 0.1), c.field, 0.5);
  for (const mesh of [frameMesh, sillMesh, blindMesh]) if (mesh) g.add(mesh);
  return g;
}

/**
 * 天井。
 *
 * 中央の平天井（幅 1600mm）と、そこから肩へ下がる傾いた面でできている。
 * 平天井には冷房の吹き出し口・ラインデリア（横流ファン）・照明のカバーが
 * 前後いっぱいに走る。実物の通勤形で天井を見上げると、この筋が車端まで
 * 通って見える。
 */
function buildCeiling(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const from = c.layout.walkableFrom;
  const to = c.layout.walkableTo;
  const flat = INTERIOR.ceilingFlatWidth / 2;
  const panels: THREE.BufferGeometry[] = [];
  panels.push(quad(to - from, flat * 2, [(from + to) / 2, c.ceiling, 0], 'ny', [0.8, 0.2]));

  // 肩の斜面（平天井の縁から側の天井へ）。水平な面を分割して作ってから、外側の
  // 縁だけを下げて傾ける。4 点で張ると接地の陰を乗せる頂点が無く、荷棚の上や
  // 妻面との取り合いが暗くならない（＝天井が 1 枚の白い紙に見える）。
  for (const side of [-1, 1] as const) {
    const z0 = side * flat;
    const z1 = side * c.inner;
    const face = quad(to - from, Math.abs(z1 - z0), [(from + to) / 2, c.ceiling, (z0 + z1) / 2], 'ny', [0.8, 0.06]); // prettier-ignore
    const position = face.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const t = Math.abs(position.getZ(i) - z0) / Math.abs(z1 - z0);
      position.setY(i, c.ceiling + (c.ceilingSide - c.ceiling) * t);
    }
    position.needsUpdate = true;
    face.computeVertexNormals();
    panels.push(face);
  }
  const panelMesh = shadedMesh(panels, lit(CEILING_COLOR, 0.8, 0.02, 0.17), c.field, 0.45);
  if (panelMesh) g.add(panelMesh);

  // 照明（カバー付きの蛍光灯 2 列）。自ら光る面なので陰影を持たせない。
  const lamps: THREE.BufferGeometry[] = [];
  const step = 1.6;
  for (const side of [-1, 1] as const) {
    for (let x = from + 0.5; x < to - 0.4; x += step) {
      const len = Math.min(step - 0.22, to - 0.4 - x);
      if (len < 0.3) continue;
      lamps.push(
        box([len, 0.05, INTERIOR.lightWidth], [x + len / 2, c.ceiling - 0.028, side * INTERIOR.lightOffset]), // prettier-ignore
      );
    }
  }
  const lampMesh = meshOf(lamps, new THREE.MeshBasicMaterial({ color: LAMP_COLOR }));
  if (lampMesh) lampMesh.renderOrder = 1;
  if (lampMesh) g.add(lampMesh);

  // 冷房の吹き出し口（中央）とラインデリア（その外側）
  const ducts: THREE.BufferGeometry[] = [];
  ducts.push(box([to - from - 0.6, 0.05, INTERIOR.coolerDuctWidth], [(from + to) / 2, c.ceiling - 0.025, 0])); // prettier-ignore
  for (const side of [-1, 1] as const) {
    ducts.push(
      box([to - from - 0.9, 0.045, INTERIOR.lineFlowWidth], [(from + to) / 2, c.ceiling - 0.022, side * INTERIOR.lineFlowOffset]), // prettier-ignore
    );
  }
  const ductMesh = meshOf(ducts, lit(0xc6cbd0, 0.6, 0.3, 0.08));
  if (ductMesh) g.add(ductMesh);

  // 吹き出しの羽根。天井を見上げたときに「面」ではなく「装置」に見えるかは
  // ここで決まる。ただし通路から見上げると天井いっぱいに並ぶので、
  // 太くすると天井が黒い櫛に見えてしまう — 実物どおり薄く細かく刻む。
  const louvres: THREE.BufferGeometry[] = [];
  for (let x = from + 0.4; x < to - 0.4; x += 0.12) {
    louvres.push(box([0.02, 0.014, INTERIOR.coolerDuctWidth - 0.05], [x, c.ceiling - 0.05, 0]));
    for (const side of [-1, 1] as const) {
      louvres.push(
        box([0.02, 0.012, INTERIOR.lineFlowWidth - 0.04], [x, c.ceiling - 0.045, side * INTERIOR.lineFlowOffset]), // prettier-ignore
      );
    }
  }
  const louvreMesh = meshOf(louvres, lit(0xa7adb3, 0.7, 0.2, 0.06));
  if (louvreMesh) g.add(louvreMesh);
  return g;
}

/**
 * 荷棚（網棚）。
 *
 * ステンレスのパイプを格子に組んだもので、**下から見ると向こうが透ける**。
 * 板で作ると天井が低く見えるので、抜けのあるテクスチャで格子を作る。
 * 上には置き忘れられた荷物をいくつか載せる。
 */
function buildRacks(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const y = c.floor + INTERIOR.rackHeight;
  const depth = INTERIOR.rackDepth;
  const tubes: THREE.BufferGeometry[] = [];
  const nets: THREE.BufferGeometry[] = [];
  const bags: THREE.BufferGeometry[] = [];
  const brackets: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < c.bays.length; i++) {
      const bay = c.bays[i]!;
      const a = bay.from + 0.05;
      const b = bay.to - 0.05;
      if (b - a < 0.5) continue;
      const aisleZ = side * (c.inner - depth);
      const wallZ = side * (c.inner - 0.05);
      // 通路側の縁パイプ。**荷棚がいちばん太く見えるのはここ**で、下から
      // 見上げたときに荷棚の位置を決めているのはこの 1 本である。細くすると
      // 荷棚全体が白い線画に見えてしまう。
      tubes.push(
        tube(INTERIOR.rackTubeDiameter / 2, b - a, [(a + b) / 2, y + INTERIOR.rackLip, aisleZ], 'x', 10), // prettier-ignore
      );
      // 縁パイプを支える立ち上がり（縁は網より高い位置にある）
      tubes.push(tube(INTERIOR.rackTubeDiameter / 2, b - a, [(a + b) / 2, y + 0.006, aisleZ], 'x', 10)); // prettier-ignore
      // 壁側の縁（網の奥の端。ここも 1 本の丸棒で受ける）
      tubes.push(tube(0.011, b - a, [(a + b) / 2, y, wallZ], 'x', 6));
      // 受け（壁から通路側の縁パイプへ渡す腕）。実物は 700mm ほどの間隔で入る。
      const supports = Math.max(2, Math.round((b - a) / 0.7) + 1);
      for (let k = 0; k < supports; k++) {
        const x = a + ((b - a) * k) / (supports - 1);
        tubes.push(tube(0.011, depth, [x, y + INTERIOR.rackLip / 2, side * (c.inner - depth / 2)], 'z', 6)); // prettier-ignore
        // 壁への取り付け金具。板 1 枚ぶんの厚みがあり、根元に陰が落ちる。
        brackets.push(box([0.05, 0.09, 0.055], [x, y + 0.02, side * (c.inner - 0.045)]));
      }
      // 網（上向きの面。下から見上げると格子越しに天井が見える）
      nets.push(quad(b - a, depth - 0.02, [(a + b) / 2, y, side * (c.inner - depth / 2)], 'py'));
      // 置かれた荷物（決まった位置に置く。走行のたびに変わっては困る）
      if ((i + (side > 0 ? 1 : 0)) % 3 === 0) {
        bags.push(box([0.46, 0.24, 0.26], [(a + b) / 2 + 0.2, y + 0.13, side * (c.inner - depth / 2)])); // prettier-ignore
      }
    }
  }
  const tubeMesh = shadedMesh(tubes, lit(STAINLESS, 0.32, 0.72, 0.12), c.field, 0.45);
  const bracketMesh = shadedMesh(brackets, lit(0x9aa0a6, 0.45, 0.5, 0.1), c.field, 0.5);
  const netGeometry = nets.length > 0 ? mergeGeometries(nets, false) : null;
  const netMesh = netGeometry
    ? new THREE.Mesh(
        netGeometry,
        new THREE.MeshStandardMaterial({
          map: rackMeshTexture(),
          transparent: true,
          alphaTest: 0.45,
          roughness: 0.4,
          metalness: 0.55,
          side: THREE.DoubleSide,
        }),
      )
    : null;
  const bagMesh = shadedMesh(bags, lit(0x4a4740, 0.85, 0.03, 0.12), c.field, 0.5);
  for (const mesh of [tubeMesh, bracketMesh, netMesh, bagMesh]) if (mesh) g.add(mesh);
  return g;
}

/**
 * ロングシート。
 *
 * 座面 430mm・奥行き 430mm と浅く、背ずりは 12 度倒れている。座席の下は
 * けこみ板で塞がれ、その中に電気暖房器（ヒーター）が入っている。冬の車内で
 * 足元が暖かいのはここからで、けこみ板にスリットが並ぶ。
 *
 * 1 人ぶんの掛け幅は 460mm。実物はモケットの縫い目とバケット状の凹みで
 * 座り分けを示すので、ここでも 460mm ごとに縫い目を入れる。
 */
function buildSeats(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const seatY = c.floor + INTERIOR.seatHeight;
  const backTop = c.floor + INTERIOR.seatBackHeight;
  const backHeight = backTop - seatY;

  const cushions: THREE.BufferGeometry[] = [];
  const priorityCushions: THREE.BufferGeometry[] = [];
  const frames: THREE.BufferGeometry[] = [];
  const kick: THREE.BufferGeometry[] = [];
  const heaters: THREE.BufferGeometry[] = [];
  const partitions: THREE.BufferGeometry[] = [];
  const partitionGlass: THREE.BufferGeometry[] = [];
  const poles: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1] as const) {
    for (const bay of c.bays) {
      const a = bay.from + INTERIOR.armPartitionThickness + 0.09;
      const b = bay.to - INTERIOR.armPartitionThickness - 0.09;
      const width = b - a;
      if (width < INTERIOR.seatPitch) continue;
      const target = bay.priority ? priorityCushions : cushions;

      // **1 人ぶんずつ**の座ぶとんと背ずりに割る。実物のバケットシートは
      // 460mm ごとに凹みと縫い目で座り分けを示しているので、1 枚の長い板に
      // すると「ベンチ」に見えてしまう。割れ目から奥の暗い座席枠がのぞくのが、
      // 遠目にも 7 人掛けと分かる理由でもある。
      const seats = Math.max(1, Math.round(width / INTERIOR.seatPitch));
      const pitch = width / seats;
      // 座席枠。割れ目の**奥**にだけ薄く入れる（座ぶとんを包んでしまうと
      // 座席そのものが枠に埋もれて見えなくなる）。暗い色にしておくと、
      // 1 人ぶんごとの割れ目がそのまま影の線として読める。
      frames.push(
        box([width, backHeight + INTERIOR.seatCushion, 0.05], [(a + b) / 2, seatY + backHeight / 2 - INTERIOR.seatCushion / 2, side * (c.inner - 0.025)]), // prettier-ignore
      );
      for (let k = 0; k < seats; k++) {
        const cx = a + pitch * (k + 0.5);
        const w = pitch - 0.022;
        // 座面
        target.push(
          box([w, INTERIOR.seatCushion, INTERIOR.seatDepth], [cx, seatY - INTERIOR.seatCushion / 2, side * (c.inner - INTERIOR.seatDepth / 2)], [0.1, 0.03, 0.07]), // prettier-ignore
        );
        // 背ずり（12 度後ろへ倒す）。座面とのあいだに 25mm の切れ目を空けて
        // 奥の暗い座席枠を覗かせる。実物にもこの隙間があり、**座面と背ずりの
        // 境目はここに落ちる影で読んでいる**（同じモケットなので色では分からない）。
        const gap = 0.025;
        const back = box([w, backHeight - gap, 0.09], [0, 0, 0], [0.1, 0.06, 0.05]);
        back.rotateX(-side * INTERIOR.seatBackTilt);
        back.translate(
          cx,
          seatY + gap + (backHeight - gap) / 2,
          side * (c.inner - 0.05 - ((backHeight - gap) / 2) * Math.tan(INTERIOR.seatBackTilt)),
        );
        target.push(back);
      }

      // けこみ（座席下の板）とヒーターのスリット
      const kickZ = side * (c.inner - INTERIOR.seatDepth + INTERIOR.seatToeSpace);
      kick.push(
        box([width + 0.18, seatY - INTERIOR.seatCushion - c.floor, 0.03], [(a + b) / 2, (c.floor + seatY - INTERIOR.seatCushion) / 2, kickZ], [0.4, 0.05, 0]), // prettier-ignore
      );
      for (let hx = a + 0.03; hx < b - 0.03; hx += 0.065) {
        heaters.push(
          box([0.04, INTERIOR.heaterHeight * 0.55, 0.012], [hx, c.floor + INTERIOR.heaterHeight * 0.6, kickZ - side * 0.018]), // prettier-ignore
        );
      }

      // 袖仕切り（座席の端の大きな板）。立客が座っている人へ寄りかからない
      // ようにするためのもので、近年の通勤形では肩の高さまで立ち上げてある。
      // ただし全面を板にすると車内が細かく仕切られて見えるので、実物と同じく
      // **腰から上を曇りガラス**にしてある（座っている人の頭上に光が回る）。
      for (const end of [bay.from, bay.to]) {
        const inward = end === bay.from ? 1 : -1;
        const px = end + inward * (INTERIOR.armPartitionThickness / 2 + 0.02);
        const solidTop = c.floor + INTERIOR.seatBackHeight + 0.12;
        partitions.push(
          box([INTERIOR.armPartitionThickness, solidTop - c.floor, INTERIOR.armPartitionDepth], // prettier-ignore
            [px, (c.floor + solidTop) / 2, side * (c.inner - INTERIOR.armPartitionDepth / 2)], [0, 0.07, 0.08]), // prettier-ignore
        );
        // 曇りガラスの上半分（枠は下の板と同じ色）
        const glassTop = c.floor + INTERIOR.armPartitionHeight;
        partitionGlass.push(
          box([INTERIOR.armPartitionThickness * 0.6, glassTop - solidTop - 0.04, INTERIOR.armPartitionDepth - 0.08], // prettier-ignore
            [px, (solidTop + glassTop - 0.04) / 2, side * (c.inner - INTERIOR.armPartitionDepth / 2 - 0.02)]), // prettier-ignore
        );
        partitions.push(
          box([INTERIOR.armPartitionThickness, 0.04, INTERIOR.armPartitionDepth], [px, glassTop - 0.02, side * (c.inner - INTERIOR.armPartitionDepth / 2)]), // prettier-ignore
        );
        // 袖仕切りの通路側に立つ縦手すり（つかまりながら座る／立つための棒）
        poles.push(
          tube(INTERIOR.poleDiameter / 2, INTERIOR.armPartitionHeight - 0.02, [px, c.floor + INTERIOR.armPartitionHeight / 2, side * (c.inner - INTERIOR.armPartitionDepth - 0.012)], 'y'), // prettier-ignore
        );
      }
    }
  }

  const seatMaterial = textured(moquetteTexture(SEAT_COLOR, SEAT_FLECK, 7), 0.95, 0.2);
  const priorityMaterial = textured(moquetteTexture(PRIORITY_COLOR, PRIORITY_FLECK, 23), 0.95, 0.2);
  const meshes = [
    shadedMesh(cushions, seatMaterial, c.field, 0.68),
    shadedMesh(priorityCushions, priorityMaterial, c.field, 0.68),
    meshOf(frames, lit(0x2b3138, 0.85, 0.1, 0.04)),
    // けこみは座面のひさしの下に入るので、いちばん深い陰が落ちる
    shadedMesh(kick, lit(0xbfc3c8, 0.6, 0.3, 0.12), c.field, 0.88),
    meshOf(heaters, lit(0x4e545a, 0.7, 0.25, 0.05)),
    shadedMesh(partitions, lit(0xd6d9dc, 0.45, 0.35, 0.13), c.field, 0.7),
    meshOf(
      partitionGlass,
      new THREE.MeshPhysicalMaterial({
        color: 0xe6eef2,
        roughness: 0.55,
        metalness: 0,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
      }),
    ),
    shadedMesh(poles, lit(STAINLESS, 0.3, 0.75, 0.13), c.field, 0.45),
  ];
  for (const mesh of meshes) if (mesh) g.add(mesh);
  return g;
}

/**
 * 立客用の縦手すり（スタンションポール）。
 *
 * 扉の脇には壁に沿った縦の手すりが立ち、乗り降りのときに握る。
 * 7 人掛けの区画には通路側にもう 1 本立てて、座席の中ほどで立つ人が
 * つかまれるようにする。
 */
function buildStanchions(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const r = INTERIOR.poleDiameter / 2;
  for (const centre of c.layout.doorCentres) {
    for (const dx of [-1, 1] as const) {
      for (const side of [-1, 1] as const) {
        parts.push(
          tube(r, c.doorTop - c.floor, [centre + dx * (CAR.doorWidth / 2 + 0.085), (c.floor + c.doorTop) / 2, side * (c.inner - 0.14)], 'y'), // prettier-ignore
        );
      }
    }
  }
  for (const bay of c.bays) {
    if (bay.to - bay.from < 3) continue;
    for (const side of [-1, 1] as const) {
      parts.push(
        tube(r, c.ceilingSide - c.floor, [(bay.from + bay.to) / 2, (c.floor + c.ceilingSide) / 2, side * (c.inner - 0.58)], 'y'), // prettier-ignore
      );
    }
  }
  const mesh = shadedMesh(parts, lit(STAINLESS, 0.3, 0.75, 0.13), c.field, 0.45);
  if (mesh) g.add(mesh);
  return g;
}

/**
 * 側扉（両開き 4 か所）。
 *
 * 開閉は `sim.doors` が決める（`DoorSystem`）。扉は左右へ 650mm ずつ開いて
 * 戸袋へ納まるので、開き具合をそのまま横移動に掛ければよい。扉の上には
 * 車内案内表示器が付き、脇には非常用の戸開ボタン（コック）の蓋がある。
 */
function buildDoors(c: Ctx): {
  group: THREE.Group;
  displays: CarDisplay[];
  update(position: number): void;
} {
  const g = new THREE.Group();
  const leaves: Array<{ object: THREE.Object3D; home: number; dir: number }> = [];
  const displays: CarDisplay[] = [];
  const leafWidth = CAR.doorWidth / 2;
  // 戸は開くと戸袋へ滑り込むので、位置で陰を焼くわけにいかない。代わりに
  // 「床に近いほど暗い」という当たり前の勾配だけを頂点色で入れる。これだけで
  // 戸が床から生えている感じが出る。
  const doorMaterial = shadeWithVertexColor(lit(DOOR_COLOR, 0.5, 0.3, 0.13));
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd6e4ee,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
  });
  const stickerMaterial = printed(doorStickerTexture(), 0.14);
  stickerMaterial.transparent = true;
  stickerMaterial.alphaTest = 0.4;

  const frames: THREE.BufferGeometry[] = [];
  const headers: THREE.BufferGeometry[] = [];
  const cocks: THREE.BufferGeometry[] = [];

  for (const centre of c.layout.doorCentres) {
    for (const side of [-1, 1] as const) {
      const z = side * (c.inner - LEAF_INSET);
      for (const dir of [-1, 1] as const) {
        // 1 枚の戸。窓を抜くため、上下と左右の框に分けて組む。
        const parts: THREE.BufferGeometry[] = [];
        const wLeft = -leafWidth / 2;
        const wRight = leafWidth / 2;
        const winA = -INTERIOR.doorWindowWidth / 2;
        const winB = INTERIOR.doorWindowWidth / 2;
        const winY0 = c.floor + INTERIOR.doorWindowSill;
        const winY1 = winY0 + INTERIOR.doorWindowHeight;
        const t = LEAF_THICKNESS;
        parts.push(box([leafWidth, winY0 - c.floor, t], [0, (c.floor + winY0) / 2, 0]));
        parts.push(box([leafWidth, c.doorTop - winY1, t], [0, (winY1 + c.doorTop) / 2, 0]));
        parts.push(box([winA - wLeft, winY1 - winY0, t], [(wLeft + winA) / 2, (winY0 + winY1) / 2, 0])); // prettier-ignore
        parts.push(box([wRight - winB, winY1 - winY0, t], [(winB + wRight) / 2, (winY0 + winY1) / 2, 0])); // prettier-ignore
        // 戸先のゴム。両開きの**合わせ目**は戸袋と反対の側（局所 -dir 側）にある。
        parts.push(box([0.022, c.doorTop - c.floor, t + 0.012], [-dir * (leafWidth / 2 - 0.011), (c.floor + c.doorTop) / 2, 0])); // prettier-ignore

        const pivot = new THREE.Group();
        const leaf = mergeGeometries(parts, false)!;
        tintVertices(leaf, (_x, ly) => 0.5 + 0.5 * Math.min(1, (ly - c.floor) / 0.6));
        pivot.add(new THREE.Mesh(leaf, doorMaterial));
        pivot.add(
          new THREE.Mesh(
            box([INTERIOR.doorWindowWidth, INTERIOR.doorWindowHeight, 0.008], [0, (winY0 + winY1) / 2, 0]), // prettier-ignore
            glassMaterial,
          ),
        );
        // 指はさみ注意のステッカー（戸先の側、腰の高さ）
        pivot.add(
          new THREE.Mesh(
            quad(0.115, 0.115, [-dir * (leafWidth / 2 - 0.11), c.floor + 1.3, -side * (t / 2 + 0.004)], side > 0 ? 'nz' : 'pz'), // prettier-ignore
            stickerMaterial,
          ),
        );
        const home = centre + dir * (leafWidth / 2);
        pivot.position.set(home, 0, z);
        leaves.push({ object: pivot, home, dir });
        g.add(pivot);
      }

      // 戸当たりの枠（開口の縁。ここを塞がないと壁の厚みの隙間から外が見える）
      const jambZ = side * (c.inner - POCKET_STEP / 2);
      for (const dx of [-1, 1] as const) {
        frames.push(
          box([0.03, c.doorTop - c.floor, POCKET_STEP], [centre + dx * (CAR.doorWidth / 2 + 0.015), (c.floor + c.doorTop) / 2, jambZ]), // prettier-ignore
        );
      }
      frames.push(
        box([CAR.doorWidth + 0.06, 0.05, POCKET_STEP], [centre, c.doorTop + 0.025, jambZ]),
      );

      // 鴨居（扉の上）
      headers.push(
        box([CAR.doorWidth + 0.32, c.ceilingSide - c.doorTop - 0.05, 0.07], [centre, (c.doorTop + 0.05 + c.ceilingSide) / 2, side * (c.inner - 0.06)]), // prettier-ignore
      );

      // 車内案内表示器
      const display = createCarDisplay();
      displays.push(display);
      g.add(
        new THREE.Mesh(
          quad(INTERIOR.displayWidth, INTERIOR.displayHeight, [centre, (c.doorTop + 0.05 + c.ceilingSide) / 2, side * (c.inner - 0.1)], side > 0 ? 'nz' : 'pz'), // prettier-ignore
          new THREE.MeshBasicMaterial({ map: display.texture }),
        ),
      );

      // 非常用の戸開コック（扉の脇の赤い蓋）
      cocks.push(
        box([0.1, 0.13, 0.025], [centre + CAR.doorWidth / 2 + 0.24, c.floor + 1.5, side * (c.inner - 0.03)]), // prettier-ignore
      );
    }
  }

  const frameMesh = shadedMesh(frames, lit(0xc6cace, 0.5, 0.35, 0.13), c.field, 0.55);
  const headerMesh = shadedMesh(headers, lit(0xcfd3d7, 0.6, 0.2, 0.13), c.field, 0.5);
  const cockMesh = meshOf(cocks, lit(0xc94a3a, 0.6, 0.1, 0.18));
  for (const mesh of [frameMesh, headerMesh, cockMesh]) if (mesh) g.add(mesh);

  return {
    group: g,
    displays,
    update(position: number): void {
      const travel = leafWidth * Math.max(0, Math.min(1, position));
      for (const leaf of leaves) leaf.object.position.x = leaf.home + leaf.dir * travel;
    },
  };
}

/**
 * 吊り革。
 *
 * **物なので減衰振り子として素直に振れる**（`packages/core/src/train/passenger.ts`
 * が解いている）。停車中は垂れ、加減速のたびに一斉に振れて、しばらく揺れてから
 * 収まる。車内の見どころはここで、立っている人（倒立振子 + むだ時間を持つ姿勢
 * 制御）とは動き方が違う — 吊り革は遅れて追従するだけだが、人は踏ん張る。
 *
 * 1 両に 40 本以上あるので `InstancedMesh` で 1 回の描画にまとめる。振れ角は
 * 全部同じ（同じ車体の上にぶら下がっているので当然）なので、姿勢だけ入れ替える。
 */
function buildStraps(c: Ctx): {
  group: THREE.Group;
  update(lateral: number, longitudinal: number): void;
} {
  const g = new THREE.Group();
  const spots: Array<{ x: number; z: number; priority: boolean }> = [];
  const bars: THREE.BufferGeometry[] = [];
  const barY = c.floor + INTERIOR.strapBarHeight;
  for (const side of [-1, 1] as const) {
    for (const bay of c.bays) {
      const a = bay.from + 0.22;
      const b = bay.to - 0.22;
      if (b - a < INTERIOR.strapPitch) continue;
      bars.push(
        tube(INTERIOR.strapBarDiameter / 2, b - a + 0.24, [(a + b) / 2, barY, side * INTERIOR.strapBarOffset], 'x'), // prettier-ignore
      );
      // 棒を天井から吊る受け金具
      for (const x of [a, (a + b) / 2, b]) {
        bars.push(
          tube(0.009, c.ceilingSide - barY, [x, (barY + c.ceilingSide) / 2, side * INTERIOR.strapBarOffset], 'y', 6), // prettier-ignore
        );
      }
      const count = Math.floor((b - a) / INTERIOR.strapPitch) + 1;
      const pitch = count > 1 ? (b - a) / (count - 1) : 0;
      for (let i = 0; i < count; i++) {
        spots.push({ x: a + i * pitch, z: side * INTERIOR.strapBarOffset, priority: bay.priority });
      }
    }
  }
  const barMesh = shadedMesh(bars, lit(STAINLESS, 0.3, 0.75, 0.13), c.field, 0.45);
  if (barMesh) g.add(barMesh);

  const beltLength = INTERIOR.strapBarHeight - INTERIOR.strapHeight - INTERIOR.strapGripHeight;
  const belt = buildStrapBelt(beltLength);
  const grip = buildStrapGrip(beltLength);

  // 帯（ベルト）と握り手は別の材質にする。実物の吊り革も、握り手が白い樹脂で
  // 帯は灰色の合成皮革なので、この 2 色があると「輪っかが浮いている」ように
  // 見えなくなる。
  const beltMaterial = lit(0x8f959b, 0.75, 0.05, 0.2);
  const groups: Array<{ mesh: THREE.InstancedMesh; spots: typeof spots }> = [];
  for (const priority of [false, true]) {
    const subset = spots.filter((s) => s.priority === priority);
    if (subset.length === 0) continue;
    const gripMaterial = lit(priority ? PRIORITY_STRAP_COLOR : STRAP_COLOR, 0.6, 0.05, 0.22);
    for (const [geometry, material] of [
      [belt, beltMaterial],
      [grip, gripMaterial],
    ] as Array<[THREE.BufferGeometry, THREE.Material]>) {
      const mesh = new THREE.InstancedMesh(geometry, material, subset.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 視界のあちこちにあるので、視錐台の判定で丸ごと消えないようにする
      mesh.frustumCulled = false;
      g.add(mesh);
      groups.push({ mesh, spots: subset });
    }
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const rotX = new THREE.Quaternion();
  const rotZ = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const position = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const update = (lateral: number, longitudinal: number): void => {
    // 左右: 正の `lateral` は右（+Z）へ振れる。X 軸まわりの正の回転は下向きの
    // ものを -Z へ動かすので、符号を反転させる。
    rotX.setFromAxisAngle(axisX, -lateral);
    // 前後: 正の `longitudinal` は前（+X）へ振れる。Z 軸まわりの正の回転で合う。
    rotZ.setFromAxisAngle(axisZ, longitudinal);
    quaternion.copy(rotX).multiply(rotZ);
    for (const entry of groups) {
      for (let i = 0; i < entry.spots.length; i++) {
        const spot = entry.spots[i]!;
        position.set(spot.x, barY, spot.z);
        matrix.compose(position, quaternion, one);
        entry.mesh.setMatrixAt(i, matrix);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
  };
  update(0, 0);
  return { group: g, update };
}

/**
 * 吊り革の帯（つり手の紐）。
 *
 * 支点を原点に置き、下へ垂らす。上端は棒に巻き付く輪になっていて、実物は
 * ここで棒の上を滑る（列車が揺れると吊り革がわずかに前後へずれるのはこのため）。
 * 帯そのものは合成皮革の板で、**厚みがある**——線で描くと吊り革が浮いて見える。
 */
function buildStrapBelt(length: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = INTERIOR.strapBeltWidth;
  parts.push(box([w, length, 0.009], [0, -length / 2, 0]));
  // 棒に巻き付く輪。棒の径（32mm）より少しだけ大きい。
  const loop = new THREE.TorusGeometry(INTERIOR.strapBarDiameter / 2 + 0.006, 0.005, 4, 10);
  loop.rotateY(Math.PI / 2);
  parts.push(loop);
  return mergeGeometries(parts, false)!;
}

/**
 * 吊り革の握り手。
 *
 * 実物は**樹脂を抜いた三角形の板**で、中が抜けていても縁には 20mm 近い厚みが
 * ある。1 周目はトーラスの輪で作っていたため、車内から見ると輪郭だけの線画に
 * 見えていた。ここでは外形と内側の抜きを別々の輪郭として持ち、押し出して
 * 板にする。握るところ（下辺）だけは丸棒を重ねて、手が掛かる太さを出す。
 *
 * 内側の抜きは、外形の三角形を**内心を中心に縮めた**もので作る。三角形では
 * これが「各辺から等距離だけ内側へ寄せた形」にちょうど一致する。
 */
function buildStrapGrip(beltLength: number): THREE.BufferGeometry {
  const w = INTERIOR.strapGripWidth;
  const h = INTERIOR.strapGripHeight;
  /** 縁の幅（樹脂の枠の太さ） */
  const rim = 0.019;
  const apex: [number, number] = [0, 0];
  const left: [number, number] = [-w / 2, -h];
  const right: [number, number] = [w / 2, -h];
  // 内心と内接円の半径。縁を rim だけ内側へ寄せた形は、内接円が rim だけ
  // 小さくなった相似形になる。
  const sideA = w;
  const sideB = Math.hypot(w / 2, h);
  const perimeter = sideA + 2 * sideB;
  const incentre: [number, number] = [0, (-h * 2 * sideB) / perimeter];
  const inradius = (w * h) / perimeter;
  const scale = Math.max(0.15, (inradius - rim) / inradius);

  const outline = (points: ReadonlyArray<readonly [number, number]>): THREE.Path => {
    const path = new THREE.Path();
    // 角を丸める（実物の握り手に鋭い角は無い。手が痛いため）
    const round = 0.014;
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i + points.length - 1) % points.length]!;
      const here = points[i]!;
      const next = points[(i + 1) % points.length]!;
      const toPrev = new THREE.Vector2(prev[0] - here[0], prev[1] - here[1]).normalize();
      const toNext = new THREE.Vector2(next[0] - here[0], next[1] - here[1]).normalize();
      const a = new THREE.Vector2(here[0], here[1]).addScaledVector(toPrev, round);
      const b = new THREE.Vector2(here[0], here[1]).addScaledVector(toNext, round);
      if (i === 0) path.moveTo(a.x, a.y);
      else path.lineTo(a.x, a.y);
      path.quadraticCurveTo(here[0], here[1], b.x, b.y);
    }
    path.closePath();
    return path;
  };

  const shape = new THREE.Shape(outline([apex, right, left]).getPoints(4));
  const inner = [apex, right, left].map(
    ([x, y]) =>
      [incentre[0] + (x - incentre[0]) * scale, incentre[1] + (y - incentre[1]) * scale] as const,
  );
  shape.holes.push(outline(inner));

  const plate = new THREE.ExtrudeGeometry(shape, {
    depth: 0.009,
    bevelEnabled: true,
    bevelThickness: 0.0018,
    bevelSize: 0.0018,
    bevelSegments: 1,
    curveSegments: 3,
  });
  // 押し出しは +Z 方向。板の厚みの中心を原点に置く。
  plate.translate(0, 0, -0.0045);

  // 握るところ（下辺）の丸棒。ここだけは手が掛かるので太い。
  const bar = new THREE.CylinderGeometry(
    INTERIOR.strapGripBar / 2,
    INTERIOR.strapGripBar / 2,
    w - 2 * rim,
    8,
  );
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, -h + rim * 0.9, 0);

  // `ExtrudeGeometry` は添字を持たない形なので、丸棒のほうを合わせてから繋ぐ
  // （添字のある形と無い形は混ぜられない）。
  const merged = mergeGeometries([plate, bar.toNonIndexed()], false)!;
  // 握り手の面は**吊り革棒と直交する**（棒は前後に通っているので、板は
  // 左右に広がって前を向く）。組み上げてからまとめて向きを変える。
  merged.rotateY(Math.PI / 2);
  merged.translate(0, -beltLength, 0);
  return merged;
}

/**
 * 妻面（車端の壁）と貫通路。
 *
 * 中間の連結面には貫通扉があり、その先に幌がある。幌は車体の外にある
 * ものなので、両側の車が半分ずつ受け持って、連結面の中ほどで重なるように
 * 少し長めに伸ばす（連結器の遊間で車間が伸び縮みしても隙間が開かない）。
 * 編成の端（運転室のある側）は仕切り壁で塞がれていて、客室からは入れない。
 */
function buildEndWalls(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const walls: THREE.BufferGeometry[] = [];
  const trims: THREE.BufferGeometry[] = [];
  const bellows: THREE.BufferGeometry[] = [];
  const gangwayHalf = INTERIOR.gangwayWidth / 2;
  const gangwayTop = c.floor + INTERIOR.gangwayHeight;
  const t = INTERIOR.endWallThickness;

  for (const end of [-1, 1] as const) {
    const x = end > 0 ? c.layout.walkableTo : c.layout.walkableFrom;
    // 妻面は**平天井の高さまで**立てる。肩の高さ（ceilingSide）で止めると、
    // 天井の斜面と妻面のあいだに細い隙間が残り、通路から見上げたときに
    // そこから連結面の上（＝屋根の外）が覗いてしまう。斜面より上へ出た部分は
    // 天井の裏に隠れるので、高くするぶんには害がない。
    const wallTop = c.ceiling;
    if (c.layout.cabSide === end) {
      // 運転室の仕切り。ここから先へは入れない。
      walls.push(
        box([t, wallTop - c.floor, INTERIOR.width], [x - (end * t) / 2, (c.floor + wallTop) / 2, 0], [0, 0.15, 0.25]), // prettier-ignore
      );
      // 仕切り扉と、その上の小窓（運転室の様子がわずかに見える）
      trims.push(box([0.04, 1.9, 0.72], [x - end * (t / 2 + 0.02), c.floor + 0.95, -end * 0.55]));
      trims.push(box([0.05, 0.42, 0.62], [x - end * (t / 2 + 0.03), c.floor + 1.62, end * 0.72]));
      continue;
    }

    // 貫通路のある妻面。開口の周りだけを壁で埋める。
    const sidePanelWidth = (INTERIOR.width - INTERIOR.gangwayWidth) / 2;
    for (const side of [-1, 1] as const) {
      walls.push(
        box([t, c.ceilingSide - c.floor, sidePanelWidth], [x - (end * t) / 2, (c.floor + c.ceilingSide) / 2, side * (INTERIOR.width + INTERIOR.gangwayWidth) / 4], [0, 0.15, 0.2]), // prettier-ignore
      );
    }
    walls.push(
      box([t, c.ceilingSide - gangwayTop, INTERIOR.gangwayWidth], [x - (end * t) / 2, (gangwayTop + c.ceilingSide) / 2, 0]), // prettier-ignore
    );

    // 貫通扉（片開き）。**開いた姿勢**で妻面に沿わせる。閉じた位置に置くと
    // 貫通路の半分が塞がって人が通れなくなる（当たり判定のほうは貫通路の
    // 内法いっぱいを通れるものとして扱っている）。
    const openDoorZ = -(gangwayHalf + INTERIOR.gangwayDoorWidth / 2 + 0.02);
    trims.push(
      box([0.045, INTERIOR.gangwayHeight - 0.04, INTERIOR.gangwayDoorWidth], [x - end * (t + 0.035), c.floor + (INTERIOR.gangwayHeight - 0.04) / 2, openDoorZ]), // prettier-ignore
    );
    // 貫通路の縁（つかまり棒を兼ねた枠）
    for (const side of [-1, 1] as const) {
      trims.push(
        box([0.07, INTERIOR.gangwayHeight, 0.06], [x - end * 0.035, c.floor + INTERIOR.gangwayHeight / 2, side * gangwayHalf]), // prettier-ignore
      );
    }
    trims.push(box([0.07, 0.06, INTERIOR.gangwayWidth], [x - end * 0.035, gangwayTop, 0]));

    // 幌の内側。車端から連結面の中ほどを越えるところまで伸ばす。
    const far = end * (c.layout.halfLength + INTERIOR.carGap / 2 + 0.08);
    const mid = (x + far) / 2;
    const length = Math.abs(far - x);
    const bellowsHalf = INTERIOR.bellowsWidth / 2;
    const bellowsTop = c.floor + INTERIOR.bellowsHeight;
    // 渡り板（連結面の床）
    trims.push(box([length, 0.03, INTERIOR.bellowsWidth], [mid, c.floor - 0.015, 0]));
    for (const side of [-1, 1] as const) {
      bellows.push(box([length, bellowsTop - c.floor, 0.04], [mid, (c.floor + bellowsTop) / 2, side * bellowsHalf])); // prettier-ignore
    }
    bellows.push(box([length, 0.04, INTERIOR.bellowsWidth], [mid, bellowsTop, 0]));
    // 幌のひだ（内側から見ると輪っかが並んでいる）
    for (let k = 0.08; k < length; k += 0.12) {
      const fx = x + end * k;
      for (const side of [-1, 1] as const) {
        bellows.push(box([0.03, bellowsTop - c.floor, 0.05], [fx, (c.floor + bellowsTop) / 2, side * (bellowsHalf - 0.02)])); // prettier-ignore
      }
      bellows.push(box([0.03, 0.05, INTERIOR.bellowsWidth - 0.04], [fx, bellowsTop - 0.02, 0]));
    }
  }

  const wallMesh = shadedMesh(walls, textured(panelTexture(0xcfcbc2, 5), 0.8, 0.12), c.field, 0.6); // prettier-ignore
  const trimMesh = shadedMesh(trims, lit(0xc4c9ce, 0.5, 0.35, 0.13), c.field, 0.55);
  const bellowsMesh = meshOf(bellows, lit(0x35383c, 0.9, 0.02, 0.1));
  for (const mesh of [wallMesh, trimMesh, bellowsMesh]) if (mesh) g.add(mesh);

  // 貫通扉の窓（隣の車が透けて見える）
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xd6e4ee,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  for (const end of [-1, 1] as const) {
    if (c.layout.cabSide === end) continue;
    const x = (end > 0 ? c.layout.walkableTo : c.layout.walkableFrom) - end * (t + 0.065);
    const z = -(INTERIOR.gangwayWidth / 2 + INTERIOR.gangwayDoorWidth / 2 + 0.02);
    g.add(
      new THREE.Mesh(
        quad(INTERIOR.gangwayWindowWidth, INTERIOR.gangwayWindowHeight, [x, c.floor + INTERIOR.gangwayWindowSill + INTERIOR.gangwayWindowHeight / 2, z], end > 0 ? 'nx' : 'px'), // prettier-ignore
        glass,
      ),
    );
  }
  return g;
}

/**
 * 広告と標記。
 *
 * 中吊り（天井から下がる縦長のもの）、まど上（荷棚の上の横長のもの）、
 * 優先席の表示。**実在の企業名や商標は使わない**ので、架空の題字だけで作る。
 * 中吊りは 2 枚を背中合わせに張る（1 枚を両面表示にすると裏から鏡像に見える）。
 */
function buildAds(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  let n = 0;
  const hangers: THREE.BufferGeometry[] = [];
  for (const bay of c.bays) {
    if (bay.to - bay.from < 3) continue;
    for (const ratio of [0.28, 0.72]) {
      const x = bay.from + (bay.to - bay.from) * ratio;
      for (const facing of ['pz', 'nz'] as const) {
        g.add(
          new THREE.Mesh(
            quad(0.36, 0.5, [x, c.ceiling - 0.33, facing === 'pz' ? 0.005 : -0.005], facing),
            printed(adTexture(n++, true)),
          ),
        );
      }
      hangers.push(box([0.02, 0.1, 0.02], [x, c.ceiling - 0.05, 0]));
    }
  }
  // まど上（荷棚の上、幕板のところ）
  for (const side of [-1, 1] as const) {
    for (const bay of c.bays) {
      if (bay.to - bay.from < 2) continue;
      g.add(
        new THREE.Mesh(
          quad(0.64, 0.2, [(bay.from + bay.to) / 2, c.floor + 1.93, side * (c.inner - 0.04)], side > 0 ? 'nz' : 'pz'), // prettier-ignore
          printed(adTexture(n++, false)),
        ),
      );
    }
  }
  // 優先席の表示（席の頭上の壁）
  const priorityMaterial = printed(priorityStickerTexture(), 0.22);
  for (const side of [-1, 1] as const) {
    for (const bay of c.bays) {
      if (!bay.priority) continue;
      g.add(
        new THREE.Mesh(
          quad(0.46, 0.17, [(bay.from + bay.to) / 2, c.floor + 1.63, side * (c.inner - 0.04)], side > 0 ? 'nz' : 'pz'), // prettier-ignore
          priorityMaterial,
        ),
      );
    }
  }
  const hangerMesh = meshOf(hangers, lit(STAINLESS, 0.4, 0.6, 0.12));
  if (hangerMesh) g.add(hangerMesh);
  return g;
}

/**
 * 車内の備品（消火器・非常通報器）。
 *
 * どちらも備え付けが決まっているもので、置き場所もおおむね決まっている。
 * 消火器は車端の座席の下、非常通報器は扉の脇の目に付くところにある。
 */
function buildEquipment(c: Ctx): THREE.Group {
  const g = new THREE.Group();
  const end = c.bays[0];
  if (end) {
    const x = (end.from + end.to) / 2;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10),
      lit(0xc03a2c, 0.5, 0.2, 0.16),
    );
    body.position.set(x, c.floor + 0.15, -(c.inner - 0.18));
    g.add(body);
    g.add(
      new THREE.Mesh(
        quad(0.17, 0.085, [x, c.floor + 0.36, -(c.inner - 0.05)], 'pz'),
        printed(noticeTexture('消火器', 'この下にあります', 0xc03a2c)),
      ),
    );
  }
  const centre = c.layout.doorCentres[1] ?? c.layout.doorCentres[0];
  if (centre !== undefined) {
    const notice = printed(noticeTexture('非常通報器', '押すと乗務員を呼べます', 0xc03a2c), 0.2);
    for (const side of [-1, 1] as const) {
      const x = centre - CAR.doorWidth / 2 - 0.26;
      g.add(
        new THREE.Mesh(
          box([0.17, 0.25, 0.03], [x, c.floor + 1.42, side * (c.inner - 0.045)]),
          lit(0xe9c33a, 0.6, 0.1, 0.2),
        ),
      );
      g.add(
        new THREE.Mesh(
          quad(0.16, 0.08, [x, c.floor + 1.5, side * (c.inner - 0.062)], side > 0 ? 'nz' : 'pz'),
          notice,
        ),
      );
    }
  }
  return g;
}
