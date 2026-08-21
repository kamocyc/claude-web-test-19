import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';
import { PLATFORM, STATION } from './dimensions.ts';
import { frameQuaternion, meterBox, meterPlane } from './geometry.ts';
import type { TrackFrame } from './frame.ts';
import {
  concreteSurface,
  glowTexture,
  plateTexture,
  roofPanelSurface,
  roofTileSurface,
  sidingSurface,
  stationSignTexture,
} from './textures.ts';

/**
 * 駅の「性格」を作るもの — 駅舎・改札・番線標・車止め。
 *
 * ## なぜ駅ごとに変える必要があるか
 *
 * ホーム・上屋・駅名標だけを同じ形で 5 か所に置くと、**同じ駅を 5 回通過する
 * 絵**になる。実際の路線でそうならないのは、駅の形が「その駅が何をする駅か」で
 * 決まっているからである。
 *
 *  - **棒線駅**（行き違いのできない中間駅） — 駅舎を持たないことが多い。
 *    ホームから直接階段で道路へ降りる。待合所が唯一の建物。
 *  - **交換可能駅**（単線で行き違う駅） — 木造平屋の駅舎が 1 番線側に建ち、
 *    改札は 1〜2 通路。跨線橋か構内踏切で 2 番線へ渡る。
 *  - **複線区間の中間駅** — 乗降が多いのでコンクリートの地上駅舎、改札 4 通路。
 *    2 面 2 線を跨線橋で結ぶ。
 *  - **橋上駅** — 線路の上に駅舎を載せ、両側の街から入れるようにしたもの。
 *    高度成長期以降に改築された駅はほとんどこれで、跨線橋と駅舎が一体になる。
 *  - **終点** — 線路が車止めで終わり、その先に頭端側の駅舎が建つ。
 *
 * この違いは遠くからでも輪郭で分かるので、駅ごとに何が建っているかを変えれば
 * 「別の駅へ着いた」と読める。
 *
 * ## 寸法の出どころ
 *
 * 実寸は `dimensions.ts` の `STATION`（出典つき）に集めてある。ここはその値を
 * 使って形を組むだけで、数値そのものは持たない。
 */

/** 駅に建つものの組み合わせ */
export interface StationCharacter {
  /** 駅舎の型 */
  readonly building: 'none' | 'hut' | 'ground' | 'overhead' | 'terminus';
  /** 改札の通路数（0 なら無人駅） */
  readonly gates: number;
  /** 終端に車止めを置くか */
  readonly bufferStop: boolean;
}

/**
 * その駅の性格を決める。
 *
 * **線形データだけから決める。**駅ごとに名前で場合分けすると、路線を差し替えた
 * ときに「知らない駅は全部同じ形」になってしまう。ここでは
 * 「隣に線路があるか」「終点か」「何番目の駅か」という、どの路線にもある情報から
 * 選ぶ。
 */
export function stationCharacter(
  route: CompiledRoute,
  station: CompiledRoute['stations'][number],
  index: number,
): StationCharacter {
  const adjacent = Math.abs(route.adjacentTrack.offsetAt(station.stopPosition));
  const passing = adjacent > 2.5;
  // 終点は「これより先に駅が無く、線路の終わりが近い」駅
  const terminus = station.stopPosition > route.length - 400;
  if (terminus) return { building: 'terminus', gates: 6, bufferStop: true };
  // 行き違いのできない駅は棒線駅。無人で駅舎を持たない
  if (!passing) return { building: 'none', gates: 0, bufferStop: false };
  // 交換可能駅（起点側）は木造平屋、その先の複線区間の駅は地上駅舎と橋上駅舎を
  // 1 つずつ。並んだときに輪郭が全部違うようにする
  if (index === 0) return { building: 'hut', gates: 2, bufferStop: false };
  return index % 2 === 0
    ? { building: 'ground', gates: 4, bufferStop: false }
    : { building: 'overhead', gates: 4, bufferStop: false };
}

