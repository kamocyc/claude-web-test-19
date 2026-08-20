import { defineConfig } from 'vitest/config';
import { BaseSequencer, type WorkspaceSpec } from 'vitest/node';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 時間のかかるファイルから先に流す。
 *
 * Vitest が並列に走らせる単位はファイルなので、長いファイルを後から始めると、
 * それがそのまま全体の終了時刻になる。既定の順番はファイルの**大きさ**順で、
 * 中身の重さとは関係が無い（実測では 68 秒かかるファイルが 75 秒目に始まり、
 * 他が全部終わったあと 1 コアで走って、全体が 148 秒になっていた）。
 *
 * ここに挙げるのは順番だけの話で、走るテストも結果も変わらない。新しく重い
 * テストを足したら継ぎ足す。抜けていても遅くなるだけで、壊れはしない。
 */
const SLOW_FIRST: readonly string[] = [
  'packages/data/test/autoDriveScenarios.test.ts',
  'packages/data/test/simulation.test.ts',
  'packages/data/test/autoDrive.test.ts',
  'packages/core/test/traction-brake.test.ts',
  'packages/core/test/snowproofBrake.test.ts',
  'packages/audio/test/synth.test.ts',
  'packages/core/test/dynamics.test.ts',
];

class SlowestFirst extends BaseSequencer {
  override async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const rank = (spec: WorkspaceSpec): number => {
      const index = SLOW_FIRST.findIndex((name) => spec.moduleId.endsWith(name));
      return index < 0 ? SLOW_FIRST.length : index;
    };
    return [...files].sort((a, b) => rank(a) - rank(b));
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@railsim/core': r('./packages/core/src/index.ts'),
      '@railsim/data': r('./packages/data/src/index.ts'),
      '@railsim/audio': r('./packages/audio/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // テストはどれも計算だけで、待ち時間が無い。既定では CPU を 1 つ空けて
    // （`CPU 数 - 1`）走らせるが、待ちが無いのだから空けても遊ぶだけなので使い切る。
    // 走らせる単位はファイルなので、長いファイルは分けておかないと効かない。
    pool: 'threads',
    poolOptions: { threads: { minThreads: 1, maxThreads: Math.max(1, availableParallelism()) } },
    sequence: { sequencer: SlowestFirst },
    benchmark: {
      include: ['packages/*/bench/**/*.bench.ts'],
    },
  },
});
