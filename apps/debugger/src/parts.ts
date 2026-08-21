/**
 * 部品の姿見（開発用）。
 *
 * 標識のような線路際の部品は、線形データだけで組めてシミュレーションを必要と
 * しない。それなのに見た目を確かめるためだけに列車を走らせて現地まで待つのは
 * 割に合わない（2km 先の標識まで数分かかる）。ここでは実際の路線から部品を組み、
 * 部品が建っている距離程に運転士の目の高さでカメラを置いて並べる。開けば全部見える。
 *
 * `npm run dev` して `/parts.html` を開く。`?p=grade` のように種類で絞れる。
 * 製品ビルドには含めない（`vite.config.ts` の入口は `index.html` だけ）。
 */
import * as THREE from 'three';
import { createDefaultLibrary } from '@railsim/data';
import { makeFrameAt } from './render/frame.ts';
import {
  buildBeacons,
  buildCurvePosts,
  buildDistancePosts,
  buildGradePosts,
  buildSignals,
  buildStations,
} from './render/wayside.ts';
import { createCabInterior } from './render/cab.ts';
import { buildCar } from './render/vehicle.ts';
import { buildLevelCrossings } from './render/structures.ts';
import { frameQuaternion } from './render/geometry.ts';

/** 1 種類あたりに並べる数（多ければ間引く） */
const PER_KIND = 6;
const WIDTH = 380;
const HEIGHT = 300;
/** 運転士の目の高さ [m]（軌道面から） */
const EYE_HEIGHT = 1.9;
/** 線路際の部品が建つ、軌道中心からの距離のめやす [m] */
const LATERAL = 2.3;

const library = createDefaultLibrary();
const route = library.scenario('test-line-local').route;
const frameAt = makeFrameAt(route);

interface Kind {
  readonly key: string;
  readonly label: string;
  /** 部品を組む。1 回だけ呼び、`spots` の数だけ場所を変えて撮る */
  readonly build: () => THREE.Object3D[];
  /**
   * 立って見る距離程 [m]。
   *
   * 部品そのものではなく**場所**を指しているのは、地上子や 100m 距離標のように
   * 路線全体を 1 つのメッシュへまとめて持つ部品があるためで、「部品ごとに 1 枚」
   * では絵にならない。実物と同じく、その距離程に立って見る。
   */
  readonly spots: () => number[];
  /** 手前にどれだけ引くか [m] */
  readonly back?: number;
  /**
   * 線路のどちら側に建つか（-1 = 左、1 = 右、0 = 軌道中心）。
   * カメラは軌道中心（運転席の位置）に置いたまま、この側へ首を振る。
   */
  readonly side?: -1 | 0 | 1;
  /** 運転台は運転士の目の位置に組まれているので、線路ではなくそこから見る */
  readonly eye?: boolean;
  /**
   * 軌道中心から横へどれだけ離れて立つか [m]。
   *
   * 標識は運転席から見るのが正しいが、**車体の標記は運転席からは絶対に
   * 見えない**（自分が乗っている車の側面だから）。ホームや線路脇から見た
   * 位置に立たないと確かめられない。
   */
  readonly standOff?: number;
  /** 立つ高さ [m]（既定は運転士の目） */
  readonly height?: number;
  /** 見る点の高さ [m]（既定 1.0m。車体は腰の高さを見る） */
  readonly lookHeight?: number;
}

/**
 * 車体標記を確かめるための編成。
 *
 * 号車札・車号・所属標記・弱冷房車・優先席は編成の中の位置で変わるので、
 * 4 両編成を組んで **1 号車（先頭・クハ）と 4 号車（弱冷房車）が並ぶ**ように
 * 置く。実物と同じ 20m 間隔。
 */
function markingTrain(): THREE.Object3D[] {
  const spec = library.scenario('test-line-local').consist.vehicles[0];
  if (!spec) return [];
  const out: THREE.Object3D[] = [];
  const cars = 4;
  for (let i = 0; i < cars; i++) {
    const s = MARKING_START + i * spec.length;
    const f = frameAt(s);
    const { group } = buildCar(spec, i === 0 || i === cars - 1, i === 0, {
      index: i + 1,
      cars,
    });
    group.quaternion.copy(frameQuaternion(f, true));
    group.position.copy(f.position);
    out.push(group);
  }
  return out;
}

/** 標記を見る編成の先頭車の中心 [m]。直線の平坦な区間へ置く */
const MARKING_START = 2000;

