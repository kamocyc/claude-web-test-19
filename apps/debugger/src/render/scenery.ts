import * as THREE from 'three';
import { Rng, type CompiledRoute } from '@railsim/core';
import { TUNNEL } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import { frameQuaternion, sweepSection, type SectionPoint, type SweepStation } from './geometry.ts';

/** 建物の色のバリエーション（住宅・ビル・倉庫） */
const BUILDING_COLORS = [0xd8d3c8, 0xc9c2b4, 0xb9c2c8, 0xd6c8b0, 0xa8b0b6, 0xcfd6cf];
const ROOF_COLORS = [0x6d5a4a, 0x4f5a63, 0x7a6a58, 0x5a6b5c];

export interface SceneryOptions {
  /** 樹木・建物を配置する間隔 [m] */
  readonly step?: number;
  /** 乱数シード（決定論的に同じ景色が生成される） */
  readonly seed?: number;
}

/**
 * 沿線の景観（樹木・建物）を生成する。
 *
 * 位置はシード付き乱数から決めるので、同じ路線・同じシードなら常に同じ景色になる。
 * すべてインスタンス描画にまとめ、数百個置いてもドローコールが増えないようにしている。
 */
export function buildScenery(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  options: SceneryOptions = {},
): THREE.Object3D[] {
  const step = options.step ?? 22;
  const rng = new Rng(options.seed ?? 0xc0ffee);
  const objects: THREE.Object3D[] = [];

  const inTunnel = (s: number): boolean => route.tunnels.at(s).length > 0;
  const nearStation = (s: number): boolean =>
    route.stations.some((st) => s > st.platformStart - 60 && s < st.platformEnd + 60);

  // --- 配置候補を作る ---
  interface Placement {
    readonly matrix: THREE.Matrix4;
    readonly colorIndex: number;
    readonly scale: THREE.Vector3;
  }
  const trees: Placement[] = [];
  const buildings: Placement[] = [];

  const count = Math.floor(route.length / step);
  for (let i = 0; i < count; i++) {
    const s = i * step + rng.range(-step / 3, step / 3);
    if (s < 0 || s > route.length || inTunnel(s)) continue;
    const f = frameAt(s);

    for (const side of [-1, 1] as const) {
      if (rng.chance(0.35)) continue;
      // 建築限界を避けて、線路から十分離れた位置に置く
      const offset = side * rng.range(14, 75);
      const pos = f.position.clone().addScaledVector(f.right, offset);
      const isBuilding = rng.chance(0.42) && !nearStation(s);

      if (isBuilding) {
        const w = rng.range(6, 16);
        const d = rng.range(6, 16);
        const h = rng.range(4, 22);
        const yaw = rng.range(0, Math.PI * 2);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(pos.x, pos.y - 1.2 + h / 2, pos.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
          new THREE.Vector3(w, h, d),
        );
        buildings.push({
          matrix: m,
          colorIndex: Math.floor(rng.range(0, BUILDING_COLORS.length)),
          scale: new THREE.Vector3(w, h, d),
        });
      } else {
        const h = rng.range(4, 11);
        const r = h * rng.range(0.22, 0.34);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(pos.x, pos.y - 1.2, pos.z),
          new THREE.Quaternion(),
          new THREE.Vector3(r, h, r),
        );
        trees.push({ matrix: m, colorIndex: 0, scale: new THREE.Vector3(r, h, r) });
      }
    }
  }

  // --- 樹木（幹 + 葉） ---
  if (trees.length > 0) {
    // 単位形状: 幹は高さ 1 の円柱、葉は高さ 1 の円錐（原点が根元）
    const trunkGeom = new THREE.CylinderGeometry(0.12, 0.16, 0.35, 6);
    trunkGeom.translate(0, 0.175, 0);
    const trunk = new THREE.InstancedMesh(
      trunkGeom,
      new THREE.MeshLambertMaterial({ color: 0x5d4633 }),
      trees.length,
    );
    const leafGeom = new THREE.ConeGeometry(1.0, 0.85, 7);
    leafGeom.translate(0, 0.55, 0);
    const leaves = new THREE.InstancedMesh(
      leafGeom,
      new THREE.MeshLambertMaterial({ color: 0x3f7a3a }),
      trees.length,
    );
    const leafColor = new THREE.Color();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i]!;
      trunk.setMatrixAt(i, t.matrix);
      leaves.setMatrixAt(i, t.matrix);
      leafColor.setHSL(0.28 + (i % 7) * 0.006, 0.42, 0.28 + (i % 5) * 0.02);
      leaves.setColorAt(i, leafColor);
    }
    trunk.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    objects.push(trunk, leaves);
  }

  // --- 建物（本体 + 屋根） ---
  if (buildings.length > 0) {
    const body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      buildings.length,
    );
    const roofGeom = new THREE.BoxGeometry(1.06, 0.06, 1.06);
    roofGeom.translate(0, 0.53, 0);
    const roof = new THREE.InstancedMesh(
      roofGeom,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      buildings.length,
    );
    const color = new THREE.Color();
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!;
      body.setMatrixAt(i, b.matrix);
      roof.setMatrixAt(i, b.matrix);
      body.setColorAt(i, color.setHex(BUILDING_COLORS[b.colorIndex]!));
      roof.setColorAt(i, color.setHex(ROOF_COLORS[b.colorIndex % ROOF_COLORS.length]!));
    }
    body.instanceMatrix.needsUpdate = true;
    roof.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (roof.instanceColor) roof.instanceColor.needsUpdate = true;
    objects.push(body, roof);
  }

  return objects;
}