/** 跨線橋を架けるか（橋上駅舎はそれ自体が跨線橋を兼ねる） */
export function needsFootbridge(character: StationCharacter): boolean {
  return character.building !== 'none';
}

/**
 * 駅舎・改札・番線標・車止めを組む。
 *
 * ホーム（`wayside.ts` の `buildPlatform`）と同じ座標の取り方をする:
 * 軌道中心から左が負、レール面が高さ 0、地表は -1.2m。
 */
export function buildStationExtras(
  route: CompiledRoute,
  station: CompiledRoute['stations'][number],
  frameAt: (s: number) => TrackFrame,
  character: StationCharacter,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const mid = (station.platformEnd + station.platformStart) / 2;
  const length = station.platformEnd - station.platformStart;
  const adjacent = route.adjacentTrack.offsetAt(station.stopPosition);

  /** ホーム背面の位置（軌道中心から左へ） */
  const back = -(PLATFORM.edgeOffset + PLATFORM.width);

  const materials = stationMaterials();

  /** 駅の中心を原点として、横 `lateral`・高さ `height`・線路方向 `along` へ置く */
  const place = <T extends THREE.Object3D>(
    object: T,
    lateral: number,
    height: number,
    along: number,
  ): T => {
    const f = frameAt(mid + along);
    const local = object.quaternion.clone();
    object.quaternion.copy(frameQuaternion(f, false)).multiply(local);
    object.position
      .copy(f.position)
      .addScaledVector(f.right, lateral)
      .add(new THREE.Vector3(0, height, 0));
    return object;
  };

  // --- 番線標 ---
  //
  // 「1 番線」「2 番線」を上屋から吊る。**行き違いのできる駅にしか無い**
  // （1 面しかない駅で番線を名乗る必要がない）。これが吊ってあるかどうかで、
  // 通過しながらでも交換駅かどうかが読める。
  if (Math.abs(adjacent) > 2.5) {
    const side: 1 | -1 = adjacent > 0 ? 1 : -1;
    const faces: Array<[number, string]> = [
      [-(PLATFORM.edgeOffset + 1.4), '1'],
      [adjacent + side * (PLATFORM.edgeOffset + 1.4), '2'],
    ];
    for (const [lateral, number] of faces) {
      const sign = new THREE.Group();
      const texture = plateTexture([`${number} 番線`], {
        aspect: 2.6,
        background: '#1f4f8c',
        color: '#ffffff',
      });
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 });
      const geometry = new THREE.PlaneGeometry(1.1, 0.42);
      // 両面に文字を入れる（1 枚の板を両面表示にすると裏から鏡像に見える）
      for (const s of [-1, 1] as const) {
        const face = new THREE.Mesh(geometry, material);
        face.rotation.y = s > 0 ? 0 : Math.PI;
        face.position.z = s * 0.01;
        sign.add(face);
      }
      out.push(place(sign, lateral, PLATFORM.height + PLATFORM.roofHeight - 1.5, -length * 0.32));
    }
  }

  // --- 駅舎 ---
  if (character.building === 'hut') {
    out.push(...placeAll(place, woodenStation(materials), back - 4.8, GROUND, -length * 0.18));
  } else if (character.building === 'ground') {
    out.push(...placeAll(place, groundStation(materials), back - 7.0, GROUND, -length * 0.12));
  } else if (character.building === 'overhead') {
    // 橋上駅舎は跨線橋（`wayside.ts` が `platformEnd - 18` に架ける）の上に載る。
    // 桁の下端 6.5m + 床版 0.45m がその床になる。
    const bridgeAt = station.platformEnd - 18 - mid;
    const across = adjacent / 2;
    out.push(...placeAll(place, overheadStation(materials, adjacent), across, 6.95, bridgeAt));
  } else if (character.building === 'terminus') {
    // 頭端式の終着駅。**駅舎が線路の突き当たりに、線路と直交して建つ。**
    // 線路の延長線上に建物が見えるのは終点だけなので、進入してくる運転士には
    // これがいちばん分かりやすい「ここで終わり」の合図になる。
    const head = terminusStation(materials, Math.abs(adjacent) + 20);
    head.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    out.push(...placeAll(place, head, adjacent / 2, GROUND, length / 2 + 24));
  }

  // --- 改札 ---
  //
  // **駅舎の中ではなく、ホーム側の軒下に並べる。**実物でも、地方の駅では
  // 改札が屋外に近いところにあり、ホームから改札の列が見える。壁の内側へ
  // 入れてしまうと、作っても誰の目にも触れない。無人駅には置かない。
  if (character.gates > 0) {
    const onBridge = character.building === 'overhead';
    const head = character.building === 'terminus';
    const lateral =
      onBridge || head ? adjacent / 2 : character.building === 'hut' ? back - 1.7 : back - 2.4;
    const height = onBridge ? 6.95 : GROUND;
    const along = onBridge
      ? station.platformEnd - 18 - mid
      : head
        ? length / 2 + 16
        : character.building === 'hut'
          ? -length * 0.18
          : -length * 0.12;
    out.push(...placeAll(place, ticketGates(materials, character.gates), lateral, height, along));
  }

  // --- 出入口の階段 ---
  //
  // ホーム（レール面上 1.1m）から地表（-1.2m）へ 2.3m 降りる。駅舎のある駅は
  // 駅舎へ、棒線駅は直接道路へ降りる。**これが無いとホームが宙に浮いた台になる。**
  out.push(
    ...placeAll(
      place,
      platformStair(materials, PLATFORM.height - GROUND),
      back - 1.2,
      GROUND,
      character.building === 'none' ? length * 0.3 : -length * 0.18,
    ),
  );

  // --- 車止め ---
  if (character.bufferStop) {
    // 線路の終わり。ホームの先端から少し先に据える
    out.push(...placeAll(place, bufferStop(materials), 0, 0, length / 2 + 6));
  }

  return out;
}

