import * as THREE from 'three';
import type { BodyMotionState } from '@railsim/core';
import { CAR, INTERIOR } from './dimensions.ts';
import { seatBays, type CarInterior, type CarLayout } from './interior.ts';

/**
 * 車内を歩く。
 *
 * 車内の人は**車体の上に立っている**。したがって視点は 2 段構えになる:
 *
 *  1. 車体そのものの姿勢（ロール・ピッチ・ヨー・左右変位・上下変位）。これは
 *     `scene.ts` が車体に掛けているので、車体の子として座標を積めば自動で乗る。
 *  2. その上に立っている**人自身の姿勢**。加減速のたびに上体が振られ、曲線では
 *     よろける。これは `packages/core/src/train/passenger.ts` が倒立振子 +
 *     むだ時間を持つ姿勢制御として解いていて、その傾き（`stance.lateral.lean` /
 *     `stance.longitudinal.lean`）をそのまま目の位置と視線に掛ける。
 *
 * 2 が要る理由は、車体動揺だけを掛けても「床にねじ止めされた頭」になってしまう
 * からである。実際には、電車の中で立っている人の頭は車体より**遅れて**動く。
 * 急ブレーキで前へつんのめり、曲線で外側へ振られ、そこから踏ん張って戻る —
 * この遅れと踏ん張りが倒立振子 + むだ時間の模型から出てくる。
 *
 * ## 座標
 *
 * 歩行者の位置は「どの車両の・車体座標系のどこか」で持つ。世界座標で持つと
 * 列車が動いた瞬間に置いて行かれるので、**車体に対する相対位置**でなければ
 * ならない。車体局所系は X = 前、Y = 上（レール面が 0）、Z = 右。
 */

/** 歩く速さ [m/s]（通勤形の通路を人が歩く速さ） */
const WALK_SPEED = 1.35;
/** 早足 [m/s] */
const RUN_SPEED = 2.3;
/** 歩き出し・止まりの応答（速度の一次遅れの時定数 [s]） */
const ACCEL_TIME = 0.12;
/** 見上げ・見下ろしの限界 [rad] */
const PITCH_LIMIT = (85 * Math.PI) / 180;
/** マウスの感度 [rad / px] */
const MOUSE_SENSITIVITY = 0.0022;
/** 頭の上下動の振幅 [m]（1 歩ごとに上下する量） */
const BOB_HEIGHT = 0.022;
/** 1 歩の長さ [m]（上下動の周期を決める） */
const STRIDE = 0.72;

/** 歩行の入力（キーから作る） */
export interface WalkInput {
  /** 前後 -1..1（+1 = 前へ） */
  readonly forward: number;
  /** 左右 -1..1（+1 = 右へ） */
  readonly strafe: number;
  /** 早足 */
  readonly run: boolean;
}

export const NEUTRAL_WALK_INPUT: WalkInput = { forward: 0, strafe: 0, run: false };

/** 歩行者の状態（どの車両の・どこに・どちらを向いて立っているか） */
export interface WalkerState {
  /** 乗っている車両（編成の先頭から 0） */
  carIndex: number;
  /** 車体座標系の前後位置 [m] */
  x: number;
  /** 車体座標系の左右位置 [m]（正 = 右） */
  z: number;
  /** 車体の前方を 0 とした向き [rad]（正 = 左を向く） */
  yaw: number;
  /** 見上げ角 [rad]（正 = 上） */
  pitch: number;
}

/**
 * その前後位置で立てる左右の半幅 [m]（車体中心から）。
 *
 * 通路の広さを決めているのは座席の奥行きで、`内法幅/2 − 座席奥行き` = 965mm。
 * 戸口の前だけは座席が無いので内壁の近くまで寄れ、袖仕切りの立っているところは
 * 逆に狭くなる。貫通路では幌の内法まで絞られる。
 *
 * 純粋な計算なので試験できる（`apps/debugger/test/walk.test.ts`）。
 */
