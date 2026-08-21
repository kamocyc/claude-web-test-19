import * as THREE from 'three';
import { Rng, type CompiledRoute } from '@railsim/core';
import { TUNNEL } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import {
  frameQuaternion,
  meterBox,
  sectionLength,
  sweepSection,
  wireGeometry,
  type SectionPoint,
  type SweepStation,
} from './geometry.ts';
import {
  apartmentSurface,
  asphaltSurface,
  concreteSurface,
  corrugatedSurface,
  fenceAlphaTexture,
  foliageSurface,
  glowTexture,
  paddySurface,
  plateTexture,
  roofPanelSurface,
  roofTileSurface,
  sidingSurface,
  tunnelLiningSurface,
} from './textures.ts';

/**
 * 沿線の景観。
 *
 * ## 何を作れば「日本の鉄道沿線」になるか
 *
 * 窓の外に流れるものを決めているのは、建物の数でも木の数でもなく
 * **並び方**である。日本の在来線の車窓には、線路際から外へ向かって
 * だいたい次の順で物が並ぶ。
 *
 *  | 軌道中心から | もの |
 *  |--------------|------|
 *  | 1.9〜3.0m    | 架線柱・信号機・標識（`catenary.ts` / `wayside.ts`） |
 *  | 3.7m         | 盛土のり尻（`track.ts` の道床断面） |
 *  | 4.6m         | **用地境界のネットフェンス** — 日本の鉄道は必ず柵で囲う |
 *  | 6〜10m       | 側道、電柱と電線 |
 *  | 12〜30m      | 家の裏側・アパート・工場（線路に**背を向けて**建つ） |
 *  | 30m〜        | 2 列目の家並み、田畑、雑木林 |
 *
 * この並びが出ていれば、個々の建物が箱でも「沿線」に見える。逆に、
 * 立派な建物を線路から等距離にばらまいても沿線には見えない。だからここでは
 * **フェンス・電柱・側道**（線路のすぐ外にあるもの）にいちばん手を掛けている。
 *
 * ## 土地利用
 *
 * 建物の種類を 1 軒ずつ乱数で選ぶと、工場と住宅と田んぼが混ざった
 * 見たことのない土地になる。実際の沿線は**数百 m 単位で土地利用が変わる**ので、
 * `ZONE_LENGTH` ごとに用途を決め、その中では同じ種類のものを建てる。
 * 駅の近くは必ず市街地にする（駅は人の集まるところにできる）。
 *
 * ## 数
 *
 * 全長 14.2km に樹木数千本・建物千棟を置くので、どれもインスタンス描画で
 * まとめる。1 種類 = 1 ドローコールなので、数を増やしても描画の手間は増えない。
 */

/** 土地利用が変わる長さ [m]。実際の市街地と郊外の切り替わりもこのくらい */
const ZONE_LENGTH = 340;

/** 用地境界のフェンスの位置（軌道中心から）と高さ [m] */
/**
 * 用地境界のフェンス。
 *
 * 支柱の間隔 3m は実物の柵の標準。網の板を刻む間隔（8m）は曲線の矢
 * （R300 で 8m あたり 27mm）が見えない範囲でいちばん粗い値にしてある —
 * 全長 14.2km ぶんを作るので、ここを細かくすると組み立て時間がそのまま延びる。
 */
const FENCE = { offset: 4.6, height: 1.8, postPitch: 3.0, sampleStep: 8 } as const;

/** 側道の中心（軌道中心から）と幅 [m] */
const SERVICE_ROAD = { offset: 9.5, width: 4.0 } as const;

/** 電柱（コンクリート柱）。実物は 10〜14m で、根入れは全長の 1/6 */
const UTILITY_POLE = { height: 11.0, offset: 7.4, pitch: 40, topDiameter: 0.19 } as const;

/** 地表の高さ（`TrackScene.buildGround()` と揃える。軌道面から下へ） */
const GROUND = -1.2;

/** 沿線の土地利用 */
type LandUse = 'residential' | 'apartment' | 'industry' | 'field' | 'wood' | 'bamboo';

/** 用途ごとの出やすさ（駅から離れた区間で使う） */
const LAND_USE_WEIGHTS: ReadonlyArray<readonly [LandUse, number]> = [
  ['residential', 0.3],
  ['apartment', 0.1],
  ['industry', 0.15],
  ['field', 0.2],
  ['wood', 0.17],
  ['bamboo', 0.08],
];

export interface SceneryOptions {
  /** 建物・樹木を置く間隔 [m] */
  readonly step?: number;
  /** 乱数シード（決定論的に同じ景色が生成される） */
  readonly seed?: number;
}

/** 建物 1 棟の置き場所（インスタンス行列を作るのに要る値） */
interface Spot {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly tint: number;
  /**
   * 大きさ。省略すれば等倍。
   *
   * 樹木でこれを省くと**すべての木が同じ高さ・同じ太さ**になり、林が
   * 一目で「同じものを並べた」と分かってしまう。実際の雑木林は同じ樹種でも
   * 樹高が倍ちがう。建物はテクスチャを実寸で貼るため等倍のままにする。
   */
  readonly scale?: THREE.Vector3;
}

/** 1 種類ぶんのインスタンスを積んでいく入れ物 */
class Bucket {
  readonly spots: Spot[] = [];
  add(spot: Spot): void {
    this.spots.push(spot);
  }
}

