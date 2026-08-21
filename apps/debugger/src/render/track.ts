import * as THREE from 'three';
import {
  turnoutBranchOffset,
  turnoutMergePoint,
  type CompiledRoute,
  type Turnout,
} from '@railsim/core';
import { BALLAST, POINT_MACHINE, RAIL, SLEEPER } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import {
  frameQuaternion,
  mirrorSection,
  sweepSection,
  type SectionPoint,
  type SweepStation,
} from './geometry.ts';
import { ballastSurface, rustedSteelSurface, sleeperSurface } from './textures.ts';
import { coatMaterial, type SurfaceCoat } from './weather.ts';

const RAIL_COLOR = 0x8b9198;
/** 頭頂面だけは車輪に磨かれて光る */
const RAILHEAD_COLOR = 0xd7dade;
const SLEEPER_COLOR = 0xb0aba2;
const BALLAST_COLOR = 0xa39d92;
const FORMATION_COLOR = 0x7b7360;
const FITTING_COLOR = 0x6a6e73;

/**
 * レールの材質。
 *
 * 腹部と底部は錆と油で黒ずんだ鋼、頭頂面だけが車輪に磨かれた鏡面になる。
 * 金属らしさは環境マップの映り込みで出るので、材質は金属度と粗さで指定する。
 */
function railMaterial(): THREE.MeshStandardMaterial {
  const { map, normalMap } = rustedSteelSurface().maps(1.2, 0.35);
  return new THREE.MeshStandardMaterial({
    color: RAIL_COLOR,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    metalness: 0.72,
    roughness: 0.58,
  });
}

/**
 * 50kgN レールの断面（JIS E 1101）。
 *
 * 高さ 153mm・底部幅 127mm・頭部幅 65mm・腹部厚 15mm。右半分だけを
 * 底面の中心から頭頂まで書き、`mirrorSection()` で左右に開いて閉じた輪郭にする。
 * 原点はレール**頭頂面**なので、高さはすべて負の値になる（`TrackFrame` の
 * 基準面が走行面であるため）。
 */
const RAIL_SECTION: SectionPoint[] = mirrorSection(
  (
    [
      [0, 0],
      [0.0635, 0],
      [0.0635, 0.011],
      [0.03, 0.028],
      [0.0075, 0.045],
      [0.0075, 0.105],
      [0.019, 0.117],
      [0.0325, 0.128],
      [0.0325, 0.142],
      [0.026, 0.151],
      [0.013, 0.153],
      [0, 0.153],
    ] as SectionPoint[]
  ).map(([lat, up]) => [lat, up - RAIL.height] as SectionPoint),
);

/**
 * 道床と路盤の断面。
 *
 * まくらぎ下 250mm・肩幅 400mm・のり面 1:1.5 の道床を、路盤肩 600mm と
 * 盛土のり面で受ける。地表（`-1.2`）でのり尻が接するので、線路が地面に
 * 浮いても潜ってもいない形になる。
 */
function ballastSection(): SectionPoint[] {
  const sleeperBottom = -RAIL.height - SLEEPER.height;
  const crown = -RAIL.height - 0.05;
  const ballastBottom = sleeperBottom - BALLAST.depth;
  const crest = SLEEPER.length / 2 + BALLAST.shoulder;
  const toe = crest + (crown - ballastBottom) * BALLAST.slope;
  const formation = toe + BALLAST.formationShoulder;
  const ground = -1.2;
  const foot = formation + (ballastBottom - ground) * BALLAST.embankmentSlope;
  const half: SectionPoint[] = [
    [0, crown],
    [crest, crown],
    [toe, ballastBottom],
    [formation, ballastBottom],
    [foot, ground],
  ];
  // 開いた帯なので、左端から右端まで一続きに並べる
  return [
    ...half
      .slice(1)
      .reverse()
      .map(([lat, up]) => [-lat, up] as SectionPoint),
    ...half,
  ];
}

/** レール中心線の軌道中心からの距離。軌間は頭部内面間の寸法なので頭部幅の半分だけ外へ出る */
const RAIL_CENTRE_OFFSET = (gauge: number): number => (gauge + RAIL.headWidth) / 2;

/**
 * 軌道（レール・まくらぎ・道床）を作る。
 *
 * レールは線として描くのではなく、実物の断面を線形に沿って掃引した立体にする。
 * 頭頂面が別の材質で光り、腹部の陰が出るので、遠くのレールでも 2 本の帯として
 * 読み取れるようになる。
 */
