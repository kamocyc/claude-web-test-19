import * as THREE from 'three';
import type { WeatherLook } from './weather.ts';

/**
 * 表面の質感（テクスチャ）。
 *
 * 画像ファイルは 1 枚も使わず、すべてその場でキャンバスに描いて作る。外部
 * リソースに依存しないので、ビルドしてどこへ置いても同じ絵が出る。
 *
 * ## 実寸で貼る
 *
 * どのテクスチャも「1 枚が実寸で何 m か」を指定して貼る。バラストの砕石は
 * 40mm、ホームのタイルは 300mm、というように、模様の大きさが実物の寸法で
 * 決まる。掃引形状（`sweepSection`）の UV は m 単位で入っているので、
 * `repeat = 1/タイル寸法` を掛けるだけで実寸に合う。
 *
 * ## 凹凸
 *
 * 描いた絵の明暗をそのまま高さと見なして法線マップを作る（`normalFromCanvas`）。
 * 砕石の丸み・コンクリートの目地・点字ブロックの突起が、色だけでなく陰影として
 * 出るようになるので、平らな板に貼っても平らに見えない。
 */

/** 標準のテクスチャ解像度 */
const SIZE = 512;

/** mulberry32。同じ種からは必ず同じ模様が出る */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** キャンバスを 1 枚用意して描く */
function paint(
  draw: (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void,
  seed: number,
  size = SIZE,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size, rng(seed));
  return canvas;
}

/**
 * 端でつながるように描く。
 *
 * タイルの縁をまたぐ図形は、反対側の縁にも同じものを描いておかないと
 * 継ぎ目が線になって出る。上下左右の 8 方向へずらして重ね描きする。
 */
function seamless(
  ctx: CanvasRenderingContext2D,
  size: number,
  x: number,
  y: number,
  draw: (cx: number, cy: number) => void,
): void {
  for (const dx of [-size, 0, size]) {
    for (const dy of [-size, 0, size]) {
      draw(x + dx, y + dy);
    }
  }
}

/**
 * 描いた絵の明暗から法線マップを作る。
 *
 * 明るいところを高く、暗いところを低いと見なして傾きを求める。端は反対側へ
 * 回り込ませるので、色と同じように継ぎ目なく繰り返せる。
 */
