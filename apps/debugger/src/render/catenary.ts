import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';
import { CATENARY } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import { frameQuaternion, wireGeometry } from './geometry.ts';

const POLE_COLOR = 0x8f958c;
const BRACKET_COLOR = 0xa8aeb4;
const WIRE_COLOR = 0x4a4640;
const CONTACT_COLOR = 0xb98a5a;

/**
 * 架線（シンプルカテナリ式・直流 1500V）。
 *
 * 実物の架線は「トロリ線 1 本」ではない。パンタグラフが擦るトロリ線を
 * レール面上 5000mm の**高さ一定**に保つために、その上にちょう架線を張り、
 * ハンガーで吊っている。ちょう架線は径間の中央でたるむので、ハンガーは
 * 支持点で長く（システム高さ 960mm）、中央へ向かって短くなる。
 *
 * さらにトロリ線は 1 か所だけを擦り減らさないよう、支持点ごとに軌道中心から
 * 左右へ 200mm ずつ振ってある（偏位）。パンタグラフの舟体の上を接点が
 * 行ったり来たりするこのジグザグは、運転席から前を見たときの架線の見え方を
 * 決める一番の特徴になる。
 *
 * ここではその 3 つ — 高さ一定のトロリ線・たるむちょう架線・偏位 — を
 * 実寸で組み立てる。
 */
export function buildCatenary(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
  inTunnel: (s: number) => boolean,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];

  /** 支持点（電化柱の位置）。トンネル内は天井から吊るので柱は立てない */
  const supports: number[] = [];
  for (let s = 0; s <= route.length; s += CATENARY.span) supports.push(s);
  if (supports.length < 2) return out;

  /** 支持点 i における偏位（軌道中心から右へ正）。1 径間ごとに向きが変わる */
  const staggerAt = (index: number): number => (index % 2 === 0 ? 1 : -1) * CATENARY.stagger;

  /** 距離程 s におけるトロリ線の偏位（支持点のあいだは直線で結ぶ） */
  const contactStagger = (s: number): number => {
    const i = Math.min(supports.length - 2, Math.max(0, Math.floor(s / CATENARY.span)));
    const t = (s - supports[i]!) / CATENARY.span;
    return staggerAt(i) * (1 - t) + staggerAt(i + 1) * t;
  };

  /**
   * ちょう架線の高さ。支持点で `contactHeight + systemHeight`、
   * 径間の中央で `sag` だけ下がる放物線。
   */
  const messengerHeight = (s: number): number => {
    const i = Math.min(supports.length - 2, Math.max(0, Math.floor(s / CATENARY.span)));
    const t = (s - supports[i]!) / CATENARY.span;
    return CATENARY.contactHeight + CATENARY.systemHeight - CATENARY.sag * 4 * t * (1 - t);
  };

  /** 距離程 s におけるトロリ線の位置（高さ一定・偏位つき） */
  const contactAt = (s: number): THREE.Vector3 => {
    const f = frameAt(s);
    return f.position
      .clone()
      .addScaledVector(f.right, contactStagger(s))
      .add(new THREE.Vector3(0, CATENARY.contactHeight, 0));
  };

  // --- トロリ線。トンネルの内も外も 1 本で続く ---
  const contactPoints: THREE.Vector3[] = [];
  for (let s = 0; s <= route.length; s += 2.5) contactPoints.push(contactAt(s));
  out.push(
    new THREE.Mesh(
      wireGeometry(contactPoints, CATENARY.contactDiameter / 2, 5),
      new THREE.MeshLambertMaterial({ color: CONTACT_COLOR }),
    ),
  );

  // --- ちょう架線。トンネル区間は剛体電車線に代わるので明かり区間だけに張る ---
  for (const [from, to] of spans(route.length, 2.5, (s) => !inTunnel(s))) {
    const points: THREE.Vector3[] = [];
    for (let s = from; s <= to; s += 2.5) {
      const f = frameAt(s);
      points.push(
        f.position
          .clone()
          .addScaledVector(f.right, contactStagger(s) * 0.5)
          .add(new THREE.Vector3(0, messengerHeight(s), 0)),
      );
    }
    if (points.length < 2) continue;
    out.push(
      new THREE.Mesh(
        wireGeometry(points, CATENARY.messengerDiameter / 2, 4),
        new THREE.MeshLambertMaterial({ color: WIRE_COLOR }),
      ),
    );
  }

  // --- 剛体電車線（トンネル内）。トンネル断面ではちょう架線を吊る高さが取れないため、
  //     トロリ線をアルミの T 形材にはめ込み、覆工から直接支える ---
  out.push(...buildRigidConductor(route, inTunnel, contactAt));

  // --- ハンガー（5m 間隔。ちょう架線とトロリ線の間隔ぶんだけ伸び縮みする） ---
  const hangers: number[] = [];
  for (let s = CATENARY.hangerSpacing; s < route.length; s += CATENARY.hangerSpacing) {
    // 支持点の真上は金具が受け持つのでハンガーは要らない
    if (s % CATENARY.span === 0 || inTunnel(s)) continue;
    hangers.push(s);
  }
  if (hangers.length > 0) {
    const hangerMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.006, 0.006, 1, 4),
      new THREE.MeshLambertMaterial({ color: WIRE_COLOR }),
      hangers.length,
    );
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < hangers.length; i++) {
      const s = hangers[i]!;
      const f = frameAt(s);
      const length = Math.max(0.05, messengerHeight(s) - CATENARY.contactHeight);
      p.copy(f.position)
        .addScaledVector(f.right, contactStagger(s) * 0.75)
        .add(new THREE.Vector3(0, CATENARY.contactHeight + length / 2, 0));
      scale.set(1, length, 1);
      hangerMesh.setMatrixAt(i, m.compose(p, q, scale));
    }
    hangerMesh.instanceMatrix.needsUpdate = true;
    out.push(hangerMesh);
  }

  // --- 電化柱と可動ブラケット ---
  for (let i = 0; i < supports.length; i++) {
    const s = supports[i]!;
    if (s > route.length || inTunnel(s)) continue;
    out.push(buildSupport(frameAt(s), staggerAt(i)));
  }

  return out;
}

