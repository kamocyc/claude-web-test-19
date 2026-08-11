import * as THREE from 'three';
import type { CompiledRoute } from '@railsim/core';

/** 距離程 s における軌道の基準座標系 */
export interface TrackFrame {
  /** 軌道中心線上の位置 */
  readonly position: THREE.Vector3;
  /** 進行方向の単位ベクトル */
  readonly forward: THREE.Vector3;
  /** 進行方向に対する右方向の単位ベクトル（水平） */
  readonly right: THREE.Vector3;
  /** カント角 [rad] */
  readonly cantAngle: number;
}

/**
 * 距離程から軌道の基準座標系を作る。
 *
 * 右手系 y-up で進行方向を (cosθ, 勾配, -sinθ) とすると、
 * 進行方向に対する右側は (sinθ, 0, cosθ) になる。
 */
export function makeFrameAt(route: CompiledRoute): (s: number) => TrackFrame {
  const a = route.alignment;
  return (s: number): TrackFrame => {
    const p = a.positionAt(s);
    const heading = a.headingAt(s);
    const grade = a.gradeAt(s);
    return {
      position: new THREE.Vector3(p.x, p.y, p.z),
      forward: new THREE.Vector3(Math.cos(heading), grade, -Math.sin(heading)).normalize(),
      right: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
      cantAngle: a.cantAngleAt(s),
    };
  };
}