/** 積んだ置き場所を InstancedMesh にする。0 個なら何も返さない */
function instance(
  bucket: Bucket,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.InstancedMesh | null {
  const n = bucket.spots.length;
  if (n === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const spot = bucket.spots[i]!;
    mesh.setMatrixAt(i, m.compose(spot.position, spot.quaternion, spot.scale ?? one));
    mesh.setColorAt(i, color.setHex(spot.tint));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** 縦横で別々にばらつかせた大きさ（背の高い木・横に広がった木を混ぜる） */
function spread(rng: Rng, low: number, high: number, squash = 0.22): THREE.Vector3 {
  const k = rng.range(low, high);
  const wide = k * rng.range(1 - squash, 1 + squash);
  return new THREE.Vector3(wide, k, wide);
}

/**
 * 距離程 `s` の土地利用。
 *
 * 同じ距離程からは必ず同じ用途が出る（区間番号だけから決めているため）。
 * 駅の前後 300m は市街地に固定する。
 */
function landUseAt(route: CompiledRoute, s: number, seed: number): LandUse {
  const nearStation = route.stations.some(
    (st) => s > st.platformStart - 300 && s < st.platformEnd + 300,
  );
  const zone = Math.floor(s / ZONE_LENGTH);
  // 区間番号を種にした一様乱数。`Rng` を毎回作るのは、距離程だけから
  // 決まる（呼ぶ順序に依らない）ようにするため。
  const r = new Rng(seed + zone * 7919).next();
  // 駅前は戸建てが主で、団地は時おり混じる程度。ここを半々にすると
  // 同じ形の中層住宅が延々と並ぶ「団地だけの街」になってしまう。
  if (nearStation) return r < 0.78 ? 'residential' : 'apartment';
  let acc = 0;
  for (const [use, weight] of LAND_USE_WEIGHTS) {
    acc += weight;
    if (r < acc) return use;
  }
  return 'residential';
}

/**
 * 切妻屋根の立体。
 *
 * 棟が局所 X 軸（線路方向）に走り、両側へ流れる。軒の出（`overhang`）は
 * 日本の木造住宅の標準的な 600mm 前後。UV は m 単位で入れるので、
 * 屋根材のテクスチャが実寸で貼れる。
 */
function gableRoofGeometry(
  width: number,
  depth: number,
  rise: number,
  overhang = 0.55,
): THREE.BufferGeometry {
  const hx = width / 2 + overhang;
  const hz = depth / 2 + overhang;
  const slope = Math.hypot(hz, rise);
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number): void => {
    pos.push(x, y, z);
    uv.push(u, v);
  };
  // 流れ面 2 枚（棟から軒先へ）
  for (const side of [-1, 1] as const) {
    push(-hx, 0, side * hz, -hx, 0);
    push(hx, 0, side * hz, hx, 0);
    push(hx, rise, 0, hx, slope);
    push(-hx, 0, side * hz, -hx, 0);
    push(hx, rise, 0, hx, slope);
    push(-hx, rise, 0, -hx, slope);
  }
  // 妻面（両端の三角形）
  for (const side of [-1, 1] as const) {
    push(side * hx, 0, -hz, -hz, 0);
    push(side * hx, 0, hz, hz, 0);
    push(side * hx, rise, 0, 0, rise);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 建物の原型。
 *
 * 大きさごとに別のインスタンスにしてあるのは、**テクスチャを実寸で貼るため**
 * である。1 つの箱を拡大縮小して使い回すと、窓の大きさが建物の大きさに比例して
 * 変わってしまい、大きい建物ほど窓が巨大になる（遠景の建物が「箱」に見える
 * いちばんの原因がこれ）。
 */
interface Archetype {
  readonly key: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** 屋根の形。切妻は棟の高さ、陸屋根はパラペットの高さ */
  readonly roof: 'gable' | 'flat' | 'shed';
  readonly rise: number;
  readonly wall: 'siding' | 'apartment' | 'corrugated';
  readonly tints: readonly number[];
}

/**
 * 沿線に建つ建物の型。
 *
 * 寸法は日本の一般的なもの:
 *  - 戸建て 2 階建て — 総 2 階で 9m × 7m、軒高 5.8m、切妻の棟まで 7.2m
 *  - アパート（軽量鉄骨 2 階建て） — 18m × 8m、高さ 6.2m、片流れ
 *  - 団地（中層 5 階建て） — 48m × 9.6m、階高 2.8m で高さ 14m、陸屋根
 *  - 倉庫・工場 — 32m × 16m、軒高 8m、緩い切妻
 */
const ARCHETYPES: readonly Archetype[] = [
  {
    key: 'house-s',
    width: 7.2,
    depth: 6.4,
    height: 5.8,
    roof: 'gable',
    rise: 1.5,
    wall: 'siding',
    tints: [0xe4ded0, 0xd8d2c4, 0xcfd4d2, 0xe8dfd0, 0xc9c4b8],
  },
  {
    key: 'house-l',
    width: 9.4,
    depth: 7.6,
    height: 6.1,
    roof: 'gable',
    rise: 1.8,
    wall: 'siding',
    tints: [0xdedbd2, 0xd2ccbe, 0xc6c9c8, 0xe2d8c6],
  },
  {
    key: 'flat-2',
    width: 18.0,
    depth: 8.2,
    height: 6.2,
    roof: 'shed',
    rise: 0.5,
    wall: 'apartment',
    tints: [0xd6d1c4, 0xc8c8c2, 0xdcd4c0],
  },
  {
    key: 'danchi',
    width: 48.0,
    depth: 9.6,
    height: 14.0,
    roof: 'flat',
    rise: 0.6,
    wall: 'apartment',
    tints: [0xd2cec2, 0xc6c2b6, 0xd8d0be],
  },
  {
    key: 'works',
    width: 32.0,
    depth: 16.0,
    height: 8.0,
    roof: 'gable',
    rise: 1.6,
    wall: 'corrugated',
    tints: [0xc8ccc8, 0xb8bcb8, 0xc2c0b4, 0xa8b2b6],
  },
];

/** 用途ごとに建つ建物（同じ型が何度も出るのは、実際の街並みもそうだから） */
const BY_LAND_USE: Record<LandUse, readonly string[]> = {
  residential: ['house-s', 'house-l', 'house-s', 'house-l', 'house-s', 'flat-2'],
  apartment: ['danchi', 'flat-2', 'flat-2', 'flat-2', 'house-l', 'house-s'],
  industry: ['works', 'works', 'flat-2'],
  field: [],
  wood: [],
  bamboo: [],
};

export function buildScenery(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  options: SceneryOptions = {},
): THREE.Object3D[] {
  const step = options.step ?? 13;
  const seed = options.seed ?? 0xc0ffee;
  const rng = new Rng(seed);
  const out: THREE.Object3D[] = [];

  const inTunnel = (s: number): boolean => route.tunnels.at(s).length > 0;
  const nearStation = (s: number): boolean =>
    route.stations.some((st) => s > st.platformStart - 40 && s < st.platformEnd + 40);
  // 橋の下は谷か川なので、そこに樹木や建物は立っていない
  const overWater = (s: number): boolean => route.bridges.overlapping(s - 60, s + 60).length > 0;
  /** 隣の線路のぶんだけ用地が広がる。柵も建物もその外側になる */
  const outward = (s: number, side: -1 | 1): number => {
    const adjacent = route.adjacentTrack.offsetAt(s);
    return side > 0 ? Math.max(0, adjacent) : Math.max(0, -adjacent);
  };

  // --- 建物 ---
  const buildings = new Map<string, Bucket>();
  for (const type of ARCHETYPES) buildings.set(type.key, new Bucket());
  const byKey = new Map(ARCHETYPES.map((a) => [a.key, a]));

  // --- 植生 ---
  const broadleaf = new Bucket();
  const cedar = new Bucket();
  const bamboo = new Bucket();
  const shrub = new Bucket();

  const count = Math.floor(route.length / step);
  for (let i = 0; i < count; i++) {
    const s = i * step + rng.range(-step / 3, step / 3);
    if (s < 0 || s > route.length || inTunnel(s) || overWater(s)) continue;
    const use = landUseAt(route, s, seed);
    const f = frameAt(s);
    const yaw = frameQuaternion(f, false);

    for (const side of [-1, 1] as const) {
      const margin = outward(s, side);
      // 線路際の雑草・低木。刈り取りの手が回らない箇所にまとまって生える。
      // 走っていていちばん近くを流れるものなので、これが無いと道床の外が
      // 唐突に「草の板」になる。
      if (!nearStation(s) && rng.chance(0.55)) {
        const lateral = side * (margin + rng.range(4.9, 6.4));
        shrub.add({
          position: f.position
            .clone()
            .addScaledVector(f.right, lateral)
            .setY(f.position.y + GROUND),
          quaternion: yaw.clone().multiply(yawOnly(rng.range(0, Math.PI))),
          tint: pick(rng, [0xdcdcb4, 0xcdd4ac, 0xe6dcb0, 0xc4cea4]),
          scale: spread(rng, 0.6, 1.5, 0.35),
        });
      }
      if (nearStation(s) && rng.chance(0.7)) continue;

      const near = rng.chance(0.55);
      const distance = margin + (near ? rng.range(14, 26) : rng.range(30, 74));
      const position = f.position
        .clone()
        .addScaledVector(f.right, side * distance)
        .setY(f.position.y + GROUND);

      if (use === 'wood' || use === 'field') {
        // 林と田畑の縁には広葉樹と杉が混じって生える。杉は列で植わることが多い
        const conifer = rng.chance(use === 'wood' ? 0.42 : 0.18);
        const bucket = conifer ? cedar : broadleaf;
        if (use === 'field' && !near && rng.chance(0.55)) continue;
        bucket.add({
          position,
          quaternion: yawOnly(rng.range(0, Math.PI * 2)),
          // **緑そのものは葉のテクスチャが持っている。** ここで指定する色は
          // その上に掛かる係数なので、緑を入れると緑どうしが掛け合わさって
          // 真っ黒な塊になる（実際そうなった）。個体差として明るさと色味を
          // わずかに振るだけに留め、白に近い値を使う。
          // スギの人工林は雑木林より暗く青みがかって見えるので、そのぶんだけ落とす。
          tint: conifer
            ? pick(rng, [0xa8b8a4, 0x9cae9c, 0xb2c0ac])
            : pick(rng, [0xe4e2c8, 0xd6dcc0, 0xecdfb8, 0xcfd8b4, 0xe8e4cc]),
          scale: conifer ? spread(rng, 0.7, 1.35, 0.16) : spread(rng, 0.6, 1.3, 0.3),
        });
        continue;
      }
      if (use === 'bamboo') {
        // 竹は 1 本ずつではなく株で生える。1 か所に数本まとめて立てる
        for (let k = 0; k < 5; k++) {
          bamboo.add({
            position: position
              .clone()
              .addScaledVector(f.right, rng.range(-2.2, 2.2))
              .addScaledVector(f.forward, rng.range(-2.2, 2.2)),
            quaternion: yawOnly(rng.range(0, Math.PI * 2)),
            // 竹は葉が黄緑で、雑木林より明るい
            tint: pick(rng, [0xf0e8c0, 0xe6e0b8, 0xf4ecc8]),
            scale: spread(rng, 0.75, 1.15, 0.1),
          });
        }
        continue;
      }

      const keys = BY_LAND_USE[use];
      if (keys.length === 0) continue;
      const type = byKey.get(keys[Math.floor(rng.range(0, keys.length))]!)!;
      // 建物が線路へ食い込まないよう、奥行きの半分だけ外へ寄せる
      const offset = position.clone().addScaledVector(f.right, side * type.depth * 0.5);
      // 沿線の家は道路の並びに合わせて建つ。道路は線路に沿っているので、
      // 家も線路と平行になる。まれに直交する区画（別の道路に面した家）を混ぜる。
      const turn = rng.chance(0.18) ? Math.PI / 2 : 0;
      buildings.get(type.key)!.add({
        position: offset,
        quaternion: yaw.clone().multiply(yawOnly(turn + rng.range(-0.04, 0.04))),
        tint: pick(rng, type.tints),
      });
    }
  }

  out.push(...buildBuildings(buildings, byKey));
  out.push(...buildVegetation(broadleaf, cedar, bamboo, shrub));
  out.push(...buildBoundaryFence(route, frameAt, outward));
  out.push(...buildUtilityLine(route, frameAt, outward));
  out.push(...buildServiceRoad(route, frameAt, outward));
  out.push(...buildPaddies(route, frameAt, seed));
  return out;
}

/**
 * 長い区間を短い塊に割る。
 *
 * 柵も側道も田も、線路に沿って何 km も続く。それを 1 つのメッシュにすると、
 * **画面のどこにも映っていなくても毎フレーム全部が描かれる**（視錐台の判定は
 * メッシュ単位なので、端が視野に入れば全長が描かれてしまう）。影を焼く
 * ときも同じことが起きるので、費用は路線の長さにそのまま比例する。
 * 200m ほどに割っておけば、実際に見えている数個だけが描かれる。
 */
function chunks(start: number, end: number, size = 300): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = start; s < end; s += size) out.push([s, Math.min(end, s + size)]);
  return out;
}

/** 局所 Y 軸まわりだけの回転 */
function yawOnly(angle: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
}

/** 小数部（GLSL の fract と同じ）。頂点を乱すのに使う */
function fract(v: number): number {
  return v - Math.floor(v);
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rng.next() * items.length))]!;
}

