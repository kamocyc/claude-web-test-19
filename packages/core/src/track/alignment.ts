import { GRAVITY, type Meters, type PerMeter, type Radians, type Slope } from '../units.ts';
import { vec3, type Vec3 } from '../math/vec3.ts';
import type { RampProfile } from './profile.ts';

/** 軌道上のある距離程における幾何情報 */
export interface TrackPoint {
  /** 距離程 [m] */
  readonly s: Meters;
  /** 軌道中心線の 3 次元位置（y が高さ） */
  readonly position: Vec3;
  /** 方位角 [rad]（正の曲率で増加する。進行方向は (cos, 0, -sin)） */
  readonly heading: Radians;
  /** 曲率 [1/m]（正 = 左曲がり、0 = 直線） */
  readonly curvature: PerMeter;
  /** 勾配 [m/m]（正 = 上り） */
  readonly grade: Slope;
  /** カント [m]（曲率と同じ符号。正 = 左曲線で外軌側=右レールが高い） */
  readonly cant: Meters;
  /** カント角 [rad] */
  readonly cantAngle: Radians;
}

/** 軌道中心線を組み立てるための入力 */
export interface AlignmentInput {
  /** 曲率プロファイル [1/m] */
  readonly curvature: RampProfile;
  /** 勾配プロファイル [m/m] */
  readonly grade: RampProfile;
  /** カントプロファイル [m] */
  readonly cant: RampProfile;
  /** 軌間 [m]（カント不足の算出に使う） */
  readonly gauge: Meters;
  /** 全長 [m] */
  readonly length: Meters;
  /** 起点の位置・方位・高さ */
  readonly origin?: { position?: Vec3; heading?: Radians };
  /** 位置サンプルの刻み [m]（既定 1 m） */
  readonly sampleStep?: Meters;
}

/** 4 点ガウス・ルジャンドル求積の節点と重み（区間 [-1,1]） */
const GL_NODES = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const GL_WEIGHTS = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];

/**
 * 軌道中心線。
 *
 * 平面線形は曲率プロファイル κ(s) で定義され、方位角は θ(s) = θ0 + ∫κ ds（解析的に厳密）、
 * 平面位置は x = ∫cos θ ds, z = -∫sin θ ds をガウス・ルジャンドル求積で数値積分して求める。
 * 直線・円曲線だけでなく緩和曲線（曲率が線形に変化する区間）も同じ枠組みで扱える。
 *
 * 縦断線形は勾配プロファイル i(s) の積分で高さを与える。縦曲線は勾配が線形に変化する区間として
 * 表現されるため、高さは s の 2 次関数となり、これも厳密に積分される。
 */
export class Alignment {
  readonly length: Meters;
  readonly gauge: Meters;
  private readonly curvatureProfile: RampProfile;
  private readonly gradeProfile: RampProfile;
  private readonly cantProfile: RampProfile;
  private readonly heading0: Radians;
  private readonly origin: Vec3;
  private readonly step: Meters;
  /** sampleStep ごとの平面位置（累積積分のキャッシュ） */
  private readonly sampleX: Float64Array;
  private readonly sampleZ: Float64Array;
  private readonly sampleS: Float64Array;

  constructor(input: AlignmentInput) {
    this.length = input.length;
    this.gauge = input.gauge;
    this.curvatureProfile = input.curvature;
    this.gradeProfile = input.grade;
    this.cantProfile = input.cant;
    this.heading0 = input.origin?.heading ?? 0;
    this.origin = input.origin?.position ?? vec3(0, 0, 0);
    this.step = input.sampleStep ?? 1;

    const n = Math.max(1, Math.ceil(this.length / this.step)) + 1;
    this.sampleS = new Float64Array(n);
    this.sampleX = new Float64Array(n);
    this.sampleZ = new Float64Array(n);
    let x = this.origin.x;
    let z = this.origin.z;
    for (let i = 0; i < n; i++) {
      const s = Math.min(i * this.step, this.length);
      this.sampleS[i] = s;
      this.sampleX[i] = x;
      this.sampleZ[i] = z;
      if (i + 1 < n) {
        const sNext = Math.min((i + 1) * this.step, this.length);
        const d = this.integrateXZ(s, sNext);
        x += d.dx;
        z += d.dz;
      }
    }
  }

  /** 方位角 θ(s) = θ0 + ∫κ ds */
  headingAt(s: Meters): Radians {
    return this.heading0 + this.curvatureProfile.integralAt(s);
  }

  /** 曲率 [1/m]（正 = 左曲がり） */
  curvatureAt(s: Meters): PerMeter {
    return this.curvatureProfile.valueAt(s);
  }

  /** 曲線半径 [m]（直線では Infinity）。符号は持たない。 */
  radiusAt(s: Meters): Meters {
    const k = Math.abs(this.curvatureAt(s));
    return k < 1e-9 ? Infinity : 1 / k;
  }

  /** 勾配 [m/m]（正 = 上り） */
  gradeAt(s: Meters): Slope {
    return this.gradeProfile.valueAt(s);
  }

  /** 区間 [s0, s1] の平均勾配。車体長にわたる勾配力の平均に使う。 */
  averageGrade(s0: Meters, s1: Meters): Slope {
    return this.gradeProfile.averageOver(s0, s1);
  }

