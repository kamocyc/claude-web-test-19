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

  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const st = stations[i]!;
    const f = st.frame;
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
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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
