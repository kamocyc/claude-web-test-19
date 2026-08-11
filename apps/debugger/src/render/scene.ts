import * as THREE from 'three';
import type { CompiledRoute, Simulation } from '@railsim/core';
import { makeFrameAt, type TrackFrame } from './frame.ts';
import { buildScenery, buildTunnels } from './scenery.ts';
import { createDaylight, createSky } from './sky.ts';

const RAIL_COLOR = 0xb0b6bd;
const SLEEPER_COLOR = 0x6b5f50;
const BALLAST_COLOR = 0x8a8478;
const GROUND_COLOR = 0x5e7a4a;

const ASPECT_COLOR: Record<string, number> = {
  R: 0xff2d20,
  YY: 0xffa000,
  Y: 0xffd23f,
  YG: 0x9be15d,
  G: 0x18d94a,
};

/** 運転席の位置（先頭車の前端からの距離・中心からの左右・レール面からの高さ） */
const CAB_OFFSET = { back: 1.35, left: 0.72, height: 2.05 };

/**
 * 軌道・列車・信号・駅・沿線の景観を描画するシーン。
 *
 * 車両は軌道の座標系に置いたうえで、車体動揺（ロール・ピッチ・ヨー・左右・上下）を
 * 局所回転として重ねる。運転席視点のカメラも同じ変換から作るため、
 * 曲線でのロールや軌道狂いによる揺れがそのまま視界に出る。
 */
export class TrackScene {
  readonly scene = new THREE.Scene();
  private readonly vehicleMeshes: THREE.Object3D[] = [];
  private readonly signalLights = new Map<string, THREE.Mesh>();
  private readonly route: CompiledRoute;
  private readonly frameAt: (s: number) => TrackFrame;
  /** 運転席視点の位置と姿勢（update() で更新される） */
  readonly cabPosition = new THREE.Vector3();
  readonly cabQuaternion = new THREE.Quaternion();

  constructor(route: CompiledRoute, sim: Simulation) {
    this.route = route;
    this.frameAt = makeFrameAt(route);
    this.scene.background = new THREE.Color(0xa9c8e4);
    this.scene.fog = new THREE.Fog(0xbcd4ea, 900, 4200);

    this.scene.add(createSky());
    for (const light of createDaylight()) this.scene.add(light);

    this.buildGround();
    this.buildTrack();
    this.buildDistancePosts();
    this.buildStations();
    this.buildSignals();
    this.buildBeacons();
    for (const o of buildTunnels(route, this.frameAt)) this.scene.add(o);
    for (const o of buildScenery(route, this.frameAt)) this.scene.add(o);
    this.buildTrain(sim);
    this.update(sim);
  }

