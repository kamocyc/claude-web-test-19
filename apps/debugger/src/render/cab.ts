import * as THREE from 'three';
import { mpsToKmh, paToKpa, type Simulation } from '@railsim/core';

const FRAME_COLOR = 0x323841;
const PANEL_COLOR = 0x3d444d;
const DESK_COLOR = 0x2b3037;

/** 指針の振れ角の全範囲（一般的な丸形計器と同じく約 270 度） */
const SWEEP = (270 * Math.PI) / 180;

function panel(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshLambertMaterial({ color }),
  );
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * 丸形計器。文字板・目盛り・指針を持ち、指針は `setRatio()` で 0..1 に応じて振れる。
 * 円筒の軸が局所 Y なので、指針は X-Z 平面に置いて Y 軸まわりに回す。
 */
class Gauge {
  readonly group = new THREE.Group();
  private readonly needle: THREE.Mesh;

  constructor(x: number, y: number, z: number, radius: number, faceColor: number) {
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.02, 24),
      new THREE.MeshLambertMaterial({ color: 0x15181c }),
    );
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.87, radius * 0.87, 0.024, 24),
      new THREE.MeshBasicMaterial({ color: faceColor }),
    );
    this.group.add(bezel, face);

    // 目盛り
    for (let i = 0; i <= 10; i++) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(radius * 0.035, 0.004, radius * (i % 5 === 0 ? 0.22 : 0.13)),
        new THREE.MeshBasicMaterial({ color: 0x2c3238 }),
      );
      tick.position.set(0, 0.014, 0);
      const holder = new THREE.Group();
      holder.add(tick);
      tick.position.z = -radius * 0.72;
      holder.rotation.y = -SWEEP / 2 + (SWEEP * i) / 10;
      this.group.add(holder);
    }

    this.needle = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 0.055, 0.006, radius * 0.78),
      new THREE.MeshBasicMaterial({ color: 0xc02020 }),
    );
    this.needle.position.set(0, 0.018, -radius * 0.34);
    const pivot = new THREE.Group();
    pivot.add(this.needle);
    this.group.add(pivot);
    this.pivot = pivot;

    this.group.position.set(x, y, z);
    // 運転士の方をやや向くように倒す
    this.group.rotation.x = Math.PI / 2 - 0.35;
  }

  private readonly pivot: THREE.Group;

  /** 0..1 の割合で指針を振る */
  setRatio(ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    this.pivot.rotation.y = -SWEEP / 2 + SWEEP * r;
  }
}

export interface CabInterior {
  readonly group: THREE.Group;
  /** 計器と表示灯をシミュレーションの状態に合わせる */
  update(sim: Simulation): void;
}

/**
 * 運転席の内装。
 *
 * カメラの子として取り付けるので、車体動揺でカメラが揺れても内装は視界の中で
 * 静止し、窓の外の景色だけが揺れる。これは実際に運転席から見える揺れ方と同じで、
 * 一人称視点で揺れを体感するうえで重要な点になる。
 *
 * 座標系はカメラ局所系（-Z が前方、+X が右、+Y が上）。
 * 前方視界をできるだけ広く取りたいので、窓は大きく・枠は細くしてある。
 */
