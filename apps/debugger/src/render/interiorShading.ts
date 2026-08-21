import * as THREE from 'three';

/**
 * 客室の**接地の陰**を頂点色に焼き込む。
 *
 * ## なぜ要るのか
 *
 * 車内は蛍光灯で照らされた閉じた箱で、光源を何本も置くと描画が持たない。そこで
 * `interior.ts` は面そのものを自己発光させて「照らされている」ことにしている。
 * ところが自己発光は**どこから照らされているかを持たない**ので、座席と床の境目・
 * 袖仕切りの根元・荷棚の下・けこみの奥といった、実物では必ず暗くなるところが
 * まったく暗くならない。結果、物が床から浮いて見え、車内ではなく模型に見える。
 *
 * 後処理の SSAO でも同じ絵は作れるが、車内の陰は**形が動かない**（座席も荷棚も
 * 車体に固定されている）ので、走るたびに計算し直す理由がない。組み立てるときに
 * 一度だけ焼いてしまえばよい。
 *
 * ## どう焼くか
 *
 * 客室を作っている塊を軸に沿った直方体（`Occluder`）として登録しておき、頂点
 * ごとに「まわりをどれだけ塞がれているか」を積む。塞がれている量は
 *
 *   遮蔽 = Σ 重み × max(0, 法線・向き) × exp(-距離 / 効く範囲)
 *
 * で近似する。`向き` は**最寄り点と塊の中心の中ほど**へ向かうベクトルで、
 * 最寄り点だけを見ると床のすぐ脇に立つ壁が水平方向になって効かなくなる
 * （床の法線と直交してしまう）。壁は床の上に立ちはだかっているのだから、
 * 塊の中心へ寄せて「上のほうを塞いでいる」ことにするのが実物に近い。
 *
 * 自分自身の塊で暗くならないのは `max(0, 法線・向き)` が受け持つ。面の裏側に
 * ある塊は視界に入らないので効かない。
 *
 * ## 自己発光にも掛けなければ効かない
 *
 * three.js の頂点色は拡散色にしか掛からない（`emissive` は素通りする）。車内は
 * ほとんど自己発光でできているので、**そのままでは焼いた陰がほとんど見えない**。
 * `shadeWithVertexColor()` が着色器へ 1 行足して、自己発光にも同じ頂点色を掛ける。
 */

/** 遮る塊。軸に沿った直方体で近似する。 */
interface Occluder {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  readonly centre: THREE.Vector3;
  /** 濃さ（大きいほど暗い） */
  readonly weight: number;
  /** 効く範囲 [m]（この距離で 1/e に落ちる） */
  readonly range: number;
}

/** 塊の表面にごく近い頂点は「その塊自身の面」とみなして数えない距離 [m] */
const SELF_SURFACE = 0.004;
/** 効く範囲の何倍まで見るか（これより遠い塊は打ち切る） */
const CUTOFF = 3.5;

const scratchClosest = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchPoint = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();

/**
 * 客室を作っている塊の一覧。
 *
 * 座標系は車体局所系（X = 前、Y = 上でレール面が 0、Z = 右）。`interior.ts` が
 * 部品を組む前に、同じ寸法から塊を登録しておく。
 */
export class OcclusionField {
  private readonly boxes: Occluder[] = [];

  /**
   * 塊を 1 つ足す。
   *
   * @param centre 中心
   * @param size   大きさ（各辺の長さ）
   * @param weight 濃さ
   * @param range  効く範囲 [m]
   */
  add(
    centre: readonly [number, number, number],
    size: readonly [number, number, number],
    weight = 1,
    range = 0.3,
  ): void {
    const half = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
    const c = new THREE.Vector3(centre[0], centre[1], centre[2]);
    this.boxes.push({
      min: c.clone().sub(half),
      max: c.clone().add(half),
      centre: c,
      weight,
      range,
    });
  }