export function buildTrack(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  /** 道床・のり面への天気の反映（雪が積もる・雨で濡れる） */
  surface: (base: number) => SurfaceCoat = (base) => ({
    color: base,
    hideMap: false,
    roughness: 0,
  }),
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const offset = RAIL_CENTRE_OFFSET(route.alignment.gauge);

  // --- レール ---
  const rail = railMaterial();
  // 頭頂面（走行面）。車輪に磨かれた鏡面なので、空を映して銀色に光る
  const railhead = new THREE.MeshStandardMaterial({
    color: RAILHEAD_COLOR,
    metalness: 1,
    roughness: 0.14,
  });
  // レールは全長を 1 本のメッシュにしてはいけない。視錐台の判定はメッシュ
  // 単位なので、14.2km を 1 本にすると**端が視野に入っただけで全長 11 万頂点が
  // 毎フレーム描かれる**（影を焼くときも同じ）。区間ごとに切っておけば、
  // 実際に見えている数区間だけになる。
  for (const [start, end] of chunkSpans(0, route.length)) {
    // 区間の継ぎ目に隙間を作らないよう、端は次の区間と共有する
    const stations = stationsBetween(start, end, 3, frameAt);
    for (const side of [-1, 1] as const) {
      const geom = sweepSection(
        stations.map((st) => ({ ...st, lateral: side * offset })),
        RAIL_SECTION,
        { closed: true },
      );
      out.push(new THREE.Mesh(geom, rail));

      const headGeom = sweepSection(
        stations.map((st) => ({ ...st, lateral: side * offset, vertical: 0.002 })),
        [
          [-RAIL.headWidth / 2 + 0.006, 0],
          [RAIL.headWidth / 2 - 0.006, 0],
        ],
      );
      out.push(new THREE.Mesh(headGeom, railhead));
    }
  }

  // --- 道床・路盤 ---
  // 無道床橋の上には道床が無い（まくらぎが桁へ直接締結される）。音の側で
  // 「加振力がそのまま桁へ入る」と扱っているのと同じことを、絵でもそのまま描く。
  const section = ballastSection();
  // 道床（まくらぎ端から肩まで）と、その外の路盤・盛土のり面を別の材質にして
  // バラストと土の境目が見えるようにする。砕石は 1 粒 40mm 前後になるよう
  // テクスチャ 1 枚を 1.2m で貼る。
  const ballastFaces = section.slice(1, section.length - 1);
  const ballastMaterial = new THREE.MeshStandardMaterial({
    ...coatMaterial(ballastSurface().maps(1.2), 1, surface(BALLAST_COLOR)),
    normalScale: new THREE.Vector2(1.5, 1.5),
    side: THREE.DoubleSide,
  });
  // 盛土のり面は同じ砕石を土の色で使う（実物ものり面には細かい砕石が撒かれている）
  const slope = new THREE.MeshStandardMaterial({
    ...coatMaterial(ballastSurface().maps(1.8), 1, surface(FORMATION_COLOR)),
    normalScale: new THREE.Vector2(0.8, 0.8),
    side: THREE.DoubleSide,
  });
  for (const [spanStart, spanEnd] of ballastedSpans(route)) {
    for (const [start, end] of chunkSpans(spanStart, spanEnd)) {
      const bed = stationsBetween(start, end, 5, frameAt);
      out.push(new THREE.Mesh(sweepSection(bed, ballastFaces), ballastMaterial));
      out.push(new THREE.Mesh(sweepSection(bed, [section[0]!, section[1]!]), slope));
      out.push(
        new THREE.Mesh(
          sweepSection(bed, [section[section.length - 2]!, section[section.length - 1]!]),
          slope,
        ),
      );
    }
  }

  // --- まくらぎ ---
  // 分岐器の区間だけは、線路方向に対して長さの違う「分岐まくらぎ」が入るので
  // 本線用の 2m まくらぎは敷かない（`buildTurnouts()` が敷く）。
  out.push(buildSleepers(route, frameAt, offset, turnoutSpans(route)));

  // --- レール継目（音が鳴る位置と同じところに置く） ---
  out.push(...buildRailJoints(route, frameAt, offset));

  // --- 交換設備・複線区間の隣の線路 ---
  out.push(
    ...buildAdjacentTrack(route, frameAt, offset, rail, railhead, {
      section: ballastFaces,
      ballast: ballastMaterial,
      slope,
      shoulders: [
        [section[0]!, section[1]!],
        [section[section.length - 2]!, section[section.length - 1]!],
      ],
    }),
  );

  return out;
}

/**
 * 道床のある区間。
 *
 * 無道床橋（`deck === 'open'`）の上には道床が無いので、そこで途切れる。橋の
 * 前後で道床が切れて桁の上にまくらぎだけが並ぶのは、実物の無道床橋そのものである。
 */
function ballastedSpans(route: CompiledRoute): Array<[number, number]> {
  const gaps = route.bridges.bridges
    .filter((b) => b.deck === 'open')
    .map((b) => [b.start, b.end] as const)
    .sort((a, b) => a[0] - b[0]);
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of gaps) {
    if (start > cursor) spans.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < route.length) spans.push([cursor, route.length]);
  return spans;
}

