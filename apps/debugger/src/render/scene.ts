import * as THREE from 'three';
import type { CompiledRoute, Simulation } from '@railsim/core';
import { buildCatenary } from './catenary.ts';
import { makeFrameAt, type TrackFrame } from './frame.ts';
import { buildScenery, buildTunnels } from './scenery.ts';
import { createDaylight, createSky, SUN_DIRECTION } from './sky.ts';
import { buildTrack, buildTurnouts } from './track.ts';
import { buildCar } from './vehicle.ts';
import {
  buildBeacons,
  buildDistancePosts,
  buildGradePosts,
  buildSignals,
  buildStations,
  type SignalHandle,
} from './wayside.ts';
import { CAR } from './dimensions.ts';
import { createEnvironment, grassSurface } from './textures.ts';

const GROUND_COLOR = 0x87a06a;

/**
 * 運転席の位置（先頭車の前端からの距離・中心からの左右・レール面からの高さ）。
 *
 * 実物の 20m 級通勤形の運転室にならい、前端から 1550mm 後ろ・車体中心から
 * 左へ 700mm、床面（レール面上 1130mm）から 1200mm の高さに目を置く。
 * 運転台の内装（`cab.ts`）もこの目の位置を原点として組んである。
 */
const CAB_OFFSET = {
  back: 1.55,
  left: CAR.driverOffset,
  height: CAR.floorHeight + CAR.eyeHeight,
};

/**
 * 軌道・列車・信号・駅・沿線の景観を描画するシーン。
 *
 * 構造物はどれも実物の寸法（`dimensions.ts`）から組み立てる。レールは 50kgN の
 * 断面を掃引した立体、まくらぎは PC まくらぎを 25m あたり 44 本、架線は
 * シンプルカテナリを偏位とたるみ込みで、というように、形が「それらしさ」ではなく
 * 実際の寸法で決まるようにしてある。
 *
 * 車両は軌道の座標系に置いたうえで、車体動揺（ロール・ピッチ・ヨー・左右・上下）を
 * 局所回転として重ねる。運転席視点のカメラも同じ変換から作るため、
 * 曲線でのロールや軌道狂いによる揺れがそのまま視界に出る。
 */
export class TrackScene {
  readonly scene = new THREE.Scene();
  private readonly vehicleMeshes: THREE.Object3D[] = [];
  private readonly signalHandles: Map<string, SignalHandle>;
  private readonly route: CompiledRoute;
  private readonly frameAt: (s: number) => TrackFrame;
  private readonly sun: THREE.DirectionalLight;
  /** 運転席視点の位置と姿勢（update() で更新される） */
  readonly cabPosition = new THREE.Vector3();
  readonly cabQuaternion = new THREE.Quaternion();

  /**
   * @param renderer 環境マップを焼くのに使う。渡すと金属が空を映すようになる
   */
  constructor(route: CompiledRoute, sim: Simulation, renderer?: THREE.WebGLRenderer) {
    this.route = route;
    this.frameAt = makeFrameAt(route);
    this.scene.background = new THREE.Color(0xa9c8e4);
    this.scene.fog = new THREE.Fog(0xbcd4ea, 900, 4200);

    this.scene.add(createSky());
    const { sun, ambient } = createDaylight();
    this.sun = sun;
    this.scene.add(sun, sun.target, ambient);
    // 金属の映り込みの元。レールの頭頂面・ステンレスの車体・架線金具は、
    // これが無いと「映すものが無い金属」になって黒く沈む。
    if (renderer) {
      this.scene.environment = createEnvironment(renderer);
      // 映り込みの元としては十分で、かつ影の中を照らしすぎない強さ
      this.scene.environmentIntensity = 0.75;
    }

    const inTunnel = (s: number): boolean => route.tunnels.at(s).length > 0;

    // 影を落とす側は絞る。トンネルの覆工（中は日が差さない）、地上子、分岐器の
    // 細かい金物まで影の地図に描いても、手間のわりに絵は変わらない。
    this.buildGround();
    this.add(buildTrack(route, this.frameAt), true);
    this.add(buildTurnouts(route, this.frameAt), false);
    this.add(buildDistancePosts(route, this.frameAt), true);
    this.add(buildGradePosts(route, this.frameAt), true);
    this.add(buildStations(route, this.frameAt), true);
    this.add(buildBeacons(route, this.frameAt), false);
    this.add(buildTunnels(route, this.frameAt), false);
    this.add(buildCatenary(route, this.frameAt, inTunnel), true);
    this.add(buildScenery(route, this.frameAt), true);

    const signals = buildSignals(route, this.frameAt);
    this.add(signals.objects, true);
    this.signalHandles = signals.handles;

    this.buildTrain(sim);
    this.update(sim);
  }

