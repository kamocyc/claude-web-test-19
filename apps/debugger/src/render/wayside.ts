import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';
import { BALLAST, BEACON, PLATFORM, RAIL, SIGNAL, SLEEPER } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import { frameQuaternion } from './geometry.ts';

/**
 * 沿線の設備（信号機・標識・地上子・駅）。
 *
 * 日本の在来線は左側通行なので、信号機もホームも**進行方向左側**に置く。
 * 運転士も左に座っているため、これらは運転席の窓のすぐ左を流れていくことになる。
 */

const MAST_COLOR = 0x767c84;
const BOARD_COLOR = 0x1a1d21;

/** 消灯した灯器の色（レンズは光っていなくても色ガラスの地色が見える） */
const DARK_LENS = 0x1d2024;

/**
 * 標識を建てる場所。
 *
 * 道床ののり尻から先は路盤の肩（平らな部分）で、線路際の標識はここに建つ。
 * 盛土ののり面に立てると宙に浮くので、横の位置と高さをこの面に合わせる。
 */
const SHOULDER = {
  lateral: SLEEPER.length / 2 + BALLAST.shoulder + BALLAST.formationShoulder + 0.25,
  level: -RAIL.height - SLEEPER.height - BALLAST.depth,
} as const;

/** 点灯時の灯器の色 */
const LIT = { red: 0xff2a1c, yellow: 0xffb020, green: 0x2ce05a } as const;

/**
 * 4 灯式信号機の灯器の並び（上から）。
 *
 * 現示との対応:
 *
 * | 現示 | 意味 | 点灯する灯器 |
 * |------|------|--------------|
 * | G    | 進行 | 緑 |
 * | YG   | 減速 | 上の黄 + 緑 |
 * | Y    | 注意 | 下の黄 |
 * | YY   | 警戒 | 上の黄 + 下の黄 |
 * | R    | 停止 | 赤 |
 *
 * 灯器 4 個で 5 現示を出すこの配列が、JR の閉塞信号機のいちばん普通の形である。
 */
const LAMP_ORDER = ['yellow', 'green', 'yellow', 'red'] as const;

/** 現示 -> 点灯する灯器の番号（`LAMP_ORDER` の添字） */
const ASPECT_LAMPS: Record<string, readonly number[]> = {
  R: [3],
  YY: [0, 2],
  Y: [2],
  YG: [0, 1],
  G: [1],
};

export interface SignalHandle {
  /** 現示に合わせて灯器を点滅させる */
  setAspect(aspect: string): void;
}

/**
 * 色灯式信号機を建てる。
 *
 * 柱は軌道中心から 1900〜2400mm、最下段の灯器はレール面上 4200mm 以上、という
 * 実物の建植基準に合わせる。灯器はレンズ・フード・背板の 3 つで構成し、
 * 前から見たときに黒い背板の中に色のついた丸が並ぶ形になる。
 */