  /** 点 `p`（法線 `n`）がどれだけ塞がれているか 0..1 */
  sample(p: THREE.Vector3, n: THREE.Vector3): number {
    let sum = 0;
    for (const box of this.boxes) {
      scratchClosest.set(
        Math.min(box.max.x, Math.max(box.min.x, p.x)),
        Math.min(box.max.y, Math.max(box.min.y, p.y)),
        Math.min(box.max.z, Math.max(box.min.z, p.z)),
      );
      const distance = scratchClosest.distanceTo(p);
      // 自分自身の面（塊の表面に乗っている頂点）は数えない
      if (distance < SELF_SURFACE) continue;
      if (distance > box.range * CUTOFF) continue;
      // 最寄り点と中心の中ほどへ向ける。最寄り点だけだと、床の脇に立つ壁の
      // ように「面と平行に接している塊」がまったく効かなくなる。
      scratchDir
        .copy(scratchClosest)
        .addScaledVector(box.centre, 1)
        .multiplyScalar(0.5)
        .sub(p)
        .normalize();
      const facing = Math.max(0, n.dot(scratchDir));
      if (facing <= 0) continue;
      sum += box.weight * facing * Math.exp(-distance / box.range);
    }
    // 重なった塊で 1 を越えないよう飽和させる
    return 1 - Math.exp(-sum);
  }

  /**
   * 頂点色へ焼く。
   *
   * @param geometry 焼く形（`color` 属性が無ければ作る）
   * @param strength 最も暗いところの明るさの下げ幅 0..1
   * @param tint     陰の色味。実物の車内の陰はわずかに青みが残る（天井の
   *                 蛍光灯より窓から入る空の光のほうが回り込むため）。
   */
  bake(geometry: THREE.BufferGeometry, strength = 0.55, tint?: THREE.Color): void {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    if (!position || !normal) return;
    const count = position.count;
    let color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!color || color.count !== count) {
      color = new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3);
      geometry.setAttribute('color', color);
    }
    const shade = tint ?? SHADE_TINT;
    for (let i = 0; i < count; i++) {
      scratchPoint.fromBufferAttribute(position, i);
      scratchNormal.fromBufferAttribute(normal, i);
      const occlusion = this.sample(scratchPoint, scratchNormal) * strength;
      color.setXYZ(
        i,
        color.getX(i) * (1 - occlusion * (1 - shade.r)),
        color.getY(i) * (1 - occlusion * (1 - shade.g)),
        color.getZ(i) * (1 - occlusion * (1 - shade.b)),
      );
    }
    color.needsUpdate = true;
  }
}

/**
 * 陰の色。真っ黒に落とすと車内が煤けて見えるので、暗いところほど青へ寄せる。
 * （実物の車内の陰は、窓から入る空の光が回り込んでいて青みが残る）
 */
const SHADE_TINT = new THREE.Color(0.07, 0.085, 0.115);

/**
 * 頂点色を**自己発光にも**掛ける。
 *
 * three.js の `vColor` は拡散色にしか掛からない。車内はほとんど自己発光で
 * できているので、この 1 行が無いと焼いた陰がほとんど見えない。差し込む場所は
 * `emissivemap_fragment` の直後 — `color_fragment` はその前に済んでいるので、
 * `vColor` はもう読める。
 */
export function shadeWithVertexColor<T extends THREE.Material>(material: T): T {
  material.vertexColors = true;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
    );
  };
  // 差し替えた着色器は使い回してよい（材質ごとに中身が変わらないため）
  material.customProgramCacheKey = () => 'interior-vcolor-emissive';
  return material;
}

/**
 * 頂点色を白で埋める。
 *
 * `vertexColors` を立てた材質を頂点色の無い形に使うと、属性が無いぶんが
 * 真っ黒（0,0,0）として読まれて面が消える。焼かない形にも下地だけは入れておく。
 */
export function fillWhite(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  const existing = geometry.getAttribute('color');
  if (existing && existing.count === position.count) return;
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(new Float32Array(position.count * 3).fill(1), 3),
  );
}

/**
 * 頂点色を面ごとに掛ける（焼いた陰の上から重ねる）。
 *
 * 床の通路中央のように「作りの都合ではなく使われ方で色が変わる」ところに使う。
 * `weight` は 0..1 で、1 なら `color` そのもの。
 */
export function tintVertices(
  geometry: THREE.BufferGeometry,
  tint: (x: number, y: number, z: number) => number,
): void {
  fillWhite(geometry);
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const k = tint(position.getX(i), position.getY(i), position.getZ(i));
    color.setXYZ(i, color.getX(i) * k, color.getY(i) * k, color.getZ(i) * k);
  }
  color.needsUpdate = true;
}