/** 建物（外壁と屋根）をインスタンスにまとめる */
function buildBuildings(
  buckets: Map<string, Bucket>,
  byKey: Map<string, Archetype>,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const walls = {
    siding: () => sidingSurface().maps(3.6, 3.2),
    apartment: () => apartmentSurface().maps(16.5, 5.6),
    corrugated: () => corrugatedSurface().maps(3.0, 4.0),
  };
  const roofTile = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    ...roofTileSurface().maps(1.8),
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.86,
  });
  const roofPanel = new THREE.MeshStandardMaterial({
    color: 0x9aa0a4,
    ...roofPanelSurface().maps(2.4, 0.6),
    normalScale: new THREE.Vector2(1.0, 1.0),
    metalness: 0.4,
    roughness: 0.62,
  });
  const parapet = new THREE.MeshStandardMaterial({
    color: 0xb6b2a8,
    ...concreteSurface().maps(2.0),
    roughness: 0.94,
  });

  for (const [key, bucket] of buckets) {
    if (bucket.spots.length === 0) continue;
    const type = byKey.get(key)!;
    const maps = walls[type.wall]();
    const wall = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: maps.map,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: type.wall === 'corrugated' ? 0.62 : 0.88,
      metalness: type.wall === 'corrugated' ? 0.35 : 0,
    });
    const body = meterBox(type.width, type.height, type.depth);
    // 原点を地面に置く（置き場所の座標は地表なので）
    body.translate(0, type.height / 2, 0);
    const bodyMesh = instance(bucket, body, wall);
    if (bodyMesh) out.push(bodyMesh);

    let roofGeom: THREE.BufferGeometry;
    let roofMaterial: THREE.Material;
    if (type.roof === 'gable') {
      roofGeom = gableRoofGeometry(type.width, type.depth, type.rise);
      roofMaterial = type.wall === 'corrugated' ? roofPanel : roofTile;
    } else if (type.roof === 'shed') {
      // 片流れ。棟を持たず、片側だけ上がる（軽量鉄骨のアパートに多い）
      roofGeom = gableRoofGeometry(type.width, type.depth * 2, type.rise, 0.4);
      roofGeom.translate(0, 0, type.depth / 2);
      roofMaterial = roofPanel;
    } else {
      // 陸屋根はパラペット（立ち上がり）だけ載せる
      roofGeom = meterBox(type.width + 0.3, type.rise, type.depth + 0.3);
      roofGeom.translate(0, type.rise / 2, 0);
      roofMaterial = parapet;
    }
    roofGeom.translate(0, type.height, 0);
    const roofBucket = new Bucket();
    // 屋根の色は外壁と別に散らす。同じ色の家が並ぶと団地に見えてしまう
    for (const spot of bucket.spots) roofBucket.add({ ...spot, tint: 0xffffff });
    const roofMesh = instance(roofBucket, roofGeom, roofMaterial);
    if (roofMesh) out.push(roofMesh);
  }
  return out;
}

/**
 * 植生。
 *
 * 樹木は円錐ではなく、**樹種ごとに違う輪郭**を持たせる。日本の沿線で目に入る
 * のは主に次の 3 つで、遠くからでも輪郭で見分けが付く。
 *
 *  - **広葉樹**（ケヤキ・クヌギ） — 横に広がる丸い樹冠。線路際の雑木林はこれ。
 *  - **スギ**（人工林） — 細く尖った円錐が列で並ぶ。山の斜面が濃い緑に見える元。
 *  - **竹**（モウソウチク） — 幹だけがまっすぐ 15m 伸び、上のほうにだけ葉が付く。
 *
 * 葉は面ではなく塊で作る（正 20 面体を潰したもの）。平面の板を交差させる
 * やり方より頂点は増えるが、どの向きから見ても厚みがあり、影も立体として落ちる。
 */