export function buildSignals(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): { objects: THREE.Object3D[]; handles: Map<string, SignalHandle> } {
  const objects: THREE.Object3D[] = [];
  const handles = new Map<string, SignalHandle>();

  for (const signal of route.signals) {
    const f = frameAt(signal.position);
    const group = new THREE.Group();
    const lamps: THREE.Mesh[] = [];

    const topLamp = SIGNAL.bottomLampHeight + SIGNAL.unitPitch * (LAMP_ORDER.length - 1);

    // 柱（路盤の肩から灯器の上まで）
    const mastHeight = topLamp + 0.3 - SHOULDER.level;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(SIGNAL.mastDiameter / 2, SIGNAL.mastDiameter / 2, mastHeight, 10),
      new THREE.MeshLambertMaterial({ color: MAST_COLOR }),
    );
    mast.position.y = mastHeight / 2 + SHOULDER.level;
    group.add(mast);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.34, 0.5, 8),
      new THREE.MeshLambertMaterial({ color: 0x9d9a92 }),
    );
    base.position.y = SHOULDER.level - 0.2;
    group.add(base);

    // 背板（灯器の背後の黒い板。現示を見やすくするためのもの）
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, SIGNAL.unitPitch * LAMP_ORDER.length + 0.24, SIGNAL.boardWidth),
      new THREE.MeshLambertMaterial({ color: BOARD_COLOR }),
    );
    // 灯器の背後（列車から見て奥）に置く
    board.position.set(0.04, (SIGNAL.bottomLampHeight + topLamp) / 2, 0);
    group.add(board);

    for (let i = 0; i < LAMP_ORDER.length; i++) {
      const y = topLamp - i * SIGNAL.unitPitch;
      // 灯器の胴（フード）
      const hood = new THREE.Mesh(
        new THREE.CylinderGeometry(
          SIGNAL.unitDiameter / 2,
          SIGNAL.unitDiameter / 2 - 0.03,
          SIGNAL.hoodLength,
          12,
          1,
          true,
        ),
        new THREE.MeshLambertMaterial({ color: BOARD_COLOR, side: THREE.DoubleSide }),
      );
      hood.rotation.z = Math.PI / 2;
      // フードは列車の来る側（局所 X の負側）へ突き出す
      hood.position.set(-0.08 - SIGNAL.hoodLength / 2, y, 0);
      group.add(hood);

      // レンズ（点灯すると自ら光って見えるよう基本材質にする）
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(SIGNAL.lensDiameter / 2, 16),
        new THREE.MeshBasicMaterial({ color: DARK_LENS, side: THREE.DoubleSide }),
      );
      lens.rotation.y = -Math.PI / 2;
      lens.position.set(-0.08, y, 0);
      group.add(lens);
      lamps.push(lens);
    }

    // 番号板（閉塞信号機の番号。白地に黒文字だが、ここでは白い板として置く）
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.3, 0.24),
      new THREE.MeshLambertMaterial({ color: 0xf2f4f6 }),
    );
    plate.position.set(-0.05, SIGNAL.bottomLampHeight - 0.5, 0);
    group.add(plate);

    // 局所系: X = 進行方向、Y = 鉛直、Z = 軌道の右方向。
    // 灯器は後ろから来る列車へ向けるので、X の負側（= 手前）を向ける。
    group.quaternion.copy(frameQuaternion(f, false));
    group.position.copy(f.position).addScaledVector(f.right, -SIGNAL.offset);
    objects.push(group);

    handles.set(signal.id, {
      setAspect(aspect: string): void {
        const lit = ASPECT_LAMPS[aspect] ?? [];
        for (let i = 0; i < lamps.length; i++) {
          const material = lamps[i]!.material as THREE.MeshBasicMaterial;
          material.color.setHex(lit.includes(i) ? LIT[LAMP_ORDER[i]!] : DARK_LENS);
        }
      },
    });
  }

  return { objects, handles };
}

/**
 * 距離標。
 *
 * 100m ごとの小さな標識と、1km ごとの大きな標識を建てる。実物は白い標柱に
 * 距離を書いたもので、線路のどちら側に置くかは線区で決まっている。ここでは
 * 信号機・ホームと重ならないよう、右側の路盤の肩に建てる。
 */
export function buildDistancePosts(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const white = new THREE.MeshLambertMaterial({ color: 0xf0f2f4 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2f353c });

  const minor = Math.floor(route.length / 100);
  const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.75, 0.09), white, minor);
  const board = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.22, 0.3), white, minor);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < minor; i++) {
    const f = frameAt(i * 100);
    const q = frameQuaternion(f, false);
    p.copy(f.position)
      .addScaledVector(f.right, SHOULDER.lateral)
      .add(new THREE.Vector3(0, SHOULDER.level + 0.375, 0));
    post.setMatrixAt(i, m.compose(p, q, one));
    p.add(new THREE.Vector3(0, 0.44, 0));
    board.setMatrixAt(i, m.compose(p, q, one));
  }
  post.instanceMatrix.needsUpdate = true;
  board.instanceMatrix.needsUpdate = true;
  out.push(post, board);

  // 1km ごとの距離標は一回り大きく、黒い縁を付ける
  for (let km = 0; km * 1000 <= route.length; km++) {
    const f = frameAt(km * 1000);
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.2, 0.11), white);
    pole.position.y = 0.6;
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.5), white);
    face.position.y = 1.35;
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.46, 0.56), dark);
    rim.position.set(-0.01, 1.35, 0);
    group.add(pole, face, rim);
    group.quaternion.copy(frameQuaternion(f, false));
    group.position
      .copy(f.position)
      .addScaledVector(f.right, SHOULDER.lateral)
      .add(new THREE.Vector3(0, SHOULDER.level, 0));
    out.push(group);
  }
  return out;
}