/** 地表の高さ（レール面から下へ。`scenery.ts` の `GROUND` と揃える） */
const GROUND = -1.2;

/** 組み上げた部品を 1 か所へまとめて置く */
function placeAll(
  place: <T extends THREE.Object3D>(o: T, lateral: number, height: number, along: number) => T,
  group: THREE.Group,
  lateral: number,
  height: number,
  along: number,
): THREE.Object3D[] {
  return [place(group, lateral, height, along)];
}

interface StationMaterials {
  readonly concrete: THREE.Material;
  readonly siding: THREE.Material;
  readonly tile: THREE.Material;
  readonly panel: THREE.Material;
  readonly steel: THREE.Material;
  readonly glass: THREE.Material;
  readonly lamp: THREE.Material;
}

function stationMaterials(): StationMaterials {
  return {
    concrete: new THREE.MeshStandardMaterial({
      color: 0xcfcabd,
      ...concreteSurface().maps(2.4),
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.93,
    }),
    siding: new THREE.MeshStandardMaterial({
      color: 0xe8e2d4,
      ...sidingSurface().maps(3.6, 5.6),
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.88,
    }),
    tile: new THREE.MeshStandardMaterial({
      color: 0x9aa0a4,
      ...roofTileSurface().maps(1.8),
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.86,
    }),
    panel: new THREE.MeshStandardMaterial({
      color: 0xa8aeb4,
      ...roofPanelSurface().maps(2.4, 0.6),
      normalScale: new THREE.Vector2(1.0, 1.0),
      metalness: 0.4,
      roughness: 0.6,
      side: THREE.DoubleSide,
    }),
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.55, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x2a343c,
      metalness: 0.4,
      roughness: 0.12,
      side: THREE.DoubleSide,
    }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff2d4 }),
  };
}

