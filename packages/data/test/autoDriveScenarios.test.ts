import { describe, expect, it } from 'vitest';
import { autoRun, lib } from './autoRun.ts';

/**
 * 全シナリオを横断して確かめるもの。
 *
 * シナリオの数だけ走らせるので、ここだけで他のテスト 1 ファイルぶんの時間がかかる。
 * 走りの質を見る `autoDrive.test.ts` と別のファイルにしてあるのは、
 * Vitest が並列に走らせる単位が**ファイル**だからで、分けておけば別々の
 * ワーカーで同時に進む。
 */
describe('自動運転（ATO）— 全シナリオ', () => {
  it.each(lib.scenarioIds)('%s でも制限速度を超えない', (id) => {
    // 制限を超えないことは運転の作法ではなく守るべき一線なので、
    // 車両・天候・進路の組み合わせすべてで見る。
    const { overspeed, sim } = autoRun(id, 300);
    expect(overspeed).toBeLessThanOrEqual(0);
    expect(sim.metrics.safety.patternBrakeCount).toBe(0);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
  });
});