export function corridorHalfWidth(
  layout: CarLayout,
  bays: readonly { from: number; to: number }[],
  x: number,
): number {
  const inner = INTERIOR.width / 2;
  // 妻面より外は貫通路。幌の内法しかない。
  if (x >= layout.walkableTo || x <= layout.walkableFrom) return INTERIOR.gangwayWidth / 2;
  for (const centre of layout.doorCentres) {
    // 戸口の前。座席が無いので内壁のすぐ手前まで寄れる（扉に頬を寄せて外を見られる）
    if (Math.abs(x - centre) <= CAR.doorWidth / 2) return inner - 0.11;
  }
  for (const bay of bays) {
    if (x < bay.from || x > bay.to) continue;
    // 袖仕切りは座席より通路側へ張り出している
    const toEnd = Math.min(x - bay.from, bay.to - x);
    if (toEnd < INTERIOR.armPartitionThickness + 0.06) return inner - INTERIOR.armPartitionDepth;
    return inner - INTERIOR.seatDepth;
  }
  // 座席の無い区画（先頭車の運転室寄りなど）。戸袋の内張りまで。
  return inner - 0.11;
}

/**
 * その車両で歩ける前後の範囲。
 *
 * 運転室の側は仕切り壁で止まる。貫通路の側は連結面の中ほどまで歩けて、
 * そこで隣の車両へ移る。
 */
export function longitudinalLimits(
  layout: CarLayout,
  radius: number,
): { readonly min: number; readonly max: number; readonly gangwayEnd: number } {
  const gangwayEnd = layout.halfLength + INTERIOR.carGap / 2;
  return {
    min: layout.cabSide === -1 ? layout.walkableFrom + radius : -gangwayEnd,
    max: layout.cabSide === 1 ? layout.walkableTo - radius : gangwayEnd,
    gangwayEnd,
  };
}

/**
 * 1 両ぶんの当たり判定。位置を範囲内へ押し戻し、車端を越えたかを返す。
 *
 * @returns `exit` は隣の車両へ移る向き（+1 = 前の車両へ / -1 = 後ろの車両へ / 0 = 移らない）
 */
export function confine(
  layout: CarLayout,
  bays: readonly { from: number; to: number }[],
  x: number,
  z: number,
  radius: number,
): { x: number; z: number; exit: -1 | 0 | 1 } {
  const limits = longitudinalLimits(layout, radius);
  let exit: -1 | 0 | 1 = 0;
  let nx = x;
  if (nx >= limits.gangwayEnd && layout.cabSide !== 1) exit = 1;
  if (nx <= -limits.gangwayEnd && layout.cabSide !== -1) exit = -1;
  nx = Math.min(limits.max, Math.max(limits.min, nx));
  const half = Math.max(0.05, corridorHalfWidth(layout, bays, nx) - radius);
  const nz = Math.min(half, Math.max(-half, z));
  return { x: nx, z: nz, exit };
}

/**
 * 歩行者。毎フレーム `step()` で進める。
 *
 * 進む向きは**車体に対して**決める。曲線で車体が回っても、通路をまっすぐ
 * 歩いている人は通路に沿って歩き続ける（世界座標で向きを持つと、曲線に入った
 * 瞬間に壁へ突き当たる）。
 */
export class Walker {
  readonly state: WalkerState = { carIndex: 0, x: 0, z: 0, yaw: 0, pitch: 0 };
  /** 車体座標系での歩く速度 [m/s] */
  private vx = 0;
  private vz = 0;
  /** 歩いた距離 [m]（頭の上下動の位相） */
  private travelled = 0;
  /** 直近に踏み出した歩数（増えた瞬間によろけを視点へ入れる） */
  private lastSteps = 0;
  /** よろけの残り [rad]（踏み出しの瞬間に立ち、指数で減る） */
  private lurch = 0;
  private readonly bays: Array<readonly { from: number; to: number }[]> = [];

  constructor(private readonly layouts: readonly CarLayout[]) {
    for (const layout of layouts) this.bays.push(seatBays(layout));
    this.reset();
  }