/**
 * 木造平屋の駅舎（交換可能駅）。
 *
 * 桁行き 9m・梁間 5m、軒高 2.9m の切妻。線路と平行に建ち、ホーム側に
 * 改札、反対側に出入口がある。屋根を大きく葺き下ろすのが古い木造駅舎の形で、
 * 遠くからでも「低くて長い屋根」として読める。
 */
function woodenStation(m: StationMaterials): THREE.Group {
  const group = new THREE.Group();
  const { width: w, depth: d, height: h } = STATION.hut;
  const body = new THREE.Mesh(meterBox(w, h, d), m.siding);
  body.position.y = h / 2;
  group.add(body);
  // 切妻屋根（棟が線路と平行）。軒の出 0.8m
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1.6, 0.16, d + 1.6), m.tile);
  roof.position.y = h + 0.5;
  group.add(roof);
  for (const sign of [-1, 1] as const) {
    const slope = new THREE.Mesh(meterPlane(w + 1.6, Math.hypot(d / 2 + 0.8, 1.0)), m.tile);
    slope.rotation.x = -Math.PI / 2 + sign * Math.atan2(1.0, d / 2 + 0.8);
    slope.position.set(0, h + 0.5 + 0.5, (sign * (d / 2 + 0.8)) / 2);
    group.add(slope);
  }
  // 駅名の掲額（出入口の上）
  const name = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 0.5),
    new THREE.MeshStandardMaterial({
      map: plateTexture(['駅'], { aspect: 4.4, background: '#f4f2ea', color: '#2b2b28' }),
      roughness: 0.7,
    }),
  );
  name.position.set(0, h - 0.5, -d / 2 - 0.03);
  name.rotation.y = Math.PI;
  group.add(name);
  return group;
}

/**
 * 地上駅舎（コンクリート 2 階建て）。
 *
 * 桁行き 16m・梁間 8m・高さ 7m の陸屋根。1 階が改札とコンコース、
 * 2 階が事務室。出入口側に庇が出る。
 */
function groundStation(m: StationMaterials): THREE.Group {
  const group = new THREE.Group();
  const { width: w, depth: d, height: h } = STATION.ground;
  const body = new THREE.Mesh(meterBox(w, h, d), m.concrete);
  body.position.y = h / 2;
  group.add(body);
  // パラペット（陸屋根の立ち上がり）
  const parapet = new THREE.Mesh(meterBox(w + 0.4, 0.6, d + 0.4), m.concrete);
  parapet.position.y = h + 0.3;
  group.add(parapet);
  // 出入口の庇（道路側へ 2.4m 出る）
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(9, 0.2, 2.4), m.panel);
  canopy.position.set(0, 3.4, -(d / 2 + 1.2));
  group.add(canopy);
  for (const dx of [-4, 4]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), m.steel);
    post.position.set(dx, 1.7, -(d / 2 + 2.2));
    group.add(post);
  }
  // 1 階のガラス面（出入口）と 2 階の窓の帯
  const front = new THREE.Mesh(meterPlane(11, 2.8), m.glass);
  front.rotation.y = Math.PI;
  front.position.set(0, 1.6, -(d / 2 + 0.02));
  group.add(front);
  const band = new THREE.Mesh(meterPlane(13, 1.4), m.glass);
  band.rotation.y = Math.PI;
  band.position.set(0, 5.1, -(d / 2 + 0.02));
  group.add(band);
  // 駅名の看板
  const name = new THREE.Mesh(
    new THREE.PlaneGeometry(5.4, 1.0),
    new THREE.MeshStandardMaterial({ map: stationSignTexture('駅'), roughness: 0.6 }),
  );
  name.rotation.y = Math.PI;
  name.position.set(0, 4.0, -(d / 2 + 0.05));
  group.add(name);
  return group;
}

/**
 * 頭端式の終着駅の駅舎。
 *
 * 線路の突き当たりに、線路と直交して建つ。中間駅の駅舎と違い、**ホームの
 * 延長線上に壁が立っている**ので、進入してくる列車からは正面に見える。
 * 高さは中間駅より高く（3 階建て相当 11m）、線路側に大きな庇が出る。
 *
 * @param width 線路をまたぐ幅 [m]
 */
