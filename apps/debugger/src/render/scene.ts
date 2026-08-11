import * as THREE from 'three';
import type { CompiledRoute, Simulation } from '@railsim/core';

const RAIL_COLOR = 0x9aa7b4;
const SLEEPER_COLOR = 0x4a4036;
const BALLAST_COLOR = 0x2c3138;

const ASPECT_COLOR: Record<string, number> = {
  R: 0xff3b30,
  YY: 0xffb400,
  Y: 0xffd23f,
  YG: 0x9be15d,
  G: 0x2fd45f,
};

/** 距離程 s における軌道の基準座標系（位置・進行方向・右方向・カント角） */
function frameAt(route: CompiledRoute, s: number) {
  const a = route.alignment;
  const p = a.positionAt(s);
  const heading = a.headingAt(s);
  const grade = a.gradeAt(s);
  const forward = new THREE.Vector3(Math.cos(heading), grade, -Math.sin(heading)).normalize();
  // 右手系 y-up で、進行方向に対する右side は (sinθ, 0, cosθ)
  const right = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  return {
    position: new THREE.Vector3(p.x, p.y, p.z),
    forward,
    right,
    cantAngle: a.cantAngleAt(s),
  };
}

/**
 * 軌道・列車・信号・駅を描画するシーン。
 *
 * 前面展望ではなく検証用の外部視点なので、形状は単純な箱と線で構成し、
 * 「どこを走っていて、どの信号が何を現示しているか」が一目で分かることを優先する。
 */
export class TrackScene {
  readonly scene = new THREE.Scene();
  readonly trainGroup = new THREE.Group();
  private readonly vehicleMeshes: THREE.Mesh[] = [];
  private readonly signalLights = new Map<string, THREE.Mesh>();
  private readonly route: CompiledRoute;

  constructor(route: CompiledRoute, sim: Simulation) {
    this.route = route;
    this.scene.background = new THREE.Color(0x0d1117);
    this.scene.fog = new THREE.Fog(0x0d1117, 600, 3000);

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2b2b2b, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);