export function createCabInterior(): CabInterior {
  const group = new THREE.Group();

  // --- 前面窓の枠 ---
  const z = -0.95;
  const left = -0.95;
  const right = 1.02;
  const top = 0.66;
  const bottom = -0.5;
  const t = 0.07;

  group.add(panel(right - left + t * 2, t, 0.1, (left + right) / 2, top, z, FRAME_COLOR));
  group.add(panel(right - left + t * 2, t, 0.1, (left + right) / 2, bottom, z, FRAME_COLOR));
  group.add(panel(t, top - bottom + t * 2, 0.1, left, (top + bottom) / 2, z, FRAME_COLOR));
  group.add(panel(t, top - bottom + t * 2, 0.1, right, (top + bottom) / 2, z, FRAME_COLOR));
  // 中桟（前面 2 枚窓）。運転士の正面を避けて右寄りに置く。
  group.add(panel(0.045, top - bottom, 0.09, 0.3, (top + bottom) / 2, z, FRAME_COLOR));

  // --- 天井・側面・後方の仕切り ---
  group.add(panel(2.8, 0.1, 2.2, 0, 0.78, -0.1, PANEL_COLOR));
  group.add(panel(0.1, 1.5, 2.2, -1.12, 0.05, -0.1, PANEL_COLOR));
  group.add(panel(0.1, 1.5, 2.2, 1.16, 0.05, -0.1, PANEL_COLOR));
  group.add(panel(2.8, 1.7, 0.08, 0, 0.05, 0.9, PANEL_COLOR));

  // --- 運転台 ---
  const desk = panel(1.75, 0.07, 0.55, -0.02, -0.56, -0.72, DESK_COLOR);
  desk.rotation.x = -0.16;
  group.add(desk);
  group.add(panel(1.75, 0.42, 0.06, -0.02, -0.78, -0.96, DESK_COLOR));

  // 計器: 速度計・ブレーキシリンダ圧力計・電流計
  const speedGauge = new Gauge(-0.36, -0.51, -0.82, 0.09, 0xeef2f7);
  const pressureGauge = new Gauge(-0.13, -0.51, -0.82, 0.07, 0xe4ecf4);
  const currentGauge = new Gauge(0.09, -0.51, -0.82, 0.07, 0xe4ecf4);
  group.add(speedGauge.group, pressureGauge.group, currentGauge.group);

  // 表示灯（ATS 動作・パターン接近・非常）
  const lampColors = [0x2fd45f, 0xffb400, 0xff3b30];
  const lamps = lampColors.map((color, i) => {
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.03, 0.012),
      new THREE.MeshBasicMaterial({ color }),
    );
    lamp.position.set(0.34 + i * 0.07, -0.49, -0.83);
    group.add(lamp);
    return lamp;
  });

  // マスコンハンドル（左手）とブレーキ設定器（右手）
  const mascon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.2, 10),
    new THREE.MeshLambertMaterial({ color: 0x9aa0a8 }),
  );
  mascon.position.set(-0.66, -0.46, -0.62);
  group.add(mascon);

  const brakeHandle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.18, 10),
    new THREE.MeshLambertMaterial({ color: 0x9aa0a8 }),
  );
  brakeHandle.position.set(0.62, -0.46, -0.62);
  group.add(brakeHandle);

  group.renderOrder = 10;

  return {
    group,
    update(sim: Simulation): void {
      const snap = sim.snapshot();
      const maxSpeed = mpsToKmh(sim.scenario.consist.maxSpeed);
      speedGauge.setRatio(mpsToKmh(snap.speed) / maxSpeed);
      pressureGauge.setRatio(paToKpa(snap.cylinderPressure) / 400);
      currentGauge.setRatio(0.5 + snap.motorCurrent / 3000);

      // ハンドルの角度をノッチに連動させる（左手前が力行、右手前がブレーキ）
      const powerRatio = snap.powerNotch / Math.max(1, sim.scenario.consist.traction.notchCount);
      const brakeRatio = snap.emergency
        ? 1.15
        : snap.brakeNotch / Math.max(1, sim.scenario.consist.brake.notchCount);
      mascon.rotation.z = 0.1 + powerRatio * 0.55;
      brakeHandle.rotation.z = -0.1 - brakeRatio * 0.55;

      // 表示灯: 進行（緑）・警報/パターン接近（橙）・非常（赤）
      const ind = snap.safety.indication;
      setLamp(lamps[0]!, !ind.bell && !snap.safety.emergencyBrake, 0x2fd45f);
      setLamp(lamps[1]!, ind.bell || ind.patternApproach || ind.chime, 0xffb400);
      setLamp(lamps[2]!, snap.safety.emergencyBrake || snap.emergency, 0xff3b30);
    },
  };
}

function setLamp(lamp: THREE.Mesh, on: boolean, color: number): void {
  const material = lamp.material as THREE.MeshBasicMaterial;
  material.color.setHex(on ? color : 0x2a2f35);
}