/**
 * 述語が成り立つ距離程の連続した区間を拾う。
 * トンネルの内と外で架線の吊り方が変わるので、その境目を求めるのに使う。
 */
function spans(
  length: number,
  step: number,
  predicate: (s: number) => boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from: number | null = null;
  for (let s = 0; s <= length; s += step) {
    if (predicate(s)) {
      if (from === null) from = s;
    } else if (from !== null) {
      out.push([from, s - step]);
      from = null;
    }
  }
  if (from !== null) out.push([from, length]);
  return out.filter(([a, b]) => b > a);
}

/**
 * 剛体電車線（トンネル内）。
 *
 * トロリ線をはめ込んだアルミの T 形材と、覆工から吊る支持金具を並べる。
 * ちょう架線が無いぶん架線の見え方がはっきり変わるので、トンネルに入った
 * ことが視覚的にも伝わる。
 */
function buildRigidConductor(
  route: CompiledRoute,
  inTunnel: (s: number) => boolean,
  contactAt: (s: number) => THREE.Vector3,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const material = new THREE.MeshLambertMaterial({ color: 0xa9aeb2 });
  for (const [from, to] of spans(route.length, 2.5, inTunnel)) {
    const points: THREE.Vector3[] = [];
    for (let s = from; s <= to; s += 2.5) {
      points.push(contactAt(s).add(new THREE.Vector3(0, 0.09, 0)));
    }
    if (points.length < 2) continue;
    out.push(new THREE.Mesh(wireGeometry(points, 0.055, 4), material));

    // 支持金具（5m 間隔で覆工から吊る）
    for (let s = Math.ceil(from / 5) * 5; s <= to; s += 5) {
      const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), material);
      hanger.position.copy(contactAt(s)).add(new THREE.Vector3(0, 0.6, 0));
      out.push(hanger);
    }
  }
  return out;
}