/** 区間 [start, end] を刻んだステーション。終端はかならず含める。 */
function stationsBetween(
  start: number,
  end: number,
  step: number,
  frameAt: (s: number) => TrackFrame,
): SweepStation[] {
  const n = Math.max(1, Math.ceil((end - start) / step));
  const out: SweepStation[] = [];
  for (let i = 0; i <= n; i++) out.push({ frame: frameAt(start + ((end - start) * i) / n) });
  return out;
}

/** 隣の線路の下に敷く道床（本線と同じ断面・同じ材質を使い回す） */
interface AdjacentBed {
  readonly section: readonly SectionPoint[];
  readonly ballast: THREE.Material;
  readonly slope: THREE.Material;
  /** 道床の外側ののり面（左右 2 枚） */
  readonly shoulders: ReadonlyArray<readonly SectionPoint[]>;
}

/**
 * 交換設備・複線区間の隣の線路。
 *
 * 単線なので、線路が 2 本あるのは行き違い設備の中だけである。横のずれは
 * `AdjacentTrack.offsetAt()`（分岐器の寸法から決まる）をそのまま使うので、
 * 対向列車が走る位置と絵がずれることがない。
 */
function buildAdjacentTrack(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  railOffset: number,
  rail: THREE.Material,
  railhead: THREE.Material,
  bed: AdjacentBed,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const loop of route.adjacentTrack.loops) {
    const stations: SweepStation[] = [];
    for (let s = loop.entry; s <= loop.exit; s += 2) {
      stations.push({ frame: frameAt(s), lateral: route.adjacentTrack.offsetAt(s) });
    }
    if (stations.length < 2) continue;

    // 道床は 2 本ぶんを重ねて敷く。線路中心間隔（交換設備 3.38m・複線 3.8m）は
    // 道床の肩幅（片側 2.5m ほど）の 2 倍より狭いので、断面が重なって 1 つの
    // 広い道床になる — 実物の複線も、線路 2 本を 1 つの道床に載せている。
    const spread: SweepStation[] = [];
    const steps = Math.max(1, Math.ceil((loop.exit - loop.entry) / 5));
    for (let i = 0; i <= steps; i++) {
      const s = loop.entry + ((loop.exit - loop.entry) * i) / steps;
      spread.push({ frame: frameAt(s), lateral: route.adjacentTrack.offsetAt(s) });
    }
    out.push(new THREE.Mesh(sweepSection(spread, bed.section), bed.ballast));
    for (const shoulder of bed.shoulders) {
      out.push(new THREE.Mesh(sweepSection(spread, shoulder), bed.slope));
    }

    for (const side of [-1, 1] as const) {
      out.push(
        new THREE.Mesh(
          sweepSection(
            stations.map((st) => ({ ...st, lateral: (st.lateral ?? 0) + side * railOffset })),
            RAIL_SECTION,
            { closed: true },
          ),
          rail,
        ),
      );
      out.push(
        new THREE.Mesh(
          sweepSection(
            stations.map((st) => ({
              ...st,
              lateral: (st.lateral ?? 0) + side * railOffset,
              vertical: 0.002,
            })),
            [
              [-RAIL.headWidth / 2 + 0.006, 0],
              [RAIL.headWidth / 2 - 0.006, 0],
            ],
          ),
          railhead,
        ),
      );
    }

    // まくらぎは 1 番線と 2 番線で共用ではないので、隣の線路のぶんを別に置く
    const count = Math.floor((loop.exit - loop.entry) / SLEEPER.spacing);
    if (count <= 0) continue;
    const sleeper = new THREE.InstancedMesh(
      taperedBoxGeometry(SLEEPER.topWidth, SLEEPER.bottomWidth, SLEEPER.height, SLEEPER.length),
      new THREE.MeshStandardMaterial({
        color: SLEEPER_COLOR,
        ...sleeperSurface().maps(0.9),
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.92,
      }),
      count,
    );
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const s = loop.entry + i * SLEEPER.spacing;
      const f = frameAt(s);
      p.copy(f.position)
        .addScaledVector(f.cantRight, route.adjacentTrack.offsetAt(s))
        .addScaledVector(f.up, -RAIL.height - SLEEPER.height / 2);
      sleeper.setMatrixAt(i, m.compose(p, frameQuaternion(f), one));
    }
    sleeper.instanceMatrix.needsUpdate = true;
    out.push(sleeper);
  }
  return out;
}

/**
 * 分岐器が占める距離程の区間。
 *
 * 渡り線は「リード曲線 → 護輪軌条部 → 戻し曲線」で隣の線路まで届くので、
 * ふつうの分岐器より長い。長さは番数と線路中心間隔から決まる
 * （`crossoverGeometry()`）。
 */
