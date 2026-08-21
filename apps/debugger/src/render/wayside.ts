import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';
import { BALLAST, BEACON, CAR, PLATFORM, RAIL, SIGNAL, SLEEPER } from './dimensions.ts';
import type { TrackFrame } from './frame.ts';
import { frameQuaternion, meterPlane } from './geometry.ts';
import {
  concreteSurface,
  glowTexture,
  plateTexture,
  platformDeckSurface,
  roofPanelSurface,
  rustedSteelSurface,
  stationSignTexture,
  tactileSurface,
} from './textures.ts';
import { hdrColor } from './postprocess.ts';

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
 * 灯火の輝度倍率。
 *
 * 実物の色灯式信号機は 1000cd を超える光度を持ち、晴天の昼でも周りの何十倍と
 * いう明るさで光る。画面の白（1.0）に収めてしまうと「色の付いた円板」に
 * しかならないので、リニア値で 1 を超える色を与え、後処理のブルーム
 * （`postprocess.ts`）に拾わせて周りへにじませる。
 */
const LAMP_GAIN = 3.2;
/** にじみの板はレンズよりさらに強く光らせる（光源そのものの周りの暈） */
const HALO_GAIN = 2.4;

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
    const halos: THREE.Mesh[] = [];

    const topLamp = SIGNAL.bottomLampHeight + SIGNAL.unitPitch * (LAMP_ORDER.length - 1);

    // 柱（路盤の肩から灯器の上まで）
    const mastHeight = topLamp + 0.3 - SHOULDER.level;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(SIGNAL.mastDiameter / 2, SIGNAL.mastDiameter / 2, mastHeight, 10),
      new THREE.MeshStandardMaterial({
        color: MAST_COLOR,
        ...rustedSteelSurface().maps(1.2, 0.5),
        normalScale: new THREE.Vector2(0.4, 0.4),
        metalness: 0.5,
        roughness: 0.6,
      }),
    );
    mast.position.y = mastHeight / 2 + SHOULDER.level;
    group.add(mast);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.34, 0.5, 8),
      new THREE.MeshStandardMaterial({
        color: 0x9d9a92,
        ...concreteSurface().maps(1.0),
        roughness: 0.95,
      }),
    );
    base.position.y = SHOULDER.level - 0.2;
    group.add(base);

    // 背板（灯器の背後の黒い板。現示を見やすくするためのもの）
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, SIGNAL.unitPitch * LAMP_ORDER.length + 0.24, SIGNAL.boardWidth),
      new THREE.MeshStandardMaterial({ color: BOARD_COLOR, roughness: 0.8 }),
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
        new THREE.MeshStandardMaterial({
          color: BOARD_COLOR,
          roughness: 0.8,
          side: THREE.DoubleSide,
        }),
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

      // 灯火のにじみ。実物の信号機は、光っている灯器だけがレンズの大きさより
      // 一回り大きく滲んで見える。これがあると遠くからでも現示が読める。
      const halo = new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, 0.62),
        new THREE.MeshBasicMaterial({
          map: glowTexture(),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      halo.rotation.y = -Math.PI / 2;
      halo.position.set(-0.12, y, 0);
      halo.visible = false;
      group.add(halo);
      halos.push(halo);
    }

    // 番号板（閉塞信号機の番号。白地に黒文字）
    const number = signal.id.replace(/[^0-9]/g, '') || '1';
    const plate = textPlate(
      plateTexture([number], { background: '#f2f4f6', color: '#15191d', aspect: 0.8 }),
      0.24,
      0.3,
      -1,
      0xf2f4f6,
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
          const on = lit.includes(i);
          const color = LIT[LAMP_ORDER[i]!];
          (lamps[i]!.material as THREE.MeshBasicMaterial).color.copy(
            on ? hdrColor(color, LAMP_GAIN) : hdrColor(DARK_LENS, 1),
          );
          const halo = halos[i]!;
          halo.visible = on;
          (halo.material as THREE.MeshBasicMaterial).color.copy(hdrColor(color, HALO_GAIN));
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
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f2f4, roughness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2f353c, roughness: 0.7 });

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

  // 1km ごとの距離標は一回り大きく、キロ程を書いた板を付ける
  for (let km = 0; km * 1000 <= route.length; km++) {
    const f = frameAt(km * 1000);
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.2, 0.11), white);
    pole.position.y = 0.6;
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.46, 0.56), dark);
    rim.position.set(-0.01, 1.35, 0);
    const face = textPlate(
      plateTexture([`${km}`], { background: '#f0f2f4', color: '#15191d', aspect: 1.25 }),
      0.5,
      0.4,
      -1,
      0xf0f2f4,
    );
    face.position.y = 1.35;
    group.add(pole, rim, face);
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
 * 勾配標の腕木の傾き [rad]。
 *
 * 勾配そのものの角度では付けない。25‰ は角度にすれば 1.4° しかなく、そのまま
 * 作っても水平にしか見えないからで、実物の腕木も離れて見て向きが分かる角度まで
 * 起こしてある。緩い勾配ほど強く誇張し、きつい勾配では頭打ちになるよう当てる
 * （勾配の値そのものは腕木に載せた数字が伝える）。
 */