function normalFromCanvas(source: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const size = source.width;
  const src = source.getContext('2d')!.getImageData(0, 0, size, size).data;
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    height[i] = (0.299 * src[i * 4]! + 0.587 * src[i * 4 + 1]! + 0.114 * src[i * 4 + 2]!) / 255;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(size, size);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * size + x) * 4;
      out.data[k] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[k + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[k + 2] = (1 / len) * 0.5 * 255 + 127.5;
      out.data[k + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** 色テクスチャ（sRGB で読む） */
function colorTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** 実寸を指定して貼れる質感 */
export interface Surface {
  /**
   * 実寸 `tileU` × `tileV` [m] で 1 枚が繰り返すテクスチャ一式を作る。
   * @param clampV 縦方向を繰り返さない（断面の上下で模様を変えたいときに使う）
   */
  maps(
    tileU: number,
    tileV?: number,
    clampV?: boolean,
  ): { map: THREE.Texture; normalMap: THREE.Texture };
}

function surface(
  draw: (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void,
  seed: number,
  bump: number,
  size = SIZE,
): () => Surface {
  let cached: { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } | null = null;
  // 同じ実寸で貼るテクスチャは使い回す。複製は絵を共有するが GPU 側の
  // テクスチャは別になるので、貼るたびに作ると無駄に増える。
  const byTile = new Map<string, { map: THREE.Texture; normalMap: THREE.Texture }>();
  return () => {
    if (cached === null) {
      const canvas = paint(draw, seed, size);
      cached = { map: colorTexture(canvas), normalMap: normalFromCanvas(canvas, bump) };
    }
    const base = cached;
    return {
      maps(tileU: number, tileV = tileU, clampV = false) {
        const key = `${tileU}/${tileV}/${clampV}`;
        const hit = byTile.get(key);
        if (hit) return hit;
        const map = base.map.clone();
        const normalMap = base.normalMap.clone();
        for (const t of [map, normalMap]) {
          t.repeat.set(1 / tileU, 1 / tileV);
          if (clampV) t.wrapT = THREE.ClampToEdgeWrapping;
          t.needsUpdate = true;
        }
        map.colorSpace = THREE.SRGBColorSpace;
        const made = { map, normalMap };
        byTile.set(key, made);
        return made;
      },
    };
  };
}

/** 細かい斑点を散らす（コンクリートの骨材、砂利の粒） */
function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  count: number,
  radius: [number, number],
  lightness: [number, number],
  alpha = 0.5,
): void {
  for (let i = 0; i < count; i++) {
    const r = radius[0] + rand() * (radius[1] - radius[0]);
    const l = Math.round(lightness[0] + rand() * (lightness[1] - lightness[0]));
    ctx.fillStyle = `rgba(${l},${l},${l},${alpha})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * バラスト（道床の砕石）。
 *
 * 実物の道床は 20〜60mm に砕いた硬い石を敷き詰めたもので、粒の一つ一つが
 * 角ばっている。丸い砂利ではなく、割れた面と稜線を持つ多角形として描く。
 * 1 枚を 1.2m にすると、粒の大きさがちょうど実物の砕石と同じになる。
 */
export const ballastSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#4a4740';
    ctx.fillRect(0, 0, size, size);
    // 粗い粒を敷き詰める。奥に暗い粒、手前に明るい粒を重ねると隙間の陰が出る
    for (let layer = 0; layer < 2; layer++) {
      const count = layer === 0 ? 620 : 420;
      for (let i = 0; i < count; i++) {
        const r = (layer === 0 ? 9 : 6) + rand() * (layer === 0 ? 12 : 8);
        const shade = layer === 0 ? 58 + rand() * 34 : 92 + rand() * 58;
        const tint = rand() * 12;
        ctx.fillStyle = `rgb(${shade + tint},${shade + tint * 0.8},${shade})`;
        const sides = 5 + Math.floor(rand() * 3);
        const angle0 = rand() * Math.PI;
        seamless(ctx, size, rand() * size, rand() * size, (cx, cy) => {
          ctx.beginPath();
          for (let k = 0; k < sides; k++) {
            const a = angle0 + (Math.PI * 2 * k) / sides;
            const rr = r * (0.62 + rand() * 0.38);
            const px = cx + Math.cos(a) * rr;
            const py = cy + Math.sin(a) * rr;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        });
      }
    }
    // 粒のあいだに落ちた細かい石粉
    speckle(ctx, size, rand, 1800, [0.6, 2.0], [40, 130], 0.35);
  },
  0x8a11ce,
  3.2,
);

/**
 * コンクリート（構造物の一般面）。
 *
 * 型枠から抜いたばかりの面ではなく、雨と埃で少し汚れた面にする。骨材の
 * 斑点、型枠の板目、雨だれの筋を重ねると「新品でない構造物」の色になる。
 */
export const concreteSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#b3aea4';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 2600, [0.6, 2.6], [140, 205], 0.3);
    speckle(ctx, size, rand, 900, [1.0, 3.4], [110, 150], 0.25);
    // 汚れのむら
    for (let i = 0; i < 26; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 30 + rand() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const dark = rand() < 0.6;
      g.addColorStop(0, dark ? 'rgba(90,86,80,0.16)' : 'rgba(210,206,198,0.14)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
    // 型枠の継ぎ目（縦の細い線）
    ctx.strokeStyle = 'rgba(120,116,110,0.35)';
    ctx.lineWidth = 1.5;
    for (const x of [0, size / 2]) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, size);
      ctx.stroke();
    }
  },
  0x51ab21,
  1.6,
);

/**
 * トンネルの覆工。
 *
 * 断面の下から上へ 1 枚を貼るので、縦方向は繰り返さない（`clampV`）。
 * 側壁の下部は排水と車両の巻き上げで黒く汚れ、上へ行くほど明るくなり、
 * 天端はディーゼルの煤と埃でまた暗い、という実物の汚れ方をそのまま描く。
 * 横方向は 10.5m（覆工 1 スパン）ごとに打継目が入る。
 */
export const tunnelLiningSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#8e887e';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 3000, [0.6, 2.4], [120, 180], 0.28);

    // 断面方向（縦）の汚れ。0 = 側壁の下端、1 = 反対側の下端
    const grime = ctx.createLinearGradient(0, 0, 0, size);
    grime.addColorStop(0.0, 'rgba(28,26,24,0.72)');
    grime.addColorStop(0.12, 'rgba(52,48,44,0.42)');
    grime.addColorStop(0.3, 'rgba(90,86,80,0.1)');
    grime.addColorStop(0.5, 'rgba(40,37,34,0.34)');
    grime.addColorStop(0.7, 'rgba(90,86,80,0.1)');
    grime.addColorStop(0.88, 'rgba(52,48,44,0.42)');
    grime.addColorStop(1.0, 'rgba(28,26,24,0.72)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, 0, size, size);

    // 打継目（覆工 1 スパンの境目）。左右の端に入れて繰り返しでつながるようにする
    ctx.fillStyle = 'rgba(38,35,32,0.55)';
    ctx.fillRect(0, 0, 3, size);
    ctx.fillRect(size - 3, 0, 3, size);
    ctx.fillStyle = 'rgba(190,186,178,0.25)';
    ctx.fillRect(3, 0, 2, size);

    // 漏水の跡（上から下へ流れた白い筋）
    for (let i = 0; i < 14; i++) {
      const x = rand() * size;
      const w = 4 + rand() * 16;
      const from = rand() * size * 0.4;
      const g = ctx.createLinearGradient(0, from, 0, from + size * 0.5);
      g.addColorStop(0, 'rgba(226,222,214,0.0)');
      g.addColorStop(0.3, 'rgba(226,222,214,0.22)');
      g.addColorStop(1, 'rgba(226,222,214,0.0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, 0, (cx) => ctx.fillRect(cx, from, w, size * 0.5));
    }
  },
  0x77d3a1,
  1.4,
);

/**
 * PC まくらぎのコンクリート。
 *
 * 工場で作る高強度コンクリートなので構造物より白く滑らかだが、レール座の
 * 周りは締結装置の錆と油で茶色く汚れる。
 */
export const sleeperSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#a9a49b';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 2200, [0.5, 2.0], [130, 195], 0.3);
    for (let i = 0; i < 18; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 18 + rand() * 60;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(92,74,58,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
  },
  0x2c9f13,
  1.0,
);

/**
 * ホームの床。
 *
 * 300mm 角のプレキャスト平板を敷いた面。目地が縦横に走り、人の歩く帯だけ
 * すり減って色が抜ける。1 枚を 1.2m にすると平板 4 枚ぶんになる。
 */
export const platformDeckSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#b8b3a9';
    ctx.fillRect(0, 0, size, size);
    const cell = size / 4;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        // 平板 1 枚ごとに色をわずかに変える（張り替えた板が混じる）
        const l = 176 + rand() * 22;
        ctx.fillStyle = `rgb(${l},${l - 3},${l - 10})`;
        ctx.fillRect(i * cell + 1.5, j * cell + 1.5, cell - 3, cell - 3);
      }
    }
    speckle(ctx, size, rand, 2600, [0.5, 2.2], [150, 210], 0.28);
    // 目地
    ctx.strokeStyle = 'rgba(112,108,100,0.75)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, size);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(size, i * cell);
      ctx.stroke();
    }
    // 汚れ
    for (let i = 0; i < 20; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 20 + rand() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(96,92,86,0.14)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
  },
  0x9d31f4,
  2.0,
);

/**
 * 点字ブロック（点状突起・内方線付き）。
 *
 * ホーム縁端に敷くのは 300mm 角に 25 個の点が並ぶ「警告ブロック」で、
 * さらにホーム内側の縁に 1 本の線（内方線）が入る。線のある側が内側だと
 * 足で分かるようになっている。1 枚 = ブロック 1 枚（300mm）で貼る。
 */
export const tactileSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#d8ae2a';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 900, [0.8, 2.4], [190, 240], 0.2);
    // 目地
    ctx.strokeStyle = 'rgba(120,96,24,0.8)';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, size, size);
    // 点状突起 5 × 5
    const n = 5;
    const pitch = size / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cx = pitch * (i + 0.5);
        const cy = pitch * (j + 0.5);
        const r = pitch * 0.26;
        const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.1, cx, cy, r);
        g.addColorStop(0, '#fbe9a6');
        g.addColorStop(0.7, '#e8c34a');
        g.addColorStop(1, '#a8801a');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 内方線（ホーム内側を示す 1 本線）
    ctx.fillStyle = '#f0d98a';
    ctx.fillRect(0, size - pitch * 0.22, size, pitch * 0.16);
  },
  0x4477aa,
  2.6,
);

/**
 * 波形の屋根板（ホーム上屋・機器庫）。
 * 折板屋根の山と谷を縞で描き、法線マップで折りを出す。
 */
export const roofPanelSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#7c8288';
    ctx.fillRect(0, 0, size, size);
    const pitch = size / 8;
    for (let i = 0; i < 8; i++) {
      const g = ctx.createLinearGradient(i * pitch, 0, (i + 1) * pitch, 0);
      g.addColorStop(0, '#5f656b');
      g.addColorStop(0.45, '#8f959b');
      g.addColorStop(0.55, '#9aa0a6');
      g.addColorStop(1, '#5f656b');
      ctx.fillStyle = g;
      ctx.fillRect(i * pitch, 0, pitch, size);
    }
    speckle(ctx, size, rand, 700, [0.6, 2.0], [90, 150], 0.18);
  },
  0x1188ff,
  4.0,
);

/**
 * 建物の外壁。
 * 窓の列とベランダの帯を描く。遠景の建物はこの模様があるかどうかで
 * 「箱」に見えるか「建物」に見えるかが決まる。
 */
export const facadeSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#cdc7bb';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 1400, [0.8, 2.6], [180, 225], 0.25);
    const floors = 6;
    const cols = 5;
    const fh = size / floors;
    const cw = size / cols;
    for (let f = 0; f < floors; f++) {
      // 各階の床の帯
      ctx.fillStyle = 'rgba(150,145,136,0.55)';
      ctx.fillRect(0, f * fh + fh * 0.86, size, fh * 0.14);
      for (let c = 0; c < cols; c++) {
        const dark = 24 + rand() * 34;
        ctx.fillStyle = `rgb(${dark},${dark + 6},${dark + 12})`;
        ctx.fillRect(c * cw + cw * 0.22, f * fh + fh * 0.2, cw * 0.56, fh * 0.5);
        // 窓枠のハイライト
        ctx.strokeStyle = 'rgba(220,218,212,0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(c * cw + cw * 0.22, f * fh + fh * 0.2, cw * 0.56, fh * 0.5);
      }
    }
  },
  0x33cc77,
  1.2,
);

/**
 * 線路際の地面（草）。
 *
 * 地面は数百 m 四方に広がるので、1 枚のテクスチャを何十回も繰り返すことになる。
 * 大きな濃淡を描き込むと、その繰り返しが「同じ模様の格子」として一目で分かって
 * しまう。そこで低い周波数の模様はほとんど入れず、細かい草の粒だけで質感を作る。
 * 遠くの地面が単色に見えないのは、この粒がまばらに散っているからである。
 */
export const grassSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#61794a';
    ctx.fillRect(0, 0, size, size);
    // 草の粒。長さと色をばらつかせて、伸びた草と枯れた草を混ぜる
    for (let i = 0; i < 26000; i++) {
      const t = rand();
      const l = 62 + rand() * 58;
      const dry = t > 0.86;
      ctx.fillStyle = dry
        ? `rgba(${l * 1.15},${l * 1.02},${l * 0.62},0.4)`
        : `rgba(${l * 0.74},${l},${l * 0.5},0.42)`;
      ctx.fillRect(rand() * size, rand() * size, 1.3, 1.4 + rand() * 2.6);
    }
    // ごく弱い濃淡（繰り返しが見えない程度に）
    for (let i = 0; i < 40; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 40 + rand() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rand() < 0.5 ? 'rgba(86,104,64,0.09)' : 'rgba(112,128,84,0.09)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
  },
  0x5eed01,
  0.8,
);

/**
 * 錆びた鋼（レールの腹部・継目板・古い金物）。
 * 黒錆の地に赤錆の斑を散らし、縦の流れ錆を入れる。
 */
export const rustedSteelSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#59554f';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 240; i++) {
      const r = 3 + rand() * 22;
      const t = rand();
      ctx.fillStyle = `rgba(${110 + t * 60},${64 + t * 34},${34 + t * 20},${0.18 + rand() * 0.3})`;
      seamless(ctx, size, rand() * size, rand() * size, (cx, cy) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    speckle(ctx, size, rand, 1200, [0.6, 2.2], [60, 130], 0.3);
  },
  0xa1b2c3,
  1.8,
);

/** 板に文字を書いたテクスチャの共通設定 */
export interface PlateOptions {
  /** 板の地色 */
  readonly background?: string;
  /** 文字色 */
  readonly color?: string;
  /** 縁取りの色 */
  readonly border?: string;
  /** 板の縦横比（幅 / 高さ）。文字の縦横比を保つために使う */
  readonly aspect?: number;
}

const plateCache = new Map<string, THREE.CanvasTexture>();

/**
 * 文字を書いた標識板。
 *
 * 距離標の数字、勾配標の ‰、信号機の番号、停止位置目標の号車数など、
 * 実物の線路際にある標識はほとんどが「板に短い文字」である。文字が
 * 読めるかどうかで、模型らしさと実物らしさが分かれる。
 */
export function plateTexture(lines: readonly string[], options: PlateOptions = {}): THREE.Texture {
  const key = JSON.stringify([lines, options]);
  const cached = plateCache.get(key);
  if (cached) return cached;

  const aspect = options.aspect ?? 1;
  const h = 256;
  const w = Math.max(64, Math.round(h * aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = options.background ?? '#f2f4f6';
  ctx.fillRect(0, 0, w, h);
  if (options.border) {
    ctx.strokeStyle = options.border;
    ctx.lineWidth = h * 0.06;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }
  ctx.fillStyle = options.color ?? '#1a1d21';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = h / (lines.length + 0.4);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    // 板からはみ出さないところまで字を大きくする
    let font = lineHeight * 0.86;
    ctx.font = `bold ${font}px sans-serif`;
    const measured = ctx.measureText(text).width;
    if (measured > w * 0.84) {
      font *= (w * 0.84) / measured;
      ctx.font = `bold ${font}px sans-serif`;
    }
    ctx.fillText(text, w / 2, lineHeight * (i + 0.7));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  plateCache.set(key, texture);
  return texture;
}

/**
 * 駅名標。
 *
 * 白地に駅名、下に細い帯（ラインカラー）、両脇に前後の駅を小さく書く、という
 * 実物の吊り下げ式駅名標の割り付けにする。ホームで最初に目に入る文字なので、
 * 読めるだけで駅の印象が変わる。
 */
export function stationSignTexture(name: string): THREE.Texture {
  const key = `station:${name}`;
  const cached = plateCache.get(key);
  if (cached) return cached;

  const w = 1024;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, w, h);
  // ラインカラーの帯
  ctx.fillStyle = '#2f6fb5';
  ctx.fillRect(0, h - 34, w, 34);
  ctx.fillRect(0, 0, w, 10);

  ctx.fillStyle = '#15191d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = 118;
  ctx.font = `bold ${font}px sans-serif`;
  const measured = ctx.measureText(name).width;
  if (measured > w * 0.72) {
    font *= (w * 0.72) / measured;
    ctx.font = `bold ${font}px sans-serif`;
  }
  ctx.fillText(name, w / 2, h * 0.44);
  // 左右の矢印（前後の駅を示す位置）
  ctx.fillStyle = '#5a616a';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('◀', w * 0.06, h * 0.44);
  ctx.fillText('▶', w * 0.94, h * 0.44);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  plateCache.set(key, texture);
  return texture;
}

let glow: THREE.CanvasTexture | null = null;

/**
 * 光のにじみ。
 *
 * 加算合成の板に貼って、照明が壁や空気を照らしている様子を出す。中心が明るく
 * 縁で消える円で、四角い板の形が見えないよう端は完全な透明にする。
 */
export function glowTexture(): THREE.Texture {
  if (glow === null) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    glow = new THREE.CanvasTexture(canvas);
    glow.colorSpace = THREE.SRGBColorSpace;
  }
  return glow;
}

/**
 * 空と地面だけの環境マップ。
 *
 * 金属の映り込みの元になる。これが無いと、金属質の材質は「映すものが無い」
 * ために真っ黒になってしまう。レールの頭頂面・ステンレスの車体・架線金具が
 * 光って見えるのはこの環境マップのおかげである。
 */
export function createEnvironment(look: WeatherLook, renderer: THREE.WebGLRenderer): THREE.Texture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const hex = (v: number): string => `#${v.toString(16).padStart(6, '0')}`;
  // 空の色は `weather.ts` の同じ値から引く。ここだけ晴天の青のままにすると、
  // 雨の日にレールと車体が青空を映すという嘘になる。
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0.0, hex(look.sky.top));
  sky.addColorStop(0.42, hex(look.sky.horizon));
  sky.addColorStop(0.5, hex(look.fog.color));
  sky.addColorStop(0.52, hex(look.sky.ground));
  sky.addColorStop(1.0, hex(look.ambient.ground));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // 太陽（`createDaylight()` の平行光と同じ方角に置く）。曇天では雲が散らすので
  // 円ではなく、空全体がぼんやり明るいだけになる。
  if (look.sun.shadow) {
    const g = ctx.createRadialGradient(w * 0.72, h * 0.22, 0, w * 0.72, h * 0.22, h * 0.3);
    g.addColorStop(0, 'rgba(255,252,235,1)');
    g.addColorStop(1, 'rgba(255,252,235,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  const equirect = new THREE.CanvasTexture(canvas);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(equirect);
  pmrem.dispose();
  equirect.dispose();
  return target.texture;
}

/**
 * 木造住宅の外壁（窯業系サイディング）。
 *
 * 日本の沿線でいちばん多く目に入る面である。455mm 幅の板を横に張った目地と、
 * 引違いの掃き出し窓・小窓を描く。1 枚を 3.6m（≒ 1 階ぶん）で貼ると、
 * 窓の大きさが実物とおよそ合う。
 */
export const sidingSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#ddd6c8';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 1600, [0.6, 2.2], [200, 240], 0.22);
    // 横の目地（サイディング 1 枚 455mm ≒ 1/8 タイル）
    ctx.fillStyle = 'rgba(160,152,140,0.42)';
    for (let i = 1; i < 8; i++) ctx.fillRect(0, (size * i) / 8, size, 2);
    // 掃き出し窓（下段）と小窓（上段）。サッシは銀、ガラスは空を映して暗い
    const window = (x: number, y: number, w: number, h: number): void => {
      ctx.fillStyle = '#2b333a';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#b9bec3';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      // 引違いの召し合わせ（中央の縦框）
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w / 2, y + h);
      ctx.stroke();
    };
    window(size * 0.1, size * 0.56, size * 0.34, size * 0.3);
    window(size * 0.58, size * 0.6, size * 0.22, size * 0.26);
    window(size * 0.12, size * 0.14, size * 0.24, size * 0.2);
    window(size * 0.62, size * 0.14, size * 0.18, size * 0.2);
    // 雨だれ（窓の下に伸びる黒い筋）。新築でない家の顔になる
    for (let i = 0; i < 10; i++) {
      const x = rand() * size;
      const g = ctx.createLinearGradient(0, size * 0.3, 0, size);
      g.addColorStop(0, 'rgba(90,84,74,0.0)');
      g.addColorStop(0.4, 'rgba(90,84,74,0.16)');
      g.addColorStop(1, 'rgba(90,84,74,0.0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, 0, (cx) => ctx.fillRect(cx, size * 0.3, 3 + rand() * 5, size * 0.7));
    }
  },
  0x71b3d2,
  1.2,
);

/**
 * 集合住宅（団地・アパート）の外壁。
 *
 * 各戸のベランダが横一列に並ぶのが、日本の集合住宅の外観を決めている。
 * 手すりの壁（腰壁）と、そこへ落ちる影、干した洗濯物の色を入れる。
 * 1 枚を「3 戸 × 2 階」＝ 幅 16.5m・高さ 5.6m で貼る。
 */
export const apartmentSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#c8c3b6';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 1200, [0.6, 2.4], [190, 230], 0.22);
    const floors = 2;
    const units = 3;
    const fh = size / floors;
    const uw = size / units;
    for (let f = 0; f < floors; f++) {
      const y = f * fh;
      // 住戸の開口（サッシ 2 枚ぶん）
      for (let u = 0; u < units; u++) {
        const x = u * uw;
        ctx.fillStyle = '#333c44';
        ctx.fillRect(x + uw * 0.1, y + fh * 0.16, uw * 0.5, fh * 0.42);
        ctx.fillStyle = '#3d464d';
        ctx.fillRect(x + uw * 0.68, y + fh * 0.2, uw * 0.2, fh * 0.34);
        // 洗濯物（ベランダの内側に色の点が並ぶ）
        if (rand() < 0.55) {
          for (let k = 0; k < 3; k++) {
            const hue = Math.floor(rand() * 360);
            ctx.fillStyle = `hsla(${hue},45%,72%,0.9)`;
            ctx.fillRect(x + uw * (0.14 + k * 0.13), y + fh * 0.5, uw * 0.08, fh * 0.12);
          }
        }
      }
      // ベランダの腰壁と、その下にできる影
      ctx.fillStyle = 'rgba(60,56,50,0.35)';
      ctx.fillRect(0, y + fh * 0.62, size, fh * 0.05);
      ctx.fillStyle = '#d2cdc0';
      ctx.fillRect(0, y + fh * 0.66, size, fh * 0.24);
      ctx.fillStyle = 'rgba(150,144,134,0.5)';
      ctx.fillRect(0, y + fh * 0.9, size, fh * 0.04);
    }
    // 住戸の境の隔て板
    ctx.fillStyle = 'rgba(170,164,152,0.8)';
    for (let u = 0; u <= units; u++) ctx.fillRect(u * uw - 2, 0, 4, size);
  },
  0x3af019,
  1.0,
);