function turnoutSpans(route: CompiledRoute): Array<[number, number]> {
  return route.turnouts.turnouts.map((t) => {
    const length = t.crossover ? crossoverGeometry(route, t).length : t.length;
    return [t.pointsPosition - 1, t.pointsPosition + length + 1] as [number, number];
  });
}

/**
 * 渡り線の寸法。
 *
 * 番数（＝クロッシング角 α）とリード半径 R は分岐器の寸法で決まっているので、
 * 線路中心間隔 W に届かせるには護輪軌条部（リード曲線と戻し曲線のあいだの
 * 直線）の長さ T で調整するしかない:
 *
 *   W = 2R(1 − cos α) + T sin α  →  T = (W − 2R(1 − cos α)) / sin α
 *
 * #12・R350 で W = 3.8m なら T = 16.6m になる。交換設備の分岐器（T = 11.6m、
 * W = 3.38m）より長いのは、複線の線路中心間隔のほうが広いからである。
 */
function crossoverGeometry(
  route: CompiledRoute,
  turnout: Turnout,
): { spacing: number; tail: number; length: number } {
  const spacing = route.adjacentTrack.spacingAt(turnout.pointsPosition);
  const tail = Math.max(
    0,
    (spacing - 2 * turnout.radius * (1 - Math.cos(turnout.crossingAngle))) /
      Math.sin(turnout.crossingAngle),
  );
  return { spacing, tail, length: 2 * turnout.leadLength + tail };
}

/**
 * 長い区間を描画の単位へ割る。
 *
 * 400m は「近すぎて無駄が出る」と「長すぎて視野の外まで描く」の折り合い。
 * 運転席から見える範囲がおよそ 1km なので、そのうち 2〜3 区間だけが
 * 実際に描かれることになる。
 */
function chunkSpans(start: number, end: number, size = 400): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = start; s < end; s += size) out.push([s, Math.min(end, s + size)]);
  return out.length > 0 ? out : [[start, end]];
}

/**
 * PC まくらぎ。
 *
 * 長さ 2000mm・高さ 190mm、上面より底面がわずかに広い台形断面。本線 1 級線の
 * 敷設間隔 25m あたり 44 本（≒ 568mm）で並べる。レール座には締結装置を模した
 * 小さな金具を置き、レールが宙に浮いて見えないようにする。
 */
function buildSleepers(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  railOffset: number,
  /** ここに入る距離程には敷かない（分岐器の区間） */
  skip: ReadonlyArray<readonly [number, number]> = [],
): THREE.Group {
  const group = new THREE.Group();
  const total = Math.floor(route.length / SLEEPER.spacing);
  const top = -RAIL.height;
  // まくらぎは 25000 本ある。1 つのインスタンスにまとめると、レールと同じ理由で
  // 視野の外のぶんまで毎フレーム描かれる。区間ごとに分ける。
  const byChunk = new Map<number, number[]>();
  for (let i = 0; i < total; i++) {
    const s = i * SLEEPER.spacing;
    if (skip.some(([a, b]) => s >= a && s <= b)) continue;
    const chunk = Math.floor(s / 400);
    const list = byChunk.get(chunk);
    if (list) list.push(s);
    else byChunk.set(chunk, [s]);
  }

  const sleeperGeometry = taperedBoxGeometry(
    SLEEPER.topWidth,
    SLEEPER.bottomWidth,
    SLEEPER.height,
    SLEEPER.length,
  );
  const sleeperMaterial = new THREE.MeshStandardMaterial({
    color: SLEEPER_COLOR,
    ...sleeperSurface().maps(0.9),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.92,
  });
  // 締結装置（レール締結ばねと軌道パッド）。まくらぎ 1 本につき左右 2 個
  const fasteningGeometry = new THREE.BoxGeometry(0.2, 0.03, 0.19);
  const fasteningMaterial = new THREE.MeshStandardMaterial({
    color: FITTING_COLOR,
    ...rustedSteelSurface().maps(0.25),
    metalness: 0.7,
    roughness: 0.6,
  });

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (const positions of byChunk.values()) {
    const count = positions.length;
    const sleeper = new THREE.InstancedMesh(sleeperGeometry, sleeperMaterial, count);
    const fastening = new THREE.InstancedMesh(fasteningGeometry, fasteningMaterial, count * 2);
    for (let i = 0; i < count; i++) {
      const f = frameAt(positions[i]!);
      const q = frameQuaternion(f);
      p.copy(f.position).addScaledVector(f.up, top - SLEEPER.height / 2);
      sleeper.setMatrixAt(i, m.compose(p, q, one));
      for (let k = 0; k < 2; k++) {
        p.copy(f.position)
          .addScaledVector(f.cantRight, (k === 0 ? -1 : 1) * railOffset)
          .addScaledVector(f.up, top - 0.015);
        fastening.setMatrixAt(i * 2 + k, m.compose(p, q, one));
      }
    }
    sleeper.instanceMatrix.needsUpdate = true;
    fastening.instanceMatrix.needsUpdate = true;
    group.add(sleeper, fastening);
  }
  return group;
}

