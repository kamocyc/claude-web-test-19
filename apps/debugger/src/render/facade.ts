import * as THREE from 'three';
import { FACADE } from './dimensions.ts';

/**
 * 建物の外皮のうち、**壁面から出っ張っているもの**。
 *
 * ## なぜ要るか
 *
 * 沿線の建物は、外壁のテクスチャに窓を描いた直方体で作ってある。テクスチャの
 * 実寸が合っているので遠景では成立するが、**近景では板に見える**。理由は
 * はっきりしていて、
 *
 *  - 窓に**影が落ちない**。実物のサッシは外壁より 40〜60mm 出ていて、
 *    その厚みが上と横に細い影を落とす。晴れた日に家を家と認識しているのは、
 *    ほとんどこの影の線である。
 *  - ガラスが**空を映さない**。描いた窓はただの暗い矩形なので、
 *    見る角度を変えても色が変わらない。実物のガラスは斜めから見るほど
 *    強く空を映す（フレネル）ので、走っていると窓が次々に光る。
 *  - 集合住宅の**ベランダが平ら**。日本の団地・アパートの外観を決めているのは
 *    窓ではなく、2.8m ごとに横一列に並ぶベランダの床と手すり壁である。
 *    これが出っ張っていないと、どんなテクスチャを貼っても壁にしか見えない。
 *
 *  - 工場（波板）に**窓が 1 つも無い**。実物の工場は壁の大半が無窓だが、
 *    軒下に鋼製サッシの連窓が 1 段通っていて、その横一本の影が壁の高さを
 *    読ませている。無いと近景でただの波板の箱に見える。
 *
 * ここではその 4 つだけを立体で足す。壁そのものは今までどおりテクスチャに
 * 任せる（窓を全部くり抜くと頂点が桁で増えるうえ、屋内を作る羽目になる）。
 *
 * ## テクスチャと合わせる
 *
 * 出っ張りは**描いてある窓とぴったり重ねなければならない**。ずれると窓が
 * 二重に見えて、かえって嘘くさくなる。そのため開口の位置は
 * `SIDING_OPENINGS`（`textures.ts`）が持っていて、テクスチャを描く側と
 * ここが同じ値を見る。壁を貼る実寸（`WALL_TILE`, `scenery.ts`）も同じ。
 *
 * ## 寸法の出どころ
 *
 * 実寸は `dimensions.ts` の `FACADE`（出典つき）に集めてある。ここはその値を
 * 使って形を組むだけで、数値そのものは持たない。
 */

/** 外壁テクスチャ 1 枚の中の開口（正規化座標。u は左→右、v は下→上） */
export interface Opening {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** 庇（ひさし）を付けるか。1 階の掃き出し窓には後付けの庇がよく付く */
  readonly hood?: boolean;
}

/** 出っ張りの寸法 [m]（出どころは `dimensions.ts` の `FACADE`） */
const SASH = {
  jamb: FACADE.sashJamb,
  reveal: FACADE.sashReveal,
  border: FACADE.sashBorder,
  hoodDepth: FACADE.hoodDepth,
  hoodThickness: FACADE.hoodThickness,
} as const;

/** ベランダの寸法 [m] */
const BALCONY = {
  depth: FACADE.balconyDepth,
  slab: FACADE.balconySlab,
  railHeight: FACADE.balconyRailHeight,
  railThickness: FACADE.balconyRailThickness,
  floorHeight: FACADE.floorHeight,
  /** 1 階の床（＝地面）からベランダ床までの立ち上がり */
  base: 0.05,
} as const;

/**
 * 工場・倉庫の高窓の寸法 [m]（出どころは `dimensions.ts` の `FACADE`）。
 *
 * 住宅のサッシと違い、**壁 1 面につき 1 段の帯**しかない。窓の数が少ないぶん
 * 頂点も少なくて済むので、方立まで立体で入れられる。
 */
const STRIP = {
  drop: FACADE.stripDrop,
  height: FACADE.stripHeight,
  mullion: FACADE.stripMullion,
  frame: FACADE.stripFrame,
  jamb: FACADE.stripJamb,
  reveal: FACADE.stripReveal,
  corner: FACADE.stripCorner,
} as const;