/**
 * 波板の外壁（工場・倉庫・作業場）。
 *
 * 角波の金属板を縦に張った面。工場地帯の建物はほとんどこれで、
 * 縦の縞と、下端から上がってくる錆がその見た目を作っている。
 */
export const corrugatedSurface = surface(
  (ctx, size, rand) => {
    const pitch = size / 16;
    for (let i = 0; i < 16; i++) {
      const g = ctx.createLinearGradient(i * pitch, 0, (i + 1) * pitch, 0);
      g.addColorStop(0, '#8b8f8c');
      g.addColorStop(0.4, '#c2c6c2');
      g.addColorStop(0.6, '#c8ccc8');
      g.addColorStop(1, '#8b8f8c');
      ctx.fillStyle = g;
      ctx.fillRect(i * pitch, 0, pitch, size);
    }
    // 下端から立ち上がる錆と、雨だれの筋
    const rust = ctx.createLinearGradient(0, size, 0, size * 0.55);
    rust.addColorStop(0, 'rgba(118,74,44,0.5)');
    rust.addColorStop(1, 'rgba(118,74,44,0)');
    ctx.fillStyle = rust;
    ctx.fillRect(0, size * 0.55, size, size * 0.45);
    for (let i = 0; i < 26; i++) {
      const x = rand() * size;
      const from = rand() * size * 0.6;
      ctx.fillStyle = `rgba(${90 + rand() * 50},${70 + rand() * 30},${52},0.16)`;
      seamless(ctx, size, x, 0, (cx) => ctx.fillRect(cx, from, 2 + rand() * 4, size - from));
    }
    speckle(ctx, size, rand, 600, [0.6, 2.0], [120, 190], 0.16);
  },
  0x6b21ac,
  3.0,
);