/**
 * レール継目板（継目板とボルト）。
 *
 * 位置は路線データの継目間隔をそのまま読むので、**「ガタン ゴトン」が鳴る場所と
 * 目に見える継目が一致する**。ロングレール区間には置かれない。
 */
function buildRailJoints(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  railOffset: number,
): THREE.Object3D[] {
  const positions: number[] = [];
  let s = 0;
  while (s < route.length) {
    const spacing = route.railJointSpacing.at(s);
    if (spacing <= 0) {
      // ロングレール区間。次の切替点まで飛ばす
      const next = route.railJointSpacing.boundaries.find((b) => b > s);
      if (next === undefined) break;
      s = next;
      continue;
    }
    s += spacing;
    if (s < route.length) positions.push(s);
  }
  if (positions.length === 0) return [];

  const plate = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.6, 0.1, 0.03),
    new THREE.MeshStandardMaterial({
      color: FITTING_COLOR,
      ...rustedSteelSurface().maps(0.6),
      metalness: 0.6,
      roughness: 0.7,
    }),
    positions.length * 2,
  );
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < positions.length; i++) {
    const f = frameAt(positions[i]!);
    const q = frameQuaternion(f);
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      p.copy(f.position)
        .addScaledVector(f.cantRight, side * (railOffset + 0.04))
        .addScaledVector(f.up, -RAIL.height / 2 - 0.01);
      plate.setMatrixAt(i * 2 + k, m.compose(p, q, one));
    }
  }
  plate.instanceMatrix.needsUpdate = true;
  return [plate];
}

/**
 * 上面と底面で幅が違う直方体。
 * まくらぎは型枠から抜くために側面がわずかに開いているので、真四角にはならない。
 *
 * UV は m 単位で入れる（面ごとに実寸の平面投影）。まくらぎの上面と側面で
 * コンクリートの模様の大きさが揃うので、継ぎ目が目立たない。
 */