  /** 区間 [s0, s1] の平均曲率 */
  averageCurvature(s0: Meters, s1: Meters): PerMeter {
    return this.curvatureProfile.averageOver(s0, s1);
  }

  /** 高さ [m] = 起点高さ + ∫i ds */
  elevationAt(s: Meters): Meters {
    return this.origin.y + this.gradeProfile.integralAt(s);
  }

  /** カント [m] */
  cantAt(s: Meters): Meters {
    return this.cantProfile.valueAt(s);
  }

  /** カント角 [rad] */
  cantAngleAt(s: Meters): Radians {
    return Math.asin(Math.max(-1, Math.min(1, this.cantAt(s) / this.gauge)));
  }

  /**
   * 均衡カント [m]。速度 v で走行したとき遠心力と重力が釣り合うカント量。
   * C_eq = G * v^2 * κ / g （慣用式 C = G V^2 / (127 R) と等価）
   */
  equilibriumCant(s: Meters, v: number): Meters {
    return (this.gauge * v * v * this.curvatureAt(s)) / GRAVITY;
  }

  /**
   * カント不足 [m] = 均衡カント - 実カント。
   * 絶対値が「カント不足量」、符号は不足している向き（曲率と同符号なら曲線外側へ超過遠心力）。
   * 負の場合はカント超過（低速通過時に内側へ倒れる側）。
   */
  cantDeficiency(s: Meters, v: number): Meters {
    return this.equilibriumCant(s, v) - this.cantAt(s);
  }

  /**
   * 軌道面内の非平衡（未補償）左右加速度 [m/s^2]。
   *
   * 必要な求心加速度 v^2*κ（正 = 左向き）から、カントによって重力が肩代わりする分
   * g*sin(カント角) を差し引いたもの。正なら左向きの求心力が不足しており、
   * 乗客は曲線外側（右）へ押される。乗り心地評価と転覆・脱線余裕の判定に使う。
   */
  lateralAcceleration(s: Meters, v: number): number {
    const k = this.curvatureAt(s);
    const phi = this.cantAngleAt(s);
    return v * v * k - GRAVITY * Math.sin(phi);
  }

  /** 平面位置 (x, z) */
  private planeAt(s: Meters): { x: number; z: number } {
    if (s <= 0) {
      const th = this.heading0;
      return { x: this.origin.x + Math.cos(th) * s, z: this.origin.z - Math.sin(th) * s };
    }
    if (s >= this.length) {
      const last = this.sampleS.length - 1;
      const th = this.headingAt(this.length);
      const d = s - this.length;
      return {
        x: this.sampleX[last]! + Math.cos(th) * d,
        z: this.sampleZ[last]! - Math.sin(th) * d,
      };
    }
    const i = Math.min(Math.floor(s / this.step), this.sampleS.length - 1);
    const s0 = this.sampleS[i]!;
    const d = this.integrateXZ(s0, s);
    return { x: this.sampleX[i]! + d.dx, z: this.sampleZ[i]! + d.dz };
  }

  /** 区間 [a, b] の平面変位をガウス・ルジャンドル求積で計算する */
  private integrateXZ(a: number, b: number): { dx: number; dz: number } {
    const half = (b - a) / 2;
    const mid = (a + b) / 2;
    let dx = 0;
    let dz = 0;
    for (let k = 0; k < GL_NODES.length; k++) {
      const s = mid + half * GL_NODES[k]!;
      const th = this.headingAt(s);
      dx += GL_WEIGHTS[k]! * Math.cos(th);
      dz -= GL_WEIGHTS[k]! * Math.sin(th);
    }
    return { dx: dx * half, dz: dz * half };
  }

  /** 3 次元位置 */
  positionAt(s: Meters): Vec3 {
    const p = this.planeAt(s);
    return vec3(p.x, this.elevationAt(s), p.z);
  }

  /** 進行方向の単位ベクトル */
  tangentAt(s: Meters): Vec3 {
    const th = this.headingAt(s);
    const i = this.gradeAt(s);
    const n = Math.sqrt(1 + i * i);
    return vec3(Math.cos(th) / n, i / n, -Math.sin(th) / n);
  }

  at(s: Meters): TrackPoint {
    return {
      s,
      position: this.positionAt(s),
      heading: this.headingAt(s),
      curvature: this.curvatureAt(s),
      grade: this.gradeAt(s),
      cant: this.cantAt(s),
      cantAngle: this.cantAngleAt(s),
    };
  }

  /** 描画用に等間隔でサンプリングする */
  sample(step: Meters, from: Meters = 0, to: Meters = this.length): TrackPoint[] {
    const out: TrackPoint[] = [];
    const n = Math.max(1, Math.ceil((to - from) / step));
    for (let i = 0; i <= n; i++) {
      out.push(this.at(Math.min(from + i * step, to)));
    }
    return out;
  }

  /** 曲率・勾配・カントの要素境界（イベント点生成用） */
  get elementBoundaries(): number[] {
    const set = new Set<number>();
    for (const b of this.curvatureProfile.boundaries) set.add(b);
    for (const b of this.gradeProfile.boundaries) set.add(b);
    for (const b of this.cantProfile.boundaries) set.add(b);
    return [...set].sort((a, b) => a - b);
  }

  /** 位置サンプルの刻み [m] */
  get sampleStep(): Meters {
    return this.step;
  }
}
