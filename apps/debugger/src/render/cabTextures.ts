import * as THREE from 'three';

/**
 * 運転台に貼る文字と画面。
 *
 * 運転台が運転台に見えるかどうかは、形よりも**文字が入っているか**で決まる。
 * 実物の運転台は、計器の文字板・スイッチの銘板・表示器のランプ名・時刻表・
 * モニタ装置の画面と、目に入るもののほとんどに文字が書いてある。逆に言えば、
 * 文字の無い運転台は「箱と円盤」にしか見えない。
 *
 * 画像ファイルは持たず、すべてキャンバスに描く（`textures.ts` と同じ方針）。
 */

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return [element, element.getContext('2d')!];
}

function toTexture(element: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  cache.set(key, made);
  return made;
}

/** 丸形計器の指針の振れ角の全範囲（一般的な計器と同じく約 270 度） */
export const DIAL_SWEEP = (270 * Math.PI) / 180;

/**
 * 丸形計器の文字板。
 *
 * 目盛りだけでは「いま何 km/h か」が読めない。実物と同じく主目盛りに数字を
 * 書き、単位を入れ、危険域を赤で示す。速度計には最高速度の手前から赤い帯が
 * 入っていて、**運転士は数字ではなく帯の位置で速度超過を見る**。
 */
export function dialTexture(
  max: number,
  step: number,
  unit: string,
  options: {
    /** 赤い危険域の始まり */
    readonly redlineFrom?: number;
    /** 文字板の下に入れる小さな標記（計器の名前） */
    readonly caption?: string;
    /** 中央が 0 の計器（電流計。左右に振れる） */
    readonly centreZero?: boolean;
  } = {},
): THREE.Texture {
  const key = `dial-${max}-${step}-${unit}-${options.redlineFrom ?? ''}-${options.caption ?? ''}-${options.centreZero ?? false}`;
  return cached(key, () => {
    const size = 512;
    const [element, ctx] = canvas(size, size);
    const c = size / 2;
    const r = size * 0.46;

    ctx.fillStyle = '#e6eaee';
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
    // 文字板の縁の陰（ベゼルの内側の落ち込み）
    ctx.strokeStyle = '#c3c8cd';
    ctx.lineWidth = size * 0.018;
    ctx.beginPath();
    ctx.arc(c, c, r - size * 0.01, 0, Math.PI * 2);
    ctx.stroke();

    /** 値 → 文字板上の角（真上を 0 として時計回り） */
    const angleOf = (value: number): number => -DIAL_SWEEP / 2 + DIAL_SWEEP * (value / max);

    if (options.redlineFrom !== undefined) {
      ctx.strokeStyle = '#cf2f26';
      ctx.lineWidth = size * 0.034;
      ctx.beginPath();
      ctx.arc(
        c,
        c,
        r * 0.83,
        angleOf(options.redlineFrom) - Math.PI / 2,
        angleOf(max) - Math.PI / 2,
      );
      ctx.stroke();
    }

    ctx.strokeStyle = '#1b2128';
    ctx.fillStyle = '#1b2128';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const minor = step / 5;
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const a = angleOf(v) - Math.PI / 2;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const inner = r * (major ? 0.7 : 0.8);
      ctx.lineWidth = size * (major ? 0.013 : 0.005);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
      ctx.lineTo(c + Math.cos(a) * r * 0.9, c + Math.sin(a) * r * 0.9);
      ctx.stroke();
      if (major) {
        ctx.font = `bold ${Math.round(size * 0.098)}px sans-serif`;
        const label = options.centreZero ? Math.round(Math.abs(v - max / 2)) : Math.round(v);
        ctx.fillText(String(label), c + Math.cos(a) * r * 0.56, c + Math.sin(a) * r * 0.56);
      }
    }

    ctx.font = `${Math.round(size * 0.07)}px sans-serif`;
    ctx.fillStyle = '#525960';
    ctx.fillText(unit, c, c + r * 0.4);
    if (options.caption) {
      ctx.font = `${Math.round(size * 0.062)}px sans-serif`;
      ctx.fillText(options.caption, c, c - r * 0.42);
    }
    return toTexture(element);
  });
}

/**
 * 運転台の面（梨地の樹脂）。
 *
 * 机も計器盤もこの地でできていて、近くで見ると細かい粒が並んでいる。
 * 白（0xffffff）を基準に描いておき、色は材質側の `color` で掛ける。
 */