/** 建物 1 型ぶんの外皮の指定 */
export interface FacadeSpec {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** 外壁テクスチャ 1 枚が受け持つ実寸 [m]（`buildBuildings` の `maps()` と同じ値） */
  readonly tile: readonly [number, number];
  /** 開口の並び。空なら窓は作らない */
  readonly openings: readonly Opening[];
  /** ベランダを付けるか（集合住宅） */
  readonly balcony: boolean;
  /**
   * 軒下の高窓（連窓）を付けるか（工場・倉庫）。
   *
   * 外壁テクスチャ（波板）には窓を描いていないので、こちらは重ねる相手が
   * 無い。壁のどこに開けても二重には見えないぶん、位置は実物の寸法だけで
   * 決められる。
   */
  readonly strip?: boolean;
}

/** 出っ張りの形。枠側とガラス側で材質が違うので別々に返す */
export interface Facade {
  /** サッシ枠・庇・ベランダ（不透明） */
  readonly frame: THREE.BufferGeometry | null;
  /** ガラス（空を映す） */
  readonly glass: THREE.BufferGeometry | null;
}

/**
 * 建物の出っ張りを組む。
 *
 * 座標系は建物本体と同じで、原点が接地面・+Y が上・XZ が平面。
 * `width` は X、`depth` は Z にとる（`buildBuildings` の `meterBox` と同じ）。
 */
export function buildFacade(spec: FacadeSpec): Facade {
  const frames: THREE.BufferGeometry[] = [];
  const panes: THREE.BufferGeometry[] = [];

  // 4 面すべてに付ける。線路と直交して建つ家（区画の都合で 18% ある）は
  // 妻面が線路を向くので、そこを素通しにすると「片側だけ作り込んだ書き割り」
  // になる。
  for (const face of FACES) {
    const across = face.axis === 'z' ? spec.width : spec.depth;
    const out = (face.axis === 'z' ? spec.depth : spec.width) / 2;
    if (spec.openings.length > 0) {
      addWindows(frames, panes, spec, face, across, out);
    }
    if (spec.balcony) addBalcony(frames, spec, face, across, out);
    if (spec.strip) addStripWindow(frames, panes, spec, face, across, out);
  }

  return {
    frame: frames.length > 0 ? merge(frames) : null,
    glass: panes.length > 0 ? merge(panes) : null,
  };
}

/** 壁 1 面の向き。`sign` はその軸の外向き */
interface Face {
  readonly axis: 'x' | 'z';
  readonly sign: 1 | -1;
}

const FACES: readonly Face[] = [
  { axis: 'z', sign: 1 },
  { axis: 'z', sign: -1 },
  { axis: 'x', sign: 1 },
  { axis: 'x', sign: -1 },
];

/**
 * 面の上の局所座標（横 `a`・高さ `y`・壁からの出 `d`）を建物の座標へ。
 *
 * **面ごとに向きを回してから置く。**箱だけなら回さなくても形は同じだが、
 * ガラス（`PlaneGeometry`）は片面しか描かないので、回さないと 4 面のうち
 * 3 面で裏を向き、壁の中を向いたまま消える（実際そうなった）。
 */
function placeOn(
  geometry: THREE.BufferGeometry,
  face: Face,
  a: number,
  y: number,
  d: number,
  out: number,
): THREE.BufferGeometry {
  // 面の外向きが +Z（= 作ったままの向き）から何度回っているか
  const yaw = face.axis === 'z' ? (face.sign > 0 ? 0 : Math.PI) : (face.sign * Math.PI) / 2;
  geometry.rotateY(yaw);
  // 面上の位置も同じだけ回す（原点で作ったものを回してから運ぶ）
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  geometry.translate(a * c + (out + d) * s, y, -a * s + (out + d) * c);
  return geometry;
}

