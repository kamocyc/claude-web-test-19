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

/** 昼光の照明（太陽の平行光 + 空と地面からの環境光） */
export function createDaylight(): THREE.Object3D[] {
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.position.set(-400, 700, 300);
  const sky = new THREE.HemisphereLight(0xbfd8f5, 0x6b7a5a, 1.5);
  return [sun, sky];
}