export function cabPanelTexture(): THREE.Texture {
  return cached('cab-panel', () => {
    const size = 256;
    const [element, ctx] = canvas(size, size);
    const image = ctx.createImageData(size, size);
    let seed = 0x9e3779b9;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 235 + random() * 40;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const texture = toTexture(element);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 8);
    return texture;
  });
}

/**
 * スイッチの銘板。
 *
 * 実物の運転台のスイッチには、必ず何のスイッチかを書いた小さな板が付いている。
 * 運転士はスイッチの形ではなく**この文字**で探す。
 */
export function labelTexture(text: string, tint = '#dbe1e7'): THREE.Texture {
  return cached(`label-${text}-${tint}`, () => {
    const [element, ctx] = canvas(256, 64);
    // 暗い運転室で読ませる銘板なので、地は黒く文字を明るくする（実物の
    // 彫り込み銘板と同じ）。白地の札にすると、暗い机の上で白い棒に見えてしまう。
    ctx.fillStyle = '#171b20';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#4a525a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = tint;
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    return toTexture(element);
  });
}

/**
 * ATS-P 表示器の面板。
 *
 * ランプの名前を書いた板で、この上に光る玉を並べる。実物の ATS-P 表示器は
 * 「電源／パターン接近／ブレーキ動作／故障／開放／ATS-SN」の 6 灯が縦横に並び、
 * どれが点いているかで**装置が何をしているか**が分かるようになっている。
 */
export const ATS_LAMPS: readonly string[] = [
  '電源',
  'パターン接近',
  'ブレーキ動作',
  '故障',
  '開放',
  'ATS-SN',
];

export function atsPanelTexture(): THREE.Texture {
  return cached('ats-panel', () => {
    const w = 512;
    const h = 384;
    const [element, ctx] = canvas(w, h);
    ctx.fillStyle = '#1d2228';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#3d444c';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
    ctx.fillStyle = '#aeb6be';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ATS-P', 20, 32);
    ctx.font = '26px sans-serif';
    for (let i = 0; i < ATS_LAMPS.length; i++) {
      const row = i % 3;
      const col = i < 3 ? 0 : 1;
      // ランプの玉は 3D の側で置くので、ここは名前だけを書く
      ctx.fillText(ATS_LAMPS[i]!, 24 + col * 250 + 52, 110 + row * 82);
    }
    return toTexture(element);
  });
}

/**
 * 時刻表（ホルダに差してある紙）。
 *
 * **実在の駅名・列車番号は使わない。** 同梱の試験線の駅名を使い、書式だけを
 * 実物の行路表に合わせる（駅名・着・発の 3 列）。
 */
export function timetableTexture(
  rows: ReadonlyArray<readonly [string, string, string]>,
): THREE.Texture {
  return cached(`timetable-${rows.map((r) => r.join()).join('|')}`, () => {
    const w = 256;
    const h = 384;
    const [element, ctx] = canvas(w, h);
    ctx.fillStyle = '#f6f3e8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#20262c';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('行路表  1234M', 12, 22);
    ctx.font = '18px sans-serif';
    ctx.fillText('駅', 14, 52);
    ctx.textAlign = 'right';
    ctx.fillText('着', 172, 52);
    ctx.fillText('発', 244, 52);
    ctx.strokeStyle = '#8a8578';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, 64);
    ctx.lineTo(w - 10, 64);
    ctx.stroke();
    for (let i = 0; i < rows.length && i < 8; i++) {
      const [name, arrive, depart] = rows[i]!;
      const y = 88 + i * 34;
      ctx.textAlign = 'left';
      ctx.font = '20px sans-serif';
      ctx.fillText(name, 14, y);
      ctx.textAlign = 'right';
      ctx.font = '20px monospace';
      ctx.fillText(arrive, 172, y);
      ctx.fillText(depart, 244, y);
      ctx.strokeStyle = '#ddd8c8';
      ctx.beginPath();
      ctx.moveTo(10, y + 17);
      ctx.lineTo(w - 10, y + 17);
      ctx.stroke();
    }
    return toTexture(element);
  });
}

/** モニタ装置の画面に出す値 */
export interface CabMonitorState {
  readonly speed: number;
  readonly limit: number;
  readonly notch: string;
  /** ブレーキシリンダ圧 [kPa] */
  readonly cylinder: number;
  /** 元空気だめ圧 [kPa] */
  readonly reservoir: number;
  /** 主電動機電流 [A] */
  readonly current: number;
  readonly doorsClosed: boolean;
  readonly nextStation: string;
  /** 次の停車駅までの距離 [m] */
  readonly distance: number;
  readonly clock: string;
}

