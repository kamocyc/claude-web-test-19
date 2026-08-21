import * as THREE from 'three';

/**
 * 客室の内装に貼る模様。
 *
 * 車内は**平らな面が近くにある**という点で外観と決定的に違う。座席のモケット、
 * 床の長尺シート、扉の化粧板は、どれも 1m 以内で見ることになるので、単色で塗ると
 * 「板でできた箱」にしか見えない。逆に言えば、模様さえ入れば形は簡素でも車内に見える。
 *
 * 画像ファイルは持たず、すべてキャンバスに描いて `CanvasTexture` にする
 * （`textures.ts` と同じ方針）。乱数は seed 付きのものだけを使う — 走行のたびに
 * 車内の柄が変わっては困るし、決定論を壊さないという約束にも合う。
 */

/** mulberry32。`textures.ts` と同じで、seed が同じなら必ず同じ模様になる。 */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return [element, element.getContext('2d')!];
}

function toTexture(element: HTMLCanvasElement, repeat?: [number, number]): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // 内装の面はどれも実寸で UV を振るので、繰り返しは常に許す
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (repeat) texture.repeat.set(repeat[0], repeat[1]);
  return texture;
}

/** キャッシュ。同じ柄を何度も描き直さない（1 両ぶんで 20 枚以上貼ることになる） */
const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  cache.set(key, made);
  return made;
}

/**
 * モケット（座席の張り地）。
 *
 * モケットは細かいパイルを立てた織物なので、近くで見ると**縦横の織り目**と
 * 色の粒が見える。ここでは織り目を 2 方向の細い線で、色の粒を画素ごとの
 * わずかな明暗で作る。優先席は色を変えるだけで柄は同じ（実物も同じ織りで
 * 色番だけ違うことが多い）。
 */
export function moquetteTexture(base: number, fleck: number, seed: number): THREE.Texture {
  return cached(`moquette-${base}-${fleck}-${seed}`, () => {
    const size = 256;
    const [element, ctx] = canvas(size, size);
    const color = new THREE.Color(base);
    const accent = new THREE.Color(fleck);
    const random = rng(seed);
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        // 織り目: 4 画素周期の縦横の畝
        const weave = (x % 4 < 2 ? 1 : -1) * (y % 4 < 2 ? 1 : -1) * 0.045;
        // パイルの粒。細かい明暗が「毛羽立った布」に見せる
        const grain = (random() - 0.5) * 0.22;
        const mix = random() < 0.06 ? accent : color;
        const k = 1 + weave + grain;
        image.data[i] = Math.min(255, mix.r * 255 * k);
        image.data[i + 1] = Math.min(255, mix.g * 255 * k);
        image.data[i + 2] = Math.min(255, mix.b * 255 * k);
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    // 座面 1 枚に 3 回ほど繰り返す大きさ。近づいても織り目が見える。
    return toTexture(element, [3, 3]);
  });
}

/**
 * 床の長尺シート（塩化ビニル）。
 *
 * 通勤形の床は 1 枚もののシートで、細かいまだら模様が入っている。単色にすると
 * 歩いたときに床が動いて見えないので、模様は歩く速さを目で測る手がかりでもある。
 */