  /**
   * 線路の両側の地表。
   * 平坦な板を置くと勾配区間で線路が地面に潜るため、軌道中心線に沿って高さを追従させる。
   */
  private buildGround(): void {
    const step = 20;
    const n = Math.floor(this.route.length / step);
    const halfWidth = 260;
    const positions: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = this.frameAt(s);
      const l = f.position.clone().addScaledVector(f.right, -halfWidth);
      const r = f.position.clone().addScaledVector(f.right, halfWidth);
      positions.push(l.x, l.y - 1.2, l.z, r.x, r.y - 1.2, r.z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    this.scene.add(
      new THREE.Mesh(
        geom,
        new THREE.MeshLambertMaterial({ color: GROUND_COLOR, side: THREE.DoubleSide }),
      ),
    );
  }

  /** 100m ごとの距離標 */
  private buildDistancePosts(): void {
    const step = 100;
    const count = Math.floor(this.route.length / step);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.18, 1.6, 0.7),
      new THREE.MeshLambertMaterial({ color: 0xf0f2f4 }),
      count,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const f = this.frameAt(i * step);
      const p = f.position
        .clone()
        .addScaledVector(f.right, -4.5)
        .add(new THREE.Vector3(0, 0.8, 0));
      m.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /** レール 2 本・道床・まくらぎ */
  private buildTrack(): void {
    const step = 4;
    const n = Math.floor(this.route.length / step);
    const half = this.route.alignment.gauge / 2;

    const leftPoints: THREE.Vector3[] = [];
    const rightPoints: THREE.Vector3[] = [];
    const ballastPositions: number[] = [];

    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = this.frameAt(s);
      // レールも道床もカントで傾いた軌道面（f.cantRight / f.up）の上に載せる。
      // 高さを個別に足し込むのではなく共通の基準座標系から作ることで、
      // 車体・まくらぎとレールが逆向きに傾くような食い違いが起きない。
      leftPoints.push(f.position.clone().addScaledVector(f.cantRight, -half));
      rightPoints.push(f.position.clone().addScaledVector(f.cantRight, half));
      const bl = f.position.clone().addScaledVector(f.cantRight, -3.6).addScaledVector(f.up, -0.4);
      const br = f.position.clone().addScaledVector(f.cantRight, 3.6).addScaledVector(f.up, -0.4);
      ballastPositions.push(bl.x, bl.y, bl.z, br.x, br.y, br.z);
    }

    const railMaterial = new THREE.LineBasicMaterial({ color: RAIL_COLOR });
    this.scene.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPoints), railMaterial),
    );
    this.scene.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPoints), railMaterial),
    );

    const ballastGeom = new THREE.BufferGeometry();
    ballastGeom.setAttribute('position', new THREE.Float32BufferAttribute(ballastPositions, 3));
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    ballastGeom.setIndex(indices);
    ballastGeom.computeVertexNormals();
    this.scene.add(
      new THREE.Mesh(
        ballastGeom,
        new THREE.MeshLambertMaterial({ color: BALLAST_COLOR, side: THREE.DoubleSide }),
      ),
    );

    const sleeperStep = 6;
    const count = Math.floor(this.route.length / sleeperStep);
    const sleeper = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.24, 0.16, 2.4),
      new THREE.MeshLambertMaterial({ color: SLEEPER_COLOR }),
      count,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const f = this.frameAt(i * sleeperStep);
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.forward, f.up, f.cantRight));
      m.compose(f.position.clone().addScaledVector(f.up, -0.1), q, new THREE.Vector3(1, 1, 1));
      sleeper.setMatrixAt(i, m);
    }
    sleeper.instanceMatrix.needsUpdate = true;
    this.scene.add(sleeper);
  }

  private buildStations(): void {
    for (const station of this.route.stations) {
      const length = station.platformEnd - station.platformStart;
      const mid = (station.platformEnd + station.platformStart) / 2;
      const f = this.frameAt(mid);
      const basis = new THREE.Matrix4().makeBasis(f.forward, new THREE.Vector3(0, 1, 0), f.right);

      const platform = new THREE.Mesh(
        new THREE.BoxGeometry(length, 1.1, 6),
        new THREE.MeshLambertMaterial({ color: 0xb9b3a8 }),
      );
      platform.quaternion.setFromRotationMatrix(basis);
      platform.position
        .copy(f.position)
        .addScaledVector(f.right, 5.2)
        .add(new THREE.Vector3(0, 0.55, 0));
      this.scene.add(platform);

      // 上屋
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(length * 0.8, 0.18, 5.4),
        new THREE.MeshLambertMaterial({ color: 0x8d939a }),
      );
      roof.quaternion.setFromRotationMatrix(basis);
      roof.position
        .copy(f.position)
        .addScaledVector(f.right, 5.4)
        .add(new THREE.Vector3(0, 4.4, 0));
      this.scene.add(roof);

      // 停止位置目標
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 2.4, 0.7),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      const fs = this.frameAt(station.stopPosition);
      marker.position
        .copy(fs.position)
        .addScaledVector(fs.right, 3.2)
        .add(new THREE.Vector3(0, 1.3, 0));
      this.scene.add(marker);
    }
  }

  private buildSignals(): void {
    for (const signal of this.route.signals) {
      const f = this.frameAt(signal.position);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 5),
        new THREE.MeshLambertMaterial({ color: 0x59606a }),
      );
      pole.position
        .copy(f.position)
        .addScaledVector(f.right, 3.4)
        .add(new THREE.Vector3(0, 2.5, 0));
      this.scene.add(pole);

      const hood = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 1.3, 1.0),
        new THREE.MeshLambertMaterial({ color: 0x2a2f36 }),
      );
      hood.position.copy(pole.position).add(new THREE.Vector3(0, 2.4, 0));
      this.scene.add(hood);

      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 16, 12),
        new THREE.MeshBasicMaterial({ color: ASPECT_COLOR.R }),
      );
      light.position.copy(hood.position).addScaledVector(f.forward, -0.25);
      this.scene.add(light);
      this.signalLights.set(signal.id, light);
    }
  }

  private buildBeacons(): void {
    const entries = this.route.beacons.all;
    if (entries.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 0.18, 1.0),
      new THREE.MeshBasicMaterial({ color: 0xe0a52c }),
      entries.length,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < entries.length; i++) {
      const f = this.frameAt(entries[i]!.s);
      m.makeTranslation(f.position.x, f.position.y + 0.05, f.position.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  private buildTrain(sim: Simulation): void {
    for (const veh of sim.dynamics.vehicles) {
      const driven = veh.spec.drivenAxleCount > 0;
      const group = new THREE.Group();
      const bodyLength = veh.spec.length - 0.7;

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(bodyLength, 3.3, 2.9),
        new THREE.MeshLambertMaterial({ color: driven ? 0xdedfe2 : 0xd6d8dc }),
      );
      body.position.y = 2.0;
      group.add(body);

      // 帯（動力車と付随車で色を変えて見分けられるようにする）
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(bodyLength + 0.02, 0.42, 2.94),
        new THREE.MeshLambertMaterial({ color: driven ? 0x2f6fb5 : 0x6b7280 }),
      );
      stripe.position.y = 2.55;
      group.add(stripe);

      // 側窓
      const windows = new THREE.Mesh(
        new THREE.BoxGeometry(bodyLength * 0.86, 0.9, 2.95),
        new THREE.MeshLambertMaterial({ color: 0x1e2b38 }),
      );
      windows.position.y = 3.0;
      group.add(windows);

      // 屋根
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(bodyLength * 0.98, 0.22, 2.6),
        new THREE.MeshLambertMaterial({ color: 0x9aa1a8 }),
      );
      roof.position.y = 3.75;
      group.add(roof);

      // 台車
      for (const sign of [-1, 1]) {
        const bogie = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 0.8, 2.4),
          new THREE.MeshLambertMaterial({ color: 0x3a3f45 }),
        );
        bogie.position.set((sign * veh.spec.bogieSpacing) / 2, 0.75, 0);
        group.add(bogie);
      }

      this.scene.add(group);
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
      const light = this.signalLights.get(s.id);
      if (light) {
        (light.material as THREE.MeshBasicMaterial).color.setHex(
          ASPECT_COLOR[s.aspect] ?? 0xffffff,
        );
      }
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
