import type { Meters } from '../units.ts';
import type { VehicleSpec } from '../vehicle/spec.ts';

/**
 * 車両の中心から見た各軸の位置 [m]（正 = 前方）。
 *
 * 台車中心は車両中心から `台車中心間距離 / 2` の位置にあり、各軸はさらに
 * 台車中心から `固定軸距 / 2` ずれる。軸の並び順は `computeAxleLoads()` と
 * 同じ（前台車から順、各台車の中では前軸から順）にそろえてある。
 */
export function axleOffsets(spec: VehicleSpec, out: number[] = []): number[] {
  out.length = 0;
  const n = spec.axleCount;
  if (n < 2) {
    out.push(0);
    return out;
  }
  const perBogie = Math.max(1, Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    const front = i < perBogie;
    const bogieCentre = front ? spec.bogieSpacing / 2 : -spec.bogieSpacing / 2;
    const indexInBogie = front ? i : i - perBogie;
    // 台車内で前軸が正、後軸が負になるよう配分する
    const rel = perBogie > 1 ? 0.5 - indexInBogie / (perBogie - 1) : 0;
    out.push(bogieCentre + rel * spec.bogieWheelbase);
  }
  return out;
}

/**
 * 定尺レールの継目を跨いだ位置を求める。
 *
 * 「いまの距離程が継目と一致したか」ではなく、**前ステップの位置と今ステップの
 * 位置のあいだを跨いだか**で判定する。地上子の通過判定（`PointTable.crossing`）と
 * 同じ考え方で、こうしないと高速走行や大きな描画間隔で継目を取りこぼす。
 *
 * 戻り値は区間内の位置 `u ∈ (0, 1]` で、`s = sPrev + u (sNow - sPrev)` が継目に
 * あたる。呼び出し側はこれをフレーム内の時刻へ直して、サンプル精度で音を
 * 鳴らせる。60fps でも「ガタン…ゴトン」の間隔が固定軸距・台車中心間距離
 * どおりになるのはこのためである。
 *
 * @param spacing 継目の間隔 [m]。0 以下ならロングレール（継目なし）。
 */
export function jointCrossings(
  sPrev: Meters,
  sNow: Meters,
  spacing: Meters,
  out: number[] = [],
): number[] {
  out.length = 0;
  if (spacing <= 0 || sPrev === sNow) return out;
  const delta = sNow - sPrev;
  if (delta > 0) {
    const first = Math.floor(sPrev / spacing) + 1;
    const last = Math.floor(sNow / spacing);
    for (let n = first; n <= last; n++) {
      out.push((n * spacing - sPrev) / delta);
    }
  } else {
    const first = Math.ceil(sPrev / spacing) - 1;
    const last = Math.ceil(sNow / spacing);
    for (let n = first; n >= last; n--) {
      out.push((n * spacing - sPrev) / delta);
    }
  }
  return out;
}