function taperedBoxGeometry(
  topWidth: number,
  bottomWidth: number,
  height: number,
  length: number,
): THREE.BufferGeometry {
  const hz = length / 2;
  const hy = height / 2;
  const t = topWidth / 2;
  const b = bottomWidth / 2;
  // x = 線路方向（まくらぎの幅）、y = 上下、z = まくらぎの長手方向
  const v: Array<[number, number, number]> = [
    [-t, hy, -hz],
    [t, hy, -hz],
    [t, hy, hz],
    [-t, hy, hz],
    [-b, -hy, -hz],
    [b, -hy, -hz],
    [b, -hy, hz],
    [-b, -hy, hz],
  ];
  const faces: Array<{ readonly idx: readonly number[]; readonly uv: 'xz' | 'xy' | 'zy' }> = [
    { idx: [0, 1, 2, 3], uv: 'xz' }, // 上
    { idx: [7, 6, 5, 4], uv: 'xz' }, // 下
    { idx: [4, 5, 1, 0], uv: 'xy' }, // 手前（線路方向 -）
    { idx: [3, 2, 6, 7], uv: 'xy' }, // 奥
    { idx: [0, 3, 7, 4], uv: 'zy' }, // 端
    { idx: [5, 6, 2, 1], uv: 'zy' }, // 端
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const idx of face.idx) {
      const [x, y, z] = v[idx!]!;
      positions.push(x!, y!, z!);
      if (face.uv === 'xz') uvs.push(z!, x!);
      else if (face.uv === 'xy') uvs.push(z!, y!);
      else uvs.push(x!, y!);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * 分岐器。
 *
 * 列車が通る側は本線の軌道としてすでに描かれているので、ここでは
 * **通らない側**の線路を分かれていく枝として描く。実物の分岐器を構成する
 * 部材のうち、外から見て形がはっきりわかるものを置く:
 *
 *  - **トングレール** — 先端が基本レールに密着し、そこから厚みを増していく。
 *    先端側を細く絞ることで「刃物のように尖った可動レール」の形になる。
 *  - **リードレール** — トングレールの後端からクロッシングまでの曲線レール。
 *  - **クロッシング**（ノーズ・ウイングレール）— 番数 N の角度 α = atan(1/N) で
 *    2 本のレールが交差する部分。ここに欠線があり、衝撃音の出どころになる。
 *  - **護輪軌条（ガードレール）** — クロッシングの反対側の基本レールに沿えて、
 *    輪軸がノーズを叩かないよう案内する。
 *  - **電気転てつ機** — トングレール先端の脇。開通方向で色を変える。
 *
 * 枝の中心線は、トングレール先端からの距離 `d` に対して
 *
 * ```
 * 横のずれ = d² / 2R            （リード曲線のあいだ）
 *          = L²/2R + (d−L) sinα （クロッシングから先は直線）
 * ```
 *
 * で置く。円弧の近似式だが、離れていく枝を数十メートル描くだけなので十分である。
 */
export function buildTurnouts(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const offset = RAIL_CENTRE_OFFSET(route.alignment.gauge);
  const rail = railMaterial();
  // トングレールとクロッシングは車輪に叩かれて磨かれるので、レール本体より光る
  const polished = new THREE.MeshStandardMaterial({
    color: RAILHEAD_COLOR,
    metalness: 0.95,
    roughness: 0.28,
  });
  const sleeperMaterial = new THREE.MeshStandardMaterial({
    color: SLEEPER_COLOR,
    ...sleeperSurface().maps(0.9),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.92,
  });

  /** 行き違い設備の分岐器か（枝は「隣の線路」として別に描いてある） */
  const inLoop = (turnout: Turnout): boolean =>
    route.adjacentTrack.loops.some(
      (loop) =>
        Math.abs(turnoutMergePoint(turnout) - loop.entry) < 1e-6 ||
        Math.abs(turnoutMergePoint(turnout) - loop.exit) < 1e-6,
    );

  for (const turnout of route.turnouts.turnouts) {
    // 分岐側を走っているときは、分かれていくのは本線（反対側へ離れる）
    const away = (turnout.side === 'right' ? 1 : -1) * (turnout.route === 'through' ? 1 : -1);
    const start = turnout.pointsPosition;
    const sinA = Math.sin(turnout.crossingAngle);
    const lead = turnout.leadLength;

    /**
     * 渡り線が渡りきる横のずれ [m]（= その地点の線路中心間隔）。
     *
     * 渡り線でないときは 0（＝上限なし）。渡り線は隣の線路に乗り移るためのもの
     * なので、離れていく先ではなく**相手の線路の位置**で線形が決まる。
     */
    const crossoverSpacing = turnout.crossover ? crossoverGeometry(route, turnout).spacing : 0;
    /**
     * 渡り線の護輪軌条部（リード曲線と戻し曲線のあいだの直線）の長さ [m]。
     *
     * 番数（＝クロッシング角 α）とリード半径 R は分岐器の寸法で決まっているので、
     * 線路中心間隔 W に届かせるにはこの直線で調整するしかない:
     *
     *   W = 2R(1 − cos α) + T sin α  →  T = (W − 2R(1 − cos α)) / sin α
     *
     * #12・R350 で W = 3.8m なら T = 16.6m になる。交換設備の分岐器（T = 11.6m、
     * W = 3.38m）より長いのは、複線の線路中心間隔のほうが広いからである。
     */
    const crossoverTail = turnout.crossover ? crossoverGeometry(route, turnout).tail : 0;
    /** 渡り線の全長 [m]（リード曲線 → 護輪軌条部 → 戻し曲線） */
    const crossoverLength = 2 * lead + crossoverTail;

    /** トングレール先端からの距離 d における、枝の中心線の横のずれ */
    const branchOffset = (d: number): number => {
      // 渡り線は戻し曲線で隣の線路と平行になる。離れていく枝ではないので、
      // 交換設備の隣の線路（`turnoutBranchOffset`）とまったく同じ線形になる。
      if (turnout.crossover) {
        return away * turnoutBranchOffset(d, turnout.radius, turnout.crossingAngle, crossoverTail);
      }
      return (
        away *
        (d <= lead
          ? (d * d) / (2 * turnout.radius)
          : (lead * lead) / (2 * turnout.radius) + (d - lead) * sinA)
      );
    };

    // 離れていく枝は 60m ほど描けば十分だが、渡り線は渡りきるまで描く
    // （途中で切ると隣の線路につながらない）。
    const end = Math.min(
      route.length,
      start + (turnout.crossover ? crossoverLength : turnout.length + 60),
    );
    const stations: SweepStation[] = [];
    for (let s = start; s <= end; s += 1) {
      stations.push({ frame: frameAt(s), lateral: branchOffset(s - start) });
    }
    if (stations.length < 2) continue;

    // 枝の 2 本のレール。基本レールから離れていく側は途中からしか要らないが、
    // 先端まで描いても密着したトングレールとして自然に見える。
    // 行き違い設備の分岐器では、枝がそのまま隣の線路（`buildAdjacentTrack`）
    // なので、ここでは描かない。
    if (!inLoop(turnout)) {
      for (const side of [-1, 1] as const) {
        out.push(
          new THREE.Mesh(
            sweepSection(
              stations.map((st) => ({ ...st, lateral: (st.lateral ?? 0) + side * offset })),
              RAIL_SECTION,
              { closed: true },
            ),
            rail,
          ),
        );
      }
    }

    // トングレール: 先端 0 → 後端でレール断面と同じ厚さになる細い刃
    const tongueLength = Math.min(lead * 0.45, 12);
    const tongue: SweepStation[] = [];
    for (let d = 0; d <= tongueLength; d += 1) {
      tongue.push({ frame: frameAt(start + d), lateral: branchOffset(d) - away * offset });
    }
    if (tongue.length >= 2) {
      out.push(new THREE.Mesh(tongueGeometry(tongue, away, tongueLength), polished));
    }

    // クロッシング（ノーズ）とウイングレール
    const crossingFrame = frameAt(Math.min(route.length, turnout.crossingPosition));
    const nose = new THREE.Mesh(new THREE.BoxGeometry(3.2, RAIL.height, 0.22), polished);
    nose.quaternion.copy(frameQuaternion(crossingFrame));
    nose.position
      .copy(crossingFrame.position)
      .addScaledVector(crossingFrame.cantRight, branchOffset(turnout.crossingPosition - start) / 2)
      .addScaledVector(crossingFrame.up, -RAIL.height / 2);
    out.push(nose);

    // 渡り線は向こう側の端にもう 1 基の分岐器が背中合わせに据わっている。
    // その分岐器のクロッシングは戻し曲線の始まりにあたる位置にあり、渡る列車は
    // ここでもう一度欠線を踏む（＝渡り線を渡ると「ガタン」が 2 回来る）。
    if (turnout.crossover) {
      const mateAt = Math.min(route.length, start + lead + crossoverTail);
      const mateFrame = frameAt(mateAt);
      const mate = new THREE.Mesh(new THREE.BoxGeometry(3.2, RAIL.height, 0.22), polished);
      mate.quaternion.copy(frameQuaternion(mateFrame));
      mate.position
        .copy(mateFrame.position)
        .addScaledVector(
          mateFrame.cantRight,
          (branchOffset(mateAt - start) + away * crossoverSpacing) / 2,
        )
        .addScaledVector(mateFrame.up, -RAIL.height / 2);
      out.push(mate);
    }

    // 護輪軌条（クロッシングの反対側のレールに沿える）
    const guard: SweepStation[] = [];
    for (let d = -4; d <= 4; d += 1) {
      const s = Math.max(0, Math.min(route.length, turnout.crossingPosition + d));
      guard.push({ frame: frameAt(s), lateral: -away * (offset - 0.09) });
    }
    out.push(
      new THREE.Mesh(
        sweepSection(
          guard,
          [
            [-0.03, -RAIL.height],
            [-0.03, -0.02],
            [0.03, -0.02],
            [0.03, -RAIL.height],
          ],
          { closed: true },
        ),
        rail,
      ),
    );

    // --- 分岐まくらぎ ---
    //
    // 分岐器の下に敷くまくらぎは、本線の 2m ではなく**枝が離れるにつれて
    // 長くなる**。トングレール先端では 2 本のレールがほとんど重なっているので
    // 本線用と大差ないが、クロッシングのあたりでは 4 本のレールを 1 本の
    // まくらぎが受けるので 4.5m を超える。実物の分岐器を上から見たときの
    // 「櫛の歯が奥へ行くほど長くなる」形はこれである。
    //
    // 向きは**本線に直角**にする。実際の分岐まくらぎも本線に直角に敷き、
    // 枝のレールはその上を斜めに横切っていく（枝に直角に敷くと、本線側の
    // 締結位置が 1 本ずつずれてしまう）。
    out.push(
      ...buildTurnoutSleepers(
        start,
        turnout.length,
        frameAt,
        (d) => branchOffset(d),
        sleeperMaterial,
      ),
    );
    if (turnout.crossover) {
      // 渡り線の向こう端の分岐器。相手の線路を基準に、同じ形のまくらぎが
      // 背中合わせに並ぶ。
      const mateStart = crossoverLength - turnout.length;
      out.push(
        ...buildTurnoutSleepers(
          start + mateStart,
          turnout.length,
          frameAt,
          (d) => branchOffset(d + mateStart) - away * crossoverSpacing,
          sleeperMaterial,
          away * crossoverSpacing,
        ),
      );
      // そのあいだ（護輪軌条部の直線）は、枝の中心に本線と同じ 2m まくらぎ。
      // 枝は本線に対して α = 4.8 度しか傾いていないので、向きは本線のままでよい。
      out.push(
        ...buildTurnoutSleepers(
          start + turnout.length,
          mateStart - turnout.length,
          frameAt,
          () => 0,
          sleeperMaterial,
          0,
          (d) => branchOffset(d + turnout.length),
        ),
      );
    }

    // 電気転てつ機（NS 形相当）と転換かんぬき
    const f = frameAt(start);
    const q = frameQuaternion(f);
    const machine = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(POINT_MACHINE.length, POINT_MACHINE.height, POINT_MACHINE.width),
      new THREE.MeshStandardMaterial({
        color: turnout.route === 'diverging' ? 0xd8a12c : 0x9aa1a8,
        metalness: 0.5,
        roughness: 0.55,
      }),
    );
    box.position.y = POINT_MACHINE.height / 2;
    const rod = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.06, POINT_MACHINE.offset - offset),
      new THREE.MeshStandardMaterial({ color: FITTING_COLOR, metalness: 0.7, roughness: 0.55 }),
    );
    rod.position.set(0.2, 0.1, (-away * (POINT_MACHINE.offset - offset)) / 2);
    machine.add(box, rod);
    machine.quaternion.copy(q);
    machine.position
      .copy(f.position)
      .addScaledVector(f.cantRight, away * POINT_MACHINE.offset)
      .addScaledVector(f.up, -RAIL.height - SLEEPER.height);
    out.push(machine);

    // 渡り線は分岐器 2 基でひと組なので、転てつ機も 2 台ある。向こう端の 1 台は
    // 相手の線路の脇に、こちらとは逆を向いて据わる（背中合わせの分岐器だから）。
    if (turnout.crossover) {
      const mateFrame2 = frameAt(Math.min(route.length, start + crossoverLength));
      const mate = machine.clone();
      mate.quaternion.copy(frameQuaternion(mateFrame2));
      mate.position
        .copy(mateFrame2.position)
        .addScaledVector(
          mateFrame2.cantRight,
          away * crossoverSpacing - away * POINT_MACHINE.offset,
        )
        .addScaledVector(mateFrame2.up, -RAIL.height - SLEEPER.height);
      out.push(mate);
    }
  }
  return out;
}