/**
 * 屋根（化粧スレート・瓦棒）。
 *
 * 日本の住宅の屋根はスレート葺きが多く、303mm × 910mm の板を千鳥に葺く。
 * 板の切れ目と、北面に出る苔の緑を入れる。1 枚を 1.8m で貼る。
 */
export const roofTileSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#4e5560';
    ctx.fillRect(0, 0, size, size);
    const rows = 6;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      const cols = 6;
      const cw = size / cols;
      const shift = (r % 2) * cw * 0.5;
      for (let c = -1; c < cols; c++) {
        const l = 62 + rand() * 26;
        ctx.fillStyle = `rgb(${l},${l + 4},${l + 10})`;
        ctx.fillRect(c * cw + shift + 1, r * rh + 1, cw - 2, rh - 2);
      }
      // 段の切れ目に落ちる影
      ctx.fillStyle = 'rgba(20,22,26,0.5)';
      ctx.fillRect(0, r * rh, size, 2.5);
    }
    // 苔と退色
    for (let i = 0; i < 22; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 12 + rand() * 44;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rand() < 0.5 ? 'rgba(96,112,74,0.2)' : 'rgba(150,155,160,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
  },
  0x18e2a7,
  1.8,
);

/**
 * 舗装（道路）。
 * 骨材の粒とわだち、ひび割れと補修跡。1 枚を 4m で貼る。
 */