function terminusStation(m: StationMaterials, width: number): THREE.Group {
  const group = new THREE.Group();
  const { depth: d, height: h } = STATION.terminus;
  const body = new THREE.Mesh(meterBox(width, h, d), m.concrete);
  body.position.y = h / 2;
  group.add(body);
  const parapet = new THREE.Mesh(meterBox(width + 0.4, 0.8, d + 0.4), m.concrete);
  parapet.position.y = h + 0.4;
  group.add(parapet);
  // 線路側の大庇（頭端のホームを覆う）
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(width, 0.22, 7), m.panel);
  canopy.position.set(0, 5.2, -(d / 2 + 3.5));
  group.add(canopy);
  for (const dx of [-width / 2 + 1.5, 0, width / 2 - 1.5]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.2, 0.2), m.steel);
    post.position.set(dx, 2.6, -(d / 2 + 6.6));
    group.add(post);
  }
  // 線路側の壁のガラス面（コンコース）と、駅名の看板
  const front = new THREE.Mesh(meterPlane(width - 3, 3.4), m.glass);
  front.rotation.y = Math.PI;
  front.position.set(0, 2.0, -(d / 2 + 0.02));
  group.add(front);
  const name = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 1.2),
    new THREE.MeshStandardMaterial({ map: stationSignTexture('終点'), roughness: 0.6 }),
  );
  name.rotation.y = Math.PI;
  name.position.set(0, 7.4, -(d / 2 + 0.05));
  group.add(name);
  return group;
}

/**
 * 橋上駅舎。
 *
 * 線路の上、跨線橋の床の高さに建つ箱。両側の街から階段で上がってきて、
 * ここで改札を通り、下のホームへ降りる。**線路をまたいで建物が載っている**
 * という輪郭そのものが、他の駅と最も違って見える。
 *
 * @param span 線路中心間隔 [m]（この幅より少し広く架ける）
 */
function overheadStation(m: StationMaterials, span: number): THREE.Group {
  const group = new THREE.Group();
  const w = STATION.overhead.width;
  const d = Math.abs(span) + 12;
  const h = STATION.overhead.height;
  const body = new THREE.Mesh(meterBox(w, h, d), m.concrete);
  body.position.y = h / 2;
  group.add(body);
  // 屋根（緩い片流れ。折板）
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.18, d + 0.8), m.panel);
  roof.position.y = h + 0.1;
  group.add(roof);
  // 側面の窓の帯（コンコースの明かり取り）
  for (const sign of [-1, 1] as const) {
    const band = new THREE.Mesh(meterPlane(d - 1.5, 1.5), m.glass);
    band.rotation.y = (sign * Math.PI) / 2;
    band.position.set((sign * w) / 2 - sign * 0.02, 2.3, 0);
    group.add(band);
  }
  return group;
}

/**
 * 自動改札機の列。
 *
 * 1 通路あたり幅 550mm の筐体が 2 台向かい合い、そのあいだの 600mm が通路になる。
 * 一列に並べると「改札」という形になり、上に列車案内の表示器が吊られる。
 */
