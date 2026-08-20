import { describe, expect, it } from 'vitest';
import type { RailCondition } from '@railsim/core';
import { fold, particleCount, weatherLook } from '../src/render/weather.ts';

const CONDITIONS: readonly RailCondition[] = ['dry', 'wet', 'leaves', 'snow'];

describe('天気ごとの見え方', () => {
  it('どの踏面状態にも見え方がある', () => {
    for (const rail of CONDITIONS) {
      const look = weatherLook(rail);
      expect(look.fog.near).toBeGreaterThan(0);
      expect(look.fog.far).toBeGreaterThan(look.fog.near);
      expect(look.sun.intensity).toBeGreaterThan(0);
      expect(look.ambient.intensity).toBeGreaterThan(0);
    }
  });

  it('晴天だけが降らず、影を落とす', () => {
    expect(weatherLook('dry').precipitation).toBe('none');
    expect(weatherLook('dry').sun.shadow).toBe(true);
    expect(weatherLook('wet').precipitation).toBe('rain');
    expect(weatherLook('snow').precipitation).toBe('snow');
    // 落葉は降ってはいないが陽の差さない日
    expect(weatherLook('leaves').precipitation).toBe('none');
  });

  it('曇るほど暗く、遠くが見えなくなる', () => {
    const clear = weatherLook('dry');
    const rain = weatherLook('wet');
    const snow = weatherLook('snow');
    // 雲を通れば平行光は弱まり、そのぶん回り込む光が強くなる
    expect(rain.sun.intensity).toBeLessThan(clear.sun.intensity);
    expect(snow.sun.intensity).toBeLessThan(clear.sun.intensity);
    expect(rain.ambient.intensity).toBeGreaterThan(clear.ambient.intensity);
    // 視程は 晴天 > 雨 > 降雪
    expect(rain.fog.far).toBeLessThan(clear.fog.far);
    expect(snow.fog.far).toBeLessThan(rain.fog.far);
    // 曇天では方向のある影は落とさない
    expect(rain.sun.shadow).toBe(false);
    expect(snow.sun.shadow).toBe(false);
  });

  it('雪は白く積もり、雨は濡れて暗く沈む', () => {
    const snow = weatherLook('snow');
    const rain = weatherLook('wet');
    expect(snow.surface.mix).toBeGreaterThan(0.5);
    // 濡れた路面は照り返しが出る＝粗さを下げる
    expect(rain.surface.roughness).toBeLessThan(0);
    expect(weatherLook('dry').surface.mix).toBe(0);
  });

  it('雪は雨よりゆっくり落ちる', () => {
    expect(weatherLook('snow').fallSpeed).toBeLessThan(weatherLook('wet').fallSpeed);
  });
});

describe('降水の巻き戻し', () => {
  it('周期へ畳んでも位相が変わらない', () => {
    // 積み上げた移動量を畳んでも、巻き戻し後の位置は同じでなければならない
    for (const v of [0, 1.5, 67.9, 68, 200.25, -3.5, -140]) {
      const folded = fold(v, 68);
      expect(folded).toBeGreaterThanOrEqual(0);
      expect(folded).toBeLessThan(68);
      // 元の値との差はちょうど周期の整数倍
      expect(Math.abs((v - folded) % 68)).toBeLessThan(1e-9);
    }
  });

  it('周期が 0 でも壊れない', () => {
    expect(fold(5, 0)).toBe(0);
  });
});

describe('粒の数', () => {
  it('降らない天気では 0', () => {
    expect(particleCount('none', 34, 1)).toBe(0);
    expect(particleCount('rain', 34, 0)).toBe(0);
  });

  it('箱を広げても濃さが変わらない（体積に比例する）', () => {
    const small = particleCount('rain', 10, 1);
    const large = particleCount('rain', 20, 1);
    // 半辺が 2 倍なら体積は 8 倍
    expect(large / small).toBeGreaterThan(7.5);
    expect(large / small).toBeLessThan(8.5);
  });

  it('端末の割り当てで減らせる', () => {
    const full = particleCount('snow', 34, 1, 1);
    const half = particleCount('snow', 34, 1, 0.5);
    expect(half).toBeCloseTo(full / 2, -1);
  });

  it('上限で頭打ちになる（描画が詰まらないように）', () => {
    expect(particleCount('rain', 1000, 1)).toBeLessThanOrEqual(30000);
  });
});
