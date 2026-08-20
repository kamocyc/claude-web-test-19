import * as THREE from 'three';
import { fold, particleCount, type WeatherLook } from './weather.ts';

/**
 * 降水の描画。
 *
 * 粒はカメラを中心とした一辺 `2*HALF` の箱に入れ、箱からはみ出したぶんを反対側へ
 * 巻き戻す。巻き戻し先は世界座標では格子状に並んだ「同じ粒の写し」なので、
 * **粒そのものは世界に対して静止した格子として振る舞う**。列車が進めばその格子を
 * 突っ切ることになり、走行に伴う流れは何もしなくても出る。数百 m 先まで粒を置く
 * 必要が無いので、これで数千粒でも降っているように見える。
 *
 * 位置の更新は頂点シェーダの中だけで行い、毎フレーム CPU から頂点を送り直さない。
 * 送るのは「積み上げた移動量」1 つだけである。
 */

/** 巻き戻しの箱の半辺 [m] */
const HALF = 34;

/** 粒が世界に対して落ちる向き（風の吹き流し込み） */
const WIND = new THREE.Vector3(0.9, 0, 0.35);

/**
 * 雨脚の長さを決める時間 [s]。見かけの速度にこれを掛けたものが 1 本の長さになる。
 * 止まっていれば短く、飛ばせば長く尾を引く。
 */
const STREAK_TIME = 0.028;

/** カメラのすぐ手前の粒は消す（顔に張り付いて見えるのを防ぐ）[m] */
const NEAR_FADE = 2.5;

/** 巻き戻しの継ぎ目で粒が突然現れないよう、箱の縁で消す */
const EDGE_FADE = /* glsl */ `
  float edgeFade(vec3 rel, float halfBox) {
    vec3 t = abs(rel) / halfBox;
    float m = max(max(t.x, t.y), t.z);
    return 1.0 - smoothstep(0.72, 1.0, m);
  }
`;

/** 箱の中へ巻き戻す */
const WRAP = /* glsl */ `
  vec3 wrapAround(vec3 base, vec3 drift, vec3 camera, float halfBox) {
    vec3 rel = base + drift - camera;
    return mod(rel + halfBox, 2.0 * halfBox) - halfBox;
  }
`;

const RAIN_VERTEX = /* glsl */ `
  attribute float aEnd;
  uniform vec3 uDrift;
  uniform vec3 uCamera;
  uniform vec3 uStreak;
  uniform float uHalf;
  uniform float uNear;
  uniform float uFade;
  varying float vAlpha;
  ${WRAP}
  ${EDGE_FADE}
  void main() {
    vec3 rel = wrapAround(position, uDrift, uCamera, uHalf);
    // 1 本の線分の後端だけを見かけの速度の向きへ伸ばす
    vec3 world = rel + uCamera + uStreak * aEnd;
    float d = length(rel);
    vAlpha = uFade * edgeFade(rel, uHalf) * smoothstep(uNear, uNear * 3.0, d);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const RAIN_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.001) discard;
    gl_FragColor = vec4(uColor, uOpacity * vAlpha);
  }
`;

const SNOW_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aScale;
  uniform vec3 uDrift;
  uniform vec3 uCamera;
  uniform float uHalf;
  uniform float uNear;
  uniform float uFade;
  uniform float uTime;
  uniform float uSize;
  varying float vAlpha;
  ${WRAP}
  ${EDGE_FADE}
  void main() {
    // 雪片は落ちながら横へ揺れる。位相を粒ごとにずらして、揃って揺れないようにする
    float t = uTime + aPhase * 6.2831853;
    vec3 sway = vec3(sin(t * 0.7) * 0.9, 0.0, cos(t * 0.53) * 0.9);
    vec3 rel = wrapAround(position + sway, uDrift, uCamera, uHalf);
    vec3 world = rel + uCamera;
    float d = length(rel);
    vAlpha = uFade * edgeFade(rel, uHalf) * smoothstep(uNear, uNear * 3.0, d);
    vec4 view = viewMatrix * vec4(world, 1.0);
    gl_PointSize = clamp((uSize * aScale * 320.0) / max(-view.z, 0.1), 1.0, 44.0);
    gl_Position = projectionMatrix * view;
  }
