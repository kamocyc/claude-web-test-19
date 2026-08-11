import { describe, expect, it } from 'vitest';
import { createDefaultLibrary } from '@railsim/data';
import { makeFrameAt } from '../src/render/frame.ts';

const route = createDefaultLibrary().scenario('test-line-local').route;
const frameAt = makeFrameAt(route);
const alignment = route.alignment;

/**
 * 試験線の曲線内で、カントが最大かつ勾配が 0 の地点。
 * R600 左曲線 1500–2300（緩和 80m）／R400 右曲線 4200–5000（緩和 100m）。
 * 縦曲線を跨ぐと軌道面が鉛直から傾き、レール高低との対応に勾配ぶんの係数が
 * 入るため、比較しやすい平坦な地点を選んでいる。
 */
const LEFT_CURVE = 1800;
const RIGHT_CURVE = 4400;
const STRAIGHT = 800;

describe('軌道の基準座標系とカント', () => {
  it('試験線の曲線にカントが入っている', () => {
    expect(alignment.cantAt(LEFT_CURVE)).toBeCloseTo(0.075, 6);
    expect(alignment.cantAt(RIGHT_CURVE)).toBeCloseTo(-0.09, 6);
    expect(alignment.cantAt(STRAIGHT)).toBeCloseTo(0, 9);
  });

  it('カント角は外軌が高いほど正（左曲線で正）', () => {
    // asin(0.075 / 1.067) = 4.03 度
    expect((alignment.cantAngleAt(LEFT_CURVE) * 180) / Math.PI).toBeCloseTo(4.03, 2);
    expect(alignment.cantAngleAt(RIGHT_CURVE)).toBeLessThan(0);
  });

  it('直線では軌道面が水平', () => {
    const f = frameAt(STRAIGHT);
    expect(f.up.y).toBeCloseTo(1, 9);
    expect(f.cantRight.y).toBeCloseTo(0, 9);
  });

  /**
   * これが本題の回帰テスト。
   * 車体・まくらぎの姿勢に使う `cantRight` と、レールの高さに使う `cantAt` が
   * 逆向きになっていると（実際に一度そうなっていた）ここで落ちる。
   */
  it('左曲線では軌道面の右側が上がる（レールの高低と一致する）', () => {
    const f = frameAt(LEFT_CURVE);
    // 右レールが高い = 右側が上がる
    expect(f.cantRight.y).toBeGreaterThan(0);
    // 軌間の半分だけ右へ出た点の高さの差が、レールの高低差の半分に一致する
    const half = alignment.gauge / 2;
    expect(f.cantRight.y * half).toBeCloseTo(alignment.cantAt(LEFT_CURVE) / 2, 6);
  });

  it('右曲線では軌道面の左側が上がる', () => {
    const f = frameAt(RIGHT_CURVE);
    expect(f.cantRight.y).toBeLessThan(0);
    const half = alignment.gauge / 2;
    expect(f.cantRight.y * half).toBeCloseTo(alignment.cantAt(RIGHT_CURVE) / 2, 6);
  });

  it('上方向は曲線の内側へ傾く', () => {
    const left = frameAt(LEFT_CURVE);
    // 左曲線の内側は進行方向左（= -right）。上方向がその側へ倒れる。
    expect(left.up.dot(left.right)).toBeLessThan(0);

    const right = frameAt(RIGHT_CURVE);
    expect(right.up.dot(right.right)).toBeGreaterThan(0);
  });

  it('基準座標系は正規直交である', () => {
    for (const s of [STRAIGHT, LEFT_CURVE, RIGHT_CURVE, 2600, 5200]) {
      const f = frameAt(s);
      expect(f.up.length()).toBeCloseTo(1, 9);
      expect(f.cantRight.length()).toBeCloseTo(1, 9);
      expect(f.up.dot(f.cantRight)).toBeCloseTo(0, 9);
      expect(f.up.dot(f.forward)).toBeCloseTo(0, 6);
      expect(f.cantRight.dot(f.forward)).toBeCloseTo(0, 9);
    }
  });

  it('緩和曲線ではカントが逓減する', () => {
    // R600 曲線は 1500m から、緩和曲線長 80m
    const a = Math.abs(alignment.cantAt(1500));
    const b = Math.abs(alignment.cantAt(1540));
    const c = Math.abs(alignment.cantAt(1580));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeCloseTo(0.075, 6);
  });
});