  /** 編成の中ほど（2 両目の中央）に立たせる。歩き始めの位置。 */
  reset(): void {
    const index = Math.min(1, this.layouts.length - 1);
    const layout = this.layouts[index];
    this.state.carIndex = index;
    this.state.x = layout ? (layout.walkableFrom + layout.walkableTo) / 2 : 0;
    this.state.z = 0;
    this.state.yaw = 0;
    this.state.pitch = 0;
    this.vx = 0;
    this.vz = 0;
    this.travelled = 0;
    this.lurch = 0;
  }

  /** マウスの相対移動で視点を回す（Pointer Lock 中に呼ぶ） */
  look(dx: number, dy: number): void {
    // 右へ動かせば右を向く。ヨーは +Y まわりの右手系なので、右向きは負。
    this.state.yaw -= dx * MOUSE_SENSITIVITY;
    this.state.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.state.pitch - dy * MOUSE_SENSITIVITY),
    );
  }

  /** キーで視点を回す（マウスを使わない場合の逃げ道） */
  turn(dyaw: number, dpitch: number): void {
    this.state.yaw += dyaw;
    this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.state.pitch + dpitch));
  }

  /**
   * 1 フレーム進める。
   *
   * @param dt 実時間 [s]（歩く速さは列車の時間倍率に依らない）
   * @param body いま乗っている車の車体動揺（立っている人の姿勢がここに入っている）
   */
  step(dt: number, input: WalkInput, body: BodyMotionState | undefined): void {
    const s = this.state;
    const speed = input.run ? RUN_SPEED : WALK_SPEED;
    const magnitude = Math.hypot(input.forward, input.strafe);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const forward = input.forward * scale * speed;
    const strafe = input.strafe * scale * speed;
    // 車体座標系での目標速度。ヨー 0 で +X が前、+Z が右。
    const targetX = forward * Math.cos(s.yaw) + strafe * Math.sin(s.yaw);
    const targetZ = -forward * Math.sin(s.yaw) + strafe * Math.cos(s.yaw);
    const k = 1 - Math.exp(-dt / ACCEL_TIME);
    this.vx += (targetX - this.vx) * k;
    this.vz += (targetZ - this.vz) * k;

    const layout = this.layouts[s.carIndex];
    if (!layout) return;
    const moved = Math.hypot(this.vx * dt, this.vz * dt);
    this.travelled += moved;

    const result = confine(
      layout,
      this.bays[s.carIndex] ?? [],
      s.x + this.vx * dt,
      s.z + this.vz * dt,
      INTERIOR.bodyRadius,
    );
    s.x = result.x;
    s.z = result.z;
    if (result.exit !== 0) {
      // 隣の車両へ移る。編成は先頭が 0 なので、前へ進むと添字が減る。
      const next = s.carIndex - result.exit;
      const target = this.layouts[next];
      if (target) {
        s.carIndex = next;
        // 連結面の中ほどで受け渡すので、相手側の同じ位置から続ける
        s.x = -result.exit * (target.halfLength + INTERIOR.carGap / 2 - 0.01);
      }
    }

    // 立っている人の姿勢制御が「足を出した」瞬間によろける。
    const stance = body?.passenger.stance;
    if (stance) {
      if (stance.steps > this.lastSteps) {
        this.lurch = Math.min(0.09, 0.02 + 0.05 * Math.min(2, stance.stagger));
        this.lastSteps = stance.steps;
      }
      this.lastSteps = stance.steps;
    }
    this.lurch *= Math.exp(-dt / 0.35);
  }

  /**
   * 目の位置と視線を、乗っている車体の局所座標系で組み立てる。
   *
   * 上体の傾きは足首を支点とした倒立振子なので、頭は
   * `重心高さ × sin(傾き)` だけ横（前後）へ動き、同じぶん沈む。傾きは視線にも
   * そのまま乗る — 前へつんのめれば下を向き、曲線でよろければ視界が傾く。
   */
  pose(body: BodyMotionState | undefined, target: THREE.Object3D): void {
    const s = this.state;
    const stance = body?.passenger.stance;
    const lean = stance?.longitudinal.lean ?? 0;
    const roll = stance?.lateral.lean ?? 0;
    const eye = INTERIOR.eyeHeight;
    // 歩くと頭が上下する。1 歩ごとに 1 回沈むので周期は歩幅。
    const bob = Math.sin((this.travelled / STRIDE) * 2 * Math.PI) * BOB_HEIGHT;
    const floor = this.layouts[s.carIndex]?.floorHeight ?? CAR.floorHeight;

    target.position.set(
      s.x + eye * Math.sin(lean),
      floor + eye * Math.cos(lean) * Math.cos(roll) + bob,
      s.z + eye * Math.sin(roll),
    );

    // 向き: 車体前方（+X）を基準に、ヨー → ピッチ → 上体の傾きの順で重ねる。
    // カメラは -Z が前なので、まず +X を -Z へ向ける回転を掛ける。
    target.quaternion.setFromAxisAngle(UP, s.yaw - Math.PI / 2);
    target.quaternion.multiply(SCRATCH_A.setFromAxisAngle(RIGHT, s.pitch + lean * Math.cos(s.yaw)));
    // よろけた向きへ視界が傾く（首が付いていく）
    target.quaternion.multiply(
      SCRATCH_A.setFromAxisAngle(FORWARD, -roll * Math.cos(s.yaw) - this.lurch),
    );
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const SCRATCH_A = new THREE.Quaternion();

/**
 * 自列車の外板を「車内から見る」ための細工。
 *
 * 車体の外板は法線が外を向いた 1 枚の殻なので、車内からは消えている。
 * ところが**側窓のガラスだけは両面**（`vehicle.ts` の `glass()` が
 * `DoubleSide`）なので、そのままだと車内から見て黒い板になり、外が見えない。
 *
 * そこで車内を歩くあいだだけ、ガラスを透過に切り替える。外から見た車体を
 * 変えたくないので、視点を戻したら元へ返す。
 *
 * 側扉も同じ事情がある。外板側の扉は開閉しない板なので、車内の扉が開いても
 * そこに残ってしまう。歩くあいだだけ、開いているときに隠す。
 *
 * ## 妻面のふさぎ板
 *
 * もう 1 つ、車内からしか分からない厄介がある。外板は断面を押し出した立体なので、
 * **押し出しの両端に蓋（`ExtrudeGeometry` の lid）が付いている**。この蓋は妻面の
 * 位置にあって法線が外を向いているため、隣の車から貫通路ごしに覗くと
 * 「向こうの車の蓋の表」が見えて、通路が黒い板で塞がって見える。
 *
 * `ExtrudeGeometry` は蓋（グループ 0）と側面（グループ 1）を別の描画グループに
 * 分けているので、歩くあいだだけ材質を配列にして**グループ 0 を透明**にすれば
 * 蓋だけを消せる。客室は内装のほうで閉じているので、蓋が無くても外は漏れない。
 *
 * 連結面の幌（`buildCouplers` が置く 260 × 2000 × 1500mm の箱）も同じ理由で
 * 邪魔になる。外から見れば連結面の隙間を塞ぐ正しい部品だが、車内から見ると
 * 貫通路の真ん中に立ちはだかる。内装の側が幌の内側を作っているので、
 * 歩くあいだはこちらを隠す。
 *
 * どのメッシュがガラスかは**材質の値**で見分ける。`glass()` だけが
 * 粗さ 0.06・金属度 0.9 という組み合わせを持っているので、色の定数に頼らずに
 * 判別できる（見つからなければ何もしないだけで、壊れはしない）。
 */
export class CarShells {
  private readonly glass: THREE.MeshStandardMaterial[] = [];
  private readonly doorPanels: THREE.Object3D[] = [];
  /** 外板の殻（押し出しの蓋を持つメッシュ）と、その元の材質 */
  private readonly shells: Array<{ mesh: THREE.Mesh; material: THREE.Material }> = [];
  /** 連結面の幌（車内から見ると貫通路を塞ぐ） */
  private readonly gangwayBlockers: THREE.Object3D[] = [];
  /** 蓋を消すための「描かない」材質 */
  private readonly hidden = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  private walking = false;

  constructor(cars: ReadonlyArray<{ object: THREE.Object3D; interior: CarInterior }>) {
    const toCar = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const size = new THREE.Vector3();
    const at = new THREE.Vector3();
    for (const car of cars) {
      const layout = car.interior.layout;
      const interior = car.interior.group;
      // 部品は「形（geometry）を動かしたもの」と「置き場所（position）で動かした
      // もの」が混ざっている。前者だけを見ると後者の位置を取り違えるので、
      // **車体の局所座標系へ移した外形**で判定する。
      car.object.updateWorldMatrix(true, true);
      toCar.copy(car.object.matrixWorld).invert();
      car.object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        // 内装そのものは対象外（自分で作ったものなので触らない）
        for (let p: THREE.Object3D | null = node; p; p = p.parent) {
          if (p === interior) return;
        }
        const material = node.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          if (material.roughness < 0.15 && material.metalness > 0.8) this.glass.push(material);
        }
        node.geometry.computeBoundingBox();
        if (!node.geometry.boundingBox) return;
        const bounds = node.geometry.boundingBox
          .clone()
          .applyMatrix4(local.multiplyMatrices(toCar, node.matrixWorld));
        bounds.getSize(size);
        bounds.getCenter(at);

        // 外板の殻。車体長いっぱいに伸びていて、背も車体の高さぶんある
        // ただ 1 つのメッシュなので、外形の大きさで見分けられる。
        if (
          !Array.isArray(node.material) &&
          size.x > CAR.bodyLength - 1 &&
          size.y > 2 &&
          node.geometry.groups.length >= 2
        ) {
          this.shells.push({ mesh: node, material: node.material });
        }
        // 連結面の幌。車体端に立つ、前後に薄く上下左右に大きい箱。
        if (
          size.x < 0.5 &&
          size.y > 1.5 &&
          size.z > 1.2 &&
          Math.abs(at.x) > CAR.bodyLength / 2 - 0.3
        ) {
          // prettier-ignore
          this.gangwayBlockers.push(node);
        }
        // 側扉のところに貼ってある板（扉そのものと扉の窓）
        const zMax = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
        if (zMax < 1.0) return;
        for (const centre of layout.doorCentres) {
          if (
            bounds.min.x > centre - CAR.doorWidth / 2 - 0.02 &&
            bounds.max.x < centre + CAR.doorWidth / 2 + 0.02
          ) {
            this.doorPanels.push(node);
            break;
          }
        }
      });
      // 内装は影を落とさない。影の地図は列車の周り 100m を焼くためのもので、
      // 車内の座席や吊り革まで描いても絵は変わらず、費用だけが増える。
      interior.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.InstancedMesh) {
          node.castShadow = false;
        }
      });
    }
  }

  /** 車内を歩くモードに入る／出る */
  setWalking(on: boolean): void {
    if (on === this.walking) return;
    this.walking = on;
    for (const material of this.glass) {
      material.transparent = on;
      // 実物の側窓も熱線吸収ガラスで色が付いている。透かしても外は少し暗い。
      material.opacity = on ? 0.22 : 1;
      material.depthWrite = !on;
      material.needsUpdate = true;
    }
    for (const shell of this.shells) {
      // グループ 0 が押し出しの蓋、グループ 1 が側面。歩くあいだだけ蓋を消す。
      shell.mesh.material = on ? [this.hidden, shell.material] : shell.material;
    }
    for (const blocker of this.gangwayBlockers) blocker.visible = !on;
    if (!on) for (const panel of this.doorPanels) panel.visible = true;
  }

  /** 扉の開き具合に合わせて、外板側の扉板を出し入れする */
  update(doorPosition: number): void {
    if (!this.walking) return;
    const open = doorPosition > 0.02;
    for (const panel of this.doorPanels) panel.visible = !open;
  }
}