const KINDS: ReadonlyArray<Kind> = [
  {
    key: 'grade',
    label: '勾配標',
    build: () => buildGradePosts(route, frameAt),
    spots: () => route.alignment.gradeChanges.map((c) => c.s),
    side: -1,
    back: 7,
  },
  {
    key: 'curve',
    label: '曲線標・カント標・緩和曲線標',
    build: () => buildCurvePosts(route, frameAt),
    spots: () => route.alignment.curveSections.flatMap((c) => [c.start, c.circularStart]),
    side: -1,
    back: 8,
  },
  {
    key: 'distance',
    label: '距離標',
    build: () => buildDistancePosts(route, frameAt),
    // 1km 標（大きい板）の建つ場所。100m 標も一緒に視野へ入る
    spots: () => [1000, 2000, 3000, 4000, 5000, 6000],
    side: 1,
    back: 8,
  },
  {
    key: 'signal',
    label: '信号機',
    build: () => buildSignals(route, frameAt).objects,
    spots: () => route.signals.map((s) => s.position),
    side: -1,
    back: 16,
  },
  {
    key: 'beacon',
    label: '地上子',
    build: () => buildBeacons(route, frameAt),
    spots: () => route.beacons.all.map((b) => b.s),
    back: 6,
  },
  {
    key: 'station',
    label: '駅（ホーム・駅名標・停止位置目標）',
    build: () => buildStations(route, frameAt),
    spots: () => route.stations.map((s) => s.stopPosition),
    side: 1,
    back: 22,
  },
  {
    key: 'crossing',
    label: '踏切（遮断桿は 1 か所おきに「下りきり」と「降下中」）',
    /**
     * 遮断桿の姿勢は装置（`LevelCrossingSystem`）が決めるので、姿見では
     * 外から与える。**下りきった桿だけを見ても、降りている途中の斜めの桿が
     * 正しいかは分からない**ので、1 か所おきに 1.0（下りきり）と 0.45
     * （降下中）を入れて両方を並べる。警報灯は点灯した側だけが光る。
     */
    build: () => {
      const built = buildLevelCrossings(route, frameAt);
      route.levelCrossings.crossings.forEach((crossing, i) => {
        built.handles.get(crossing.id)?.update(i % 2 === 0 ? 1 : 0.45, true, 0.3);
      });
      return built.objects;
    },
    spots: () => route.levelCrossings.crossings.map((c) => c.position),
    back: 26,
    side: 0,
    standOff: -9,
    height: 3.2,
    lookHeight: 1.6,
  },
  {
    key: 'stationhouse',
    label: '駅ごとの違い（駅舎・改札・番線標・車止め）',
    build: () => buildStations(route, frameAt),
    spots: () => route.stations.map((s) => s.stopPosition),
    // 駅舎はホームの背面（線路の左）に建つ。運転席の高さからはホームに隠れて
    // 見えないので、**ホーム全体が視野に入るところまで下がって**高いところから
    // 眺める。近づくと駅舎が視野の外（真横）へ出てしまう。
    back: 150,
    side: -1,
    standOff: -32,
    height: 24,
    lookHeight: 4,
  },
  {
    key: 'car',
    label: '車体の標記（号車札・車号・所属・弱冷房車・優先席）',
    build: markingTrain,
    // 1 号車の車端（車号と所属）、1 号車の中ほど（号車札）、4 号車（弱冷房車）
    spots: () => [MARKING_START - 6, MARKING_START + 4, MARKING_START + 62],
    back: 4,
    standOff: 7,
    height: 2.0,
    lookHeight: 2.0,
  },
  {
    key: 'cab',
    label: '運転台（静止状態）',
    build: () => [createCabInterior().group],
    spots: () => [0],
    eye: true,
  },
];

/** WebGL の文脈は 1 つだけ使い、絵は 2D のキャンバスへ写す（何十個並べても足りる） */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x76889c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x55606c, 2.2));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(-4, 8, 3);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.05, 400);

/** その距離程へ進来する列車の運転席から見る */
function aim(s: number, kind: Kind): void {
  if (kind.eye) {
    camera.position.set(0, 0, 0);
    camera.lookAt(0, -0.15, -3);
    return;
  }
  const back = kind.back ?? 9;
  const here = frameAt(s);
  const from = frameAt(Math.max(0, s - back));
  camera.position
    .copy(from.position)
    .addScaledVector(from.right, kind.standOff ?? 0)
    .add(new THREE.Vector3(0, kind.height ?? EYE_HEIGHT, 0));
  // 標識は線路際に建つので、軌道中心を見ていると隅へ寄ってしまう。建つ側を見る
  const target = here.position
    .clone()
    .addScaledVector(here.right, (kind.side ?? 0) * LATERAL)
    .add(new THREE.Vector3(0, kind.lookHeight ?? 1, 0));
  camera.lookAt(target);
}

/** 値の違いが見える程度に間引く */
function sample(items: readonly number[], count: number): number[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]!);
}

function cell(label: string): HTMLElement {
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas');
  const ratio = renderer.getPixelRatio();
  canvas.width = WIDTH * ratio;
  canvas.height = HEIGHT * ratio;
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  figure.append(canvas, caption);
  renderer.render(scene, camera);
  canvas.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
  return figure;
}

const wanted = new URLSearchParams(window.location.search).get('p');
for (const kind of KINDS) {
  if (wanted !== null && wanted !== kind.key) continue;
  const objects = kind.build();
  const spots = kind.spots();
  const shown = sample(spots, PER_KIND);

  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent =
    spots.length > shown.length
      ? `${kind.label}（${spots.length} か所のうち ${shown.length} か所）`
      : `${kind.label}（${spots.length} か所）`;
  section.appendChild(heading);
  const row = document.createElement('div');
  row.className = 'row';

  scene.add(...objects);
  for (const s of shown) {
    aim(s, kind);
    row.appendChild(cell(kind.eye ? kind.label : `${s.toFixed(0)}m`));
  }
  scene.remove(...objects);

  section.appendChild(row);
  document.body.appendChild(section);
}