function buildVegetation(
  broadleaf: Bucket,
  cedar: Bucket,
  bamboo: Bucket,
  shrub: Bucket,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  // 樹冠の質感。1 枚を 1.1m で貼ると、葉の塊（30cm 前後）が実物と同じ大きさに
  // なる。平滑な陰影（`flatShading` を切る）に葉のむらを重ねると、
  // 「低ポリゴンの塊」ではなく「茂み」に見えるようになる。
  const foliage = foliageSurface().maps(1.1);
  const leaf = (roughness: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: foliage.map,
      normalMap: foliage.normalMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness,
      metalness: 0,
      // 葉は薄いので裏から光が透ける。両面を描かないと樹冠の内側が黒く抜ける
      side: THREE.DoubleSide,
    });
  const bark = new THREE.MeshStandardMaterial({ color: 0x4d4033, roughness: 0.95 });

  // 広葉樹: 幹 + 押しつぶした球 3 つ（1 つでは輪郭が幾何学的すぎる）
  if (broadleaf.spots.length > 0) {
    const canopy = mergeBlobs([
      [0, 6.4, 0, 3.5, 2.6],
      [1.9, 5.2, 0.8, 2.4, 1.9],
      [-1.6, 5.6, -1.1, 2.2, 1.8],
    ]);
    const mesh = instance(broadleaf, canopy, leaf(0.86));
    if (mesh) out.push(mesh);
    const trunk = new THREE.CylinderGeometry(0.16, 0.28, 4.6, 6);
    trunk.translate(0, 2.3, 0);
    const trunks = instance(sameSpots(broadleaf, 0xb8a894), trunk, bark);
    if (trunks) out.push(trunks);
  }

  // スギ: 細く尖った円錐を 2 段。上ほど細い
  if (cedar.spots.length > 0) {
    const cone = mergeCones([
      [0, 4.2, 2.5, 7.5],
      [0, 9.0, 1.5, 5.5],
    ]);
    const mesh = instance(cedar, cone, leaf(0.9));
    if (mesh) out.push(mesh);
    const trunk = new THREE.CylinderGeometry(0.13, 0.24, 4.4, 5);
    trunk.translate(0, 2.2, 0);
    const trunks = instance(sameSpots(cedar, 0x9c8a70), trunk, bark);
    if (trunks) out.push(trunks);
  }

  // 竹: 稈（かん）は 15m でほぼ一様な太さ。葉は上 1/3 にだけ付く
  if (bamboo.spots.length > 0) {
    const culm = new THREE.CylinderGeometry(0.055, 0.075, 14, 5);
    culm.translate(0, 7, 0);
    // 稈（かん）は黄緑がかった明るい色。竹林が明るく見えるのはこの幹の色による
    const culms = instance(
      bamboo,
      culm,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    );
    if (culms) out.push(culms);
    const foliage = mergeBlobs([
      [0, 11.5, 0, 1.5, 2.6],
      [0.5, 13.2, 0.3, 1.0, 1.6],
    ]);
    const leaves = instance(sameSpots(bamboo, 0xe8e4bc), foliage, leaf(0.9));
    if (leaves) out.push(leaves);
  }

  // 線路際の低木・雑草。背が低く、まとまって生える
  if (shrub.spots.length > 0) {
    const blob = mergeBlobs([
      [0, 0.55, 0, 1.0, 0.55],
      [0.7, 0.4, 0.3, 0.7, 0.4],
      [-0.6, 0.45, -0.4, 0.75, 0.45],
    ]);
    const mesh = instance(shrub, blob, leaf(0.95));
    if (mesh) out.push(mesh);
  }
  return out;
}

/** 同じ置き場所を別の色で使い回す（幹と葉のように、位置は同じで色が違うもの） */
function sameSpots(bucket: Bucket, tint: number): Bucket {
  const copy = new Bucket();
  for (const spot of bucket.spots) copy.add({ ...spot, tint });
  return copy;
}

/**
 * 複数の潰した球を 1 つの形にまとめる。
 * `[x, y, z, 半径, 高さの半分]` を並べる。
 */
function mergeBlobs(
  blobs: ReadonlyArray<readonly [number, number, number, number, number]>,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r, h] of blobs) {
    // 正 20 面体を 1 段分割（80 面）。そのままだと球にしか見えないので、
    // 頂点を半径方向へ乱してでこぼこにする。葉の塊の縁が不揃いになると、
    // 平滑な球ではなく「茂み」の輪郭になる。種は位置から決めるので、
    // 同じ形は必ず同じ場所に出る。
    const geom = new THREE.IcosahedronGeometry(1, 1);
    const pos = geom.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const wobble =
        0.82 + 0.36 * fract(Math.sin(vx * 12.9898 + vy * 78.233 + vz * 37.719) * 43758.5453);
      pos.setXYZ(i, vx * wobble, vy * wobble, vz * wobble);
    }
    geom.scale(r, h, r);
    geom.translate(x, y, z);
    parts.push(geom);
  }
  return mergeGeometries(parts);
}

/** 円錐を積み上げて 1 つの形にする。`[x, 底の高さ, 半径, 高さ]` */
function mergeCones(
  cones: ReadonlyArray<readonly [number, number, number, number]>,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, base, r, h] of cones) {
    const geom = new THREE.ConeGeometry(r, h, 7, 1);
    geom.translate(x, base + h / 2, 0);
    parts.push(geom);
  }
  return mergeGeometries(parts);
}

/**
 * 形をつなぎ合わせる。
 *
 * three.js の `BufferGeometryUtils` を読み込まずに済ませるための最小の実装。
 * 位置と法線だけを持つ、索引を持たない形しか扱わない（樹木にはそれで足りる）。
 */
function mergeGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const geom = part.index ? part.toNonIndexed() : part;
    const p = geom.attributes.position!;
    geom.computeVertexNormals();
    const n = geom.attributes.normal!;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

/**
 * 用地境界のネットフェンス。
 *
 * 日本の鉄道は、線路の用地を端から端まで柵で囲っている（鉄道営業法にいう
 * 立入禁止の措置）。運転席から見ると、これが**いちばん近くを流れ続けるもの**で、
 * 線路脇の「速さ」はほとんどこの柵が作っている。
 *
 * 金網は面ではなく線の網なので、抜きの型（`alphaMap`）を貼った板で作る。
 * 遠くでは網目が潰れて半透明の膜に見えるのが実物どおりである。
 */
