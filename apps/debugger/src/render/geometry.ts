import * as THREE from 'three';
import type { TrackFrame } from './frame.ts';

/**
 * 軌道に沿って断面を掃引するための道具。
 *
 * レール・道床・トンネル覆工はどれも「決まった断面が線形に沿って延びていく」
 * 構造物なので、断面の輪郭さえ実物どおりに書けば同じ関数で作れる。
 */

/** 掃引する断面の 1 点。`lat` は軌道中心から右へ、`up` はレール面から上へ [m] */
export type SectionPoint = readonly [lat: number, up: number];

/** 掃引の各ステーション（距離程と、その位置で断面をずらす量） */
export interface SweepStation {
  readonly frame: TrackFrame;
  /** 断面全体を横へずらす量（分岐器の枝や架線の偏位に使う） */
  readonly lateral?: number;
  /** 断面全体を上下へずらす量 */
  readonly vertical?: number;
}

export interface SweepOptions {
  /** 断面が閉じているか（レールのような中実断面は true） */
  readonly closed?: boolean;
  /**
   * 断面の上方向に鉛直を使うか。
   * レールや道床は軌道と一緒に傾くので false（カント込みの軌道面法線を使う）。
   * トンネル覆工や構造物は鉛直に建つので true。
   */
  readonly vertical?: boolean;
}

/**
 * 断面を線形に沿って掃引してメッシュの形を作る。
 *
 * 断面の点は `[右方向, 上方向]` の 2 次元で書く。各ステーションで軌道の基準座標系
 * （カント込みの `cantRight` / `up`、または水平の `right` と鉛直）に載せ替え、
 * 隣り合うステーションどうしを四角形で張る。
 *
 * UV は **m 単位**で入れる。u が線路方向の距離、v が断面に沿った距離になるので、
 * テクスチャ側で `repeat = 1 / 実寸` を掛けるだけで模様の大きさが実物に合う
 * （バラストの砕石が 40mm、覆工の打継目が 10.5m、という具合に）。
 * 閉じた断面では最後の 1 面だけ v が 0 へ戻るので、繰り返し模様の継ぎ目が
 * そこに来る。中実断面（レール）は無地で使うため問題にならない。
 */
export function sweepSection(
  stations: readonly SweepStation[],
  section: readonly SectionPoint[],
  options: SweepOptions = {},
): THREE.BufferGeometry {
  const closed = options.closed ?? false;
  const m = section.length;
  const n = stations.length;
  const positions = new Float32Array(n * m * 3);
  const uvs = new Float32Array(n * m * 2);

  // 断面に沿った累積距離（v 座標）
  const v = new Float32Array(m);
  for (let j = 1; j < m; j++) {
    const [lat0, up0] = section[j - 1]!;
    const [lat1, up1] = section[j]!;
    v[j] = v[j - 1]! + Math.hypot(lat1 - lat0, up1 - up0);
  }

  const p = new THREE.Vector3();
  let u = 0;
  for (let i = 0; i < n; i++) {
    const st = stations[i]!;
    const f = st.frame;
    if (i > 0) u += f.position.distanceTo(stations[i - 1]!.frame.position);
    const right = options.vertical ? f.right : f.cantRight;
    const up = options.vertical ? UP : f.up;
    const dLat = st.lateral ?? 0;
    const dUp = st.vertical ?? 0;
    for (let j = 0; j < m; j++) {
      const [lat, height] = section[j]!;
      p.copy(f.position)
        .addScaledVector(right, lat + dLat)
        .addScaledVector(up, height + dUp);
      const k = (i * m + j) * 3;
      positions[k] = p.x;
      positions[k + 1] = p.y;
      positions[k + 2] = p.z;
      const t = (i * m + j) * 2;
      uvs[t] = u;
      uvs[t + 1] = v[j]!;
    }
  }

  const quads = closed ? m : m - 1;
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < quads; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      indices.push(a, a + m, b, b, a + m, b + m);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * UV を m 単位にした板。
 *
 * `PlaneGeometry` の UV は 0..1 なので、そのままテクスチャを貼ると板の大きさに
 * 応じて模様が伸び縮みしてしまう。UV を実寸に直しておけば、どんな大きさの板でも
 * 同じ大きさの模様（タイル 300mm、砕石 40mm）が並ぶ。
 */
export function meterPlane(width: number, height: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = geometry.attributes.uv!;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * width, uv.getY(i) * height);
  }
  return geometry;
}

/** UV を m 単位にした直方体。面ごとにその面の実寸で UV を入れる */
export function meterBox(width: number, height: number, depth: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const uv = geometry.attributes.uv!;
  // BoxGeometry の面の順序は +X, -X, +Y, -Y, +Z, -Z。各面 4 頂点
  const faceSize: Array<[number, number]> = [
    [depth, height],
    [depth, height],
    [width, depth],
    [width, depth],
    [width, height],
    [width, height],
  ];
  for (let face = 0; face < 6; face++) {
    const [su, sv] = faceSize[face]!;
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  return geometry;
}

/** 断面に沿った長さ [m]。掃引形状に貼るテクスチャの縦方向の実寸になる */
export function sectionLength(section: readonly SectionPoint[]): number {
  let total = 0;
  for (let j = 1; j < section.length; j++) {
    const [lat0, up0] = section[j - 1]!;
    const [lat1, up1] = section[j]!;
    total += Math.hypot(lat1 - lat0, up1 - up0);
  }
  return total;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * 折れ線を細い丸棒にする。
 *
 * 架線やハンガーのような「細いが確かに太さのある」ものを線分で描くと、
 * 遠くで消え、近くでも太さが変わらない不自然な見え方になる。実物どおりの
 * 直径を与えた棒にすると、距離に応じて素直に細くなる。
 */
export function wireGeometry(
  points: readonly THREE.Vector3[],
  radius: number,
  radialSegments = 4,
): THREE.BufferGeometry {
  const n = points.length;
  const positions = new Float32Array(n * radialSegments * 3);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(n - 1, i + 1)]!;
    tangent.subVectors(next, prev).normalize();
    // 架線はほぼ水平なので、鉛直との外積で安定した基準が取れる
    normal.crossVectors(UP, tangent).normalize();
    binormal.crossVectors(tangent, normal).normalize();
    for (let j = 0; j < radialSegments; j++) {
      const a = (j / radialSegments) * Math.PI * 2;
      p.copy(points[i]!)
        .addScaledVector(normal, Math.cos(a) * radius)
        .addScaledVector(binormal, Math.sin(a) * radius);
      const k = (i * radialSegments + j) * 3;
      positions[k] = p.x;
      positions[k + 1] = p.y;
      positions[k + 2] = p.z;
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * radialSegments + j;
      const b = i * radialSegments + ((j + 1) % radialSegments);
      indices.push(a, a + radialSegments, b, b, a + radialSegments, b + radialSegments);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** 軌道の基準座標系から three.js の回転を作る（局所 X が前・Y が上・Z が右） */
export function frameQuaternion(frame: TrackFrame, cant = true): THREE.Quaternion {
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      frame.forward,
      cant ? frame.up : UP,
      cant ? frame.cantRight : frame.right,
    ),
  );
}

/** 断面の輪郭を左右対称に閉じる（右半分だけ書けばよくなる） */
export function mirrorSection(half: readonly SectionPoint[]): SectionPoint[] {
  const out: SectionPoint[] = [...half];
  for (let i = half.length - 1; i >= 0; i--) {
    const [lat, up] = half[i]!;
    if (lat === 0) continue;
    out.push([-lat, up]);
  }
  return out;
}
