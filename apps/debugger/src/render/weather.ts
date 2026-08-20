import type * as THREE from 'three';
import type { RailCondition } from '@railsim/core';

/** 降っているもの */
export type Precipitation = 'none' | 'rain' | 'snow';

/**
 * 天気ごとの見え方。
 *
 * 空・霧・照明・降水・路面をここ 1 か所で決める。天気は「粒を降らせる」だけでは
 * それらしくならない。雨の日に暗く見えるのは雨粒のせいではなく雲のせいで、
 * 遠くが霞むのも雲と雨滴の散乱による。粒・空・光・霧をまとめて動かして初めて
 * 「その日の線路」になるので、別々の場所に散らさずここへ集める。
 */
export interface WeatherLook {
  /** 天頂・地平線・地平線下の色と、グラデーションの締まり具合 */
  readonly sky: { top: number; horizon: number; ground: number; exponent: number };
  /** 空の球より外側（描き残し）の色 */
  readonly background: number;
  /** 霧。近いほど、濃いほど遠くが見えなくなる */
  readonly fog: { color: number; near: number; far: number };
  /** 太陽（平行光）。曇れば弱く、色も冷たくなる */
  readonly sun: { color: number; intensity: number; shadow: boolean };
  /** 空と地面からの環境光。曇るほど影が浅くなるので、こちらは強くする */
  readonly ambient: { sky: number; ground: number; intensity: number };
  readonly precipitation: Precipitation;
  /** 降りの強さ 0..1（粒の数に掛かる） */
  readonly density: number;
  /** 落下速度 [m/s]。雨は速く、雪はゆっくり舞う */
  readonly fallSpeed: number;
  /** 粒の色 */
  readonly particleColor: number;
  /** 地表・道床に混ぜる色と割合（雪の積もり・雨の濡れ）、および粗さの補正 */
  readonly surface: { tint: number; mix: number; roughness: number };
}

const CLEAR: WeatherLook = {
  sky: { top: 0x2f6fd0, horizon: 0xcfe3f5, ground: 0x8fa08a, exponent: 0.7 },
  background: 0xa9c8e4,
  fog: { color: 0xbcd4ea, near: 900, far: 4200 },
  sun: { color: 0xfff4e0, intensity: 2.9, shadow: true },
  ambient: { sky: 0xbfd8f5, ground: 0x6b7a5a, intensity: 0.7 },
  precipitation: 'none',
  density: 0,
  fallSpeed: 0,
  particleColor: 0xffffff,
  surface: { tint: 0xffffff, mix: 0, roughness: 0 },
};

/**
 * 天気ごとの見え方。
 *
 * 引数は物理側の「レール踏面の状態」である。走りに効くのは踏面だけなので核は
 * それしか持たないが、見た目の側では雨と落葉を同じ絵にするわけにいかない。
 * 濡れ（`wet`）は雨、`snow` は降雪、`leaves` は降ってはいないが陽の差さない
 * 曇天、という対応にする。
 */
export function weatherLook(rail: RailCondition): WeatherLook {
  switch (rail) {
    case 'wet':
      return {
        sky: { top: 0x6a7a88, horizon: 0xa8b3bd, ground: 0x5d6657, exponent: 0.45 },
        background: 0x93a0ac,
        // 雨脚の中は数百 m 先から白くかすむ
        fog: { color: 0x93a0ac, near: 180, far: 1700 },
        sun: { color: 0xdfe6ee, intensity: 0.9, shadow: false },
        ambient: { sky: 0xa8b8c8, ground: 0x616858, intensity: 1.9 },
        precipitation: 'rain',
        density: 1,
        fallSpeed: 9.5,
        particleColor: 0xc8d6e4,
        // 濡れた路面は暗く沈み、そのぶん照り返しが出る（粗さを下げる）
        surface: { tint: 0x3c4038, mix: 0.4, roughness: -0.45 },
      };
    case 'snow':
      return {
        sky: { top: 0xb6c0ca, horizon: 0xe1e6ea, ground: 0xc6ccd0, exponent: 0.35 },
        background: 0xd2d9df,
        // 降雪はいちばん視界が利かない
        fog: { color: 0xc9d1d8, near: 90, far: 950 },
        sun: { color: 0xeef2f7, intensity: 0.8, shadow: false },
        ambient: { sky: 0xdbe3ea, ground: 0xa4aaae, intensity: 2.0 },
        precipitation: 'snow',
        density: 1,
        fallSpeed: 1.4,
        particleColor: 0xffffff,
        // 積もった雪。白くして、粉なので粗くする
        surface: { tint: 0xeef2f6, mix: 0.78, roughness: 0.15 },
      };
    case 'leaves':
      return {
        // 降ってはいないが陽の差さない日。落葉期なので地表は枯れ色へ寄せる
        sky: { top: 0x7c8794, horizon: 0xc0c3bd, ground: 0x6e6a52, exponent: 0.5 },
        background: 0xa9adaa,
        fog: { color: 0xa9adaa, near: 400, far: 2600 },
        sun: { color: 0xf0e6d6, intensity: 1.1, shadow: true },
        ambient: { sky: 0xb6bcc0, ground: 0x6a6350, intensity: 1.1 },
        precipitation: 'none',
        density: 0,
        fallSpeed: 0,
        particleColor: 0xffffff,
        surface: { tint: 0x6b5a3c, mix: 0.25, roughness: 0 },
      };
    case 'dry':
    default:
      return CLEAR;
  }
}