function buildBoundaryFence(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  outward: (s: number, side: -1 | 1) => number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const alpha = fenceAlphaTexture();
  // 網目 50mm。1m あたり 20 目になるよう繰り返す
  alpha.repeat.set(1 / 0.4, 1 / 0.4);
  const mesh = new THREE.MeshStandardMaterial({
    color: 0x9aa19c,
    alphaMap: alpha,
    transparent: true,
    // 網は裏から見ても網なので両面。片面だと片側から消える
    side: THREE.DoubleSide,
    metalness: 0.5,
    roughness: 0.6,
    // 半透明の面どうしが重なると描画順で瞬くので、深度は書いておく
    depthWrite: true,
    // 網の線が占める面積は 1 割ほど。ミップマップで潰れた遠くの網は平均の
    // 不透明度がここを下回って消える — 実物の金網も、離れれば見えなくなる。
    alphaTest: 0.45,
  });
  const postMaterial = new THREE.MeshStandardMaterial({
    color: 0x8d938e,
    metalness: 0.45,
    roughness: 0.65,
  });

  for (const [spanStart, spanEnd] of fenceSpans(route)) {
    for (const [start, end] of chunks(spanStart, spanEnd)) {
      for (const side of [-1, 1] as const) {
        const stations: SweepStation[] = [];
        const n = Math.max(1, Math.ceil((end - start) / FENCE.sampleStep));
        for (let i = 0; i <= n; i++) {
          const s = start + ((end - start) * i) / n;
          stations.push({ frame: frameAt(s), lateral: side * (FENCE.offset + outward(s, side)) });
        }
        // 網の板（地表から 1.8m）
        out.push(
          new THREE.Mesh(
            sweepSection(
              stations,
              [
                [0, GROUND + 0.05],
                [0, GROUND + FENCE.height],
              ],
              { vertical: true },
            ),
            mesh,
          ),
        );
        // 支柱（φ48.6mm の鋼管を 2.5m ごと）と上桟
        const posts = Math.floor((end - start) / FENCE.postPitch);
        if (posts > 0) {
          const post = new THREE.InstancedMesh(
            new THREE.CylinderGeometry(0.024, 0.024, FENCE.height, 6),
            postMaterial,
            posts,
          );
          const m = new THREE.Matrix4();
          const one = new THREE.Vector3(1, 1, 1);
          for (let i = 0; i < posts; i++) {
            const s = start + i * FENCE.postPitch;
            const f = frameAt(s);
            post.setMatrixAt(
              i,
              m.compose(
                f.position
                  .clone()
                  .addScaledVector(f.right, side * (FENCE.offset + outward(s, side)))
                  .setY(f.position.y + GROUND + FENCE.height / 2),
                frameQuaternion(f, false),
                one,
              ),
            );
          }
          post.instanceMatrix.needsUpdate = true;
          out.push(post);
        }
      }
    }
  }
  return out;
}

/**
 * 柵を張る区間。
 *
 * トンネルの中には要らない（そもそも人が入れない）。駅のホームがあるところと
 * 踏切のところも、柵ではなく別の構造物が境界になるので空ける。
 */
function fenceSpans(route: CompiledRoute): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  for (const span of route.tunnels.all) gaps.push([span.start - 12, span.end + 12]);
  for (const st of route.stations) gaps.push([st.platformStart - 25, st.platformEnd + 25]);
  for (const xg of route.levelCrossings.crossings) {
    gaps.push([xg.position - xg.roadWidth / 2 - 3, xg.position + xg.roadWidth / 2 + 3]);
  }
  for (const bridge of route.bridges.bridges) gaps.push([bridge.start - 8, bridge.end + 8]);
  gaps.sort((a, b) => a[0] - b[0]);
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of gaps) {
    if (start > cursor + 8) spans.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < route.length - 8) spans.push([cursor, route.length]);
  return spans;
}

/**
 * 電柱と電線。
 *
 * 線路沿いの道には必ず電柱が立ち、電線が架かっている。日本の郊外の
 * 車窓が「日本らしく」見える理由の大きな部分がこれで、
 * **等間隔に流れる柱**と**たるんで張られた線**の 2 つが速度感を作る。
 *
 * 柱はコンクリート柱（根元 φ300mm・先端 φ190mm・地上高 11m）で、
 * 上部に高圧の腕金、その下に低圧の腕金が付く。電線は柱間 32m で
 * たるみ 0.6m ほど（懸垂線を放物線で近似する）。
 */
function buildUtilityLine(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  outward: (s: number, side: -1 | 1) => number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xa8a49c,
    ...concreteSurface().maps(1.2),
    roughness: 0.92,
  });
  const armMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f7378,
    metalness: 0.6,
    roughness: 0.6,
  });
  const wireMaterial = new THREE.MeshStandardMaterial({
    color: 0x24262a,
    metalness: 0.3,
    roughness: 0.7,
  });

  // 架線柱と反対側（進行方向右）に立てる。同じ側に並ぶと柱が二重になる
  const side: -1 | 1 = 1;
  /** 柱の建つ距離程 */
  const poles: number[] = [];
  for (let s = 20; s < route.length - 20; s += UTILITY_POLE.pitch) {
    if (route.tunnels.at(s).length > 0) continue;
    if (route.bridges.overlapping(s - 5, s + 5).length > 0) continue;
    poles.push(s);
  }
  if (poles.length === 0) return out;

  const lateralAt = (s: number): number => side * (UTILITY_POLE.offset + outward(s, side));
  const at = (s: number, height: number, lateralShift = 0): THREE.Vector3 => {
    const f = frameAt(s);
    return f.position
      .clone()
      .addScaledVector(f.right, lateralAt(s) + lateralShift)
      .setY(f.position.y + GROUND + height);
  };

  // --- 柱 ---
  const pole = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(UTILITY_POLE.topDiameter / 2, 0.15, UTILITY_POLE.height, 8),
    concrete,
    poles.length,
  );
  const arm = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.06, 0.06, 1.5),
    armMaterial,
    poles.length * 2,
  );
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < poles.length; i++) {
    const s = poles[i]!;
    const f = frameAt(s);
    const q = frameQuaternion(f, false);
    pole.setMatrixAt(i, m.compose(at(s, UTILITY_POLE.height / 2), q, one));
    arm.setMatrixAt(i * 2, m.compose(at(s, UTILITY_POLE.height - 0.5), q, one));
    arm.setMatrixAt(i * 2 + 1, m.compose(at(s, UTILITY_POLE.height - 2.4), q, one));
  }
  pole.instanceMatrix.needsUpdate = true;
  arm.instanceMatrix.needsUpdate = true;
  out.push(pole, arm);

  // --- 電線 ---
  // 腕金の左右と、その下の低圧線。柱間はたるむので、径間を 4 つに刻んで
  // 放物線を通す（直線で結ぶと「張り詰めた針金」になって嘘っぽい）。
  const lines: Array<{ height: number; shift: number; sag: number; radius: number }> = [
    { height: UTILITY_POLE.height - 0.5, shift: -0.65, sag: 0.55, radius: 0.022 },
    { height: UTILITY_POLE.height - 0.5, shift: 0.65, sag: 0.55, radius: 0.022 },
    { height: UTILITY_POLE.height - 2.4, shift: -0.6, sag: 0.75, radius: 0.026 },
    { height: UTILITY_POLE.height - 2.4, shift: 0.6, sag: 0.75, radius: 0.026 },
    { height: UTILITY_POLE.height - 3.6, shift: 0, sag: 0.95, radius: 0.03 },
  ];
  for (const line of lines) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < poles.length - 1; i++) {
      const s0 = poles[i]!;
      const s1 = poles[i + 1]!;
      // 柱が飛んでいる（トンネル・橋）ところは電線も切る
      if (s1 - s0 > UTILITY_POLE.pitch * 1.5) {
        if (points.length > 1)
          out.push(new THREE.Mesh(wireGeometry(points, line.radius, 3), wireMaterial));
        points.length = 0;
        continue;
      }
      const steps = 4;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const s = s0 + (s1 - s0) * t;
        // 放物線のたるみ。両端で 0、中央で最大
        const drop = line.sag * 4 * t * (1 - t);
        points.push(at(s, line.height - drop, line.shift));
      }
    }
    if (points.length > 1) {
      points.push(at(poles[poles.length - 1]!, line.height, line.shift));
      out.push(new THREE.Mesh(wireGeometry(points, line.radius, 3), wireMaterial));
    }
  }
  return out;
}