    this.buildGround();
    this.buildTrack();
    this.buildDistancePosts();
    this.buildStations();
    this.buildSignals();
    this.buildBeacons();
    this.buildTrain(sim);
    this.scene.add(this.trainGroup);
  }

  /**
   * 線路の両側に地表のリボンを敷く。
   * 平坦な板を置くと勾配区間で線路が地面に潜ってしまうため、
   * 軌道中心線に沿って高さを追従させる。
   */
  private buildGround(): void {
    const step = 20;
    const n = Math.floor(this.route.length / step);
    const halfWidth = 90;
    const positions: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = frameAt(this.route, s);
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
        new THREE.MeshLambertMaterial({ color: 0x1b2b22, side: THREE.DoubleSide }),
      ),
    );
  }

  /** 100m ごとの距離標。動きと位置を目で追えるようにする。 */
  private buildDistancePosts(): void {
    const step = 100;
    const count = Math.floor(this.route.length / step);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.18, 1.6, 0.7),
      new THREE.MeshLambertMaterial({ color: 0xcfd6de }),
      count,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const f = frameAt(this.route, i * step);
      const p = f.position.clone().addScaledVector(f.right, -4.5).add(new THREE.Vector3(0, 0.8, 0));
      m.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /** レール 2 本・道床・まくらぎを距離程に沿って生成する */
  private buildTrack(): void {
    const step = 4;
    const n = Math.floor(this.route.length / step);
    const half = this.route.alignment.gauge / 2;

    const leftPoints: THREE.Vector3[] = [];
    const rightPoints: THREE.Vector3[] = [];
    const ballastPositions: number[] = [];

    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = frameAt(this.route, s);
      // カントは外軌側が高くなるように左右のレール高さへ振り分ける
      const cant = this.route.alignment.cantAt(s);
      const l = f.position
        .clone()
        .addScaledVector(f.right, -half)
        .add(new THREE.Vector3(0, -cant / 2, 0));
      const r = f.position
        .clone()
        .addScaledVector(f.right, half)
        .add(new THREE.Vector3(0, cant / 2, 0));
      leftPoints.push(l);
      rightPoints.push(r);

      const bl = f.position.clone().addScaledVector(f.right, -3.6);
      const br = f.position.clone().addScaledVector(f.right, 3.6);
      ballastPositions.push(bl.x, bl.y - 0.4, bl.z, br.x, br.y - 0.4, br.z);
    }

    const railMaterial = new THREE.LineBasicMaterial({ color: RAIL_COLOR });
    this.scene.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPoints), railMaterial),
    );
    this.scene.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPoints), railMaterial),
    );

    // 道床を三角形ストリップで敷く
    const ballastGeom = new THREE.BufferGeometry();
    ballastGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(ballastPositions, 3),
    );
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

    // まくらぎ（インスタンス描画）
    const sleeperStep = 12;
    const count = Math.floor(this.route.length / sleeperStep);
    const sleeper = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.24, 0.16, 2.4),
      new THREE.MeshLambertMaterial({ color: SLEEPER_COLOR }),
      count,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const s = i * sleeperStep;
      const f = frameAt(this.route, s);
      const basis = new THREE.Matrix4().makeBasis(
        f.forward,
        new THREE.Vector3(0, 1, 0).applyAxisAngle(f.forward, f.cantAngle),
        f.right,
      );
      q.setFromRotationMatrix(basis);
      m.compose(f.position.clone().add(new THREE.Vector3(0, -0.1, 0)), q, new THREE.Vector3(1, 1, 1));
      sleeper.setMatrixAt(i, m);
    }
    sleeper.instanceMatrix.needsUpdate = true;
    this.scene.add(sleeper);
  }

  private buildStations(): void {
    for (const station of this.route.stations) {
      const length = station.platformEnd - station.platformStart;
      const mid = (station.platformEnd + station.platformStart) / 2;
      const f = frameAt(this.route, mid);
      const platform = new THREE.Mesh(
        new THREE.BoxGeometry(length, 1.0, 5),
        new THREE.MeshLambertMaterial({ color: 0x39424f }),
      );
      const basis = new THREE.Matrix4().makeBasis(
        f.forward,
        new THREE.Vector3(0, 1, 0),
        f.right,
      );
      platform.quaternion.setFromRotationMatrix(basis);
      platform.position.copy(f.position).addScaledVector(f.right, 4.5).add(new THREE.Vector3(0, 0.5, 0));
      this.scene.add(platform);

      // 停止位置目標
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 2.2, 0.6),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      const fs = frameAt(this.route, station.stopPosition);
      marker.position.copy(fs.position).addScaledVector(fs.right, 3.0).add(new THREE.Vector3(0, 1.2, 0));
      this.scene.add(marker);
    }
  }

  private buildSignals(): void {
    for (const signal of this.route.signals) {
      const f = frameAt(this.route, signal.position);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 5),
        new THREE.MeshLambertMaterial({ color: 0x4c5561 }),
      );
      pole.position.copy(f.position).addScaledVector(f.right, 3.4).add(new THREE.Vector3(0, 2.5, 0));
      this.scene.add(pole);

      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 16, 12),
        new THREE.MeshBasicMaterial({ color: ASPECT_COLOR.R }),
      );
      light.position.copy(pole.position).add(new THREE.Vector3(0, 2.4, 0));
      this.scene.add(light);
      this.signalLights.set(signal.id, light);
    }
  }

  private buildBeacons(): void {
    const entries = this.route.beacons.all;
    if (entries.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 0.18, 1.0),
      new THREE.MeshBasicMaterial({ color: 0xd8a13a }),
      entries.length,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < entries.length; i++) {
      const f = frameAt(this.route, entries[i]!.s);
      m.makeTranslation(f.position.x, f.position.y + 0.05, f.position.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  private buildTrain(sim: Simulation): void {
    for (const veh of sim.dynamics.vehicles) {
      const driven = veh.spec.drivenAxleCount > 0;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(veh.spec.length - 0.6, 3.6, 2.9),
        new THREE.MeshLambertMaterial({ color: driven ? 0x3f6fb5 : 0x5c6470 }),
      );
      this.trainGroup.add(mesh);
      this.vehicleMeshes.push(mesh);
    }
  }

  /** シミュレーションの状態を描画へ反映する */
  update(sim: Simulation): void {
    for (let i = 0; i < this.vehicleMeshes.length; i++) {
      const veh = sim.dynamics.vehicles[i]!;
      const mesh = this.vehicleMeshes[i]!;
      const f = frameAt(this.route, veh.s);
      const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(f.forward, f.cantAngle);
      const right = f.right.clone().applyAxisAngle(f.forward, f.cantAngle);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.forward, up, right));
      mesh.position.copy(f.position).addScaledVector(up, 2.0);
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

  /** 先頭車の位置と向き（カメラ追従用） */
  frontFrame(sim: Simulation) {
    return frameAt(this.route, sim.dynamics.vehicles[0]!.s);
  }
}