`;

const SNOW_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.001) discard;
    // テクスチャを持たずに丸くぼかす。縁を立てると四角い粒に見えてしまう
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity * vAlpha;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** シェーダへ渡す一式（雨と雪で共通の名前を使う） */
type Uniforms = Record<string, THREE.IUniform>;

function baseUniforms(look: WeatherLook): Uniforms {
  return {
    uDrift: { value: new THREE.Vector3() },
    uCamera: { value: new THREE.Vector3() },
    uHalf: { value: HALF },
    uNear: { value: NEAR_FADE },
    uFade: { value: 1 },
    uColor: { value: new THREE.Color(look.particleColor) },
    uOpacity: { value: 1 },
  };
}

/** 一様乱数（見た目だけなので再現性は要らないが、種を固定して毎回同じ絵にする） */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 降水系。天気が変わるたびに作り直さず、`setLook()` で作り替える。
 * 路線には依存しないので、シーンを組み直しても使い回せる。
 */
export class Precipitation {
  readonly group = new THREE.Group();

  private mesh: THREE.Object3D | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private look: WeatherLook | null = null;
  private budget = 1;

  private readonly drift = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly apparent = new THREE.Vector3();
  private time = 0;

  constructor(budget = 1) {
    this.budget = budget;
    // 影の計算にも霧にも入れない。粒は自分で明るさを持つ。
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = 5;
  }

  /** 天気を差し替える（降らない天気なら粒を捨てる） */
  setLook(look: WeatherLook): void {
    if (this.look === look) return;
    this.look = look;
    this.dispose();
    if (look.precipitation === 'none') return;
    const count = particleCount(look.precipitation, HALF, look.density, this.budget);
    if (count <= 0) return;
    this.mesh =
      look.precipitation === 'rain' ? this.buildRain(look, count) : this.buildSnow(look, count);
    this.group.add(this.mesh);
  }

  private buildRain(look: WeatherLook, count: number): THREE.Object3D {
    const random = seeded(0x5eed1a);
    const positions = new Float32Array(count * 6);
    const ends = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = (random() * 2 - 1) * HALF;
      const y = (random() * 2 - 1) * HALF;
      const z = (random() * 2 - 1) * HALF;
      // 線分の 2 頂点は同じ基準位置を持ち、後端だけシェーダで伸ばす
      positions.set([x, y, z, x, y, z], i * 6);
      ends.set([0, 1], i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const uniforms: Uniforms = {
      ...baseUniforms(look),
      uStreak: { value: new THREE.Vector3() },
    };
    uniforms.uOpacity = { value: 0.62 };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.geometry = geometry;
    this.material = material;
    return this.finish(new THREE.LineSegments(geometry, material));
  }

  private buildSnow(look: WeatherLook, count: number): THREE.Object3D {
    const random = seeded(0x51e6d0);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const scales = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions.set(
        [(random() * 2 - 1) * HALF, (random() * 2 - 1) * HALF, (random() * 2 - 1) * HALF],
        i * 3,
      );
      phases[i] = random();
      // 粒の大小を散らす。揃っていると降雪ではなく点描に見える
      scales[i] = 0.45 + random() * random() * 1.5;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    const uniforms: Uniforms = {
      ...baseUniforms(look),
      uTime: { value: 0 },
      uSize: { value: 0.075 },
    };
    uniforms.uOpacity = { value: 0.9 };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SNOW_VERTEX,
      fragmentShader: SNOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.geometry = geometry;
    this.material = material;
    return this.finish(new THREE.Points(geometry, material));
  }

  /**
   * 視錐台の判定から外す。
   *
   * 粒の位置は頂点シェーダの中でカメラの周りへ巻き戻している。ところが
   * three.js が持つ境界球は属性に入っている**基準位置**（原点まわり）から
   * 作られるので、列車が原点から離れると「画面の外にある」と判定されて
   * 丸ごと描かれなくなる。実際に描く場所は常にカメラの周りなので、
   * ここでは判定そのものを外すのが正しい。
   */
  private finish<T extends THREE.Object3D>(object: T): T {
    object.frustumCulled = false;
    return object;
  }

  /**
   * 1 フレーム進める。
   *
   * @param dt      進める時間 [s]（一時停止中は 0）
   * @param camera  巻き戻しの中心
   * @param trainVelocity 列車の速度ベクトル [m/s]（雨脚の傾きに使う）
   * @param visibility 0..1。トンネルの中では 0 にして降りを止める
   */
  update(
    dt: number,
    camera: THREE.Vector3,
    trainVelocity: THREE.Vector3,
    visibility: number,
  ): void {
    const material = this.material;
    const look = this.look;
    if (material === null || look === null) return;
    this.group.visible = visibility > 0.001;
    if (!this.group.visible) return;

    this.velocity.copy(WIND).setY(-look.fallSpeed);
    this.drift.addScaledVector(this.velocity, dt);
    // 巻き戻しの周期そのもので畳んでおくと、見た目を変えずに桁を保てる
    const period = 2 * HALF;
    this.drift.set(
      fold(this.drift.x, period),
      fold(this.drift.y, period),
      fold(this.drift.z, period),
    );
    this.time += dt;

    const u = material.uniforms;
    (u.uDrift!.value as THREE.Vector3).copy(this.drift);
    (u.uCamera!.value as THREE.Vector3).copy(camera);
    u.uFade!.value = visibility;
    if (u.uTime) u.uTime.value = this.time;
    if (u.uStreak) {
      // 見かけの速度 = 粒の速度 − 列車の速度。止まっていれば真下へ、
      // 飛ばしていれば後ろへ倒れた長い尾になる。
      this.apparent.copy(this.velocity).sub(trainVelocity).multiplyScalar(STREAK_TIME);
      (u.uStreak.value as THREE.Vector3).copy(this.apparent);
    }
  }

  dispose(): void {
    if (this.mesh) this.group.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.geometry = null;
    this.material = null;
  }
}
