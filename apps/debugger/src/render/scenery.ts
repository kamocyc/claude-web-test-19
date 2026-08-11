import * as THREE from 'three';
import { Rng, type CompiledRoute } from '@railsim/core';
import type { TrackFrame } from './frame.ts';

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
 * 沿線の景観（樹木・建物・架線柱・架線）を生成する。
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

  objects.push(...buildCatenary(route, frameAt, inTunnel));
  return objects;
}

/**
 * 架線柱と架線。
 * 電化区間の見た目を決める要素であり、等間隔に並ぶので速度感を出すのにも効く。
 */
function buildCatenary(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  inTunnel: (s: number) => boolean,
): THREE.Object3D[] {
  const spacing = 45;
  const positions: number[] = [];
  for (let s = 0; s <= route.length; s += spacing) {
    if (!inTunnel(s)) positions.push(s);
  }
  if (positions.length === 0) return [];

  const poleGeom = new THREE.CylinderGeometry(0.11, 0.15, 8, 6);
  poleGeom.translate(0, 4, 0);
  const pole = new THREE.InstancedMesh(
    poleGeom,
    new THREE.MeshLambertMaterial({ color: 0x8a9099 }),
    positions.length,
  );
  const armGeom = new THREE.BoxGeometry(0.12, 0.12, 3.4);
  armGeom.translate(0, 7.3, -1.7);
  const arm = new THREE.InstancedMesh(
    armGeom,
    new THREE.MeshLambertMaterial({ color: 0x8a9099 }),
    positions.length,
  );

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < positions.length; i++) {
    const f = frameAt(positions[i]!);
    q.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(f.forward, new THREE.Vector3(0, 1, 0), f.right),
    );
    const p = f.position.clone().addScaledVector(f.right, 3.9);
    m.compose(p, q, one);
    pole.setMatrixAt(i, m);
    arm.setMatrixAt(i, m);
  }
  pole.instanceMatrix.needsUpdate = true;
  arm.instanceMatrix.needsUpdate = true;

  // トロリ線（軌道中心の上を通る 1 本の線）
  const wirePoints: THREE.Vector3[] = [];
  for (let s = 0; s <= route.length; s += 5) {
    const f = frameAt(s);
    wirePoints.push(f.position.clone().add(new THREE.Vector3(0, 5.2, 0)));
  }
  const wire = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(wirePoints),
    new THREE.LineBasicMaterial({ color: 0x6a6f74 }),
  );

  return [pole, arm, wire];
}

/**
 * トンネルの覆工。
 * 軌道に沿ってアーチ断面を掃引する。内側から見るので両面描画にする。
 */
export function buildTunnels(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  // アーチ断面（車両限界の外側）: 側壁 → 円弧 → 側壁
  const section: Array<[number, number]> = [];
  const radius = 3.6;
  const springLine = 1.6;
  section.push([-radius, -0.6]);
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    section.push([radius * Math.cos(a), springLine + radius * Math.sin(a)]);
  }
  section.push([radius, -0.6]);

  for (const span of route.tunnels.all) {
    const start = span.start;
    const end = span.end;
    const step = 6;
    const n = Math.max(2, Math.ceil((end - start) / step));
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = start + ((end - start) * i) / n;
      const f = frameAt(s);
      for (const [lat, up] of section) {
        const p = f.position
          .clone()
          .addScaledVector(f.right, lat)
          .add(new THREE.Vector3(0, up, 0));
        positions.push(p.x, p.y, p.z);
      }
    }
    const m = section.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m - 1; j++) {
        const a = i * m + j;
        const b = a + m;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    out.push(
      new THREE.Mesh(
        geom,
        new THREE.MeshLambertMaterial({ color: 0x6e6a63, side: THREE.DoubleSide }),
      ),
    );
  }
  return out;
}