/** 2 つの色（0xRRGGBB）を割合 `t` で混ぜる */
export function mixColor(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ch = (v: number, shift: number): number => (v >> shift) & 0xff;
  const mix = (shift: number): number =>
    Math.round(ch(a, shift) * (1 - k) + ch(b, shift) * k) << shift;
  return mix(16) | mix(8) | mix(0);
}

/** 地表・道床に天気を反映するときの指定 */
export interface SurfaceCoat {
  /** 材質へ与える色 */
  readonly color: number;
  /**
   * 下地の模様（草・砕石）を隠すか。
   *
   * 材質の色は模様に**掛かる**ので、緑の草の上に白を掛けても白くはならない。
   * 積もって下地が見えなくなる雪だけは、模様そのものを外して塗り替える。
   * 凹凸（法線）は残すので、のっぺりはしない。
   */
  readonly hideMap: boolean;
  /** 粗さの補正（濡れれば下がり、粉雪なら上がる） */
  readonly roughness: number;
}

/** 下地の色に天気を混ぜる */
export function surfaceCoat(base: number, look: WeatherLook): SurfaceCoat {
  const hideMap = look.surface.mix > 0.5;
  return {
    color: mixColor(base, look.surface.tint, look.surface.mix),
    hideMap,
    roughness: look.surface.roughness,
  };
}

/** 下地の模様と天気から、材質へ渡す指定を組み立てる */
export function coatMaterial(
  maps: { map?: THREE.Texture | null; normalMap?: THREE.Texture | null },
  baseRoughness: number,
  coat: SurfaceCoat,
): {
  color: number;
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  roughness: number;
} {
  const roughness = baseRoughness + coat.roughness;
  return {
    color: coat.color,
    map: coat.hideMap ? null : (maps.map ?? null),
    normalMap: maps.normalMap ?? null,
    roughness: Math.max(0.05, Math.min(1, roughness)),
  };
}

/**
 * 値を周期 `period` へ畳み込む（結果は 0 以上 `period` 未満）。
 *
 * 降水の移動量を積み上げっぱなしにすると、何分も走っているうちに float の桁が
 * 足りなくなって粒がかくつく。巻き戻しの周期そのもので畳んでおけば、見た目を
 * 変えずに値を小さく保てる。
 */
export function fold(value: number, period: number): number {
  if (!(period > 0)) return 0;
  const r = value % period;
  return r < 0 ? r + period : r;
}

/**
 * 粒 1 個ぶんの体積 [m^3]。降りの強さから粒の数を決めるのに使う。
 * 実際の雨滴の数とは桁が違う（見た目が成立する密度に寄せた値）。
 */
const VOLUME_PER_PARTICLE: Record<Exclude<Precipitation, 'none'>, number> = {
  rain: 55,
  snow: 85,
};

/**
 * 巻き戻しの箱の中に置く粒の数。
 *
 * 箱の体積に比例させるので、箱を広げても濃さは変わらない。`budget` は端末の
 * 描画能力に対する割り当て（携帯端末では減らす）。
 */
export function particleCount(
  precipitation: Precipitation,
  half: number,
  density: number,
  budget = 1,
): number {
  if (precipitation === 'none' || density <= 0) return 0;
  const volume = (2 * half) ** 3;
  const n = (volume / VOLUME_PER_PARTICLE[precipitation]) * density * budget;
  return Math.max(0, Math.min(30000, Math.round(n)));
}
