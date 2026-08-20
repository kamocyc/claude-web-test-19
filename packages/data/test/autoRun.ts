/**
 * 自動運転のテストで使う共通の走行。
 *
 * ファイル名が `*.test.ts` ではないので、これ自体はテストとして集められない
 * （`vitest.config.ts` の `include` が拾うのは `.test.ts` で終わるものだけ）。
 */
import { Simulation, type Scenario, type SimSnapshot } from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

export const lib = createDefaultLibrary();

/** 走行中と見なす速度 [m/s]（これ以下での込めは停止保持であり、衝動にならない） */
const MOVING_SPEED = 0.5;
export const scenarioOf = (id: string): Scenario => lib.scenario(id);

export interface RunResult {
  readonly sim: Simulation;
  /** 常用ブレーキノッチが変わった回数（保安装置の介入を含む実効ノッチ） */
  readonly notchChanges: number;
  /**
   * 走行中にブレーキが緩解から込めへ立ち上がった回数。
   * 止まってからの停止保持（勾配で転動しないための込め）は、動いていないので
   * 前後衝動にならない。運転の質として数えたいのは走行中の入切だけ。
   */
  readonly applications: number;
  /** 停止した瞬間の減速度 [m/s^2] */
  readonly stopDecelerations: number[];
  /** 制限速度を超えた最大量 [m/s] */
  readonly overspeed: number;
  /**
   * 制限速度へいちばん近づいたときの差 [m/s]（負 = 超えていない）。
   * `overspeed` と違って 0 で切らないので、「超えないか」と「使い切っているか」を
   * 同じ 1 つの量で見られる。
   */
  readonly closestApproach: number;
  /** 停止ごとの、這うような速度で走った時間 [s] と距離 [m] */
  readonly crawls: ReadonlyArray<{ time: number; distance: number }>;
  /** ブレーキが入っていた時間の割合 */
  readonly brakingRatio: number;
}

/**
 * これ以下を「這うような速度」と見なす [m/s]（約 11km/h）。
 * 停止直前にこの速度で長く走るのは、手前で減速しきってしまった証拠である。
 */
const CRAWL_SPEED = 3;

/**
 * 自動運転で走らせて、運転の質を測る。
 * dt は描画フレーム相当の粗い刻みにして、実際の使われ方に近づける。
 */
function drive(scenarioId: string, seconds: number, dt: number): RunResult {
  const sim = new Simulation(scenarioOf(scenarioId));
  sim.setAutoDrive(true);
  let previousNotch = 0;
  let previousSpeed = sim.speed;
  let notchChanges = 0;
  let applications = 0;
  let brakingSteps = 0;
  let steps = 0;
  let overspeed = 0;
  let closestApproach = Number.NEGATIVE_INFINITY;
  const stopDecelerations: number[] = [];
  const crawls: Array<{ time: number; distance: number }> = [];
  let crawlTime = 0;
  let crawlDistance = 0;
  let crawling = false;

  for (let i = 0; i < Math.round(seconds / dt); i++) {
    sim.step(dt);
    const snap: SimSnapshot = sim.snapshot();
    if (snap.brakeNotch !== previousNotch) {
      notchChanges++;
      if (previousNotch === 0 && Math.abs(sim.speed) > MOVING_SPEED) applications++;
      previousNotch = snap.brakeNotch;
    }
    if (snap.brakeNotch > 0) brakingSteps++;
    steps++;
    // 這うような速度で走った時間と距離を、停止ごとに数える。
    // 一度でも CRAWL_SPEED を上回れば、それは停止直前の這いではないので数え直す。
    const v = Math.abs(sim.speed);
    if (v >= CRAWL_SPEED) {
      crawling = false;
      crawlTime = 0;
      crawlDistance = 0;
    } else if (v > 0.05) {
      crawling = true;
      crawlTime += dt;
      crawlDistance += v * dt;
    }
    // 停止した瞬間（速度が停止判定を下回った瞬間）の減速度が、そのまま前後衝動になる
    if (previousSpeed > 0.05 && sim.speed <= 0.05) {
      stopDecelerations.push(-snap.acceleration);
      if (crawling) crawls.push({ time: crawlTime, distance: crawlDistance });
      crawling = false;
      crawlTime = 0;
      crawlDistance = 0;
    }
    previousSpeed = sim.speed;
    const limit = Math.min(snap.speedLimit, sim.scenario.route.maxSpeed);
    overspeed = Math.max(overspeed, sim.speed - limit);
    closestApproach = Math.max(closestApproach, sim.speed - limit);
  }
  return {
    sim,
    notchChanges,
    applications,
    stopDecelerations,
    overspeed,
    closestApproach,
    crawls,
    brakingRatio: brakingSteps / Math.max(1, steps),
  };
}

/**
 * 同じ条件の走行を覚えておく。
 *
 * シミュレーションは決定論的なので、同じシナリオを同じ秒数だけ走らせれば結果は
 * 必ず同じになる。同じ 1 本の走行について「停止位置は」「衝動は」「保安装置は」と
 * 別々に確かめたいだけなのに、テストの数だけ走らせ直すと、その回数ぶん時間が要る。
 * ここで覚えておけば、確かめる内容は変えずに走行そのものは 1 回で済む。
 *
 * 返す `RunResult` はテスト間で共有されるので、**読むだけ**にすること。
 * とくに `sim` をさらに `step()` で進めてはいけない（進めたい試験は
 * `new Simulation(scenarioOf(...))` から自分で組む）。
 */
const runs = new Map<string, RunResult>();

/**
 * 自動運転で走らせて、運転の質を測る。
 * dt は描画フレーム相当の粗い刻みにして、実際の使われ方に近づける。
 */
export function autoRun(scenarioId: string, seconds: number, dt = 0.05): RunResult {
  const key = `${scenarioId}|${seconds}|${dt}`;
  const known = runs.get(key);
  if (known) return known;
  const result = drive(scenarioId, seconds, dt);
  runs.set(key, result);
  return result;
}
