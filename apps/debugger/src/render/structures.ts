import * as THREE from 'three';
import { bridgeLength, crossingEdges, type Bridge, type CompiledRoute } from '@railsim/core';
import { BALLAST, BRIDGE, CROSSING, RAIL, SLEEPER } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import {
  frameQuaternion,
  meterPlane,
  sweepSection,
  type SectionPoint,
  type SweepStation,
} from './geometry.ts';
import {
  asphaltSurface,
  barrierStripeTexture,
  concreteSurface,
  crossingMarkTexture,
  glowTexture,
  rippleSurface,
  rustedSteelSurface,
} from './textures.ts';
import { hdrColor } from './postprocess.ts';

/**
 * 橋りょうと踏切。
 *
 * どちらも「線路がふつうの路盤の上を走っていない場所」で、走行音が変わるのと
 * 同じ理由（道床が無い・道路が横切る）で見た目も変わる。音の側（`bridgeAcoustics()`・
 * `LevelCrossingSystem`）が使う寸法と同じものからここも組み立てる。
 */

const STEEL_COLOR = 0x6d7a80;
const CONCRETE_COLOR = 0xa8a49b;

/** 桁の鋼材。屋外で塗り直しながら使われるので、錆と塗膜の混じった質感になる */
function steelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: STEEL_COLOR,
    ...rustedSteelSurface().maps(1.6, 0.5),
    normalScale: new THREE.Vector2(0.5, 0.5),
    metalness: 0.55,
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
}

function concreteMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: CONCRETE_COLOR,
    ...concreteSurface().maps(1.5),
    roughness: 0.95,
  });
}

/** 橋の下の地面をどれだけ掘り下げるか [m]（桁下の余裕を確保する） */
export function bridgeValleyDepth(bridge: Bridge): number {
  return girderBottom(bridge) * -1 + BRIDGE.clearance;
}

/** 桁の下端の高さ（レール面を 0 とする） */
function girderBottom(bridge: Bridge): number {
  if (bridge.kind === 'truss') return -0.9;
  if (bridge.kind === 'concrete') return deckSlabTop(bridge) - bridge.girderDepth;
  return BRIDGE.deckTop - bridge.girderDepth;
}

/** 有道床橋の床版の上面（道床の下） */
function deckSlabTop(_bridge: Bridge): number {
  return -RAIL.height - SLEEPER.height - BALLAST.depth;
}

/**
 * 距離程 `s` で地面をどれだけ下げるか [m]。
 *
 * 橋は谷や川を渡るために架けるものなので、桁の下には空間が要る。橋の前後 30m で
 * なだらかに落とし、橋の区間はまるごと掘り下げる。掘らないと、地表の板が桁を
 * 突き抜けて「地面の上に架かった橋」になってしまう。
 */
export function groundDepressionAt(route: CompiledRoute, s: number): number {
  let deepest = 0;
  for (const bridge of route.bridges.bridges) {
    const ramp = 30;
    if (s < bridge.start - ramp || s > bridge.end + ramp) continue;
    const t =
      s < bridge.start
        ? (s - (bridge.start - ramp)) / ramp
        : s > bridge.end
          ? (bridge.end + ramp - s) / ramp
          : 1;
    // 端は余弦で丸める（角のある谷にしない）
    const shape = 0.5 * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t))));
    deepest = Math.max(deepest, bridgeValleyDepth(bridge) * shape);
  }
  return deepest;
}

/** 橋りょうを組み立てる */
export function buildBridges(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const steel = steelMaterial();
  const concrete = concreteMaterial();

  for (const bridge of route.bridges.bridges) {
    const stations = stationsBetween(bridge.start, bridge.end, frameAt);
    switch (bridge.kind) {
      case 'plate-girder':
        out.push(...buildPlateGirder(bridge, stations, steel));
        break;
      case 'truss':
        out.push(...buildTruss(bridge, stations, frameAt, steel));
        break;
      case 'concrete':
        out.push(...buildConcreteGirder(bridge, stations, concrete));
        break;
    }
    if (bridge.deck === 'ballasted' && bridge.kind !== 'concrete') {
      // 有道床の鋼橋は、桁の上に道床を受ける床版（バラスト止め）が乗る
      out.push(
        new THREE.Mesh(sweepSection(stations, ballastTroughSection(), { closed: true }), concrete),
      );
    }
    out.push(...buildPiers(bridge, frameAt, concrete));
    out.push(...buildParapets(bridge, stations, steel));
    out.push(buildWater(bridge, frameAt));
  }
  return out;
}