/**
 * 側道。
 *
 * 線路に沿って走る細い道。日本の在来線の沿線にはたいていこれがあり、
 * 保守用の通路と生活道路を兼ねている。舗装の帯を 1 本通すだけで、
 * 柵の外が「草地」ではなく「街の中」になる。
 */
function buildServiceRoad(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  outward: (s: number, side: -1 | 1) => number,
): THREE.Object3D[] {
  const material = new THREE.MeshStandardMaterial({
    color: 0x8a8c8e,
    ...asphaltSurface().maps(4),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.95,
  });
  const out: THREE.Object3D[] = [];
  for (const [spanStart, spanEnd] of fenceSpans(route)) {
    if (spanEnd - spanStart < 40) continue;
    for (const [start, end] of chunks(spanStart, spanEnd)) {
      for (const side of [-1, 1] as const) {
        const stations: SweepStation[] = [];
        const n = Math.max(1, Math.ceil((end - start) / 12));
        for (let i = 0; i <= n; i++) {
          const s = start + ((end - start) * i) / n;
          stations.push({
            frame: frameAt(s),
            lateral: side * (SERVICE_ROAD.offset + outward(s, side)),
          });
        }
        out.push(
          new THREE.Mesh(
            sweepSection(
              stations,
              [
                [-SERVICE_ROAD.width / 2, GROUND + 0.03],
                [SERVICE_ROAD.width / 2, GROUND + 0.03],
              ],
              { vertical: true },
            ),
            material,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * 水田。
 *
 * 田は「線路に沿った帯」ではなく、畦（あぜ）で仕切られた区画の集まりである。
 * ここでは土地利用が `field` の区間に、線路と平行な帯を数枚並べ、
 * そのあいだに畦を通す。水面は粗さを下げてあるので、空を映して光る。
 */
function buildPaddies(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  seed: number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const water = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    ...paddySurface().maps(4.8),
    normalScale: new THREE.Vector2(0.3, 0.3),
    // 水を張った田は空を映す。粗さを下げるとその照り返しが出るが、
    // 鏡にすると板ガラスに見えるので、風で立つさざ波のぶんだけ濁らせる。
    roughness: 0.62,
    metalness: 0.02,
  });
  const levee = new THREE.MeshStandardMaterial({ color: 0x6a6248, roughness: 0.98 });

  let s = 0;
  while (s < route.length) {
    const zoneStart = Math.floor(s / ZONE_LENGTH) * ZONE_LENGTH;
    const zoneEnd = zoneStart + ZONE_LENGTH;
    s = zoneEnd;
    if (landUseAt(route, zoneStart + 1, seed) !== 'field') continue;
    if (route.tunnels.at(zoneStart + ZONE_LENGTH / 2).length > 0) continue;
    const stations: SweepStation[] = [];
    const n = Math.max(2, Math.ceil(ZONE_LENGTH / 20));
    for (let i = 0; i <= n; i++) {
      stations.push({ frame: frameAt(Math.min(route.length, zoneStart + (ZONE_LENGTH * i) / n)) });
    }
    for (const side of [-1, 1] as const) {
      // 1 区画 18m の田を 3 枚。畦は 0.5m 高くして幅 0.6m
      for (let k = 0; k < 3; k++) {
        const inner = side * (22 + k * 19);
        const outerEdge = side * (22 + k * 19 + 18);
        out.push(
          new THREE.Mesh(
            sweepSection(
              stations,
              [
                // 地表の板（GROUND）より上に置く。下へ潜らせると板に隠れて
                // 畦だけが線になって残り、地面に引っかき傷が付いたように見える。
                [inner, GROUND + 0.04],
                [outerEdge, GROUND + 0.04],
              ],
              { vertical: true },
            ),
            water,
          ),
        );
        out.push(
          new THREE.Mesh(
            sweepSection(
              stations,
              [
                [outerEdge, GROUND + 0.26],
                [outerEdge + side * 0.7, GROUND + 0.26],
              ],
              { vertical: true },
            ),
            levee,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * 遠景の山なみ。
 *
 * 地表の板は線路の左右 260m で尽きる。その先が空だけだと、地平線が
 * **定規で引いた線**になってしまい、どれだけ手前を作り込んでも
 * 「箱庭の中」から出られない。関東平野の縁を走る路線ならどこからでも
 * 見える丘陵を、2.5〜6.5km の距離に置いて空との境目を埋める。
 *
 * 山は自分では色を持たない。指数の霞（`FogExp2`）が距離に応じて空の色を
 * 被せるので、近い尾根ほど暗く緑がかり、遠い尾根ほど空へ溶ける — これが
 * エアリアルパースペクティブそのもので、奥行きはこの重なりで読める。
 */
export function buildHorizon(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const rng = new Rng(0x5eed17);
  const spots: Spot[] = [];
  /** 同じところに山を重ねないための粗い格子（1 マス 700m） */
  const taken = new Set<string>();
  const cell = 700;
  /**
   * 線路の粗い形。
   *
   * 「今いる場所から 4km 横」に山を置くだけでは足りない。この路線は
   * R300 まで含む曲線の連続で、全体では何度も向きを変えるので、
   * ある地点の 4km 横が、別の地点では線路の**真上**になりうる
   * （実際、それで線路の正面に山が生えた）。置く前に路線全体との
   * 距離を見て、`KEEP_CLEAR` より近ければ捨てる。
   */
  const centreline: THREE.Vector3[] = [];
  for (let s = 0; s <= route.length; s += 200) centreline.push(frameAt(s).position.clone());
  const KEEP_CLEAR = 3000;
  const clearOfTrack = (p: THREE.Vector3): boolean => {
    for (const q of centreline) {
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < KEEP_CLEAR * KEEP_CLEAR) return false;
    }
    return true;
  };

  for (let s = 0; s <= route.length; s += 500) {
    const f = frameAt(s);
    for (let k = 0; k < 5; k++) {
      const side = rng.chance(0.5) ? 1 : -1;
      const distance = rng.range(3600, 7200);
      const along = rng.range(-1800, 1800);
      const p = f.position
        .clone()
        .addScaledVector(f.right, side * distance)
        .addScaledVector(f.forward, along);
      const key = `${Math.round(p.x / cell)}/${Math.round(p.z / cell)}`;
      if (taken.has(key)) continue;
      if (!clearOfTrack(p)) continue;
      taken.add(key);
      spots.push({
        // 山は稜線しか見えないので、根元は地表よりだいぶ下でよい
        position: new THREE.Vector3(p.x, f.position.y - 55, p.z),
        quaternion: yawOnly(rng.range(0, Math.PI * 2)),
        // 遠いものほど霞むので、山そのものは同じ色でよい。近い尾根だけ
        // わずかに濃くして、重なりが読めるようにする
        tint: distance < 3800 ? 0x4a5a48 : 0x556450,
      });
    }
  }
  if (spots.length === 0) return [];

  // 尾根の形。円錐を 3 つずらして重ねると、単調な三角形ではなく
  // 「峰がいくつか連なった尾根」の輪郭になる。
  const ridge = mergeGeometries([
    coneAt(0, 0, 0, 950, 250),
    coneAt(800, 0, 240, 740, 180),
    coneAt(-720, 0, -200, 820, 210),
  ]);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const mesh = new THREE.InstancedMesh(ridge, material, spots.length);
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]!;
    mesh.setMatrixAt(i, m.compose(spot.position, spot.quaternion, one));
    mesh.setColorAt(i, color.setHex(spot.tint));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // 山は遠すぎて霞の中にあるので、影を落としても受けても絵は変わらない
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // 空の球（半径 5000m）の外に出る山があるが、空は深度を書かないので
  // 描き順だけで正しく重なる。視錐台の判定は効かせておく。
  mesh.renderOrder = 0;
  return [mesh];
}

function coneAt(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
): THREE.BufferGeometry {
  const geom = new THREE.ConeGeometry(radius, height, 9, 1);
  geom.translate(x, y + height / 2, z);
  return geom;
}

/**
 * トンネル内空の断面（側壁 → アーチ → 側壁）。掃引にも壁面の位置決めにも使う。
 *
 * @param halfWidth 内空の半幅 [m]
 * @param archRise 起拱線から天端までの高さ [m]
 */
function tunnelSection(halfWidth: number, archRise: number): SectionPoint[] {
  const section: SectionPoint[] = [[-halfWidth, TUNNEL.invert]];
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI - (Math.PI * i) / 16;
    // 単線は真円、複線は扁平な楕円のアーチ（実物も 3 心円で扁平になる）
    section.push([halfWidth * Math.cos(a), TUNNEL.springLine + archRise * Math.sin(a)]);
  }
  section.push([halfWidth, TUNNEL.invert]);
  return section;
}

/**
 * トンネルの覆工とその中の設備。
 *
 * ## 単線と複線で断面が違う
 *
 * 在来線の**電化単線トンネル**の内空は、側壁が起拱線（レール面上 2900mm）まで
 * 垂直で、その上が半径 2500mm のアーチ。天端はレール面上 5400mm になり、
 * トロリ線（5000mm）と剛体電車線がぎりぎり収まる。明かり区間のシンプル
 * カテナリ（ちょう架線まで 5960mm）が入らないのはこの断面のためで、
 * トンネルの中だけ架線の形が変わる理由でもある。
 *
 * **複線トンネル**（この路線では `tunnel-2`）は、線路中心間隔 3800mm ぶんだけ
 * 内空が広い。半幅は 4400mm、アーチは扁平にして天端をレール面上 6200mm に
 * 収める（真円で広げると天端が高くなりすぎ、掘る量が跳ね上がる）。実物の
 * 複線トンネルが単線 2 本ではなく 1 本の大きな断面で掘られるのは、
 * **中間の柱が要らず、掘削量が 2 本ぶんより少なくて済む**からである。
 * 断面積が大きいぶん列車が押しのける空気の逃げ場もあり、坑口の圧力波も
 * 車内の耳の詰まりも単線トンネルより穏やかになる。
 *
 * 断面は**線路 2 本の真ん中**に置く。自線だけを中心にすると、隣の線路が
 * 側壁に埋まってしまう。
 *
 * ## 内壁の質感
 *
 * 覆工コンクリートは、断面に沿って 1 枚のテクスチャを貼る（横は 10.5m =
 * 覆工 1 スパンで繰り返し、縦は繰り返さない）。実物の覆工は場所によって
 * 汚れ方がまるで違い、
 *
 *  - 側壁の下部 — 排水と列車の巻き上げで黒い
 *  - 側壁の中ほど — 比較的きれいで、漏水の白い筋が縦に走る
 *  - 天端 — 埃と煤でまた暗い
 *
 * という縦方向の変化がある。これを 1 枚のテクスチャの縦方向に描き込んで
 * おくと、どこを見ても同じのっぺりした灰色、という状態から抜け出せる。
 *
 * ## 中の設備
 *
 * 覆工だけのトンネルは実物にはない。側壁には保守用の歩廊とケーブルラック、
 * 50m ごとの待避坑、20m ごとの照明が付く。照明は自発光の器具だけでなく、
 * 覆工に落ちる光の輪も描くので、光源が壁を照らしているように見える。
 */
export function buildTunnels(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const concrete = concreteSurface();
  const walkwayMaterial = new THREE.MeshStandardMaterial({
    color: 0x8f8a80,
    ...concrete.maps(1.5),
    roughness: 0.95,
    emissive: 0x2a2620,
  });

  for (const span of route.tunnels.all) {
    const mid = (span.start + span.end) / 2;
    // 複線区間の中にあるトンネルは、線路 2 本ぶんの断面で掘られている
    const spacing = route.adjacentTrack.has(mid) ? route.adjacentTrack.spacingAt(mid) : 0;
    const centre = route.adjacentTrack.has(mid) ? route.adjacentTrack.offsetAt(mid) / 2 : 0;
    const halfWidth = spacing / 2 + TUNNEL.arcRadius;
    const archRise = spacing > 0 ? TUNNEL.doubleArchRise : TUNNEL.arcRadius;
    const section = tunnelSection(halfWidth, archRise);
    const perimeter = sectionLength(section);

    const lining = new THREE.MeshStandardMaterial({
      color: 0x9a948a,
      // 太陽光も空からの環境光も届かないので、そのままでは真っ黒になり断面の形も
      // 奥行きも読めない。実物も照明で薄明るいので、わずかな自発光を持たせる。
      // 自発光にも同じテクスチャを掛けて、汚れた部分は光らせない。
      emissive: 0x6a6055,
      emissiveIntensity: 0.42,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const maps = tunnelLiningSurface().maps(10.5, perimeter, true);
    lining.map = maps.map;
    lining.normalMap = maps.normalMap;
    lining.normalScale = new THREE.Vector2(0.8, 0.8);
    lining.emissiveMap = maps.map;

    const step = 4;
    const n = Math.max(2, Math.ceil((span.end - span.start) / step));
    const stations: SweepStation[] = [];
    for (let i = 0; i <= n; i++) {
      stations.push({
        frame: frameAt(span.start + ((span.end - span.start) * i) / n),
        lateral: centre,
      });
    }
    out.push(new THREE.Mesh(sweepSection(stations, section, { vertical: true }), lining));

    // 保守用の歩廊と側溝（両側の壁ぎわ。実物のトンネルにも必ずある）
    for (const side of [-1, 1] as const) {
      const x = side * (halfWidth - 0.02);
      const walkway: SectionPoint[] = [
        [x, TUNNEL.invert],
        [x, TUNNEL.invert + 0.35],
        [x - side * 0.75, TUNNEL.invert + 0.35],
        [x - side * 0.75, TUNNEL.invert + 0.12],
        [x - side * 1.0, TUNNEL.invert + 0.12],
      ];
      out.push(
        new THREE.Mesh(sweepSection(stations, walkway, { vertical: true }), walkwayMaterial),
      );
    }

    // ケーブルラック（信号・電力のケーブルを載せる棚）。側壁の中ほどを走る
    for (const [height, radius] of [
      [1.55, 0.045],
      [1.42, 0.035],
      [1.3, 0.03],
    ] as const) {
      const duct: SectionPoint[] = [
        [-(halfWidth - 0.06), TUNNEL.invert + height + radius],
        [-(halfWidth - 0.06 - radius * 2), TUNNEL.invert + height + radius],
        [-(halfWidth - 0.06 - radius * 2), TUNNEL.invert + height - radius],
        [-(halfWidth - 0.06), TUNNEL.invert + height - radius],
      ];
      out.push(
        new THREE.Mesh(
          sweepSection(stations, duct, { vertical: true, closed: true }),
          new THREE.MeshStandardMaterial({
            color: 0x2a2c2f,
            roughness: 0.8,
            emissive: 0x151312,
          }),
        ),
      );
    }
    // ラックの受け金物（5m ごと）
    out.push(...buildTunnelBrackets(span.start, span.end, frameAt, halfWidth, centre));

    out.push(...buildPortal(frameAt(span.start), halfWidth, archRise, centre));
    out.push(...buildPortal(frameAt(span.end), halfWidth, archRise, centre));
    out.push(...buildRefuges(span.start, span.end, frameAt, halfWidth, centre));
    out.push(...buildTunnelLights(span.start, span.end, frameAt, halfWidth, centre, archRise));
  }
  return out;
}

/** ケーブルラックを覆工に留める受け金物 */
function buildTunnelBrackets(
  start: number,
  end: number,
  frameAt: (s: number) => TrackFrame,
  halfWidth: number,
  centre: number,
): THREE.Object3D[] {
  const count = Math.floor((end - start) / 5);
  if (count <= 0) return [];
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.06, 0.5, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.85, emissive: 0x191817 }),
    count,
  );
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < count; i++) {
    const f = frameAt(start + 2.5 + i * 5);
    const p = f.position
      .clone()
      .addScaledVector(f.right, centre - (halfWidth - 0.11))
      .add(new THREE.Vector3(0, TUNNEL.invert + 1.42, 0));
    mesh.setMatrixAt(i, m.compose(p, frameQuaternion(f, false), one));
  }
  mesh.instanceMatrix.needsUpdate = true;
  return [mesh];
}

/**
 * 坑門。
 *
 * 実物の坑門は、内空を囲う迫石（アーチの縁）と、その両脇の翼壁でできている。
 * トンネルに入る瞬間・出る瞬間にいちばん大きく画面を占めるので、
 * 額縁と翼壁の 2 つだけは形を作っておく。
 */
function buildPortal(
  f: TrackFrame,
  halfWidth: number,
  archRise: number,
  centre: number,
): THREE.Object3D[] {
  const material = new THREE.MeshStandardMaterial({
    color: 0x9c968c,
    ...concreteSurface().maps(2.0),
    roughness: 0.95,
  });
  const group = new THREE.Group();
  const outer = halfWidth + TUNNEL.liningThickness;

  // アーチの縁（内空の周りを 1 周する額縁）。複線では扁平なので、
  // 真円のトーラスを縦に潰して合わせる
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(halfWidth + 0.2, 0.22, 8, 24, Math.PI),
    material,
  );
  ring.rotation.y = Math.PI / 2;
  ring.scale.set(1, archRise / halfWidth, 1);
  ring.position.set(0, TUNNEL.springLine, centre);
  group.add(ring);
  for (const side of [-1, 1] as const) {
    const jamb = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, TUNNEL.springLine - TUNNEL.invert, 0.44),
      material,
    );
    jamb.position.set(
      0,
      (TUNNEL.springLine + TUNNEL.invert) / 2,
      centre + side * (halfWidth + 0.2),
    );
    group.add(jamb);
    // 翼壁（坑口の両脇でのり面を受ける壁）
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.6, 3.4), material);
    wing.position.set(0, TUNNEL.invert + 2.3, centre + side * (outer + 1.5));
    group.add(wing);
  }

  group.quaternion.copy(frameQuaternion(f, false));
  group.position.copy(f.position);
  return [group];
}