export interface CabMonitor {
  readonly texture: THREE.CanvasTexture;
  update(state: CabMonitorState): void;
}

/**
 * モニタ装置（車両情報表示装置）の画面。
 *
 * 実物の通勤形の運転台には、速度・ブレーキ・戸閉・機器の状態を一覧できる画面が
 * ある。ここでは運転に要る値だけを、実物と同じ「上に主要値・下に機器の帯」という
 * 割り付けで出す。1 秒に何度も描き直しても意味が無いので、値が変わったときだけ
 * 描く。
 */
export function createCabMonitor(): CabMonitor {
  const w = 512;
  const h = 384;
  const [element, ctx] = canvas(w, h);
  const texture = toTexture(element);
  let last = '';

  const update = (state: CabMonitorState): void => {
    const key = [
      state.speed.toFixed(0),
      state.limit.toFixed(0),
      state.notch,
      state.cylinder.toFixed(0),
      state.reservoir.toFixed(0),
      state.current.toFixed(0),
      state.doorsClosed,
      state.nextStation,
      state.distance.toFixed(0),
      state.clock,
    ].join('|');
    if (key === last) return;
    last = key;

    ctx.fillStyle = '#06121c';
    ctx.fillRect(0, 0, w, h);
    // 見出し
    ctx.fillStyle = '#123048';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#cfe6f7';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('モニタ装置', 14, 23);
    ctx.textAlign = 'right';
    ctx.font = '24px monospace';
    ctx.fillText(state.clock, w - 14, 23);

    // 速度（大きく）と制限
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7fe3a0';
    ctx.font = 'bold 88px monospace';
    ctx.fillText(state.speed.toFixed(0).padStart(3, ' '), 14, 106);
    ctx.font = '26px sans-serif';
    ctx.fillText('km/h', 200, 128);
    ctx.fillStyle = '#ffd24a';
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${state.limit.toFixed(0)}`, w - 80, 84);
    ctx.font = '22px sans-serif';
    ctx.fillText('制限 km/h', w - 14, 122);

    // ノッチ
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9fb6c8';
    ctx.font = '22px sans-serif';
    ctx.fillText('ノッチ', 14, 168);
    ctx.fillStyle = '#e8f2fa';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(state.notch, 100, 168);

    // 圧力・電流の帯
    const bar = (label: string, value: string, ratio: number, y: number, colour: string): void => {
      ctx.fillStyle = '#9fb6c8';
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, 14, y);
      ctx.fillStyle = '#0d2434';
      ctx.fillRect(120, y - 12, 250, 24);
      ctx.fillStyle = colour;
      ctx.fillRect(120, y - 12, 250 * Math.max(0, Math.min(1, ratio)), 24);
      ctx.fillStyle = '#e8f2fa';
      ctx.font = '20px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(value, w - 14, y);
    };
    bar('BC 圧', `${state.cylinder.toFixed(0)} kPa`, state.cylinder / 500, 214, '#e06a3a');
    bar('MR 圧', `${state.reservoir.toFixed(0)} kPa`, state.reservoir / 1000, 252, '#3a8fe0');
    bar('主電動機', `${state.current.toFixed(0)} A`, Math.abs(state.current) / 1200, 290, '#5fc27e'); // prettier-ignore

    // 戸閉と次駅
    ctx.textAlign = 'left';
    ctx.fillStyle = state.doorsClosed ? '#1d7a3c' : '#8a2b22';
    ctx.fillRect(14, 312, 120, 46);
    ctx.fillStyle = '#eef6ff';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(state.doorsClosed ? '戸閉' : '戸開', 30, 336);
    ctx.fillStyle = '#9fb6c8';
    ctx.font = '20px sans-serif';
    ctx.fillText('次駅', 152, 324);
    ctx.fillStyle = '#e8f2fa';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(state.nextStation, 200, 324);
    ctx.fillStyle = '#9fb6c8';
    ctx.font = '20px monospace';
    ctx.fillText(`${state.distance.toFixed(0)} m`, 200, 352);
    texture.needsUpdate = true;
  };

  update({
    speed: 0,
    limit: 0,
    notch: 'N',
    cylinder: 0,
    reservoir: 0,
    current: 0,
    doorsClosed: true,
    nextStation: '',
    distance: 0,
    clock: '--:--',
  });
  return { texture, update };
}
