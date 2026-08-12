import * as THREE from 'three';

const VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  uniform float offset;
  uniform float exponent;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
    vec3 sky = mix(horizonColor, topColor, pow(max(h, 0.0), exponent));
    vec3 color = h < 0.0 ? mix(horizonColor, groundColor, min(-h * 4.0, 1.0)) : sky;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * 昼間の空。
 *
 * 天頂から地平線へ向かうグラデーションを内向きの巨大な球に貼る。
 * 画像テクスチャを持たずに済むので、外部リソースなしで昼光の雰囲気が出せる。
 */
export function createSky(radius = 5000): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x2f6fd0) },
      horizonColor: { value: new THREE.Color(0xcfe3f5) },
      groundColor: { value: new THREE.Color(0x8fa08a) },
      offset: { value: 60 },
      exponent: { value: 0.7 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material);
  mesh.renderOrder = -1;
  return mesh;
}

/** 太陽の向き（列車から見た太陽の位置。影の落ちる方向を決める） */
export const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.79, 0.34).normalize();

/**
 * 昼光の照明（太陽の平行光 + 空と地面からの環境光）。
 *
 * 太陽には影を落とさせる。列車が道床に落とす影、上屋がホームに落とす影、
 * 架線柱がのり面に落とす影 — 晴れた日の線路の見え方は、明るさよりも影の
 * 形で決まる。ただし影を焼く範囲は狭くしないと粗くなるので、列車の周りだけを
 * 追いかける（`TrackScene.update()` が光源を運ぶ）。
 */
export function createDaylight(): { sun: THREE.DirectionalLight; ambient: THREE.HemisphereLight } {
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.9);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const extent = 90;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 700;
  // 自分自身に縞模様の影が出る（シャドウアクネ）のを防ぐ。法線方向へずらすほうが
  // 深度をずらすより、レールのような細い立体の影が痩せにくい。
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.045;
  // 空からの光は太陽より弱くしておく。ここを強くすると影の中まで明るくなり、
  // せっかく落とした影が見えなくなる。
  const ambient = new THREE.HemisphereLight(0xbfd8f5, 0x6b7a5a, 0.7);
  return { sun, ambient };
}
