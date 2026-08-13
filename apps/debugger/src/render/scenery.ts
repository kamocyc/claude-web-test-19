import * as THREE from 'three';
import { Rng, type CompiledRoute } from '@railsim/core';
import { TUNNEL } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import {
  frameQuaternion,
  sectionLength,
  sweepSection,
  type SectionPoint,
  type SweepStation,
} from './geometry.ts';
import {
  concreteSurface,
  facadeSurface,
  glowTexture,
  plateTexture,
  tunnelLiningSurface,
} from './textures.ts';

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
  // 橋の下は谷か川なので、そこに樹木や建物は立っていない
  const overWater = (s: number): boolean => route.bridges.overlapping(s - 45, s + 45).length > 0;

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
    if (s < 0 || s > route.length || inTunnel(s) || overWater(s)) continue;
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
    // 外壁には窓の並んだ模様を貼る。遠景の建物が「箱」ではなく建物に見えるかは
    // ほとんどこれで決まる。1 インスタンスの UV は 0..1 なので、建物の大きさに
    // 応じて窓の大きさも変わる（背の高い建物ほど階数が多く見える）。
    const body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        ...facadeSurface().maps(1),
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughness: 0.85,
      }),
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

/** トンネル内空の断面（側壁 → アーチ → 側壁）。掃引にも壁面の位置決めにも使う */
function tunnelSection(): SectionPoint[] {
  const section: SectionPoint[] = [[-TUNNEL.arcRadius, TUNNEL.invert]];
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI - (Math.PI * i) / 16;
    section.push([
      TUNNEL.arcRadius * Math.cos(a),
      TUNNEL.springLine + TUNNEL.arcRadius * Math.sin(a),
    ]);
  }
  section.push([TUNNEL.arcRadius, TUNNEL.invert]);
  return section;
}

/**
 * トンネルの覆工とその中の設備。
 *
 * 在来線の**電化単線トンネル**の内空断面に合わせる。側壁は起拱線（レール面上
 * 2900mm）まで垂直で、その上は半径 2500mm のアーチ。天端はレール面上 5400mm
 * になり、トロリ線（5000mm）と剛体電車線がぎりぎり収まる。明かり区間の
 * シンプルカテナリ（ちょう架線まで 5960mm）が入らないのはこの断面のためで、
 * トンネルの中だけ架線の形が変わる理由でもある。
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
 * 10.5m ごとの打継目もテクスチャの左右端に入れてあるので、走ると等間隔の
 * 縦線が流れていく。
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
  const section = tunnelSection();
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

  const concrete = concreteSurface();
  const walkwayMaterial = new THREE.MeshStandardMaterial({
    color: 0x8f8a80,
    ...concrete.maps(1.5),
    roughness: 0.95,
    emissive: 0x2a2620,
  });

  for (const span of route.tunnels.all) {
    const step = 4;
    const n = Math.max(2, Math.ceil((span.end - span.start) / step));
    const stations: SweepStation[] = [];
    for (let i = 0; i <= n; i++) {
      stations.push({ frame: frameAt(span.start + ((span.end - span.start) * i) / n) });
    }
    out.push(new THREE.Mesh(sweepSection(stations, section, { vertical: true }), lining));

    // 保守用の歩廊と側溝（両側の壁ぎわ。実物の単線トンネルにも必ずある）
    for (const side of [-1, 1] as const) {
      const x = side * (TUNNEL.arcRadius - 0.02);
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
        [-(TUNNEL.arcRadius - 0.06), TUNNEL.invert + height + radius],
        [-(TUNNEL.arcRadius - 0.06 - radius * 2), TUNNEL.invert + height + radius],
        [-(TUNNEL.arcRadius - 0.06 - radius * 2), TUNNEL.invert + height - radius],
        [-(TUNNEL.arcRadius - 0.06), TUNNEL.invert + height - radius],
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
    out.push(...buildTunnelBrackets(span.start, span.end, frameAt));

    out.push(...buildPortal(frameAt(span.start)));
    out.push(...buildPortal(frameAt(span.end)));
    out.push(...buildRefuges(span.start, span.end, frameAt));
    out.push(...buildTunnelLights(span.start, span.end, frameAt));
  }
  return out;
}

/** ケーブルラックを覆工に留める受け金物 */
function buildTunnelBrackets(
  start: number,
  end: number,
  frameAt: (s: number) => TrackFrame,
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
      .addScaledVector(f.right, -(TUNNEL.arcRadius - 0.11))
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
function buildPortal(f: TrackFrame): THREE.Object3D[] {
  const material = new THREE.MeshStandardMaterial({
    color: 0x9c968c,
    ...concreteSurface().maps(2.0),
    roughness: 0.95,
  });
  const group = new THREE.Group();
  const outer = TUNNEL.arcRadius + TUNNEL.liningThickness;

  // アーチの縁（内空の周りを 1 周する額縁）
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(TUNNEL.arcRadius + 0.2, 0.22, 8, 20, Math.PI),
    material,
  );
  ring.rotation.y = Math.PI / 2;
  ring.position.set(0, TUNNEL.springLine, 0);
  group.add(ring);
  for (const side of [-1, 1] as const) {
    const jamb = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, TUNNEL.springLine - TUNNEL.invert, 0.44),
      material,
    );
    jamb.position.set(0, (TUNNEL.springLine + TUNNEL.invert) / 2, side * (TUNNEL.arcRadius + 0.2));
    group.add(jamb);
    // 翼壁（坑口の両脇でのり面を受ける壁）
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.6, 3.4), material);
    wing.position.set(0, TUNNEL.invert + 2.3, side * (outer + 1.5));
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
    const x = -(TUNNEL.arcRadius - 0.02);

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
      .addScaledVector(f.right, -(TUNNEL.arcRadius - 0.14))
      .add(new THREE.Vector3(0, TUNNEL.springLine + 0.35, 0));
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