/** サッシ・ガラス・庇を 1 面ぶん並べる */
function addWindows(
  frames: THREE.BufferGeometry[],
  panes: THREE.BufferGeometry[],
  spec: FacadeSpec,
  face: Face,
  across: number,
  out: number,
): void {
  const [tileU, tileV] = spec.tile;
  const columns = Math.ceil(across / tileU);
  const rows = Math.ceil(spec.height / tileV);
  for (let ti = 0; ti < columns; ti++) {
    for (let tj = 0; tj < rows; tj++) {
      for (const o of spec.openings) {
        const a0 = ti * tileU + o.u0 * tileU - across / 2;
        const a1 = ti * tileU + o.u1 * tileU - across / 2;
        const y0 = tj * tileV + o.v0 * tileV;
        const y1 = tj * tileV + o.v1 * tileV;
        // 壁の外や屋根の上へはみ出すものは捨てる。テクスチャの側は
        // 途中で切れた窓を描くが、立体は切れずに宙へ飛び出してしまう。
        if (a1 > across / 2 - 0.12 || y1 > spec.height - 0.2) continue;
        const w = a1 - a0;
        const h = y1 - y0;
        if (w < 0.3 || h < 0.3) continue;
        const a = (a0 + a1) / 2;
        const y = (y0 + y1) / 2;
        // 枠。壁をまたいで置くので、内側の半分は本体に隠れる
        frames.push(
          placeOn(
            new THREE.BoxGeometry(w, h, SASH.jamb),
            face,
            a,
            y,
            SASH.reveal - SASH.jamb / 2,
            out,
          ),
        );
        // ガラス。枠は中身の詰まった板なので、**ガラスは枠の前面のさらに
        // 外へ置かないと枠に飲み込まれて見えない**（実際そうなった）。
        // 枠を刳り抜いて奥へ落とすほうが実物には近いが、窓 1 つが 14 三角形
        // から 34 三角形へ増える。沿線の家 500 軒ぶんではその差が効くので、
        // 「枠ごと壁から 50mm 出す」ことで奥行きを出すほうを選んだ。
        panes.push(
          placeOn(
            new THREE.PlaneGeometry(w - SASH.border * 2, h - SASH.border * 2),
            face,
            a,
            y,
            SASH.reveal + 0.002,
            out,
          ),
        );
        if (o.hood) {
          frames.push(
            placeOn(
              new THREE.BoxGeometry(w + 0.24, SASH.hoodThickness, SASH.hoodDepth),
              face,
              a,
              y1 + 0.09,
              SASH.hoodDepth / 2,
              out,
            ),
          );
        }
      }
    }
  }
}

/**
 * 軒下の高窓（工場・倉庫）。
 *
 * 波板の工場は、近づくと**窓が 1 つも無い板**に見えていた。実物の工場は
 * 壁の大半が無窓だが、軒下に鋼製サッシの連窓が 1 段だけ通っていて、その
 * 無目（横枠）と方立（縦枠）の影が壁に横の線を引く。**この 1 本の線があるか
 * どうか**で、波板の箱が工場に見えるかどうかが決まる。
 *
 * 住宅のサッシ（`addWindows`）と違ってテクスチャに描いた窓と重ねる必要が
 * ないので、割り付けは実寸だけで決める。ガラスは方立で仕切られた 1 枚ずつに
 * 分けて置く — 1 枚の板で帯を覆うと、その手前にある方立が隠れてしまう。
 */
function addStripWindow(
  frames: THREE.BufferGeometry[],
  panes: THREE.BufferGeometry[],
  spec: FacadeSpec,
  face: Face,
  across: number,
  out: number,
): void {
  const band = across - STRIP.corner * 2;
  // 隅の柱を除くと窓が 1 枚も入らない壁（小さい建屋の妻面）には付けない
  if (band < STRIP.mullion) return;
  const top = spec.height - STRIP.drop;
  const bottom = top - STRIP.height;
  if (bottom < 2.0) return;
  const middle = (top + bottom) / 2;
  // 無目（上下の横枠）。帯の全長に通す
  for (const y of [bottom, top]) {
    frames.push(
      placeOn(
        new THREE.BoxGeometry(band, STRIP.frame, STRIP.jamb),
        face,
        0,
        y,
        STRIP.reveal - STRIP.jamb / 2,
        out,
      ),
    );
  }
  // 水切り。下枠の下に少しだけ出して、壁に横一本の影を落とす
  frames.push(
    placeOn(
      new THREE.BoxGeometry(band + 0.16, 0.06, STRIP.reveal + 0.1),
      face,
      0,
      bottom - STRIP.frame / 2 - 0.03,
      (STRIP.reveal + 0.1) / 2 - 0.02,
      out,
    ),
  );
  // 方立で割る。1 枚の幅が鋼製サッシの標準（1.8m）に近くなる枚数を選ぶ
  const bays = Math.max(1, Math.round(band / STRIP.mullion));
  const bay = band / bays;
  for (let i = 0; i <= bays; i++) {
    const a = -band / 2 + i * bay;
    frames.push(
      placeOn(
        new THREE.BoxGeometry(STRIP.frame, STRIP.height, STRIP.jamb),
        face,
        a,
        middle,
        STRIP.reveal - STRIP.jamb / 2,
        out,
      ),
    );
    if (i === bays) continue;
    // ガラスは枠より前へ置く（`addWindows` と同じ理由。枠は中身の詰まった箱）
    panes.push(
      placeOn(
        new THREE.PlaneGeometry(bay - STRIP.frame, STRIP.height - STRIP.frame),
        face,
        a + bay / 2,
        middle,
        STRIP.reveal + 0.002,
        out,
      ),
    );
  }
}