/**
 * トンネルの覆工。
 *
 * 在来線の**電化単線トンネル**の内空断面に合わせる。側壁は起拱線（レール面上
 * 2900mm）まで垂直で、その上は半径 2500mm のアーチ。天端はレール面上 5400mm
 * になり、トロリ線（5000mm）と剛体電車線がぎりぎり収まる。明かり区間の
 * シンプルカテナリ（ちょう架線まで 5960mm）が入らないのはこの断面のためで、
 * トンネルの中だけ架線の形が変わる理由でもある。
 *
 * 覆工のほかに、50m ごとの待避坑（保守作業員が列車をやり過ごす窪み）と、
 * 20m ごとのトンネル照明を置く。内側から見るので両面描画にする。
 *
 * 覆工にはわずかな自発光を持たせてある。太陽光も空からの環境光も届かないため、
 * そのままでは真っ黒になり、断面の形も奥行きも読めなくなるからである。
 * 実物のトンネルも照明で薄明るく、天端と側壁の境目がぼんやり見える。
 */
export function buildTunnels(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const lining = new THREE.MeshLambertMaterial({
    color: 0x77726a,
    emissive: 0x2b2621,
    side: THREE.DoubleSide,
  });

  // 内空断面: 側壁 → アーチ → 側壁。掃引は軌道座標系ではなく鉛直で行う
  // （トンネルはカントに合わせて傾かず、鉛直に掘られる）。
  const section: SectionPoint[] = [[-TUNNEL.arcRadius, TUNNEL.invert]];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI - (Math.PI * i) / 12;
    section.push([
      TUNNEL.arcRadius * Math.cos(a),
      TUNNEL.springLine + TUNNEL.arcRadius * Math.sin(a),
    ]);
  }
  section.push([TUNNEL.arcRadius, TUNNEL.invert]);

  for (const span of route.tunnels.all) {
    const step = 5;
    const n = Math.max(2, Math.ceil((span.end - span.start) / step));
    const stations: SweepStation[] = [];
    for (let i = 0; i <= n; i++) {
      stations.push({ frame: frameAt(span.start + ((span.end - span.start) * i) / n) });
    }
    out.push(new THREE.Mesh(sweepSection(stations, section, { vertical: true }), lining));

    // 坑門（入口の壁）。断面の縁を額縁のように囲う
    for (const s of [span.start, span.end]) {
      const f = frameAt(s);
      const portal = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 1.4, TUNNEL.arcRadius * 2 + TUNNEL.liningThickness * 2),
        new THREE.MeshLambertMaterial({ color: 0x8a857c }),
      );
      portal.quaternion.copy(frameQuaternion(f, false));
      portal.position
        .copy(f.position)
        .add(new THREE.Vector3(0, TUNNEL.springLine + TUNNEL.arcRadius + 0.5, 0));
      out.push(portal);
    }

    // 待避坑（側壁のくぼみ）。壁の内側すれすれに置いて、掘り込まれた穴に見せる
    const refugeMaterial = new THREE.MeshLambertMaterial({ color: 0x191715 });
    for (let s = span.start + TUNNEL.refugePitch; s < span.end; s += TUNNEL.refugePitch) {
      const f = frameAt(s);
      const refuge = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 0.14), refugeMaterial);
      refuge.quaternion.copy(frameQuaternion(f, false));
      refuge.position
        .copy(f.position)
        .addScaledVector(f.right, -(TUNNEL.arcRadius - 0.07))
        .add(new THREE.Vector3(0, TUNNEL.invert + 1.0, 0));
      out.push(refuge);
    }

    // トンネル照明（側壁の上寄りに並ぶ蛍光灯）。
    // 等間隔に流れていく光の列が、トンネルの中でいちばん速度感を出す。
    const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xffe6ad });
    const lampCount = Math.floor((span.end - span.start) / 20);
    if (lampCount > 0) {
      const lamps = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.1, 0.09, 0.06),
        lampMaterial,
        lampCount,
      );
      const m = new THREE.Matrix4();
      const one = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < lampCount; i++) {
        const f = frameAt(span.start + 10 + i * 20);
        const p = f.position
          .clone()
          .addScaledVector(f.right, -(TUNNEL.arcRadius - 0.12))
          .add(new THREE.Vector3(0, TUNNEL.springLine + 0.35, 0));
        lamps.setMatrixAt(i, m.compose(p, frameQuaternion(f, false), one));
      }
      lamps.instanceMatrix.needsUpdate = true;
      out.push(lamps);
    }
  }
  return out;
}
