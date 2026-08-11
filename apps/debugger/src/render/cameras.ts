import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'chase' | 'side' | 'overhead' | 'free';

export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: '追跡',
  side: '側面',
  overhead: '俯瞰',
  free: '自由',
};

interface Frame {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
}

export interface CameraTarget {
  readonly frame: Frame;
  /** 編成長 [m]。追跡カメラの引き幅に使う。 */
  readonly trainLength: number;
}

/**
 * 検証用のカメラ。
 * 前面展望ではなく「列車と線路の関係が見える外部視点」を用意する。
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  mode: CameraMode = 'chase';

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 6000);
    this.camera.position.set(0, 40, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.controls.enabled = mode === 'free';
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(target: CameraTarget): void {
    const { frame } = target;
    switch (this.mode) {
      case 'chase': {
        // 編成全体が入るよう、先頭車から編成長ぶん後ろへ引く
        const look = frame.position.clone().addScaledVector(frame.forward, 30).add(new THREE.Vector3(0, 3, 0));
        const eye = frame.position
          .clone()
          .addScaledVector(frame.forward, -(target.trainLength + 70))
          .add(new THREE.Vector3(0, 26, 0));
        this.camera.position.lerp(eye, 0.12);
        this.camera.lookAt(look);
        break;
      }
      case 'side': {
        const look = frame.position
          .clone()
          .addScaledVector(frame.forward, -target.trainLength / 2)
          .add(new THREE.Vector3(0, 2, 0));
        const eye = look.clone().addScaledVector(frame.right, -90).add(new THREE.Vector3(0, 20, 0));
        this.camera.position.lerp(eye, 0.15);
        this.camera.lookAt(look);
        break;
      }
      case 'overhead': {
        const look = frame.position.clone().addScaledVector(frame.forward, -target.trainLength / 2);
        const eye = look.clone().add(new THREE.Vector3(0, 150, 0)).addScaledVector(frame.forward, 30);
        this.camera.position.lerp(eye, 0.12);
        this.camera.lookAt(look);
        break;
      }
      case 'free':
        this.controls.update();
        break;
    }
  }
}