function gradeArmTilt(grade: number): number {
  /** 倒しきったときの角度 [rad] */
  const MAX_TILT = 0.42;
  /** この勾配 [m/m] でおよそ 8 割まで倒れる */
  const REFERENCE = 0.012;
  return MAX_TILT * Math.tanh(grade / REFERENCE);
}

/**
 * 勾配標。
 *
 * 勾配が変わる地点に建て、これから先の勾配を示す。柱の頂部から腕木が片持ちで
 * 出ていて、上り勾配なら右上がり、下り勾配なら右下がりに斜めに傾くのが実物の
 * 形なので、そのとおり組む。腕木には勾配の値（‰、平坦は "L"）を書いた板を載せる。
 * 距離標と重ならないよう、こちらは左側の路盤の肩に建てる。
 *
 * 建てる場所は `Alignment.gradeChanges` が返す勾配変化点そのもので、縦曲線が
 * あるときはその中心（前後の勾配線の交点）になる。縦曲線の中は勾配が連続的に
 * 変化しているので、距離程を一定間隔でサンプルして勾配の差を見ると 1 か所の
 * 変化点が何本もの標識に化けてしまう。実物と同じく **1 か所につき 1 本**である。
 */
export function buildGradePosts(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const white = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.75 });
  /** 腕木の長さ [m] */
  const armLength = 0.72;
  for (const change of route.alignment.gradeChanges) {
    if (change.s < 0 || change.s > route.length) continue;
    // 標識に書くのも腕木の傾きで示すのも、これから走る側の勾配である
    const grade = change.to;

    const f = frameAt(change.s);
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.5, 0.08), white);
    pole.position.y = 0.75;

    // 腕木は柱の頂部を支点にして、線路と反対側（-Z）へ出す。線路側へ出すと
    // 建築限界を侵すためで、実物も車両から逃げる側に腕を張り出している。
    // 上り勾配では線路側の端が上がるので、運転士からはやはり右上がりに見える。
    const arm = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, armLength), white);
    bar.position.z = -armLength / 2;
    // 勾配の値を書いた板は、腕木の先寄りに脚を立てて載せる
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.05), white);
    brace.position.set(0, 0.11, -armLength * 0.6);
    const permille = Math.abs(grade * 1000);
    const plate = textPlate(
      plateTexture([permille < 0.5 ? 'L' : permille.toFixed(0)], {
        background: '#eef1f4',
        color: '#15191d',
        aspect: 1.4,
      }),
      0.4,
      0.28,
    );
    plate.position.set(0, 0.33, -armLength * 0.6);
    arm.add(bar, brace, plate);
    arm.position.y = 1.5;
    arm.rotation.x = -gradeArmTilt(grade);

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
 * 曲線に関する標識を建てる場所。
 *
 * 勾配標・距離標より一段外へ寄せる。曲線標とカント標は路盤の肩のさらに外、
 * 緩和曲線の始終端標は肩の上で、互いに重ならない。
 */
const CURVE_SIGN = {
  /** 曲線標・カント標の横位置（軌道中心から左へ） */
  lateral: SHOULDER.lateral + 0.6,
  /** 緩和曲線の始終端標の横位置 */
  markerLateral: SHOULDER.lateral,
} as const;