/** 橋の区間に沿ったステーション（曲線でも桁が線形に沿うようにする） */
function stationsBetween(
  start: number,
  end: number,
  frameAt: (s: number) => TrackFrame,
  step = 5,
): SweepStation[] {
  const n = Math.max(1, Math.ceil((end - start) / step));
  const out: SweepStation[] = [];
  for (let i = 0; i <= n; i++) out.push({ frame: frameAt(start + ((end - start) * i) / n) });
  return out;
}

/** 道床を受けるコンクリートの樋（有道床の鋼橋） */
function ballastTroughSection(): SectionPoint[] {
  const top = deckSlabTop({} as Bridge);
  const half = SLEEPER.length / 2 + BALLAST.shoulder;
  return [
    [-half - 0.2, top + 0.5],
    [-half - 0.2, top - 0.3],
    [half + 0.2, top - 0.3],
    [half + 0.2, top + 0.5],
    [half, top + 0.5],
    [half, top],
    [-half, top],
    [-half, top + 0.5],
  ];
}

/**
 * 上路プレートガーダー橋。
 *
 * まくらぎのすぐ下に 2 本の I 桁が走り、その腹板が音を出す。断面を線形に沿って
 * 掃引するので、曲線上の橋でも桁が線形どおりにねじれる。
 */
function buildPlateGirder(
  bridge: Bridge,
  stations: readonly SweepStation[],
  material: THREE.Material,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const top = BRIDGE.deckTop;
  const bottom = top - bridge.girderDepth;
  const web = BRIDGE.webThickness / 2;
  const flange = BRIDGE.flangeWidth / 2;
  const t = BRIDGE.flangeThickness;

  for (const side of [-1, 1] as const) {
    const centre = side * (BRIDGE.girderSpacing / 2);
    // I 形の輪郭（上フランジ → 腹板 → 下フランジ）を右回りに一周する
    const section: SectionPoint[] = [
      [centre - flange, top],
      [centre + flange, top],
      [centre + flange, top - t],
      [centre + web, top - t],
      [centre + web, bottom + t],
      [centre + flange, bottom + t],
      [centre + flange, bottom],
      [centre - flange, bottom],
      [centre - flange, bottom + t],
      [centre - web, bottom + t],
      [centre - web, top - t],
      [centre - flange, top - t],
    ];
    out.push(new THREE.Mesh(sweepSection(stations, section, { closed: true }), material));
  }

  // 垂直補剛材（腹板を区切る板。音の単位でもある）
  const spacing = bridge.panel.width;
  const count = Math.floor(bridgeLength(bridge) / spacing);
  if (count > 0) {
    const stiffener = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.04, bridge.girderDepth * 0.92, 0.22),
      material,
      count * 2,
    );
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const f = frameOf(stations, i / count);
      const q = frameQuaternion(f, false);
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        p.copy(f.position)
          .addScaledVector(f.right, side * (BRIDGE.girderSpacing / 2 + 0.12))
          .add(new THREE.Vector3(0, (top + bottom) / 2, 0));
        stiffener.setMatrixAt(i * 2 + k, m.compose(p, q, one));
      }
    }
    stiffener.instanceMatrix.needsUpdate = true;
    out.push(stiffener);
  }
  return out;
}

/** ステーション列を 0..1 で内挿して座標系を取り出す（近いほうへ丸める） */
function frameOf(stations: readonly SweepStation[], t: number): TrackFrame {
  const index = Math.round(t * (stations.length - 1));
  return stations[Math.max(0, Math.min(stations.length - 1, index))]!.frame;
}