  /**
   * 構造物をシーンに入れ、影の扱いを決める。
   *
   * 影を受けるのはすべての面。落とすのは `cast` を立てたものだけ。
   * 自ら光っている面（信号の灯火・トンネル照明・光のにじみ）は、影を
   * 落とすと光源が黒い板に見えてしまうので外す。
   */
  private add(objects: readonly THREE.Object3D[], cast: boolean): void {
    for (const object of objects) {
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.InstancedMesh)) return;
        const material = node.material as THREE.Material;
        if (material instanceof THREE.MeshBasicMaterial) return;
        node.receiveShadow = true;
        node.castShadow = cast;
      });
      this.scene.add(object);
    }
  }

  /**
   * 線路の両側の地表。
   * 平坦な板を置くと勾配区間で線路が地面に潜るため、軌道中心線に沿って高さを追従させる。
   * 盛土のり尻がちょうどこの面に接するよう、道床の断面と同じ -1.2m に置く。
   */
  private buildGround(): void {
    const step = 20;
    const n = Math.floor(this.route.length / step);
    const halfWidth = 260;
    const positions: number[] = [];
    const uvs: number[] = [];
    let u = 0;
    let previous: THREE.Vector3 | null = null;
    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = this.frameAt(s);
      if (previous) u += f.position.distanceTo(previous);
      previous = f.position.clone();
      const l = f.position.clone().addScaledVector(f.right, -halfWidth);
      const r = f.position.clone().addScaledVector(f.right, halfWidth);
      positions.push(l.x, l.y - 1.2, l.z, r.x, r.y - 1.2, r.z);
      // UV は m 単位。草の模様が線路の近くでも遠くでも同じ大きさになる
      uvs.push(u, -halfWidth, u, halfWidth);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const ground = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: GROUND_COLOR,
        ...grassSurface().maps(18),
        // 地面は 1 枚を何十回も繰り返すので、凹凸を強くすると繰り返しが目に付く
        normalScale: new THREE.Vector2(0.25, 0.25),
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    );
    // 地表は影を受けるだけ。線路の周り数百 m を覆う 1 枚の板なので、
    // これ自身に影を落とさせると自分の裏側を陰にして縞が出る。
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  /**
   * 編成を組む。
   *
   * 両端の車が先頭車（運転室と前面を持つ）、中間は貫通の中間車。
   * 動力車かどうかは塗り分けではなく、屋根のパンタグラフと床下の主回路箱で示す。
   */
  private buildTrain(sim: Simulation): void {
    const cars = sim.dynamics.vehicles;
    for (let i = 0; i < cars.length; i++) {
      const veh = cars[i]!;
      const lead = i === 0 || i === cars.length - 1;
      const { group } = buildCar(veh.spec, lead, i === 0);
      this.add([group], true);
      this.vehicleMeshes.push(group);
    }
  }

  /**
   * 車両の姿勢を更新する。
   *
   * 軌道の基準座標系（進行方向・カント込みの上方向・右方向）を作り、
   * そこへ車体動揺のロール・ピッチ・ヨーを局所回転として重ねる。
   * 左右・上下の変位も車体座標系で加える。
   */
  update(sim: Simulation): void {
    const scratch = new THREE.Quaternion();
    for (let i = 0; i < this.vehicleMeshes.length; i++) {
      const veh = sim.dynamics.vehicles[i]!;
      const mesh = this.vehicleMeshes[i]!;
      const f = this.frameAt(veh.s);
      const body = veh.body;

      const up = f.up;
      const right = f.cantRight;
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.forward, up, right));
      // 局所軸: X = 前、Y = 上、Z = 右
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), body.roll));
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -body.pitch));
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(0, 1, 0), body.yaw));

      mesh.position
        .copy(f.position)
        .addScaledVector(right, body.lateral)
        .addScaledVector(up, body.vertical);

      if (i === 0) {
        // 運転席は先頭車の前端寄り・左側
        this.cabQuaternion.copy(mesh.quaternion);
        const cabForward = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
        const cabRight = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
        const cabUp = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
        this.cabPosition
          .copy(mesh.position)
          .addScaledVector(cabForward, veh.spec.length / 2 - CAB_OFFSET.back)
          .addScaledVector(cabRight, -CAB_OFFSET.left)
          .addScaledVector(cabUp, CAB_OFFSET.height);
      }
    }

    for (const s of sim.signalling.snapshot()) {
      this.signalHandles.get(s.id)?.setAspect(s.aspect);
    }

    // 影を焼く範囲を列車に追従させる。路線全体を 1 枚の影の地図に収めることは
    // できないので、列車の周り 100m ほどだけを高い解像度で焼く。
    const lead = this.vehicleMeshes[0];
    if (lead) {
      this.sun.target.position.copy(lead.position);
      this.sun.position.copy(lead.position).addScaledVector(SUN_DIRECTION, 300);
    }
  }

  /** 運転席視点のとき、先頭車の車体を隠して視界を遮らないようにする */
  setLeadCarVisible(visible: boolean): void {
    const lead = this.vehicleMeshes[0];
    if (lead) lead.visible = visible;
  }

  /** 先頭車の位置と向き（外部視点カメラの追従用） */
  frontFrame(sim: Simulation): TrackFrame {
    return this.frameAt(sim.dynamics.vehicles[0]!.s);
  }
}