/**
 * 待避坑。
 *
 * 保守作業員が列車をやり過ごすための窪みで、50m ごとに側壁を掘り込んである。
 * 暗いトンネルで見つけられるよう、実物は縁を白く塗り、標識を掲げている。
 */
function buildRefuges(
  start: number,
  end: number,
  frameAt: (s: number) => TrackFrame,
  halfWidth: number,
  centre: number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const hollow = new THREE.MeshStandardMaterial({
    color: 0x2a2724,
    roughness: 1,
    emissive: 0x161412,
    side: THREE.DoubleSide,
  });
  const border = new THREE.MeshStandardMaterial({
    color: 0xe8e4d8,
    roughness: 0.8,
    emissive: 0x4a4740,
  });
  const sign = new THREE.MeshBasicMaterial({
    map: plateTexture(['待避'], { background: '#1d5fbf', color: '#ffffff', aspect: 1 }),
  });

  for (let s = start + TUNNEL.refugePitch; s < end; s += TUNNEL.refugePitch) {
    const f = frameAt(s);
    const group = new THREE.Group();
    const w = 1.5;
    const h = 2.1;
    const depth = 0.55;
    const x = centre - (halfWidth - 0.02);

    // 窪みの内側（奥の壁・天井・左右）
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), hollow);
    back.rotation.y = Math.PI / 2;
    back.position.set(0, TUNNEL.invert + h / 2, x - depth);
    group.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, depth), hollow);
    top.rotation.x = Math.PI / 2;
    top.position.set(0, TUNNEL.invert + h, x - depth / 2);
    group.add(top);
    for (const dx of [-w / 2, w / 2]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), hollow);
      side.rotation.y = Math.PI / 2;
      side.rotation.x = Math.PI / 2;
      side.position.set(dx, TUNNEL.invert + h / 2, x - depth / 2);
      group.add(side);
    }

    // 白い縁取り（上枠と左右の枠）
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.14, 0.1), border);
    lintel.position.set(0, TUNNEL.invert + h + 0.07, x + 0.02);
    group.add(lintel);
    for (const dx of [-(w / 2 + 0.07), w / 2 + 0.07]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.14, h, 0.1), border);
      jamb.position.set(dx, TUNNEL.invert + h / 2, x + 0.02);
      group.add(jamb);
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), sign);
    plate.rotation.y = Math.PI / 2;
    plate.position.set(0, TUNNEL.invert + h + 0.32, x + 0.03);
    group.add(plate);

    group.quaternion.copy(frameQuaternion(f, false));
    group.position.copy(f.position);
    out.push(group);
  }
  return out;
}