/**
 * 下路トラス橋。
 *
 * 列車が主構のあいだを通るので、両脇と頭上を鋼材が囲む。音がよく反響するのも、
 * 運転席から見て圧迫感があるのも同じ理由による。
 */
function buildTruss(
  bridge: Bridge,
  stations: readonly SweepStation[],
  frameAt: (s: number) => TrackFrame,
  material: THREE.Material,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const half = BRIDGE.trussSpacing / 2;
  const size = BRIDGE.memberSize;
  const bottom = -0.6;
  const top = bottom + bridge.girderDepth;

  // 上弦材・下弦材（線形に沿って通す）
  for (const side of [-1, 1] as const) {
    for (const height of [bottom, top]) {
      const section: SectionPoint[] = [
        [side * half - size / 2, height - size / 2],
        [side * half + size / 2, height - size / 2],
        [side * half + size / 2, height + size / 2],
        [side * half - size / 2, height + size / 2],
      ];
      out.push(new THREE.Mesh(sweepSection(stations, section, { closed: true }), material));
    }
  }

  // 斜材と垂直材。格間長は主構高の 0.8 倍前後が普通。
  const panel = Math.max(4, bridge.girderDepth * 0.8);
  const length = bridgeLength(bridge);
  const panels = Math.max(2, Math.round(length / panel));
  const geometry = new THREE.BoxGeometry(size * 0.7, 1, size * 0.7);
  for (let i = 0; i <= panels; i++) {
    const s = bridge.start + (length * i) / panels;
    const f = frameAt(s);
    const q = frameQuaternion(f, false);
    for (const side of [-1, 1] as const) {
      // 垂直材
      const post = new THREE.Mesh(geometry, material);
      post.quaternion.copy(q);
      post.scale.y = bridge.girderDepth;
      post.position
        .copy(f.position)
        .addScaledVector(f.right, side * half)
        .add(new THREE.Vector3(0, (bottom + top) / 2, 0));
      out.push(post);

      // 斜材（1 格間ぶんを斜めに渡す。向きは格間ごとに互い違い）
      if (i === panels) continue;
      const run = length / panels;
      const diagonal = new THREE.Mesh(geometry, material);
      const rise = bridge.girderDepth;
      diagonal.scale.y = Math.hypot(run, rise);
      const next = frameAt(s + run);
      const mid = f.position.clone().add(next.position).multiplyScalar(0.5);
      diagonal.quaternion.copy(q);
      diagonal.rotateZ((i % 2 === 0 ? 1 : -1) * Math.atan2(run, rise));
      diagonal.position
        .copy(mid)
        .addScaledVector(f.right, side * half)
        .add(new THREE.Vector3(0, (bottom + top) / 2, 0));
      out.push(diagonal);
    }

    // 横構（左右の主構を頭上でつなぐ）。橋の中を通っている感じはこれで出る。
    const brace = new THREE.Mesh(
      new THREE.BoxGeometry(size * 0.6, size * 0.6, BRIDGE.trussSpacing),
      material,
    );
    brace.quaternion.copy(q);
    brace.position.copy(f.position).add(new THREE.Vector3(0, top, 0));
    out.push(brace);
  }

  // 床組（縦桁・横桁）。音を出しているのはこの板である。
  const floor: SectionPoint[] = [
    [-1.4, bottom + 0.05],
    [1.4, bottom + 0.05],
    [1.4, bottom + 0.05 - bridge.panel.height],
    [-1.4, bottom + 0.05 - bridge.panel.height],
  ];
  out.push(new THREE.Mesh(sweepSection(stations, floor, { closed: true }), material));
  return out;
}