/**
 * 勾配標。
 *
 * 勾配が変わる地点に建て、これから先の勾配を示す。上り勾配は右上がり、
 * 下り勾配は右下がりの腕木で表すのが実物の形なので、腕を傾けて置く。
 * 距離標と重ならないよう、こちらは左側の路盤の肩に建てる。
 */
export function buildGradePosts(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const white = new THREE.MeshLambertMaterial({ color: 0xeef1f4 });
  const step = 20;
  let previous = route.alignment.gradeAt(0);
  for (let s = step; s <= route.length; s += step) {
    const grade = route.alignment.gradeAt(s);
    if (Math.abs(grade - previous) < 0.002) continue;
    previous = grade;

    const f = frameAt(s);
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), white);
    pole.position.y = 0.7;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.85), white);
    arm.position.y = 1.4;
    // 腕木の傾きで勾配の向きを示す（誇張しないと見えないので 6 倍）
    arm.rotation.x = Math.atan(grade * 6);
    group.add(pole, arm);
    group.quaternion.copy(frameQuaternion(f, false));
    group.position
      .copy(f.position)
      .addScaledVector(f.right, -SHOULDER.lateral)
      .add(new THREE.Vector3(0, SHOULDER.level, 0));
    out.push(group);
  }
  return out;
}

/**
 * ATS の地上子。
 *
 * 実物はまくらぎの上に固定された黄色い箱で、車上子と向かい合って情報をやり取りする。
 * 軌道中心からわずかに左へ寄せた位置に、レール面より低く据える。
 */
export function buildBeacons(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const entries = route.beacons.all;
  if (entries.length === 0) return [];

  const body = new THREE.InstancedMesh(
    new THREE.BoxGeometry(BEACON.width, BEACON.height, BEACON.length),
    new THREE.MeshLambertMaterial({ color: 0xe2b23a }),
    entries.length,
  );
  const bracket = new THREE.InstancedMesh(
    new THREE.BoxGeometry(BEACON.width + 0.1, 0.03, 0.06),
    new THREE.MeshLambertMaterial({ color: 0x4a4f55 }),
    entries.length * 2,
  );
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < entries.length; i++) {
    const f = frameAt(entries[i]!.s);
    const q = frameQuaternion(f);
    const top = -RAIL.height - SLEEPER.height * 0.25;
    p.copy(f.position)
      .addScaledVector(f.cantRight, BEACON.offset)
      .addScaledVector(f.up, top - BEACON.height / 2);
    body.setMatrixAt(i, m.compose(p, q, one));
    for (let k = 0; k < 2; k++) {
      p.copy(f.position)
        .addScaledVector(f.cantRight, BEACON.offset + (k === 0 ? -1 : 1) * (BEACON.length / 2))
        .addScaledVector(f.up, top - BEACON.height);
      bracket.setMatrixAt(i * 2 + k, m.compose(p, q, one));
    }
  }
  body.instanceMatrix.needsUpdate = true;
  bracket.instanceMatrix.needsUpdate = true;
  return [body, bracket];
}

/**
 * プラットホーム。
 *
 * 高さはレール面上 1100mm（ステップの無い電車専用区間の値）、縁端は軌道中心から
 * 1600mm。車体幅 2950mm の車両との隙間は 125mm になり、実物と同じく「足元が
 * 見えるほど狭い隙間」になる。縁端には白線と点字ブロックを敷き、上屋は柱で支える。
 */