function ticketGates(m: StationMaterials, lanes: number): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xbfc4c8, metalness: 0.3, roughness: 0.45 });
  const pitch = STATION.gatePitch;
  const total = lanes * pitch;
  for (let i = 0; i <= lanes; i++) {
    const x = -total / 2 + i * pitch;
    const unit = new THREE.Mesh(
      new THREE.BoxGeometry(STATION.gateWidth, STATION.gateHeight, STATION.gateLength),
      body,
    );
    unit.position.set(x, STATION.gateHeight / 2, 0);
    group.add(unit);
    // 読み取り部（上面の緑の光）
    const reader = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x35c26a }),
    );
    reader.rotation.x = -Math.PI / 2;
    reader.position.set(x, STATION.gateHeight + 0.005, 0.5);
    group.add(reader);
  }
  // 改札上の案内表示器（自ら光る面）
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(total, 0.7),
    new THREE.MeshStandardMaterial({
      color: 0x101a24,
      emissive: 0xf0a020,
      emissiveIntensity: 0.5,
      roughness: 0.4,
    }),
  );
  board.position.set(0, 2.5, -0.9);
  board.rotation.y = Math.PI;
  group.add(board);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(total + 1.2, 1.6),
    new THREE.MeshBasicMaterial({
      map: glowTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: 0xffcf88,
    }),
  );
  glow.position.set(0, 2.5, -1.0);
  glow.rotation.y = Math.PI;
  group.add(glow);
  // 天井から吊る蛍光灯
  for (const dx of [-total / 3, total / 3]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.14), m.lamp);
    lamp.position.set(dx, 2.9, 0);
    group.add(lamp);
  }
  return group;
}

/**
 * ホームから地表へ降りる階段。
 *
 * 踏面 300mm・蹴上げ 170mm（建築基準法の階段の寸法）。両側に手すりを立てる。
 * **手すりが無いと、段だけが宙に浮いた模型に見える。**
 */
function platformStair(m: StationMaterials, rise: number): THREE.Group {
  const group = new THREE.Group();
  const steps = Math.max(1, Math.round(rise / STATION.riser));
  const width = 2.2;
  for (let i = 0; i < steps; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(width, STATION.riser, STATION.tread),
      m.concrete,
    );
    step.position.set(0, rise - (i + 0.5) * STATION.riser, -(i + 0.5) * STATION.tread);
    group.add(step);
  }
  // 手すり（笠木は高さ 1100mm。段の勾配に沿って傾ける）
  const run = steps * STATION.tread;
  const slope = Math.atan2(rise, run);
  for (const sign of [-1, 1] as const) {
    const rail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, Math.hypot(rise, run), 6),
      m.steel,
    );
    rail.rotation.x = Math.PI / 2 - slope;
    rail.position.set((sign * width) / 2, rise / 2 + STATION.railHeight, -run / 2);
    group.add(rail);
    // 手すりの支柱
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, STATION.railHeight, 0.04), m.steel);
      post.position.set((sign * width) / 2, rise * (1 - t) + STATION.railHeight / 2, -run * t);
      group.add(post);
    }
  }
  return group;
}

/**
 * 車止め（終端）。
 *
 * 鋼製の第 2 種車止め。左右のレールをまたぐ枠に緩衝板を張り、
 * 反射板（赤白の斜め縞）を付ける。実物と同じくレール面上 900mm。
 */
function bufferStop(m: StationMaterials): THREE.Group {
  const group = new THREE.Group();
  const gauge = 1.067;
  const frame = new THREE.MeshStandardMaterial({ color: 0x8a3a30, metalness: 0.4, roughness: 0.6 });
  // 左右の支え（レールに載る）
  for (const sign of [-1, 1] as const) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.16), frame);
    leg.position.set(0, 0.45, (sign * gauge) / 2);
    leg.rotation.z = -0.5;
    group.add(leg);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.16), frame);
    post.position.set(0.6, 0.45, (sign * gauge) / 2);
    group.add(post);
  }
  // 緩衝板（列車の連結器が当たる面）
  const buffer = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 1.4), frame);
  buffer.position.set(0.6, STATION.bufferHeight, 0);
  group.add(buffer);
  // 反射板（赤白の斜め縞。夜間これだけが見える）
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.55),
    new THREE.MeshStandardMaterial({
      map: plateTexture(['車止'], { aspect: 2.7, background: '#e02a1c', color: '#ffffff' }),
      roughness: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  board.rotation.y = -Math.PI / 2;
  board.position.set(0.72, STATION.bufferBoardHeight, 0);
  group.add(board);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), m.steel);
  mast.position.set(0.6, 1.15, 0);
  group.add(mast);
  return group;
}