/**
 * トンネル照明。
 *
 * 側壁の上寄りに 20m 間隔で並ぶ。等間隔に流れていく光の列が、トンネルの中で
 * いちばん速度感を出す。器具そのものに加えて、覆工に落ちる光の輪も描く
 * （加算合成の板）。光源が壁を照らしていることが分かると、トンネルの中の
 * 奥行きが一気に読めるようになる。
 */
function buildTunnelLights(
  start: number,
  end: number,
  frameAt: (s: number) => TrackFrame,
  halfWidth: number,
  centre: number,
  archRise: number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const count = Math.floor((end - start) / 20);
  if (count <= 0) return out;

  const lamps = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.1, 0.09, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xffeec2 }),
    count,
  );
  const housings = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.24, 0.16, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x4a4a48, roughness: 0.7, emissive: 0x201f1d }),
    count,
  );
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    color: 0xffe3a8,
  });

  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < count; i++) {
    const f = frameAt(start + 10 + i * 20);
    const q = frameQuaternion(f, false);
    const p = f.position
      .clone()
      .addScaledVector(f.right, centre - (halfWidth - 0.14))
      .add(new THREE.Vector3(0, TUNNEL.springLine + archRise * 0.15, 0));
    lamps.setMatrixAt(i, m.compose(p, q, one));
    housings.setMatrixAt(i, m.compose(p.clone().addScaledVector(f.right, -0.06), q, one));

    // 覆工に落ちる光。壁に沿わせた板を加算合成で重ねる
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), glowMaterial);
    glow.quaternion.copy(q);
    glow.rotateY(Math.PI / 2);
    glow.position.copy(p).addScaledVector(f.right, 0.06);
    out.push(glow);
  }
  lamps.instanceMatrix.needsUpdate = true;
  housings.instanceMatrix.needsUpdate = true;
  out.push(lamps, housings);
  return out;
}