export function floorSheetTexture(base: number, seed: number): THREE.Texture {
  return cached(`floor-${base}-${seed}`, () => {
    const size = 256;
    const [element, ctx] = canvas(size, size);
    const color = new THREE.Color(base);
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillRect(0, 0, size, size);
    const random = rng(seed);
    // まだら（大小 2 段階の斑点を重ねる）
    for (let i = 0; i < 2600; i++) {
      const k = 0.82 + random() * 0.36;
      const c = color.clone().multiplyScalar(k);
      ctx.fillStyle = `#${c.getHexString()}`;
      const r = random() < 0.85 ? 1 + random() * 1.6 : 2 + random() * 3;
      ctx.beginPath();
      ctx.arc(random() * size, random() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 床は面ごとに実寸で UV を振る（`interior.ts` の `scaleUv`）ので繰り返しは 1
    return toTexture(element);
  });
}

/**
 * 化粧板（内張り）。
 *
 * 側壁・妻面・扉の内側に貼る樹脂の化粧板。ごく薄い縦の木目風の柄で、
 * 面が広いわりに主張しない。
 */
export function panelTexture(base: number, seed: number): THREE.Texture {
  return cached(`panel-${base}-${seed}`, () => {
    const size = 256;
    const [element, ctx] = canvas(size, size);
    const color = new THREE.Color(base);
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillRect(0, 0, size, size);
    const random = rng(seed);
    for (let i = 0; i < 220; i++) {
      const c = color.clone().multiplyScalar(0.93 + random() * 0.14);
      ctx.strokeStyle = `#${c.getHexString()}`;
      ctx.lineWidth = 0.5 + random() * 2.5;
      const x = random() * size;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 6, size / 3, x - 6, (size * 2) / 3, x, size);
      ctx.stroke();
    }
    return toTexture(element, [2, 2]);
  });
}

/**
 * 荷棚（網棚）の網目。
 *
 * 実物はステンレスのパイプを格子に組んだもので、**下から見ると向こうが透ける**。
 * 板で作ると天井が低く見えてしまうので、透過つきのテクスチャで抜く。
 */
export function rackMeshTexture(): THREE.Texture {
  return cached('rack-mesh', () => {
    const size = 128;
    const [element, ctx] = canvas(size, size);
    ctx.clearRect(0, 0, size, size);
    // 線を細くすると下から見上げたときに消えてしまい、荷棚が「白い細線」に
    // 見える。実物のパイプは φ8mm 前後あって、間隔（約 60mm）に対して
    // 十分に太い。その比をそのまま画に写す。
    ctx.lineCap = 'square';
    for (let i = 0; i <= 4; i++) {
      const p = (i * size) / 4;
      // 影側を先に描いてから明るい面を重ねると、平らな線が丸いパイプに見える
      ctx.strokeStyle = '#6f757c';
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
      ctx.strokeStyle = '#d2d7dd';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(p - 1.5, 0);
      ctx.lineTo(p - 1.5, size);
      ctx.moveTo(0, p - 1.5);
      ctx.lineTo(size, p - 1.5);
      ctx.stroke();
    }
    const texture = toTexture(element, [10, 2]);
    return texture;
  });
}

/**
 * 車内案内表示器（扉上の LCD）。
 *
 * 実物と同じく黒地に色文字で、次の停車駅・種別・行先を出す。**書き換えるので
 * キャッシュしない** — 駅が近づくたびに描き直して `needsUpdate` を立てる。
 */
export interface CarDisplay {
  readonly texture: THREE.CanvasTexture;
  /** 次の駅・種別・行先を書き換える */
  update(next: string, kind: string, destination: string, arriving: boolean): void;
}

export function createCarDisplay(): CarDisplay {
  const width = 512;
  const height = 128;
  const [element, ctx] = canvas(width, height);
  const texture = toTexture(element);
  let last = '';

  const update = (next: string, kind: string, destination: string, arriving: boolean): void => {
    const key = `${next}|${kind}|${destination}|${arriving}`;
    if (key === last) return;
    last = key;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, width, height);
    // 左の種別・行先（実物と同じく種別の色で塗り分ける）
    ctx.fillStyle = '#1a3f70';
    ctx.fillRect(0, 0, 150, height);
    ctx.fillStyle = '#e8f0ff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind, 75, 38);
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(destination, 75, 92);
    // 右の案内。到着直前は「まもなく」に変わる
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd24a';
    ctx.font = '30px sans-serif';
    ctx.fillText(arriving ? 'まもなく' : 'つぎは', 172, 34);
    ctx.fillStyle = '#f4f8ff';
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText(next, 172, 88);
    texture.needsUpdate = true;
  };

  update('', '', '', false);
  return { texture, update };
}

/**
 * 中吊り・まど上の広告。
 *
 * **実在の企業名や商標は使わない。** 架空の題字と帯だけで「広告らしさ」を作る。
 * 実物の中吊りも、離れて見えているのは色面と大きな文字の配置だけである。
 */
const AD_COPY: ReadonlyArray<{
  readonly title: string;
  readonly lead: string;
  readonly tint: number;
}> = [
  { title: '海へ', lead: '夏の臨時列車 運転', tint: 0x1f6fb2 },
  { title: '山あいの温泉', lead: '週末は各駅停車で', tint: 0xb2521f },
  { title: '新生活応援', lead: '定期券は駅の窓口で', tint: 0x2f8f5b },
  { title: '安全のために', lead: 'ホームでは黄色い線の内側へ', tint: 0x8a6d1f },
  { title: '沿線美術館', lead: '春季展 開催中', tint: 0x6a3f9c },
  { title: 'まちの図書館', lead: '駅から歩いて 3 分', tint: 0x1f7f8f },
];

