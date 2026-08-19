import { describe, expect, it } from 'vitest';
import { Simulation, mpsToKmh, stateHash, type Scenario, type SimSnapshot } from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

const lib = createDefaultLibrary();

/** 走行中と見なす速度 [m/s]（これ以下での込めは停止保持であり、衝動にならない） */
const MOVING_SPEED = 0.5;
const scenarioOf = (id: string): Scenario => lib.scenario(id);

interface RunResult {
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
function autoRun(scenarioId: string, seconds: number, dt = 0.05): RunResult {
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

describe('自動運転（ATO）', () => {
  it('起点から終点まで自分で走り、全駅の停止位置に所定内で止まる', () => {
    const { sim } = autoRun('test-line-local', 600);
    const stops = sim.metrics.stops;
    expect(stops.map((s) => s.stationId)).toEqual(['stn-a', 'stn-b', 'stn-c']);
    for (const stop of stops) {
      const station = sim.scenario.route.stations.find((s) => s.id === stop.stationId)!;
      expect(Math.abs(stop.stopError)).toBeLessThan(station.stopTolerance);
    }
    // 終着駅に停まったまま、扉を開けて留置している
    expect(Math.abs(sim.speed)).toBeLessThan(0.05);
    expect(sim.position).toBeGreaterThan(7100);
  });

  it('停車時分と発時刻を満たしてから発車する', () => {
    const { sim } = autoRun('test-line-local', 600);
    const stnB = sim.stations.find((s) => s.station.id === 'stn-b')!;
    expect(stnB.departureTime).not.toBeNull();
    // 停車時分ぶんは扉を開けて停まっている
    expect(stnB.dwellElapsed).toBeGreaterThanOrEqual(stnB.station.dwellTime);
    // 発時刻より前には出ない
    expect(stnB.departureTime!).toBeGreaterThanOrEqual(stnB.station.departureTime!);
  });

  it('保安装置を一度も動作させずに走り切る', () => {
    const { sim, overspeed } = autoRun('test-line-local', 600);
    const safety = sim.metrics.safety;
    expect(safety.emergencyBrakeCount).toBe(0);
    expect(safety.patternBrakeCount).toBe(0);
    // 制限速度を超えない
    expect(overspeed).toBeLessThanOrEqual(0);
  });

  it('制限速度を使い切る（直下まで出すが、決して超えない）', () => {
    const { overspeed, closestApproach } = autoRun('test-line-local', 600);
    // 超えない
    expect(overspeed).toBeLessThanOrEqual(0);
    // かつ、遠慮しすぎない。制限の 2km/h 以内までは出す。
    // 余裕を厚く取って安全を買う運転をやめ、先読みの精度で買うようにした結果であり、
    // ここが緩むのは「制限のはるか下を走っている」ということなので回帰として拾いたい。
    expect(closestApproach).toBeGreaterThan(-0.6);
  });

  it.each(lib.scenarioIds)('%s でも制限速度を超えない', (id) => {
    // 制限を超えないことは運転の作法ではなく守るべき一線なので、
    // 車両・天候・進路の組み合わせすべてで見る。
    const { overspeed, sim } = autoRun(id, 300);
    expect(overspeed).toBeLessThanOrEqual(0);
    expect(sim.metrics.safety.patternBrakeCount).toBe(0);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
  });

  it('降雪でも停止直前に這って走らない', () => {
    const dry = autoRun('test-line-local', 600).crawls;
    const snow = autoRun('test-line-snow', 700).crawls;
    expect(dry.length).toBeGreaterThanOrEqual(2);
    expect(snow.length).toBeGreaterThanOrEqual(2);
    // 効きが落ちる条件でも、停止直前の低速走行が晴天の 2 倍を超えない。
    // 効き推定が「指令より強く効いている」を覚えられないと、狙いより強く減速して
    // 停止位置のはるか手前で速度を失い、残りを惰行でだらだら詰めることになる。
    const worst = (cs: ReadonlyArray<{ time: number; distance: number }>): number =>
      Math.max(...cs.map((c) => c.time));
    expect(worst(snow)).toBeLessThan(worst(dry) * 2);
    for (const c of snow) {
      expect(c.time).toBeLessThan(30);
      expect(c.distance).toBeLessThan(35);
    }
  });

  it('ブレーキの入切が極端に少ない（停車 1 回につきおおむね 1 回）', () => {
    const { applications, notchChanges, sim } = autoRun('test-line-local', 600);
    // 走行中の込め直しは停車回数程度で収まる
    expect(applications).toBeLessThanOrEqual(sim.metrics.stops.length);
    // ノッチの操作回数も、1 回の制動あたり数段の範囲に収まる
    expect(notchChanges).toBeLessThan(30);
  });

  it('止まる瞬間の減速度が小さい（停車の衝撃緩和）', () => {
    const { stopDecelerations, sim } = autoRun('test-line-local', 600);
    expect(stopDecelerations.length).toBeGreaterThanOrEqual(2);
    for (const decel of stopDecelerations) {
      // 常用最大の 1/5 以下。ノッチを入れたまま止まればこの数倍になる。
      expect(decel).toBeLessThan(sim.scenario.consist.brake.maxServiceDeceleration / 5);
    }
  });

  it('止まる直前ほどブレーキノッチが浅くなる', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.setAutoDrive(true);
    // 中原へ向かう制動中のノッチを速度ごとに拾う（停車が記録されたら打ち切る）
    const samples: Array<{ notch: number; speed: number }> = [];
    for (let i = 0; i < 8000; i++) {
      sim.step(0.05);
      if (sim.position < 3000) continue;
      if (sim.metrics.stops.length >= 2) break;
      const notch = sim.snapshot().brakeNotch;
      if (notch > 0) samples.push({ notch, speed: Math.abs(sim.speed) });
    }
    expect(samples.length).toBeGreaterThan(50);
    const fast = samples.filter((s) => s.speed > 10);
    const slow = samples.filter((s) => s.speed < 3);
    expect(fast.length).toBeGreaterThan(0);
    expect(slow.length).toBeGreaterThan(0);
    const maxFast = Math.max(...fast.map((s) => s.notch));
    const maxSlow = Math.max(...slow.map((s) => s.notch));
    expect(maxSlow).toBeLessThan(maxFast);
  });

  it('下り勾配では抑速（電気ブレーキ）で速度を保ち、空気ブレーキを入切しない', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.setAutoDrive(true);
    let applications = 0;
    let previousNotch = 0;
    let holdingSteps = 0;
    let steps = 0;
    // 33‰ の下り勾配区間（4600〜6000m）を通過するまで
    for (let i = 0; i < 20000 && sim.position < 6000; i++) {
      sim.step(0.05);
      if (sim.position < 4600) continue;
      const notch = sim.snapshot().brakeNotch;
      if (notch !== previousNotch) {
        if (previousNotch === 0) applications++;
        previousNotch = notch;
      }
      if (sim.effectiveInput.holdingNotch > 0) holdingSteps++;
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    // 抑速ブレーキを使っている
    expect(holdingSteps).toBeGreaterThan(0);
    // 勾配区間で常用ブレーキを入切していない
    expect(applications).toBe(0);
  });

  it('降雪でブレーキが効きにくくても停止位置に収まる', () => {
    const { sim } = autoRun('test-line-snow', 700);
    const stops = sim.metrics.stops.filter((s) => s.stationId !== 'stn-a');
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) {
      const station = sim.scenario.route.stations.find((s) => s.id === stop.stationId)!;
      expect(Math.abs(stop.stopError)).toBeLessThan(station.stopTolerance);
    }
  });

  it('停止現示の信号機の手前で止まり、現示がアップしたら自分で発進する', () => {
    // 先行列車を閉塞（1200〜2200m）に留め置いてから動かす。
    // sig-2 は先行列車の最後尾が 2200m を越えるまで停止現示のまま。
    const base = scenarioOf('test-line-following');
    const sim = new Simulation({
      ...base,
      scheduledTrains: [
        {
          id: 'preceding',
          length: 80,
          waypoints: [
            { time: 35940, position: 1500 },
            { time: 36180, position: 1500 },
            { time: 36330, position: 4000 },
          ],
        },
      ],
    });
    sim.setAutoDrive(true);

    // 停止現示のあいだは信号機を越えず、その手前で止まりきる
    let stopped = false;
    for (let i = 0; i < 8000; i++) {
      sim.step(0.05);
      if (sim.signalling.aspectOf('sig-2') !== 'R') break;
      expect(sim.position).toBeLessThan(1200);
      if (Math.abs(sim.speed) < 0.05 && sim.position > 1000) stopped = true;
    }
    expect(stopped).toBe(true);
    // 保安装置に止められたのではなく、自分で止まっている
    expect(sim.metrics.safety.patternBrakeCount).toBe(0);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
    // 現示がアップすれば自分で発進する
    for (let i = 0; i < 4000 && sim.position < 1400; i++) sim.step(0.05);
    expect(sim.position).toBeGreaterThan(1400);
  });

  it('ATS-SN 区間では確認扱いを行い、非常ブレーキに至らない', () => {
    const { sim } = autoRun('test-line-ats-sn', 700);
    expect(sim.metrics.safety.atsWarningCount).toBeGreaterThan(0);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
  });

  it('EB 装置を積んでいてもノッチを保持したまま走れる', () => {
    // 自動運転装置は連続して指令を出しているので、無操作とは見なされない
    const { sim } = autoRun('test-line-local', 600);
    expect(sim.scenario.hasVigilance).toBe(true);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
  });

  it('フレームレートを変えても同じ走行になる', () => {
    // 自動運転装置は制御周期（100Hz）の中で回るので、呼び出し間隔には依存しない
    const run = (dt: number): number => {
      const sim = new Simulation(scenarioOf('test-line-local'));
      sim.setAutoDrive(true);
      for (let i = 0; i < Math.round(120 / dt); i++) sim.step(dt);
      return stateHash(sim);
    };
    const reference = run(0.05);
    expect(run(0.01)).toBe(reference);
    expect(run(0.2)).toBe(reference);
  });

  it('手動へ戻すと運転士の操作がそのまま効く', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.setAutoDrive(true);
    for (let i = 0; i < 1600; i++) sim.step(0.05);
    expect(mpsToKmh(sim.speed)).toBeGreaterThan(30);
    sim.setAutoDrive(false);
    sim.input = { ...sim.input, powerNotch: 0, brakeNotch: 8, doorsClosed: true };
    for (let i = 0; i < 200; i++) sim.step(0.05);
    expect(sim.snapshot().brakeNotch).toBe(8);
    expect(sim.effectiveInput.brakeNotch).toBe(8);
  });
});
