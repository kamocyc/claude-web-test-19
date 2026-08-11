import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';

/** 距離程 s における軌道の基準座標系 */
export interface TrackFrame {
  /** 軌道中心線上の位置 */
  readonly position: THREE.Vector3;
  /** 進行方向の単位ベクトル */
  readonly forward: THREE.Vector3;
  /** 進行方向に対する右方向の単位ベクトル（水平。カントを含まない） */
  readonly right: THREE.Vector3;
  /** カント角 [rad]（外軌が高いほど正 = 左曲線で正） */
  readonly cantAngle: number;
  /** 軌道面の上方向（カントで曲線の内側へ傾く） */
  readonly up: THREE.Vector3;
  /** 軌道面内の右方向（カントが正なら右側が上がる） */
  readonly cantRight: THREE.Vector3;
}

/**
 * 距離程から軌道の基準座標系を作る。
 *
 * 右手系 y-up で進行方向を (cosθ, 勾配, -sinθ) とすると、
 * 進行方向に対する右側は (sinθ, 0, cosθ) になる。
 *
 * ## カントの符号について
 *
 * ここがカントの回転を作る唯一の場所であり、符号を間違えると車体とレールが
 * 逆向きに傾く（実際に一度そうなっていた）。約束は 2 つある:
 *
 *  - `Alignment.cantAngleAt()` は **外軌（曲線外側のレール）が高いほど正**。
 *    左曲線（曲率が正）ではカントも正になり、右レールが高い。
 *  - three.js の `applyAxisAngle` は右手系なので、`forward` まわりに正の角で
 *    回すと上方向は `right` 側へ倒れる。すなわち **右側が下がる**。
 *
 * 求めたいのは「右側が上がる」姿勢なので、回転角は **-cantAngle** になる。
 * こうすると上方向は曲線の内側へ傾き、実物と同じくバンクした姿勢になる。
 */
export function makeFrameAt(route: CompiledRoute): (s: number) => TrackFrame {
  const a = route.alignment;
  return (s: number): TrackFrame => {
    const p = a.positionAt(s);
    const heading = a.headingAt(s);
    const grade = a.gradeAt(s);
    const cantAngle = a.cantAngleAt(s);
    const forward = new THREE.Vector3(Math.cos(heading), grade, -Math.sin(heading)).normalize();
    const right = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    // カント無しの軌道面法線。勾配区間では鉛直ではなく、軌道に垂直な向きになる
    // （鉛直のままだと基準座標系が直交せず、車体がわずかに歪む）。
    const upNoCant = right.clone().cross(forward).normalize();
    return {
      position: new THREE.Vector3(p.x, p.y, p.z),
      forward,
      right,
      cantAngle,
      up: upNoCant.clone().applyAxisAngle(forward, -cantAngle),
      cantRight: right.clone().applyAxisAngle(forward, -cantAngle),
    };
  };
}