/**
 * 標識の板。
 *
 * 板は進行方向に対して直角ではなく**線路と平行**に向ける（`rotation.y = ±π/2`）。
 * 実物の線路際の標識も、走ってくる列車から読めるように板面が線路を向いている。
 *
 * 文字は**進来する列車が読む面にだけ**入れ、裏は無地の板を背中合わせに張る。
 * 1 枚の板を両面表示（`DoubleSide`）にすると裏から見た面はテクスチャが鏡像になり、
 * `R600` が裏返しに読めてしまう。実物の標識の裏も、ただの白い板である。
 *
 * @param facing 文字面の向き（-1 = 線路の後方＝進来する列車の側、+1 = 前方）
 */
function textPlate(
  map: THREE.Texture,
  width: number,
  height: number,
  facing: -1 | 1 = -1,
  background = 0xeef1f4,
): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(width, height);
  const front = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 0.75 }));
  front.rotation.y = (facing * Math.PI) / 2;
  front.position.x = facing * 0.012;
  const back = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: background, roughness: 0.8 }),
  );
  back.rotation.y = (-facing * Math.PI) / 2;
  back.position.x = -facing * 0.012;
  group.add(front, back);
  return group;
}

/** 標識板を付けた標柱 */
function signBoard(
  lines: readonly string[],
  width: number,
  height: number,
  poleHeight: number,
  material: THREE.Material,
  background = '#eef1f4',
): THREE.Group {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.07, poleHeight, 0.07), material);
  pole.position.y = poleHeight / 2;
  const board = textPlate(
    plateTexture(lines, { background, color: '#15191d', aspect: width / height }),
    width,
    height,
  );
  board.position.y = poleHeight + height / 2 - 0.02;
  group.add(pole, board);
  return group;
}

/**
 * 曲線標・カント標・緩和曲線の始終端標。
 *
 * 実物の曲線には、曲線 1 か所につき次の標識が建つ。運転士から見ると、曲線へ入る
 * 手前で「これから何 R の曲線がどれだけ続くか」が分かり、曲線の中では自分が
 * 緩和曲線にいるのか円曲線にいるのかが分かる。
 *
 * | 標識 | 建つ場所 | 書いてあるもの |
 * |------|----------|----------------|
 * | 曲線標 | 曲線の始点 BTC | 曲線半径 R と曲線長 L |
 * | カント標 | 円曲線始点 BCC | カント量 C [mm] |
 * | 緩和曲線の始終端標 | BTC / BCC / ECC / ETC | その点の略号 |
 *
 * **緩和曲線もカントも無い曲線には建てない**。本線の曲線は必ず緩和曲線とカントを
 * 持つが、分岐器のリード曲線は曲率が一段で立ち上がりカントも無い。実物でも
 * 分岐器の中に曲線標は無いので、そこが線形上の区別にそのまま対応する。
 */