/**
 * 分岐まくらぎ。
 *
 * @param start 敷き始める距離程
 * @param length 敷く長さ
 * @param branch 起点からの距離 d における、枝の中心の横のずれ（基準線から）
 * @param base 基準線そのものの横のずれ（渡り線の向こう端では相手の線路になる）
 * @param shift まくらぎ全体をさらに横へずらす量（護輪軌条部の直線で使う）
 */
function buildTurnoutSleepers(
  start: number,
  length: number,
  frameAt: (s: number) => TrackFrame,
  branch: (d: number) => number,
  material: THREE.Material,
  base = 0,
  shift?: (d: number) => number,
): THREE.Object3D[] {
  const count = Math.floor(length / SLEEPER.spacing);
  if (count <= 0) return [];
  const mesh = new THREE.InstancedMesh(
    taperedBoxGeometry(SLEEPER.topWidth, SLEEPER.bottomWidth, SLEEPER.height, SLEEPER.length),
    material,
    count,
  );
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const d = i * SLEEPER.spacing;
    const f = frameAt(start + d);
    const off = branch(d);
    // 4 本のレールをまたぐので、枝が離れたぶんだけ長くする。実物の分岐まくらぎも
    // 2.4m から 5m 弱まで、10cm 刻みの何十種類かが用意されている。
    const span = Math.min(5.0, SLEEPER.length + Math.abs(off));
    const centre = base + off / 2 + (shift ? shift(d) : 0);
    p.copy(f.position)
      .addScaledVector(f.cantRight, centre)
      .addScaledVector(f.up, -RAIL.height - SLEEPER.height / 2);
    scale.set(1, 1, span / SLEEPER.length);
    mesh.setMatrixAt(i, m.compose(p, frameQuaternion(f), scale));
  }
  mesh.instanceMatrix.needsUpdate = true;
  return [mesh];
}

/**
 * トングレールの立体。
 * 先端でほぼ厚さ 0、後端でレール頭部の厚さになる楔形にする。
 */
function tongueGeometry(
  stations: readonly SweepStation[],
  away: number,
  length: number,
): THREE.BufferGeometry {
  const n = stations.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const st = stations[i]!;
    const t = length > 0 ? i / (n - 1) : 0;
    const thickness = 0.008 + t * (RAIL.headWidth - 0.008);
    const f = st.frame;
    const lat = st.lateral ?? 0;
    for (const [dl, du] of [
      [0, -RAIL.height * 0.55],
      [away * thickness, -RAIL.height * 0.55],
      [away * thickness, -0.004],
      [0, -0.004],
    ] as const) {
      const p = f.position
        .clone()
        .addScaledVector(f.cantRight, lat + dl)
        .addScaledVector(f.up, du);
      positions.push(p.x, p.y, p.z);
    }
    if (i > 0) {
      const a = (i - 1) * 4;
      const b = i * 4;
      for (let j = 0; j < 4; j++) {
        const j2 = (j + 1) % 4;
        indices.push(a + j, b + j, a + j2, a + j2, b + j, b + j2);
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}
