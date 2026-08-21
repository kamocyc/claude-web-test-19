import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TrackFrame } from './frame.ts';

export type CameraMode = 'cab' | 'walk' | 'chase' | 'side' | 'overhead' | 'free';

export const CAMERA_MODES: readonly CameraMode[] = [
  'cab',
  'walk',
  'chase',
  'side',
  'overhead',
  'free',
];

export const CAMERA_LABEL: Record<CameraMode, string> = {
  cab: '運転席',
  walk: '車内',
  chase: '追跡',
  side: '側面',
  overhead: '俯瞰',
  free: '自由',
};

export interface CameraTarget {
  readonly frame: TrackFrame;
  /** 編成長 [m]。追跡カメラの引き幅に使う。 */
  readonly trainLength: number;
  /** 運転席の位置（車体動揺を含む） */
  readonly cabPosition: THREE.Vector3;
  /** 先頭車の姿勢（局所 X が前方） */
  readonly cabQuaternion: THREE.Quaternion;
  /**
   * 車内を歩いている人の目（世界座標）。`walk.ts` が車体の姿勢まで含めて
   * 組み立てたものをそのまま使う。車内視点のときだけ入る。
   */
  readonly walkPosition?: THREE.Vector3 | undefined;
  readonly walkQuaternion?: THREE.Quaternion | undefined;
}

/** 車体の局所座標系（X が前方）をカメラの向き（-Z が前方）へ合わせる回転 */
const BODY_TO_CAMERA = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  -Math.PI / 2,
);

/**
 * 運転士は前方の軌道を見るためやや下向きに視線を置く。
 * これがないと運転台がまったく視界に入らず、逆に不自然になる。
 */
const CAB_LOOK_DOWN = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  (-4.5 * Math.PI) / 180,
);

/**
 * カメラ。運転席からの一人称視点と、検証用の外部視点を切り替える。
 *
 * 運転席視点だけは補間せず車体の姿勢をそのまま使う。補間すると
 * 車体動揺（軌道狂いによる揺れ、曲線でのロール）が鈍って伝わらなくなるため。
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  mode: CameraMode = 'cab';

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 8000);
    this.camera.position.set(0, 40, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.controls.enabled = mode === 'free';
    // 車内は狭いので画角を広めに取る。実物の車内で感じる「奥行きの詰まった
    // 空間」は、視野角を絞ると出ない。
    this.camera.fov = mode === 'cab' ? 68 : mode === 'walk' ? 75 : 55;
    this.camera.updateProjectionMatrix();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(target: CameraTarget): void {
    const { frame } = target;
    switch (this.mode) {
      case 'cab': {
        this.camera.position.copy(target.cabPosition);
        this.camera.quaternion
          .copy(target.cabQuaternion)
          .multiply(BODY_TO_CAMERA)
          .multiply(CAB_LOOK_DOWN);
        break;
      }
      case 'walk': {
        // 位置も向きも `walk.ts` が出したものをそのまま使う。補間しないのは
        // 運転席視点と同じ理由で、鈍らせると車体動揺が伝わらなくなるため。
        if (target.walkPosition) this.camera.position.copy(target.walkPosition);
        if (target.walkQuaternion) this.camera.quaternion.copy(target.walkQuaternion);
        break;
      }
      case 'chase': {
        const look = frame.position
          .clone()
          .addScaledVector(frame.forward, 30)
          .add(new THREE.Vector3(0, 3, 0));
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
        const eye = look
          .clone()
          .addScaledVector(frame.right, -90)
          .add(new THREE.Vector3(0, 20, 0));
        this.camera.position.lerp(eye, 0.15);
        this.camera.lookAt(look);
        break;
      }
      case 'overhead': {
        const look = frame.position.clone().addScaledVector(frame.forward, -target.trainLength / 2);
        const eye = look
          .clone()
          .add(new THREE.Vector3(0, 150, 0))
          .addScaledVector(frame.forward, 30);
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