export function buildCurvePosts(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const white = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.75 });

  /** 路盤の肩へ据える（横位置は軌道中心から左へ） */
  const place = (group: THREE.Object3D, s: number, lateral: number): void => {
    const f = frameAt(s);
    group.quaternion.copy(frameQuaternion(f, false));
    group.position
      .copy(f.position)
      .addScaledVector(f.right, -lateral)
      .add(new THREE.Vector3(0, SHOULDER.level, 0));
    out.push(group);
  };

  for (const curve of route.alignment.curveSections) {
    if (!curve.hasTransition && curve.cant === 0) continue;
    if (!Number.isFinite(curve.radius)) continue;

    // 曲線標（曲線の始点）。半径と曲線長を 2 行に書く
    place(
      signBoard(
        [`R${curve.radius.toFixed(0)}`, `L${curve.length.toFixed(0)}`],
        0.52,
        0.42,
        1.2,
        white,
      ),
      curve.start,
      CURVE_SIGN.lateral,
    );

    // カント標（円曲線始点）。カントは mm で書くのが実物の書き方
    if (curve.cant > 0) {
      place(
        signBoard([`C${(curve.cant * 1000).toFixed(0)}`], 0.46, 0.3, 1.0, white),
        curve.circularStart,
        CURVE_SIGN.lateral,
      );
    }

    // 緩和曲線の始終端標。円曲線部を持たない曲線では BCC と ECC が重なるので 1 本にする
    const points: Array<[number, string]> = [
      [curve.start, 'BTC'],
      [curve.circularStart, 'BCC'],
      [curve.circularEnd, 'ECC'],
      [curve.end, 'ETC'],
    ];
    let previous = Number.NEGATIVE_INFINITY;
    for (const [s, label] of points) {
      if (s - previous < 1) continue;
      previous = s;
      place(signBoard([label], 0.34, 0.16, 0.55, white), s, CURVE_SIGN.markerLateral);
    }
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
 * 見えるほど狭い隙間」になる。
 *
 * 実物のホームで目に入るものを、縁端から順に並べる。
 *
 *  | 位置（縁端から） | もの |
 *  |------------------|------|
 *  | 0〜500mm         | 縁端ブロック（コンクリートの縁石。白線が入る） |
 *  | 800mm            | 内方線付き点状ブロック（幅 300mm） |
 *  | それより内側     | 平板敷きの床、上屋の柱、ベンチ |
 *
 * 床は 300mm 角の平板、壁と縁端はコンクリート、上屋は折板屋根、というように
 * 材質ごとにテクスチャを変えてある。ホームは運転席からいちばん近くを流れる
 * 構造物なので、質感の差がそのまま「駅らしさ」になる。
 */
export function buildStations(
  route: CompiledRoute,
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const station of route.stations) {
    out.push(...buildPlatform(station, frameAt));
  }
  return out;
}