/**
 * ベランダ（集合住宅）。
 *
 * 階ごとに床スラブと手すり壁を横一列に通す。**この 2 本の水平線が
 * 2.8m ごとに影を落とすことが、団地を団地に見せている**。
 */
function addBalcony(
  frames: THREE.BufferGeometry[],
  spec: FacadeSpec,
  face: Face,
  across: number,
  out: number,
): void {
  // 妻面（短いほう）にベランダは付かない。実物も開口は桁行き側にしか無い
  if (face.axis === 'x') return;
  const floors = Math.max(1, Math.round(spec.height / BALCONY.floorHeight));
  for (let k = 0; k < floors; k++) {
    const level = k * BALCONY.floorHeight + BALCONY.base;
    if (level + BALCONY.railHeight > spec.height) break;
    frames.push(
      placeOn(
        new THREE.BoxGeometry(across + 0.12, BALCONY.slab, BALCONY.depth),
        face,
        0,
        level + BALCONY.slab / 2,
        BALCONY.depth / 2,
        out,
      ),
    );
    frames.push(
      placeOn(
        new THREE.BoxGeometry(across + 0.12, BALCONY.railHeight, BALCONY.railThickness),
        face,
        0,
        level + BALCONY.slab + BALCONY.railHeight / 2,
        BALCONY.depth - BALCONY.railThickness / 2,
        out,
      ),
    );
  }
}

/**
 * 位置・法線・UV だけを持つ形をつなぐ。
 *
 * `BoxGeometry` と `PlaneGeometry` はどちらもこの 3 つを持つので、
 * 添字を展開してから並べれば 1 つにまとまる。
 */
function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  for (const part of parts) {
    const geom = part.index ? part.toNonIndexed() : part;
    const p = geom.attributes.position!;
    const n = geom.attributes.normal!;
    const t = geom.attributes.uv!;
    for (let i = 0; i < p.count; i++) {
      position.push(p.getX(i), p.getY(i), p.getZ(i));
      normal.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t.getX(i), t.getY(i));
    }
    if (geom !== part) geom.dispose();
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return merged;
}

/**
 * 窓ガラスの材質。
 *
 * 板ガラスは正面からは 8% しか反射しないが、斜めから見ると 50% を超える
 * （フレネル）。`MeshStandardMaterial` は粗さの小さい非金属でこの角度依存を
 * 出すので、`envMap`（空を焼いたもの）を強めに掛ければ、走りながら見たときに
 * 窓が次々と空の色に光る。色そのものは室内の暗さで、青みがかった濃い灰。
 *
 * @param environmentIntensity シーン側の環境マップの強さ。これで割り戻して、
 *   屋外の影の濃さの調整（`scene.ts`）に窓の映り込みが引きずられないようにする
 */
export function glassMaterial(environmentIntensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    // 室内の暗さ。外から見た窓が「黒い穴」に見えるのはこれのせいで、
    // 明るくすると窓ではなく白い板になる。
    color: 0x252d34,
    // つるつるに寄せすぎると、面の向きが揃っている窓が**一斉に**太陽を映して
    // 白い紙のように飛ぶ（実際そうなった）。網入りガラスや汚れのぶんだけ
    // 荒らして、映り込みを少し広げる。
    roughness: 0.22,
    metalness: 0,
    // シーン側（屋外の影の濃さに合わせて弱めてある）を割り戻し、
    // ガラスにだけ空の輝度の 1.2 倍を映す（フレネルで角度が寝るほど強く光る）
    envMapIntensity: 1.2 / Math.max(0.05, environmentIntensity),
  });
}