/** コンクリート桁（有道床）。道床を受ける箱形の床版が線形に沿って続く。 */
function buildConcreteGirder(
  bridge: Bridge,
  stations: readonly SweepStation[],
  material: THREE.Material,
): THREE.Object3D[] {
  const top = deckSlabTop(bridge);
  const bottom = top - bridge.girderDepth;
  const half = SLEEPER.length / 2 + BALLAST.shoulder + 0.3;
  const section: SectionPoint[] = [
    [-half, top + 0.55],
    [-half, top - 0.25],
    [-half + 0.5, bottom],
    [half - 0.5, bottom],
    [half, top - 0.25],
    [half, top + 0.55],
    [half - 0.3, top + 0.55],
    [half - 0.3, top],
    [-half + 0.3, top],
    [-half + 0.3, top + 0.55],
  ];
  return [new THREE.Mesh(sweepSection(stations, section, { closed: true }), material)];
}

/** 橋脚と橋台。支間ごとに 1 基立つので、支間長がそのまま見た目に出る。 */
function buildPiers(
  bridge: Bridge,
  frameAt: (s: number) => TrackFrame,
  material: THREE.Material,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const length = bridgeLength(bridge);
  const spans = Math.max(1, Math.round(length / bridge.spanLength));
  const bottom = girderBottom(bridge);
  const floor = -bridgeValleyDepth(bridge);
  const height = bottom - floor;
  if (height <= 0) return out;

  for (let i = 0; i <= spans; i++) {
    const s = bridge.start + (length * i) / spans;
    const f = frameAt(s);
    const end = i === 0 || i === spans;
    const pier = new THREE.Mesh(
      new THREE.BoxGeometry(
        end ? BRIDGE.pierWidth * 2 : BRIDGE.pierWidth,
        height,
        BRIDGE.pierLength,
      ),
      material,
    );
    pier.quaternion.copy(frameQuaternion(f, false));
    pier.position.copy(f.position).add(new THREE.Vector3(0, floor + height / 2, 0));
    out.push(pier);
  }
  return out;
}

/** 高欄（保守で人が渡るときの手すり）。橋の上だけに現れる細い線が速度感を出す。 */
function buildParapets(
  bridge: Bridge,
  stations: readonly SweepStation[],
  material: THREE.Material,
): THREE.Object3D[] {
  const base = bridge.kind === 'truss' ? -0.55 : BRIDGE.deckTop;
  const out: THREE.Object3D[] = [];
  for (const side of [-1, 1] as const) {
    const lateral = side * BRIDGE.parapetOffset;
    for (const height of [base + BRIDGE.parapetHeight, base + BRIDGE.parapetHeight * 0.55]) {
      const section: SectionPoint[] = [
        [lateral - 0.03, height - 0.03],
        [lateral + 0.03, height - 0.03],
        [lateral + 0.03, height + 0.03],
        [lateral - 0.03, height + 0.03],
      ];
      out.push(new THREE.Mesh(sweepSection(stations, section, { closed: true }), material));
    }
  }
  return out;
}

/** 橋の下の水面。谷底に張るだけだが、これがあると橋が「渡っている」ものに見える。 */
function buildWater(bridge: Bridge, frameAt: (s: number) => TrackFrame): THREE.Object3D {
  const length = bridgeLength(bridge) + 60;
  const mid = frameAt((bridge.start + bridge.end) / 2);
  // 水面は「色」ではなく「傾きの分布」で水に見える。さざ波の法線を貼ると、
  // 映り込んだ空が割れて、平らな板から水面になる。色そのものは濁った緑がかった
  // 灰で、日本の中小河川はたいていこの色をしている（澄んだ青ではない）。
  const ripple = rippleSurface().maps(0.4);
  const water = new THREE.Mesh(
    meterPlane(length, 90),
    new THREE.MeshStandardMaterial({
      color: 0x40534f,
      normalMap: ripple.normalMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: 0.16,
      metalness: 0.25,
    }),
  );
  // 板は線路方向 × 直角方向に寝かせる（`meterPlane` は縦の板として作られるので、
  // 軌道の座標系へ載せてから 2 回まわして水平にする）
  water.quaternion.copy(frameQuaternion(mid, false));
  water.rotateX(-Math.PI / 2);
  water.rotateZ(Math.PI / 2);
  // 水面は谷底のすこし上。勾配のある橋でも中央の高さに合わせて 1 枚張る。
  water.position.copy(mid.position).add(new THREE.Vector3(0, -bridgeValleyDepth(bridge) + 0.6, 0));
  return water;
}