function buildPlatform(
  station: CompiledRoute['stations'][number],
  frameAt: (s: number) => TrackFrame,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const length = station.platformEnd - station.platformStart;
  const mid = (station.platformEnd + station.platformStart) / 2;
  const f = frameAt(mid);
  const q = frameQuaternion(f, false);
  /** ホーム中心の軌道中心からの距離（左側）。縁端 1600mm から幅の半分だけ外へ */
  const centre = -(PLATFORM.edgeOffset + PLATFORM.width / 2);
  const edge = -PLATFORM.edgeOffset;
  const back = centre - PLATFORM.width / 2;

  /** ホーム中央を原点として、線路方向 `along`・軌道中心から `lateral`・高さ `height` へ置く */
  const place = <T extends THREE.Object3D>(
    mesh: T,
    lateral: number,
    height: number,
    along = 0,
  ): T => {
    // 呼ぶ前に付けておいた向き（板を寝かせる・裏返すなど）を軌道の向きに重ねる
    const local = mesh.quaternion.clone();
    mesh.quaternion.copy(q).multiply(local);
    mesh.position
      .copy(f.position)
      .addScaledVector(f.right, lateral)
      .addScaledVector(f.forward, along)
      .add(new THREE.Vector3(0, height, 0));
    return mesh;
  };

  const concrete = concreteSurface();
  const deckMaterial = new THREE.MeshStandardMaterial({
    color: 0xc2bdb3,
    ...platformDeckSurface().maps(1.2),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.9,
  });
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x9c968c,
    ...concrete.maps(2.0),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.95,
  });
  const copingMaterial = new THREE.MeshStandardMaterial({
    color: 0xb5b0a6,
    ...concrete.maps(1.0),
    roughness: 0.88,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0xa4aab0,
    metalness: 0.55,
    roughness: 0.5,
  });

  // --- 床。線路側の縁端ブロックのぶんだけ空けて、平板を敷く ---
  const deckEdge = edge - 0.5;
  const deck = new THREE.Mesh(meterPlane(length, deckEdge - back), deckMaterial);
  deck.rotation.x = -Math.PI / 2;
  out.push(place(deck, (deckEdge + back) / 2, PLATFORM.height, 0));

  // 縁端ブロック（線路側の縁。上面と、軌道へ向く立ち上がり）
  const coping = new THREE.Mesh(meterPlane(length, 0.5), copingMaterial);
  coping.rotation.x = -Math.PI / 2;
  out.push(place(coping, edge - 0.25, PLATFORM.height + 0.001, 0));

  // 側壁（線路側・背面・両端）。局所系の +Z が軌道の右なので、線路側の壁は
  // 板をそのまま、背面は裏返し、端は 90 度回して立てる
  const wall = new THREE.Mesh(meterPlane(length, PLATFORM.height), wallMaterial);
  out.push(place(wall, edge, PLATFORM.height / 2, 0));
  const backWall = new THREE.Mesh(meterPlane(length, PLATFORM.height), wallMaterial);
  backWall.rotation.y = Math.PI;
  out.push(place(backWall, back, PLATFORM.height / 2, 0));
  for (const sign of [-1, 1] as const) {
    const end = new THREE.Mesh(meterPlane(PLATFORM.width, PLATFORM.height), wallMaterial);
    end.rotation.y = (sign * Math.PI) / 2;
    out.push(place(end, centre, PLATFORM.height / 2, (sign * length) / 2));
  }

  // 白線（縁端から 120mm）と、内方線付き点状ブロック（縁端から 800mm）
  const line = new THREE.Mesh(
    meterPlane(length, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.7 }),
  );
  line.rotation.x = -Math.PI / 2;
  out.push(place(line, edge - 0.12, PLATFORM.height + 0.003, 0));

  const tactile = new THREE.Mesh(
    meterPlane(length, PLATFORM.tactileWidth),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      ...tactileSurface().maps(0.3),
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.75,
    }),
  );
  tactile.rotation.x = -Math.PI / 2;
  out.push(place(tactile, edge - PLATFORM.tactileOffset, PLATFORM.height + 0.004, 0));

  // --- 乗車位置目標。停止位置から編成を後ろへたどり、扉の来る場所に白い印を描く ---
  const mark = new THREE.MeshStandardMaterial({ color: 0xeceff2, roughness: 0.7 });
  for (let car = 0; car < 10; car++) {
    const carCentre = station.stopPosition - CAR.couplerLength * (car + 0.5);
    for (const k of [-1.5, -0.5, 0.5, 1.5]) {
      const s = carCentre + k * CAR.doorPitch;
      if (s < station.platformStart + 1 || s > station.platformEnd - 1) continue;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.12), mark);
      mesh.rotation.x = -Math.PI / 2;
      out.push(place(mesh, edge - 1.4, PLATFORM.height + 0.005, s - mid));
    }
  }

  // --- 上屋 ---
  const roofLength = Math.min(length - 2, length * 0.85);
  const roofY = PLATFORM.height + PLATFORM.roofHeight;
  const columnLateral = [back + 1.0, edge - 1.2];
  const bays = Math.max(2, Math.round(roofLength / PLATFORM.roofPitch));
  for (let i = 0; i <= bays; i++) {
    const x = -roofLength / 2 + (roofLength * i) / bays;
    for (const lateral of columnLateral) {
      const column = new THREE.Mesh(hBeamGeometry(PLATFORM.roofHeight, 0.2, 0.16), steel);
      out.push(place(column, lateral, PLATFORM.height + PLATFORM.roofHeight / 2, x));
    }
    // 梁（柱と柱をつなぐ横材）
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.26, columnLateral[1]! - columnLateral[0]!),
      steel,
    );
    out.push(place(beam, (columnLateral[0]! + columnLateral[1]!) / 2, roofY - 0.2, x));
  }
  // 桁（柱の上を線路方向に通す部材）
  for (const lateral of columnLateral) {
    const girder = new THREE.Mesh(new THREE.BoxGeometry(roofLength, 0.3, 0.14), steel);
    out.push(place(girder, lateral, roofY - 0.2, 0));
  }
  // 折板屋根（軌道側へわずかに下がる片流れ）
  const roofWidth = PLATFORM.width - 1.4;
  const roof = new THREE.Mesh(
    meterPlane(roofLength, roofWidth),
    new THREE.MeshStandardMaterial({
      color: 0x9298a0,
      ...roofPanelSurface().maps(2.4, 0.6),
      normalScale: new THREE.Vector2(1.4, 1.4),
      metalness: 0.45,
      roughness: 0.55,
      side: THREE.DoubleSide,
    }),
  );
  // 軌道側へわずかに傾ける（雨を線路側の樋へ落とすため）
  roof.rotation.x = -Math.PI / 2 + 0.035;
  out.push(place(roof, centre, roofY, 0));
  // 雨樋（軌道側の縁）
  const gutter = new THREE.Mesh(new THREE.BoxGeometry(roofLength, 0.14, 0.16), steel);
  out.push(place(gutter, centre + roofWidth / 2, roofY - 0.14, 0));

  // 上屋の照明（蛍光灯。ホームの中では夕方いちばん目立つ）
  const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xfff4d8 });
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    color: 0xffe9bc,
  });
  for (let i = 0; i < bays; i++) {
    const x = -roofLength / 2 + roofLength * ((i + 0.5) / bays);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.16), lampMaterial);
    out.push(place(lamp, centre + 0.4, roofY - 0.34, x));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), glowMaterial);
    glow.rotation.x = Math.PI / 2;
    out.push(place(glow, centre + 0.4, roofY - 0.42, x));
  }

  // --- 駅名標（上屋から吊る。ホームのどちら側からも読む標識なので、線路を向く面と
  //     その反対の面の両方に文字を入れる。1 枚を両面表示にすると裏の面が鏡像に
  //     なってしまうので、背中合わせに 2 枚張る） ---
  const signMaterial = new THREE.MeshStandardMaterial({
    map: stationSignTexture(station.name),
    roughness: 0.6,
  });
  const signGeometry = new THREE.PlaneGeometry(1.9, 0.48);
  for (const t of [0.25, 0.75]) {
    const x = -roofLength / 2 + roofLength * t;
    const sign = new THREE.Group();
    for (const side of [-1, 1] as const) {
      const face = new THREE.Mesh(signGeometry, signMaterial);
      face.rotation.y = side > 0 ? 0 : Math.PI;
      face.position.z = side * 0.01;
      sign.add(face);
    }
    out.push(place(sign, edge - 1.4, roofY - 0.85, x));
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), steel);
    out.push(place(hanger, edge - 1.4, roofY - 0.5, x));
  }

  // --- ベンチ（ホームの奥寄りに並ぶ） ---
  const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x7d8890, roughness: 0.6 });
  const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x9c7a52, roughness: 0.8 });
  for (let x = -roofLength / 2 + 6; x < roofLength / 2 - 4; x += 16) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.07, 0.45), woodMaterial);
    out.push(place(seat, back + 0.9, PLATFORM.height + 0.42, x));
    const rest = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 0.06), woodMaterial);
    out.push(place(rest, back + 0.7, PLATFORM.height + 0.64, x));
    for (const dx of [-0.7, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.4), benchMaterial);
      out.push(place(leg, back + 0.9, PLATFORM.height + 0.21, x + dx));
    }
  }

  // --- 待合室 ---
  //
  // 上屋の下、ホームの奥寄りに建つ小さな箱。三方がガラス、線路側に引き戸が
  // ある。地方の駅ではここが唯一の「屋内」で、朝夕には必ず人が入っている。
  {
    const roomLength = 5.0;
    const roomDepth = 2.4;
    const roomHeight = 2.5;
    const roomX = -roofLength * 0.28;
    const roomLateral = back + roomDepth / 2 + 0.2;
    const frame = new THREE.MeshStandardMaterial({
      color: 0xb9bec2,
      metalness: 0.5,
      roughness: 0.5,
    });
    const pane = new THREE.MeshStandardMaterial({
      // 中は外より暗い。ガラス越しに奥が見えることが「箱」と「部屋」を分ける
      color: 0x2c3439,
      metalness: 0.7,
      roughness: 0.08,
      side: THREE.DoubleSide,
    });
    // 壁（線路側・背面・両妻）。ガラス面のあいだに枠が通る
    for (const [w, d, lat, along] of [
      [roomLength, 0.06, roomLateral - roomDepth / 2, 0],
      [roomLength, 0.06, roomLateral + roomDepth / 2, 0],
    ] as const) {
      const wall = new THREE.Mesh(meterPlane(w, roomHeight), pane);
      out.push(place(wall, lat, PLATFORM.height + roomHeight / 2, roomX + along + d * 0));
    }
    for (const sign of [-1, 1] as const) {
      const end = new THREE.Mesh(meterPlane(roomDepth, roomHeight), pane);
      end.rotation.y = (sign * Math.PI) / 2;
      out.push(
        place(end, roomLateral, PLATFORM.height + roomHeight / 2, roomX + (sign * roomLength) / 2),
      );
    }
    // 枠（四隅の柱と、上下の桟）
    for (const sign of [-1, 1] as const) {
      for (const dl of [-roomDepth / 2, roomDepth / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, roomHeight, 0.08), frame);
        out.push(
          place(
            post,
            roomLateral + dl,
            PLATFORM.height + roomHeight / 2,
            roomX + (sign * roomLength) / 2,
          ),
        );
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(roomLength, 0.1, 0.08), frame);
      out.push(
        place(
          rail,
          roomLateral + sign * (roomDepth / 2),
          PLATFORM.height + roomHeight - 0.05,
          roomX,
        ),
      );
    }
    // 屋根（上屋の下にもう 1 枚。雨の吹き込みを防ぐため軒が出る）
    const roomRoof = new THREE.Mesh(meterPlane(roomLength + 0.5, roomDepth + 0.5), steel);
    roomRoof.rotation.x = -Math.PI / 2;
    out.push(place(roomRoof, roomLateral, PLATFORM.height + roomHeight + 0.06, roomX));
  }

  // --- 自動販売機 ---
  //
  // ホームの背面壁ぎわに 2 台並べる。前面が自ら光っているので、日陰の
  // ホームでもここだけ明るく見える — 夕方の駅の絵はこれで決まる。
  {
    const vendMaterial = new THREE.MeshStandardMaterial({ color: 0xb8352c, roughness: 0.5 });
    const faceMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8e2d2,
      roughness: 0.3,
      // 中の蛍光灯。庫内が光っているので、面そのものが光源に見える
      emissive: 0xffe8b0,
      emissiveIntensity: 0.55,
    });
    for (let k = 0; k < 2; k++) {
      const x = roofLength * 0.18 + k * 1.15;
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.9, 0.75), vendMaterial);
      out.push(place(box, back + 0.45, PLATFORM.height + 0.95, x));
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 1.35), faceMaterial);
      out.push(place(panel, back + 0.83, PLATFORM.height + 1.15, x));
    }
  }

  // --- 停止位置目標（何両編成の停止位置かを書いた板） ---
  const fs = frameAt(station.stopPosition);
  const marker = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.8, 0.06), steel);
  pole.position.y = 0.9;
  const face = textPlate(
    plateTexture(['停'], { background: '#f2f4f6', color: '#c02020', border: '#c02020' }),
    0.44,
    0.44,
    -1,
    0xf2f4f6,
  );
  face.position.y = 1.85;
  marker.add(pole, face);
  marker.quaternion.copy(frameQuaternion(fs, false));
  marker.position
    .copy(fs.position)
    .addScaledVector(fs.right, -(PLATFORM.edgeOffset + 0.5))
    .add(new THREE.Vector3(0, PLATFORM.height, 0));
  out.push(marker);

  return out;
}

/**
 * H 形鋼の柱。
 *
 * ホーム上屋の柱は角パイプではなく H 形鋼で、正面から見ると I の字、
 * 斜めから見るとフランジの厚みが見える。四角い柱と比べて、光の当たり方が
 * 面ごとに変わるぶん鉄骨らしく見える。
 */
function hBeamGeometry(height: number, depth: number, width: number): THREE.BufferGeometry {
  const t = 0.016;
  const shape = new THREE.Shape();
  const hw = width / 2;
  const hd = depth / 2;
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, -hd + t);
  shape.lineTo(t / 2, -hd + t);
  shape.lineTo(t / 2, hd - t);
  shape.lineTo(hw, hd - t);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.lineTo(-hw, hd - t);
  shape.lineTo(-t / 2, hd - t);
  shape.lineTo(-t / 2, -hd + t);
  shape.lineTo(-hw, -hd + t);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geometry.translate(0, 0, -height / 2);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}