export const asphaltSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#4a4b4e';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, rand, 5200, [0.7, 2.4], [58, 122], 0.4);
    speckle(ctx, size, rand, 1400, [0.5, 1.4], [130, 170], 0.2);
    // 補修跡（黒く塗った帯）
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = 'rgba(30,30,32,0.5)';
      ctx.lineWidth = 3 + rand() * 7;
      ctx.beginPath();
      let x = rand() * size;
      let y = rand() * size;
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (rand() - 0.5) * size * 0.5;
        y += (rand() - 0.5) * size * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
  0x2f6a91,
  1.4,
);

/**
 * 水田。
 *
 * 田植えのあとの水田は、水面に苗の列が並ぶ。列の間隔 300mm・株間 150mm で、
 * 遠くから見ると水色の地に緑の縞が走る。1 枚を 4.8m（16 列）で貼る。
 */
export const paddySurface = surface(
  (ctx, size, rand) => {
    // 水面。泥を透かすので青ではなく灰緑
    ctx.fillStyle = '#5d6a5c';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 20 + rand() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(126,140,128,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, y, (cx, cy) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2));
    }
    // 苗の列
    const rows = 16;
    const pitch = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < 32; k++) {
        const y = (size * (k + 0.5)) / 32 + (rand() - 0.5) * 3;
        const l = 92 + rand() * 46;
        ctx.fillStyle = `rgb(${l * 0.55},${l},${l * 0.5})`;
        ctx.beginPath();
        ctx.ellipse(pitch * (r + 0.5), y, pitch * 0.2, pitch * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
  0x9c3f28,
  1.0,
);

/**
 * 立入禁止のネットフェンス（線路の境界）。
 *
 * 日本の鉄道は用地の境界に必ず柵を持つ。金網は面ではなく**線の網**なので、
 * 板に貼って抜きの型（`alphaMap`）として使う。網目は 50mm 角、線径 3.2mm。
 * 遠くでは網が潰れて半透明の膜に見えるのが実物どおりで、そのために
 * ミップマップを効かせる（`alphaTest` ではなく `transparent` で使う）。
 */
export function fenceAlphaTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  // 菱形金網。斜めに張った線が交差する
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size / 70;
  for (let i = -size; i < size * 2; i += size / 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.moveTo(i + size, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/**
 * 樹冠の葉。
 *
 * 樹木を単色の塊にすると、どれだけ輪郭を凝っても「緑の岩」にしか見えない。
 * 実際の樹冠が樹冠に見えるのは、**葉の一枚一枚ではなく、葉の塊が作る
 * 明暗のむら**があるからである。日の当たる上面は黄緑に飛び、内側は
 * ほとんど黒に近い。その明暗を塊の大きさ（30cm 前後）で描き込む。
 */
export const foliageSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#26301c';
    ctx.fillRect(0, 0, size, size);
    // 葉の塊。暗いものから明るいものへ重ねると、内側の陰が残る
    for (let layer = 0; layer < 3; layer++) {
      const count = [260, 420, 380][layer]!;
      const radius = [26, 17, 11][layer]!;
      for (let i = 0; i < count; i++) {
        const l = 40 + layer * 32 + rand() * 46;
        ctx.fillStyle = `rgb(${Math.round(l * 0.72)},${Math.round(l)},${Math.round(l * 0.44)})`;
        const r = radius * (0.5 + rand() * 0.7);
        const x = rand() * size;
        const y = rand() * size;
        seamless(ctx, size, x, y, (cx, cy) => {
          ctx.beginPath();
          // 葉の塊は円ではなく、上へ膨らんだ楕円が重なった形になる
          ctx.ellipse(cx, cy, r, r * (0.6 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
    // 隙間から抜ける空（樹冠は密ではない）
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = 'rgba(150,168,178,0.22)';
      const r = 1.5 + rand() * 4;
      const x = rand() * size;
      const y = rand() * size;
      seamless(ctx, size, x, y, (cx, cy) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  },
  0x2ba8f1,
  2.4,
);

/**
 * 遮断桿（しゃだんかん）の縞。
 *
 * 実物の遮断桿は、夜間や霧の中でも見えるよう、黄と黒（または赤白）の
 * 斜めの縞に塗ってある。縞の幅は 300mm 前後で、竿の全長 4〜5m に
 * 十数本入る。1 枚を 0.6m で貼ると実物と同じ間隔になる。
 */
export function barrierStripeTexture(): THREE.Texture {
  const w = 128;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f0c419';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1e1e1e';
  // 斜めの縞。竿は水平に伸びるので、縞は進行方向に対して斜めになる
  for (let i = -1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo((i * w) / 2, 0);
    ctx.lineTo((i * w) / 2 + w / 4, 0);
    ctx.lineTo((i * w) / 2 + w / 4 + h, h);
    ctx.lineTo((i * w) / 2 + h, h);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/**
 * 踏切警標（ふみきりけいひょう）。
 *
 * 道路から踏切を見たときに、警報機の上に掲げてある黄色の×印である。
 * 道路標識令の「踏切あり」ではなく、鉄道側が建てる標識で、
 * 交差を意味する×の形そのものが遠くからでも踏切だと分かるようになっている。
 */
export function crossingMarkTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#f2c21c';
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = size * 0.035;
  const arm = size * 0.17;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  ctx.rect(-size * 0.46, -arm / 2, size * 0.92, arm);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(Math.PI / 2);
  ctx.beginPath();
  ctx.rect(-size * 0.46, -arm / 2, size * 0.92, arm);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * ステンレスの外板（車体）。
 *
 * 帯鋼を圧延したままの面なので、**横方向にごく細かい目**が走る。塗装した鋼板と
 * 違って光の反射に方向があり、同じ銀色でも見る角度で明るさが変わる。
 *
 * さらに、走っている車両の側面には必ず**雨だれの筋**が縦に入る。屋根に載った
 * 埃が雨で流れ落ちた跡で、窓の下と扉の戸袋のあたりから始まって裾へ向かう。
 * 新製時の写真と実際に走っている車両の見え方がいちばん違うのがここで、
 * これを入れないと「模型」から抜けられない。
 *
 * 1 枚を 2.4m（＝側窓 1 つぶんくらい）で貼る。
 */
export const stainlessSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#d0d4d8';
    ctx.fillRect(0, 0, size, size);
    // 圧延の目（横に流れる細い縞）
    for (let i = 0; i < 2600; i++) {
      const l = 196 + rand() * 52;
      ctx.fillStyle = `rgba(${l},${l + 2},${l + 4},0.28)`;
      const y = rand() * size;
      ctx.fillRect(0, y, size, 0.7 + rand() * 0.8);
    }
    // 雨だれ（上から下へ、細く暗い筋）
    for (let i = 0; i < 40; i++) {
      const x = rand() * size;
      const w = 1 + rand() * 3.5;
      const from = rand() * size * 0.35;
      const g = ctx.createLinearGradient(0, from, 0, size);
      g.addColorStop(0, 'rgba(120,120,116,0)');
      g.addColorStop(0.25, `rgba(120,120,116,${0.1 + rand() * 0.14})`);
      g.addColorStop(1, 'rgba(120,120,116,0.03)');
      ctx.fillStyle = g;
      seamless(ctx, size, x, 0, (cx) => ctx.fillRect(cx, from, w, size - from));
    }
    // 裾に溜まる床下からの埃
    const dust = ctx.createLinearGradient(0, size, 0, size * 0.72);
    dust.addColorStop(0, 'rgba(112,106,96,0.34)');
    dust.addColorStop(1, 'rgba(112,106,96,0)');
    ctx.fillStyle = dust;
    ctx.fillRect(0, size * 0.72, size, size * 0.28);
  },
  0x1d77c4,
  0.5,
);

/**
 * 水面のさざ波。
 *
 * 川の水面が水色の板に見えてしまうのは、**表面の傾きが一様**だからである。
 * 実際の水面は風で細かく波立っていて、その傾きの分布が空のどこを映すかを
 * 決めている。色ではなく法線（傾き）だけを与えれば、映り込みが割れて
 * 水らしくなる。波長は 0.4m ほど（河川の風波）。
 */
export const rippleSurface = surface(
  (ctx, size, rand) => {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    // 風向きに揃った細長い波を重ねる
    for (let layer = 0; layer < 3; layer++) {
      const count = [90, 160, 240][layer]!;
      const long = [90, 52, 26][layer]!;
      const short = [7, 5, 3][layer]!;
      for (let i = 0; i < count; i++) {
        const l = 128 + (rand() - 0.5) * [90, 66, 44][layer]!;
        ctx.fillStyle = `rgba(${l},${l},${l},0.5)`;
        const x = rand() * size;
        const y = rand() * size;
        seamless(ctx, size, x, y, (cx, cy) => {
          ctx.beginPath();
          ctx.ellipse(cx, cy, long * (0.5 + rand()), short, 0.22, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  },
  0x71ac33,
  1.6,
);