export function adTexture(index: number, poster: boolean): THREE.Texture {
  return cached(`ad-${index}-${poster}`, () => {
    const copy = AD_COPY[index % AD_COPY.length]!;
    // 中吊りは縦長のポスター、まど上は横長の額。判の違いがそのまま比率になる
    const w = poster ? 384 : 512;
    const h = poster ? 512 : 160;
    const [element, ctx] = canvas(w, h);
    const tint = new THREE.Color(copy.tint);
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `#${tint.getHexString()}`;
    if (poster) {
      ctx.fillRect(0, 0, w, h * 0.45);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(w * 0.19)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(copy.title, w / 2, h * 0.24);
      ctx.fillStyle = '#22262c';
      ctx.font = `${Math.round(w * 0.075)}px sans-serif`;
      ctx.fillText(copy.lead, w / 2, h * 0.58);
      // 本文に見立てた罫。読ませるためではなく、面を埋めるためにある
      ctx.fillStyle = '#9aa0a8';
      for (let i = 0; i < 6; i++) ctx.fillRect(w * 0.12, h * (0.68 + i * 0.045), w * 0.76, 4);
    } else {
      ctx.fillRect(0, 0, w * 0.34, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(h * 0.34)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(copy.title, w * 0.17, h / 2);
      ctx.fillStyle = '#22262c';
      ctx.font = `${Math.round(h * 0.2)}px sans-serif`;
      ctx.fillText(copy.lead, w * 0.67, h * 0.42);
      ctx.fillStyle = '#9aa0a8';
      ctx.fillRect(w * 0.4, h * 0.66, w * 0.54, 5);
    }
    return toTexture(element);
  });
}

/**
 * 扉上・戸袋のステッカー。
 *
 * 実物の扉には「指はさみ注意」の絵が必ず貼ってある。文字ではなく絵で伝えるもの
 * なので、ここも簡単な図記号で描く。
 */
export function doorStickerTexture(): THREE.Texture {
  return cached('door-sticker', () => {
    const [element, ctx] = canvas(256, 256);
    ctx.fillStyle = '#f5d024';
    ctx.beginPath();
    ctx.moveTo(128, 16);
    ctx.lineTo(244, 224);
    ctx.lineTo(12, 224);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#1a1c20';
    ctx.lineWidth = 10;
    ctx.stroke();
    // 戸に挟まれる手を表す図記号
    ctx.fillStyle = '#1a1c20';
    ctx.fillRect(60, 120, 26, 76);
    ctx.fillRect(170, 120, 26, 76);
    ctx.beginPath();
    ctx.ellipse(128, 150, 30, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    return toTexture(element);
  });
}

/**
 * 優先席の表示。
 *
 * 席の頭上の窓や壁に貼る、席を譲る対象を絵で示したもの。
 */
export function priorityStickerTexture(): THREE.Texture {
  return cached('priority-sticker', () => {
    const [element, ctx] = canvas(512, 192);
    ctx.fillStyle = '#153a6b';
    ctx.fillRect(0, 0, 512, 192);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 62px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('優先席', 20, 96);
    // 4 種類の対象を並べた図記号（人の形を丸と台形で）
    for (let i = 0; i < 4; i++) {
      const x = 240 + i * 66;
      ctx.beginPath();
      ctx.arc(x, 62, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 24, 148);
      ctx.lineTo(x - 13, 86);
      ctx.lineTo(x + 13, 86);
      ctx.lineTo(x + 24, 148);
      ctx.closePath();
      ctx.fill();
    }
    return toTexture(element);
  });
}

/** 消火器・非常通報器などの標記板 */
export function noticeTexture(title: string, body: string, tint: number): THREE.Texture {
  return cached(`notice-${title}-${body}-${tint}`, () => {
    const [element, ctx] = canvas(256, 128);
    ctx.fillStyle = '#f2f3f5';
    ctx.fillRect(0, 0, 256, 128);
    const color = new THREE.Color(tint);
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fillRect(0, 0, 256, 44);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 128, 23);
    ctx.fillStyle = '#22262c';
    ctx.font = '22px sans-serif';
    ctx.fillText(body, 128, 84);
    return toTexture(element);
  });
}