export function buildStations(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const deck = new THREE.MeshLambertMaterial({ color: 0xb0aca4 });
  const wall = new THREE.MeshLambertMaterial({ color: 0x8f8b84 });
  const tactile = new THREE.MeshLambertMaterial({ color: 0xe8c33a });
  const line = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
  const steel = new THREE.MeshLambertMaterial({ color: 0x9aa1a8 });
  const roofMaterial = new THREE.MeshLambertMaterial({ color: 0x6f757c });

  for (const station of route.stations) {
    const length = station.platformEnd - station.platformStart;
    const mid = (station.platformEnd + station.platformStart) / 2;
    const f = frameAt(mid);
    const q = frameQuaternion(f, false);
    /** ホーム中心の軌道中心からの距離（左側）。縁端 1600mm から幅の半分だけ外へ */
    const centre = -(PLATFORM.edgeOffset + PLATFORM.width / 2);

    const place = (mesh: THREE.Object3D, lateral: number, height: number): THREE.Object3D => {
      mesh.quaternion.copy(q);
      mesh.position
        .copy(f.position)
        .addScaledVector(f.right, lateral)
        .add(new THREE.Vector3(0, height, 0));
      return mesh;
    };

    // 床（表面）と側壁
    out.push(
      place(
        new THREE.Mesh(new THREE.BoxGeometry(length, 0.12, PLATFORM.width), deck),
        centre,
        PLATFORM.height - 0.06,
      ),
    );
    out.push(
      place(
        new THREE.Mesh(new THREE.BoxGeometry(length, PLATFORM.height, PLATFORM.width - 0.1), wall),
        centre,
        (PLATFORM.height - 0.12) / 2,
      ),
    );

    // 縁端の白線と点字ブロック
    out.push(
      place(
        new THREE.Mesh(new THREE.BoxGeometry(length, 0.02, 0.1), line),
        -(PLATFORM.edgeOffset + 0.12),
        PLATFORM.height + 0.005,
      ),
    );
    out.push(
      place(
        new THREE.Mesh(new THREE.BoxGeometry(length, 0.03, PLATFORM.tactileWidth), tactile),
        -(PLATFORM.edgeOffset + PLATFORM.tactileOffset),
        PLATFORM.height + 0.01,
      ),
    );

    // 上屋（柱 + 梁 + 屋根）
    const roofLength = length * 0.85;
    const roofY = PLATFORM.height + PLATFORM.roofHeight;
    const columns = Math.max(2, Math.round(roofLength / PLATFORM.roofPitch));
    for (let i = 0; i <= columns; i++) {
      const x = -roofLength / 2 + (roofLength * i) / columns;
      for (const lateral of [
        centre - PLATFORM.width / 2 + 1.0,
        centre + PLATFORM.width / 2 - 1.0,
      ]) {
        const column = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, PLATFORM.roofHeight, 0.18),
          steel,
        );
        const placed = place(column, lateral, PLATFORM.height + PLATFORM.roofHeight / 2);
        placed.position.addScaledVector(f.forward, x);
        out.push(placed);
      }
    }
    out.push(
      place(
        new THREE.Mesh(new THREE.BoxGeometry(roofLength, 0.16, PLATFORM.width - 1.2), roofMaterial),
        centre,
        roofY,
      ),
    );

    // 駅名標（上屋から吊る）
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.05), line);
    out.push(place(sign, -(PLATFORM.edgeOffset + 1.2), roofY - 0.6));

    // 停止位置目標（ホーム上に立てる。先頭車の運転席から見える高さに置く）
    const fs = frameAt(station.stopPosition);
    const marker = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.8, 0.06), steel);
    pole.position.y = 0.9;
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 0.42), line);
    face.position.y = 1.85;
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.5, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x2f353c }),
    );
    rim.position.set(0.01, 1.85, 0);
    marker.add(pole, face, rim);
    marker.quaternion.copy(frameQuaternion(fs, false));
    marker.position
      .copy(fs.position)
      .addScaledVector(fs.right, -(PLATFORM.edgeOffset + 0.5))
      .add(new THREE.Vector3(0, PLATFORM.height, 0));
    out.push(marker);
  }
  return out;
}