/**
 * 1 基の電化柱。
 *
 * 実物の可動ブラケットは、柱から斜め上へ伸びる主管でちょう架線を支え、
 * その下の水平な振止金具でトロリ線を偏位の位置に保持する。曲線では
 * 「曲線引金具」がトロリ線を軌道の内側へ引く。ここでは主管・振止金具・
 * ちょう架線支持金具・曲線引の 4 つを組み立てる。
 */
function buildSupport(frame: TrackFrame, stagger: number): THREE.Object3D {
  const group = new THREE.Group();
  // 日本の在来線は左側通行で、ホームも信号機も進行方向左側に置く。
  // 電化柱はそれらと場所を取り合わないよう反対の右側に建植する。
  const side = 1;
  const poleLateral = side * CATENARY.poleOffset;

  // 柱（根元が太い鋼管柱）
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.16, CATENARY.poleHeight, 8),
    new THREE.MeshLambertMaterial({ color: POLE_COLOR }),
  );
  pole.position.set(0, CATENARY.poleHeight / 2 - 0.6, 0);
  group.add(pole);

  // 基礎
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.38, 0.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x9d9a92 }),
  );
  base.position.y = -0.55;
  group.add(base);

  const bracketMaterial = new THREE.MeshLambertMaterial({ color: BRACKET_COLOR });

  // 主管（斜め上へ伸びてちょう架線を支える）
  const messengerTop = CATENARY.contactHeight + CATENARY.systemHeight;
  group.add(
    tube(
      new THREE.Vector3(0, messengerTop - 1.9, 0),
      new THREE.Vector3(-poleLateral + stagger * 0.5, messengerTop, 0),
      0.045,
      bracketMaterial,
    ),
  );
  // 振止金具（水平。トロリ線の高さでブラケットを支える）
  group.add(
    tube(
      new THREE.Vector3(0, CATENARY.contactHeight + 0.15, 0),
      new THREE.Vector3(-poleLateral + stagger, CATENARY.contactHeight + 0.15, 0),
      0.032,
      bracketMaterial,
    ),
  );
  // 曲線引金具（振止金具の先からトロリ線をつまむ）
  group.add(
    tube(
      new THREE.Vector3(-poleLateral + stagger, CATENARY.contactHeight + 0.15, 0),
      new THREE.Vector3(-poleLateral + stagger, CATENARY.contactHeight + 0.02, 0),
      0.02,
      bracketMaterial,
    ),
  );
  // ちょう架線支持金具（主管の先からちょう架線へ下ろす）
  group.add(
    tube(
      new THREE.Vector3(-poleLateral + stagger * 0.5, messengerTop, 0),
      new THREE.Vector3(-poleLateral + stagger * 0.5, messengerTop - 0.12, 0),
      0.018,
      bracketMaterial,
    ),
  );
  // 碍子（主管と振止金具の付け根）
  for (const y of [messengerTop - 1.9, CATENARY.contactHeight + 0.15]) {
    const insulator = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.22, 8),
      new THREE.MeshLambertMaterial({ color: 0x6d5b52 }),
    );
    insulator.rotation.z = Math.PI / 2;
    insulator.position.set(0, y, -side * 0.16);
    group.add(insulator);
  }

  // 柱の局所系: X = 進行方向、Y = 鉛直、Z = 軌道の右方向
  group.quaternion.copy(frameQuaternion(frame, false));
  group.position.copy(frame.position).addScaledVector(frame.right, poleLateral);
  // 局所 Z を「軌道中心へ向かう向き」に読み替えるため、各部材の横位置は
  // 上のベクトル生成で z 成分ではなく x 成分に入れてある（下の tube() が入れ替える）
  return group;
}

/**
 * 2 点を結ぶ丸棒。
 * `from`/`to` の x 成分を「軌道の右方向（局所 Z）」として読み替える。
 * 架線金具は進行方向にはほとんど広がらないので、この 2 次元指定で足りる。
 */
function tube(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const a = new THREE.Vector3(0, from.y, from.x);
  const b = new THREE.Vector3(0, to.y, to.x);
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = Math.max(1e-3, dir.length());
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 6), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}