/** 踏切 1 か所の可動部 */
export interface CrossingHandle {
  /** 遮断桿の下がり具合 0（上）..1（下）と、警報灯の点滅を反映する */
  update(barrier: number, ringing: boolean, time: number): void;
}

/** 警報灯が左右交互に点滅する周期 [Hz]（実物も 1 秒に 1 往復ほど） */
const LAMP_RATE = 1.0;

const LAMP_ON = 0xff2a1c;
const LAMP_OFF = 0x3a1512;
/**
 * 点灯した警報灯の輝度倍率。
 *
 * 踏切の警報灯は、昼間に道路から見て分かるだけの光度を持つ。画面の白に
 * 収めず 1 を超える値にして、後処理のブルームでにじませる（`postprocess.ts`）。
 */
const LAMP_GAIN = 3.0;

/**
 * 踏切道。
 *
 * 道路・踏切板・警報機・遮断機を組み立てる。位置と幅は路線データの寸法をそのまま
 * 使うので、**音が鳴る場所と目に見える踏切が一致する**（踏切板の目地を踏む音は
 * 踏切道の入口と出口で鳴り、その入口と出口はここで描いている縁と同じ点である）。
 */
export function buildLevelCrossings(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): { objects: THREE.Object3D[]; handles: Map<string, CrossingHandle> } {
  const objects: THREE.Object3D[] = [];
  const handles = new Map<string, CrossingHandle>();

  const asphalt = new THREE.MeshStandardMaterial({
    color: 0xa0a2a6,
    ...asphaltSurface().maps(4),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.97,
  });
  // 踏切の手前はカラー舗装（赤褐色）にして、運転者に踏切だと知らせる。
  // 実物も同じ理由で、停止線から踏切道までを着色してある。
  const coloured = new THREE.MeshStandardMaterial({
    color: 0x9a4a34,
    ...asphaltSurface().maps(4),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.95,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x6b6357,
    ...concreteSurface().maps(1.2),
    roughness: 0.9,
  });
  const postMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8d5cc,
    metalness: 0.3,
    roughness: 0.7,
  });
  const stripeTexture = barrierStripeTexture();
  // 縞の実寸は 300mm。竿の長さに応じて繰り返す（下で竿ごとに複製する）
  const stripeMaterial = new THREE.MeshStandardMaterial({
    map: stripeTexture,
    roughness: 0.7,
  });
  const markMaterial = new THREE.MeshBasicMaterial({
    map: crossingMarkTexture(),
    transparent: true,
    side: THREE.DoubleSide,
  });

  for (const crossing of route.levelCrossings.crossings) {
    const [entry, exit] = crossingEdges(crossing);
    const f = frameAt(crossing.position);
    const q = frameQuaternion(f, false);
    const group = new THREE.Group();
    group.quaternion.copy(q);
    group.position.copy(f.position);

    /**
     * 道路が渡る線路。
     *
     * 複線区間の踏切（この路線では `xg-4`）では、道路は**線路 2 本**を渡る。
     * 踏切板も遮断桿も 2 本ぶんの幅が要るので、隣の線路の位置
     * （`AdjacentTrack.offsetAt()`）を読んで用意する。単線区間では
     * 0 が返るので、線路 1 本ぶんのままになる。
     */
    const adjacent = route.adjacentTrack.offsetAt(crossing.position);
    const laterals = adjacent === 0 ? [0] : [0, adjacent];
    /** 踏切道が塞ぐ範囲（軌道中心からの左右）。遮断機と警報機はこの外に建つ */
    const spanLeft = Math.min(0, adjacent);
    const spanRight = Math.max(0, adjacent);

    // 道路（線路の左右へ伸びる舗装）。線路の高さに合わせるので、踏切の前後で
    // 道路がわずかに盛り上がっているように見える。
    const road = new THREE.Mesh(
      meterPlane(crossing.roadWidth, CROSSING.roadLength + Math.abs(adjacent)),
      asphalt,
    );
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = Math.PI / 2;
    road.position.set(0, -RAIL.height + 0.02, adjacent / 2);
    group.add(road);

    // カラー舗装（踏切道の手前 8m ずつ）
    for (const sign of [-1, 1] as const) {
      const strip = new THREE.Mesh(meterPlane(crossing.roadWidth, 8), coloured);
      strip.rotation.x = -Math.PI / 2;
      strip.rotation.z = Math.PI / 2;
      strip.position.set(
        0,
        -RAIL.height + 0.025,
        sign > 0 ? spanRight + 4.5 + 4 : spanLeft - 4.5 - 4,
      );
      group.add(strip);
    }

    // 踏切板（軌道内と軌道の外側。レール頭頂面のすぐ下）
    const gauge = route.alignment.gauge;
    for (const centre of laterals) {
      for (const [width, offset] of [
        [gauge - 0.1, 0],
        [0.6, gauge / 2 + 0.45],
        [0.6, -(gauge / 2 + 0.45)],
      ] as const) {
        const board = new THREE.Mesh(meterPlane(crossing.roadWidth, width), panel);
        board.rotation.x = -Math.PI / 2;
        board.rotation.z = Math.PI / 2;
        board.position.set(0, CROSSING.panelTop, centre + offset);
        group.add(board);
      }
    }
    // 線路と線路のあいだ（複線のときだけ）。実物もここは舗装で埋めてある
    if (adjacent !== 0) {
      const between = new THREE.Mesh(
        meterPlane(crossing.roadWidth, Math.abs(adjacent) - gauge - 0.9),
        panel,
      );
      between.rotation.x = -Math.PI / 2;
      between.rotation.z = Math.PI / 2;
      between.position.set(0, CROSSING.panelTop, adjacent / 2);
      group.add(between);
    }

    // 警報機と遮断機は道路の両側に建つ。線路方向には踏切道の外側へ少し出る。
    const lamps: Array<[THREE.Mesh, THREE.Mesh]> = [];
    const halos: Array<[THREE.Mesh, THREE.Mesh]> = [];
    const arms: THREE.Object3D[] = [];
    for (const side of [-1, 1] as const) {
      const along = side * (crossing.roadWidth / 2 + 1.2);
      // 複線では、外側の線路よりさらに外へ建てる
      const lateral = (side > 0 ? spanRight : spanLeft) + side * CROSSING.postOffset;
      const ground = -RAIL.height - SLEEPER.height - BALLAST.depth;

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(
          CROSSING.postDiameter / 2,
          CROSSING.postDiameter / 2,
          CROSSING.postHeight,
          8,
        ),
        postMaterial,
      );
      post.position.set(along, ground + CROSSING.postHeight / 2, lateral);
      group.add(post);

      // 警報灯 2 個と、その光のにじみ。交互に点くのでにじみも別々に切り替える。
      const pair: [THREE.Mesh, THREE.Mesh] = [
        makeLamp(along, ground + CROSSING.lampHeight, lateral, -CROSSING.lampSpacing / 2),
        makeLamp(along, ground + CROSSING.lampHeight, lateral, CROSSING.lampSpacing / 2),
      ];
      const glowPair: [THREE.Mesh, THREE.Mesh] = [
        makeHalo(along, ground + CROSSING.lampHeight, lateral, -CROSSING.lampSpacing / 2),
        makeHalo(along, ground + CROSSING.lampHeight, lateral, CROSSING.lampSpacing / 2),
      ];
      for (const lamp of pair) group.add(lamp);
      for (const halo of glowPair) group.add(halo);

      // 踏切警標（黄色の×印）。警報灯の上に道路へ向けて掲げる。
      // 道路は線路と直交しているので、板は線路と平行な面を向く。
      for (const face of [-1, 1] as const) {
        const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), markMaterial);
        mark.rotation.y = face > 0 ? 0 : Math.PI;
        mark.position.set(along + face * 0.05, ground + CROSSING.lampHeight + 0.72, lateral);
        group.add(mark);
      }
      lamps.push(pair);
      halos.push(glowPair);

      // 遮断桿。
      //
      // 塞ぐのは**道路**であって線路ではないので、竿は線路と平行に伸びる。
      // 道路は線路を横切って走っているから、その車線を塞ぐには線路方向へ
      // 竿を渡すことになる。柱は線路の片側に 1 本ずつ立ち、それぞれが
      // 自分の側の車線を受け持つ。
      const armLength = crossing.roadWidth / 2 + 1.2;
      const pivot = new THREE.Group();
      pivot.position.set(along, ground + 1.0, lateral);
      // 縞は 300mm ごと。竿の長さに合わせて繰り返し数を決める（材質は共有し、
      // テクスチャだけ複製する）
      const armMaterial = stripeMaterial.clone();
      armMaterial.map = stripeTexture.clone();
      armMaterial.map.repeat.set(armLength / 0.6, 1);
      armMaterial.map.needsUpdate = true;
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(armLength, CROSSING.barrierDiameter, CROSSING.barrierDiameter),
        armMaterial,
      );
      // 竿は根元から踏切道の中央へ向かって伸びる
      arm.position.set(-side * (armLength / 2), 0, 0);
      // 上がっているときは鉛直に立ち、下りると水平になる
      pivot.userData.side = side;
      pivot.add(arm);
      group.add(pivot);
      arms.push(pivot);
    }

    // 踏切の入口と出口（音が鳴る点）に白線を引く。目地の位置がそのまま見える。
    for (const s of [entry, exit]) {
      const edge = new THREE.Mesh(
        meterPlane(0.12, CROSSING.roadLength),
        new THREE.MeshStandardMaterial({ color: 0xdad7cc, roughness: 0.9 }),
      );
      const ef = frameAt(s);
      edge.quaternion.copy(frameQuaternion(ef, false));
      edge.rotateX(-Math.PI / 2);
      edge.rotateZ(Math.PI / 2);
      edge.position.copy(ef.position).add(new THREE.Vector3(0, -RAIL.height + 0.03, 0));
      objects.push(edge);
    }

    objects.push(group);
    handles.set(crossing.id, {
      update(barrier: number, ringing: boolean, time: number): void {
        // 竿は鉛直（0）から水平（1）へ倒れる。倒れる向きは柱がどちら側に
        // 立っているかで決まる（自分の受け持つ車線のほうへ倒れる）。
        for (const pivot of arms) {
          const side = pivot.userData.side as number;
          pivot.rotation.z = -side * (Math.PI / 2) * (1 - barrier);
        }
        const phase = ringing ? Math.floor(time * LAMP_RATE * 2) % 2 : -1;
        for (let post = 0; post < lamps.length; post++) {
          for (let k = 0; k < 2; k++) {
            const on = phase === k;
            (lamps[post]![k]!.material as THREE.MeshBasicMaterial).color.copy(
              on ? hdrColor(LAMP_ON, LAMP_GAIN) : hdrColor(LAMP_OFF, 1),
            );
            halos[post]![k]!.visible = on;
          }
        }
      },
    });
  }

  return { objects, handles };
}

/** 警報灯のレンズ（点灯すると自ら光って見えるよう基本材質にする） */
function makeLamp(along: number, height: number, lateral: number, offset: number): THREE.Mesh {
  const lamp = new THREE.Mesh(
    new THREE.CircleGeometry(CROSSING.lampDiameter / 2, 14),
    new THREE.MeshBasicMaterial({ color: LAMP_OFF, side: THREE.DoubleSide }),
  );
  lamp.position.set(along, height, lateral + offset);
  return lamp;
}

/** 点灯した警報灯のにじみ */
function makeHalo(along: number, height: number, lateral: number, offset: number): THREE.Mesh {
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.7),
    new THREE.MeshBasicMaterial({
      map: glowTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: LAMP_ON,
    }),
  );
  halo.position.set(along, height, lateral + offset);
  halo.visible = false;
  return halo;
}
