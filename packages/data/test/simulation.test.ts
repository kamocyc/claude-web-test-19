import { beforeAll, describe, expect, it } from 'vitest';
import {
  AtcSystem,
  InputRecorder,
  NEUTRAL_INPUT,
  Simulation,
  SignallingSystem,
  consistLength,
  kmhToMps,
  mpsToKmh,
  replay,
  stateHash,
  type ControlInput,
  type Scenario,
} from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

const lib = createDefaultLibrary();
/**
 * EB 装置は「一定時間まったく操作が無い」と非常ブレーキをかける実装なので、
 * ノッチを固定したまま長時間走らせるテストでは意図せず動作してしまう。
 * EB 自体を検証するテスト以外では無効にしておく。
 */
const scenarioOf = (id: string): Scenario => ({ ...lib.scenario(id), hasVigilance: false });

const input = (over: Partial<ControlInput> = {}): ControlInput => ({
  ...NEUTRAL_INPUT,
  ...over,
});

/** dt 刻みで進めながら毎ステップ観測する */
function run(sim: Simulation, seconds: number, onStep?: (s: Simulation) => void, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.step(dt);
    onStep?.(sim);
  }
}

/**
 * 条件が成立するまで進める。上限時間を超えたら例外にする
 * （物理側の不具合で列車が止まったまま無限ループになるのを防ぐ）。
 */
function runUntil(
  sim: Simulation,
  done: (s: Simulation) => boolean,
  maxSeconds = 300,
  onStep?: (s: Simulation) => void,
  dt = 0.05,
): void {
  const limit = Math.round(maxSeconds / dt);
  for (let i = 0; i < limit; i++) {
    if (done(sim)) return;
    sim.step(dt);
    onStep?.(sim);
  }
  if (!done(sim)) {
    throw new Error(
      `${maxSeconds}s 以内に条件が成立しませんでした (pos=${sim.position.toFixed(1)}, v=${sim.speed.toFixed(2)})`,
    );
  }
}

describe('編成の公称性能', () => {
  it('起動加速度が公称値 3.3km/h/s に一致する', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    // トルク指令の立ち上がりを待ってから加速度を測る
    run(sim, 2);
    const v0 = sim.speed;
    run(sim, 3);
    const accel = mpsToKmh(sim.speed - v0) / 3;
    expect(accel).toBeGreaterThan(3.1);
    expect(accel).toBeLessThan(3.5);
  });

  it('常用最大ブレーキの減速度が公称値 3.5km/h/s に一致する', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    run(sim, 30);
    sim.input = input({ brakeNotch: 8 });
    run(sim, 3);
    const v0 = sim.speed;
    run(sim, 3);
    const decel = mpsToKmh(v0 - sim.speed) / 3;
    expect(decel).toBeGreaterThan(3.3);
    expect(decel).toBeLessThan(3.7);
  });

  it('乗車率が上がっても応荷重制御で減速度が保たれる', () => {
    const measure = (loadFactor: number) => {
      const scenario = { ...scenarioOf('test-line-local'), loadFactor };
      const sim = new Simulation(scenario);
      sim.input = input({ powerNotch: 4 });
      run(sim, 30);
      sim.input = input({ brakeNotch: 8 });
      run(sim, 4);
      const v0 = sim.speed;
      run(sim, 3);
      return mpsToKmh(v0 - sim.speed) / 3;
    };
    expect(Math.abs(measure(0) - measure(1))).toBeLessThan(0.15);
  });
});

describe('線形が走行に与える影響', () => {
  it('25‰ の上り勾配で惰行すると減速する', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    // 勾配区間（2000m〜3200m）へ入る手前まで加速する
    runUntil(sim, (s) => s.position >= 1900);
    sim.input = input();
    const v0 = sim.speed;
    runUntil(sim, (s) => s.position >= 3000 || s.speed < 1);
    expect(sim.speed).toBeLessThan(v0);
  });

  it('33‰ の下り勾配で惰行すると加速する', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    runUntil(
      sim,
      (s) => s.position >= 4500,
      300,
      (s) => {
        // 制限速度を超えないよう適当に抑える
        s.input = s.speed > kmhToMps(70) ? input() : input({ powerNotch: 4 });
      },
    );
    sim.input = input();
    const v0 = sim.speed;
    runUntil(sim, (s) => s.position >= 5600);
    expect(sim.speed).toBeGreaterThan(v0);
  });

  it('曲線を走ると非平衡横加速度が生じる', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    let maxLateral = 0;
    runUntil(
      sim,
      (s) => s.position >= 2300,
      300,
      (s) => {
        maxLateral = Math.max(maxLateral, Math.abs(s.snapshot().lateralAcceleration));
      },
    );
    expect(maxLateral).toBeGreaterThan(0.1);
    // 許容カント不足 60mm 相当（0.55 m/s^2）を大きくは超えない
    expect(maxLateral).toBeLessThan(1.0);
  });

  it('トンネル内では走行抵抗が増える', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    let sawTunnel = false;
    runUntil(
      sim,
      (s) => s.position >= 5500,
      400,
      (s) => {
        if (s.dynamics.vehicles[0]!.inTunnel) sawTunnel = true;
      },
    );
    expect(sawTunnel).toBe(true);
  });
});

describe('速度制限と編成長', () => {
  const route = lib.route('test-line');
  /** R400 の制限（4200〜）が明ける距離程 */
  const exit = route.speedLimitEntries.find(
    (e) => e.start > 4200 && e.speed > kmhToMps(100),
  )!.start;
  const trainLength = consistLength(lib.vehicle('commuter-4'));

  /** 制限区間の出口を惰行のまま渡る */
  const leaveLimit = (): Simulation => {
    const sim = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: exit - 200,
      startSpeed: kmhToMps(78),
    });
    sim.input = input();
    return sim;
  };

  it('先頭が制限区間を抜けても、最後部が抜けるまで制限が続く', () => {
    const sim = leaveLimit();
    // 先頭が抜けた直後 — 最後部はまだ曲線の中
    runUntil(sim, (s) => s.position > exit + 5);
    expect(sim.dynamics.rearPosition).toBeLessThan(exit);
    expect(mpsToKmh(sim.snapshot().speedLimit)).toBeCloseTo(80, 6);

    // 最後部まであと少し
    runUntil(sim, (s) => s.dynamics.rearPosition > exit - 5);
    expect(mpsToKmh(sim.snapshot().speedLimit)).toBeCloseTo(80, 6);
  });

  it('制限が明けるのは最後部が抜けた時点で、先頭端の判定より編成長ぶん遅い', () => {
    const sim = leaveLimit();
    runUntil(sim, (s) => s.snapshot().speedLimit > kmhToMps(100), 60, undefined, 0.005);
    expect(sim.dynamics.rearPosition).toBeCloseTo(exit, 0);
    // 先頭端で引いていたら exit で明けていたはずで、その差が編成長そのものになる
    expect(sim.position - exit).toBeGreaterThan(trainLength - 1);
    expect(sim.position - exit).toBeLessThan(trainLength + 1);
  });

  it('先頭が入った時点では効きはじめる（入るほうは先頭端）', () => {
    const sim = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: 4100,
      startSpeed: kmhToMps(78),
    });
    sim.input = input();
    expect(mpsToKmh(sim.snapshot().speedLimit)).toBeCloseTo(110, 6);
    runUntil(sim, (s) => s.position > 4205, 60, undefined, 0.005);
    // 最後部はまだ制限の手前にいるが、先頭が入っているので制限がかかる
    expect(sim.dynamics.rearPosition).toBeLessThan(4200);
    expect(mpsToKmh(sim.snapshot().speedLimit)).toBeCloseTo(80, 6);
  });

  it('自動運転は最後部が抜けるまで加速を始めない', () => {
    const sim = leaveLimit();
    sim.setAutoDrive(true);
    let poweredAt: number | null = null;
    runUntil(
      sim,
      (s) => s.dynamics.rearPosition > exit + 100,
      120,
      (s) => {
        if (poweredAt === null && s.effectiveInput.powerNotch > 0) poweredAt = s.position;
      },
      0.005,
    );
    expect(poweredAt).not.toBeNull();
    // 先頭端で引いていれば exit の時点で力行できてしまう
    expect(poweredAt!).toBeGreaterThan(exit + trainLength - 1);
  });
});

describe('閉塞と信号現示', () => {
  it('先行列車がいる閉塞は停止現示になる', () => {
    const sim = new Simulation(scenarioOf('test-line-following'));
    const byId = new Map(sim.signalling.snapshot().map((s) => [s.id, s.aspect]));
    // 先行列車は開始時点で 1466m 付近 = 閉塞 sig-2 (1200-2200) に在線
    expect(byId.get('sig-2')).toBe('R');
    // 自列車も閉塞 sig-1 (200-1200) に在線しているので sig-1 も停止現示
    expect(byId.get('sig-1')).toBe('R');
    // 前方の閉塞は空いている
    expect(byId.get('sig-3')).not.toBe('R');
  });

  it('停止現示の手前は R → Y → YG → G と段階的に現示アップする', () => {
    const route = lib.route('test-line');
    const signalling = new SignallingSystem(route, []);
    // 閉塞 sig-5 (4200-5200) だけに列車がいる状態を作る
    signalling.update({ rear: 4500, front: 4580 }, 0);
    expect(signalling.aspectOf('sig-5')).toBe('R');
    expect(signalling.aspectOf('sig-4')).toBe('YY');
    expect(signalling.aspectOf('sig-3')).toBe('Y');
    expect(signalling.aspectOf('sig-2')).toBe('YG');
    expect(signalling.aspectOf('sig-1')).toBe('G');
    // 通過後の信号は進行現示に戻る
    expect(signalling.aspectOf('sig-6')).toBe('G');
  });

  it('先行列車が進むと後方の信号が現示アップする', () => {
    const sim = new Simulation(scenarioOf('test-line-following'));
    expect(sim.signalling.aspectOf('sig-2')).toBe('R');
    // 自列車は停めたまま時間だけ進める
    run(sim, 150);
    expect(sim.signalling.aspectOf('sig-2')).not.toBe('R');
  });

  it('自列車の在線でも信号が停止現示になる', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    runUntil(sim, (s) => s.position >= 1500);
    // 自列車が閉塞 sig-2 に在線している
    expect(sim.signalling.aspectOf('sig-2')).toBe('R');
  });
});

describe('ATS-P', () => {
  it('停止現示に接近するとパターンブレーキが動作し、信号手前で止まる', () => {
    const sim = new Simulation(scenarioOf('test-line-following'));
    sim.input = input({ powerNotch: 4 });
    let patternBraked = false;
    let minPatternSpeed = Infinity;
    for (let i = 0; i < 3000; i++) {
      sim.step(0.05);
      const snap = sim.snapshot();
      if (snap.safety.serviceBrakeNotch !== null) patternBraked = true;
      if (snap.safety.indication.patternSpeed !== null) {
        minPatternSpeed = Math.min(minPatternSpeed, snap.safety.indication.patternSpeed);
      }
      if (sim.speed < 0.01 && patternBraked) break;
    }
    expect(patternBraked).toBe(true);
    expect(minPatternSpeed).toBeLessThan(kmhToMps(20));
    // 停止現示の信号機（1200m）を冒進していない
    expect(sim.position).toBeLessThan(1200);
    expect(sim.metrics.safety.emergencyBrakeCount).toBe(0);
  });

  it('パターン速度が理論式 v^2 = 2 a L と整合する', () => {
    const sim = new Simulation(scenarioOf('test-line-following'));
    sim.input = input({ powerNotch: 1 });
    // 最初の ATS-P 地上子（600m 地点）を通過させる
    runUntil(sim, (s) => s.position >= 700);
    const snap = sim.snapshot();
    const distance = 1200 - sim.position;
    // ATS-P の既定値: 減速度 0.7m/s^2、余裕距離 20m、応答時間 2s
    const a = 0.7;
    const tr = 2.0;
    const d = distance - 20;
    const expected = -a * tr + Math.sqrt(a * a * tr * tr + 2 * a * d);
    // パターンは直近の制御周期（10ms 前）の位置で計算されているため、その分の誤差を許す
    expect(snap.safety.indication.patternSpeed!).toBeCloseTo(expected, 2);
  });

  it('速度制限に対してもパターンを生成する', () => {
    // 先行列車のいない条件で、R600 曲線（95km/h 制限）へ高速で接近する
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    let limitPatternSeen = false;
    runUntil(
      sim,
      (s) => s.position >= 1500,
      300,
      (s) => {
        const patterns = s.snapshot().safety.indication.patternSpeed;
        if (patterns !== null && patterns < kmhToMps(100) && s.position > 1000) {
          limitPatternSeen = true;
        }
      },
    );
    expect(limitPatternSeen).toBe(true);
    // 制限区間に入るときには制限速度以下になっている
    expect(mpsToKmh(sim.speed)).toBeLessThan(97);
  });

  it('停止現示の信号機を冒進すると非常ブレーキがかかる', () => {
    // ATS-P を積まない構成にして、意図的に信号を冒進させる
    const scenario = { ...scenarioOf('test-line-following'), safetySystems: [] as never[] };
    const withoutAtsP = new Simulation(scenario);
    withoutAtsP.input = input({ powerNotch: 4 });
    runUntil(withoutAtsP, (s) => s.position >= 1300);
    expect(withoutAtsP.position).toBeGreaterThan(1200);

    const withAtsP = new Simulation(scenarioOf('test-line-following'));
    withAtsP.input = input({ powerNotch: 4 });
    // 停止現示が続いているあいだは信号機を越えられない。
    // 現示がアップしたあとは進行してよいので、そこで観測を打ち切る。
    for (let i = 0; i < 4000; i++) {
      if (withAtsP.signalling.aspectOf('sig-2') !== 'R') break;
      withAtsP.step(0.05);
    }
    expect(withAtsP.position).toBeLessThan(1200);
    expect(Math.abs(withAtsP.speed)).toBeLessThan(0.1);
  });

  it('停止現示の手前で止まっても、現示がアップすれば発進できる', () => {
    // パターンの余裕距離の内側には次の地上子が無いため、停車したまま現示アップを
    // 受け取れずに動けなくなる、ということがあってはならない。
    const sim = new Simulation(scenarioOf('test-line-following'));
    sim.input = input({ powerNotch: 4 });
    runUntil(sim, (s) => s.signalling.aspectOf('sig-2') !== 'R', 300);
    const stoppedAt = sim.position;
    expect(stoppedAt).toBeLessThan(1200);
    runUntil(sim, (s) => s.position > 1250, 120);
    expect(sim.position).toBeGreaterThan(1250);
  });
});

describe('ATS-SN', () => {
  it('停止現示のロング地上子で警報が鳴り、確認扱いが無ければ非常ブレーキになる', () => {
    const sim = new Simulation(scenarioOf('test-line-ats-sn'));
    sim.input = input({ powerNotch: 4 });
    let bellRang = false;
    let emergency = false;
    for (let i = 0; i < 1000; i++) {
      sim.step(0.05);
      const snap = sim.snapshot();
      if (snap.safety.indication.bell) bellRang = true;
      if (snap.safety.emergencyBrake) {
        emergency = true;
        break;
      }
    }
    expect(bellRang).toBe(true);
    expect(emergency).toBe(true);
    // ロング地上子（600m）を過ぎてから 5 秒以内に動作している
    expect(sim.position).toBeGreaterThan(600);
    expect(sim.position).toBeLessThan(900);
  });

  it('確認扱いを行えば非常ブレーキにならない（ただし信号は冒進できる）', () => {
    const sim = new Simulation(scenarioOf('test-line-ats-sn'));
    sim.input = input({ powerNotch: 4 });
    let acknowledged = false;
    let emergencyBeforeSignal = false;
    for (let i = 0; i < 2000; i++) {
      const snap = sim.snapshot();
      if (snap.safety.indication.bell && !acknowledged) {
        sim.input = input({ powerNotch: 4, acknowledge: true });
        acknowledged = true;
      } else if (acknowledged) {
        sim.input = input({ powerNotch: 4 });
      }
      sim.step(0.05);
      if (sim.position < 1195 && sim.snapshot().safety.emergencyBrake) {
        emergencyBeforeSignal = true;
        break;
      }
      if (sim.position > 1150) break;
    }
    expect(acknowledged).toBe(true);
    expect(emergencyBeforeSignal).toBe(false);
  });

  it('停止現示の直下地上子を通過すると即時に非常ブレーキになる', () => {
    const sim = new Simulation(scenarioOf('test-line-ats-sn'));
    sim.input = input({ powerNotch: 2 });
    let emergencyPosition = 0;
    for (let i = 0; i < 4000; i++) {
      // 警報が鳴るたびに確認扱いを行う（押し下げの立ち上がりで検出される）
      const bell = sim.snapshot().safety.indication.bell;
      sim.input = input({ powerNotch: 2, acknowledge: bell && i % 2 === 0 });
      sim.step(0.05);
      if (sim.snapshot().safety.emergencyBrake) {
        emergencyPosition = sim.position;
        break;
      }
    }
    expect(emergencyPosition).toBeGreaterThan(1190);
    expect(emergencyPosition).toBeLessThan(1210);
  });
});

describe('EB 装置', () => {
  it('無操作が続くと警報を経て非常ブレーキになる', () => {
    const sim = new Simulation({
      ...scenarioOf('test-line-local'),
      safetySystems: [],
      hasVigilance: true,
    });
    sim.input = input({ powerNotch: 2 });
    run(sim, 5);
    // 以降は一切操作しない（入力オブジェクトも変えない）
    let emergency = false;
    for (let i = 0; i < 3000; i++) {
      sim.step(0.05);
      if (sim.snapshot().safety.emergencyBrake) {
        emergency = true;
        break;
      }
    }
    expect(emergency).toBe(true);
    expect(sim.elapsed).toBeGreaterThan(60);
    expect(sim.elapsed).toBeLessThan(80);
  });
});

describe('駅の取り扱いと運転評価', () => {
  it('停止位置に止まると停車が記録され、誤差が算出される', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    const target = 3500; // 中原駅の停止位置
    // 単純な自動運転: 目標速度まで加速し、停止パターンに沿って減速する
    for (let i = 0; i < 20000; i++) {
      // 目標地点で 0 になる減速パターンを引き、それに追従するようノッチを選ぶ
      const remaining = target - sim.position;
      const patternSpeed = Math.sqrt(Math.max(0, 2 * 0.75 * Math.max(0, remaining - 3)));
      const cruise = Math.min(kmhToMps(75), sim.currentSpeedLimit * 0.9);
      if (sim.speed > patternSpeed) {
        const excess = sim.speed - patternSpeed;
        const notch = Math.max(1, Math.min(8, Math.ceil(excess * 6)));
        sim.input = input({ brakeNotch: notch });
      } else if (sim.speed < Math.min(cruise, patternSpeed - 1)) {
        sim.input = input({ powerNotch: 4 });
      } else {
        sim.input = input();
      }
      sim.step(0.05);
      if (sim.position > 3300 && sim.speed < 0.01) break;
    }
    expect(sim.speed).toBeLessThan(0.05);
    const stops = sim.metrics.stops;
    expect(stops.length).toBeGreaterThanOrEqual(1);
    const stnB = stops.find((s) => s.stationId === 'stn-b');
    expect(stnB).toBeDefined();
    expect(Math.abs(stnB!.stopError)).toBeLessThan(20);
  });

  it('乗り心地・電力量の指標が記録される', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    run(sim, 40);
    sim.input = input({ brakeNotch: 6 });
    run(sim, 30);
    expect(sim.metrics.ride.maxAcceleration).toBeGreaterThan(0.5);
    expect(sim.metrics.ride.maxDeceleration).toBeGreaterThan(0.5);
    expect(sim.metrics.ride.maxJerk).toBeGreaterThan(0);
    expect(sim.metrics.energy.consumed).toBeGreaterThan(0);
    // 電気ブレーキで回生電力が発生している
    expect(sim.metrics.energy.regenerated).toBeGreaterThan(0);
  });

  /**
   * 乗客のよろけは加速度の**大きさ**ではなく**変え方**で決まる。
   *
   * 発車がいちばん分かりやすい。フルノッチで起動すると引張力が 1 秒足らずで
   * 立ち上がるので、立っている乗客は取り残されて足を出す。同じ加速度でも
   * 1 ノッチずつ入れれば、加速度がゆっくり育つので踏み出さずに済む。
   */
  it('フルノッチで発車すると乗客が足を出し、刻んで発車すれば出さない', () => {
    const depart = (notches: readonly number[], hold: number) => {
      const sim = new Simulation(scenarioOf('test-line-local'));
      let maxStagger = 0;
      const watch = (s: Simulation) => {
        maxStagger = Math.max(maxStagger, s.dynamics.vehicles[0]!.body.passenger.stance.stagger);
      };
      for (const notch of notches) {
        sim.input = input({ powerNotch: notch });
        run(sim, hold, watch, 0.01);
      }
      run(sim, 10, watch, 0.01);
      return { steps: sim.metrics.ride.passengerSteps, maxStagger, speed: sim.speed };
    };

    const sudden = depart([4], 12);
    const gradual = depart([1, 2, 3, 4], 3);

    // 同じところまで加速している
    expect(gradual.speed).toBeGreaterThan(sudden.speed * 0.85);
    expect(sudden.steps).toBeGreaterThan(0);
    expect(gradual.steps).toBe(0);
    expect(sudden.maxStagger).toBeGreaterThan(1);
    expect(gradual.maxStagger).toBeLessThan(1);
  });

  /**
   * ブレーキは事情が違う。BC 圧にはむだ時間と込め時定数があるため、ノッチを一気に
   * 入れても**減速度の立ち上がりは装置の側で鈍らされる**。それでも一気に入れれば
   * よろけ方は大きくなるが、足が出るところまでは行かない。
   * 乗客を放り出すのは、ブレーキの応答より速い変化のほうである。
   */
  it('ブレーキを一気に入れると乗客がよろけ、刻めばよろけない', () => {
    const brake = (notches: readonly number[], hold: number) => {
      const sim = new Simulation(scenarioOf('test-line-local'));
      sim.input = input({ powerNotch: 4 });
      run(sim, 40);
      sim.input = input();
      run(sim, 5);
      // 発車の衝動は評価に入れない（見たいのはブレーキの入れ方の違い）
      const before = sim.metrics.ride.passengerSteps;
      let maxStagger = 0;
      const watch = (s: Simulation) => {
        maxStagger = Math.max(maxStagger, s.dynamics.vehicles[0]!.body.passenger.stance.stagger);
      };
      for (const notch of notches) {
        sim.input = input({ brakeNotch: notch });
        run(sim, hold, watch, 0.01);
      }
      run(sim, 10, watch, 0.01);
      return {
        steps: sim.metrics.ride.passengerSteps - before,
        maxStagger,
        ride: sim.metrics.ride,
      };
    };

    const sudden = brake([8], 12);
    const gradual = brake([2, 4, 6, 8], 3);

    // 到達する減速度はほぼ同じ
    expect(gradual.ride.maxDeceleration).toBeGreaterThan(sudden.ride.maxDeceleration * 0.9);
    // 込め時定数のおかげでどちらも足は出ない。それでも踏ん張りの深さは違う。
    expect(sudden.steps).toBe(0);
    expect(gradual.steps).toBe(0);
    expect(sudden.maxStagger).toBeGreaterThan(gradual.maxStagger * 1.3);
  });
});

describe('分岐器の通過', () => {
  const turnoutOf = (id: string, turnoutId: string) =>
    scenarioOf(id).route.turnouts.get(turnoutId)!;

  /**
   * 分岐器の 250m 手前から、指定の速度で**惰行のまま**入って通過する。
   *
   * ノッチを動かすとその衝動が乗客に効いてしまうので、分岐器そのものの影響だけを
   * 見るために惰行で渡る。保安装置も切ってある（分岐制限に ATS-P のパターンが
   * 掛かると、制限超過で渡るという条件そのものが成立しない）。
   */
  const cross = (id: string, turnoutId: string, kmh: number) => {
    const base = scenarioOf(id);
    const turnout = turnoutOf(id, turnoutId);
    const sim = new Simulation({
      ...base,
      safetySystems: [],
      startPosition: turnout.position - 250,
      startSpeed: kmhToMps(kmh),
    });
    sim.input = input();
    // 走り出しの過渡（惰行抵抗が立ち上がるぶん）が収まってから測り始める
    runUntil(sim, (s) => s.position > turnout.position - 60, 60, undefined, 0.005);
    const before = { steps: sim.metrics.ride.passengerSteps, speed: sim.speed };
    let maxRoll = 0;
    let maxStagger = 0;
    let maxLateral = 0;
    runUntil(
      sim,
      (s) => s.position > turnout.position + turnout.length + 20,
      60,
      (s) => {
        const body = s.dynamics.vehicles[0]!.body;
        maxRoll = Math.max(maxRoll, Math.abs(body.roll));
        maxStagger = Math.max(maxStagger, body.passenger.stance.stagger);
        maxLateral = Math.max(maxLateral, Math.abs(body.feltLateral));
      },
      0.005,
    );
    const steps = sim.metrics.ride.passengerSteps - before.steps;
    return { sim, turnout, before, maxRoll, maxStagger, maxLateral, steps };
  };

  /**
   * 直進側に制限は無いので線路最高速度のまま渡れる。それでもクロッシングの欠線は
   * 踏むので、車体は揺れる（欠線は片方のレールにしかないのでロールになる）。
   */
  it('直進側でも分岐器を通れば車体が揺れる', () => {
    const crossing = cross('test-line-turnout', 'to-3', 100);
    expect(mpsToKmh(crossing.before.speed)).toBeGreaterThan(90);
    expect(crossing.maxRoll).toBeGreaterThan(0.0004);
    // 揺れはするが、よろけるほどではない
    expect(crossing.maxStagger).toBeLessThan(1);
    expect(crossing.steps).toBe(0);
  });

  /**
   * 2 番線から出る列車は、緩和曲線もカントも無い R350 を戻し曲線と合わせて
   * **逆向きに 2 度**通ることになる。制限（45km/h）を無視して渡れば横 G が
   * 階段状に立ち上がり、しかも符号が反転するので、立っている乗客は足を出す。
   */
  it('分岐側を制限速度超過で渡ると乗客がよろける', () => {
    const fast = cross('test-line-loop', 'to-2', 90);
    expect(mpsToKmh(fast.before.speed)).toBeGreaterThan(80);
    // R350 を 90km/h → v²/R = 1.8 m/s²。許容カント不足の範囲をはるかに超える。
    expect(fast.maxLateral).toBeGreaterThan(1.5);
    expect(fast.maxStagger).toBeGreaterThan(1);
    expect(fast.steps).toBeGreaterThan(0);
  });

  /** 制限速度まで落として渡れば、同じ分岐器でも横 G は乗り心地の範囲に収まる */
  it('制限速度まで落として渡ればよろけない', () => {
    const slow = cross('test-line-loop', 'to-2', 45);
    // R350 を 45km/h → 0.45 m/s²。カント不足に直せば 48mm で、許容値の内側。
    expect(slow.maxLateral).toBeLessThan(0.7);
    expect(slow.maxStagger).toBeLessThan(1);
    expect(slow.steps).toBe(0);
  });

  /** 分岐器の位置と開通方向はスナップショットから読める（HUD の表示に使う） */
  it('次の分岐器がスナップショットに出る', () => {
    const sim = new Simulation(scenarioOf('test-line-loop'));
    const snap = sim.snapshot();
    expect(snap.nextTurnout).not.toBeNull();
    // 起点駅の 2 番線に停まっているので、次は交換設備の出口（背向・分岐側）
    expect(snap.nextTurnout!.turnout.id).toBe('to-2');
    expect(snap.nextTurnout!.turnout.route).toBe('diverging');
    expect(snap.nextTurnout!.distance).toBeGreaterThan(0);
    expect(mpsToKmh(snap.nextTurnout!.turnout.divergingSpeed)).toBeCloseTo(45, 6);
  });
});

describe('決定論とリプレイ', () => {
  let hashA = 0;
  let hashB = 0;

  const script: Array<{ at: number; input: ControlInput }> = [
    { at: 0, input: input({ powerNotch: 4 }) },
    { at: 12, input: input({ powerNotch: 2 }) },
    { at: 20, input: input() },
    { at: 26, input: input({ brakeNotch: 5 }) },
    { at: 40, input: input({ brakeNotch: 8 }) },
  ];

  const drive = (dt: number): { sim: Simulation; recorder: InputRecorder } => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    const recorder = new InputRecorder(NEUTRAL_INPUT);
    const total = 50;
    const steps = Math.round(total / dt);
    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      for (const entry of script) {
        if (t >= entry.at) sim.input = entry.input;
      }
      recorder.record(t, sim.input);
      sim.step(dt);
    }
    recorder.record(total, sim.input);
    return { sim, recorder };
  };

  beforeAll(() => {
    hashA = stateHash(drive(0.05).sim);
    hashB = stateHash(drive(0.05).sim);
  });

  it('同じ入力なら同じ状態になる', () => {
    expect(hashA).toBe(hashB);
  });

  it('呼び出し間隔（フレームレート）を変えても結果が一致する', () => {
    const coarse = stateHash(drive(0.2).sim);
    const fine = stateHash(drive(0.01).sim);
    expect(coarse).toBe(hashA);
    expect(fine).toBe(hashA);
  });

  it('記録した入力を再生すると同じ走行になる', () => {
    const { sim, recorder } = drive(0.05);
    const recording = recorder.toRecording('test-line-local', 20240101);
    const replayed = new Simulation(scenarioOf('test-line-local'));
    replay(replayed, recording, 0.05);
    expect(replayed.position).toBeCloseTo(sim.position, 6);
    expect(replayed.speed).toBeCloseTo(sim.speed, 9);
  });
});

describe('多質点モードと単一質点モード', () => {
  it('単一質点モードでも同じ運転で概ね同じ位置に到達する', () => {
    const runMode = (rigidConsist: boolean) => {
      const sim = new Simulation({ ...scenarioOf('test-line-local'), rigidConsist });
      sim.input = input({ powerNotch: 4 });
      run(sim, 60);
      return sim.position;
    };
    const flexible = runMode(false);
    const rigid = runMode(true);
    expect(Math.abs(flexible - rigid)).toBeLessThan(5);
  });

  it('多質点モードでは勾配変化点で連結器力が発生する', () => {
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    let maxCoupler = 0;
    runUntil(
      sim,
      (s) => s.position >= 3500,
      400,
      (s) => {
        maxCoupler = Math.max(maxCoupler, s.dynamics.maxCouplerForce);
      },
    );
    expect(maxCoupler).toBeGreaterThan(1000);
  });
});

describe('ATC（車内信号方式）', () => {
  it('デジタル ATC は停止点までのパターンで一段減速し、信号手前で止まる', () => {
    const base = scenarioOf('test-line-following');
    const sim = new Simulation(
      { ...base, safetySystems: [] },
      { safetyFactory: () => new AtcSystem({ mode: 'digital' }) },
    );
    sim.input = input({ powerNotch: 4 });
    let braked = false;
    for (let i = 0; i < 4000; i++) {
      sim.step(0.05);
      if (sim.snapshot().safety.serviceBrakeNotch !== null) braked = true;
      if (braked && sim.speed < 0.01) break;
    }
    expect(braked).toBe(true);
    expect(sim.position).toBeLessThan(1200);
  });

  it('段階 ATC は車内信号の現示速度を超えるとブレーキが動作する', () => {
    const base = scenarioOf('test-line-following');
    const sim = new Simulation(
      { ...base, safetySystems: [] },
      { safetyFactory: () => new AtcSystem({ mode: 'step' }) },
    );
    sim.input = input({ powerNotch: 4 });
    let maxSpeedSeen = 0;
    let cabSpeedSeen: number | null = null;
    for (let i = 0; i < 2000; i++) {
      sim.step(0.05);
      const snap = sim.snapshot();
      maxSpeedSeen = Math.max(maxSpeedSeen, sim.speed);
      if (snap.safety.indication.cabSignalSpeed !== null) {
        cabSpeedSeen = snap.safety.indication.cabSignalSpeed;
      }
      if (sim.position > 1100) break;
    }
    expect(cabSpeedSeen).not.toBeNull();
    // 閉塞 sig-1 の現示（先行列車が 2 閉塞先にいるので注意〜減速現示）を超えない
    expect(maxSpeedSeen).toBeLessThan(cabSpeedSeen! + 2);
  });

  it('ATC はパターン速度を車内信号として表示する', () => {
    const base = scenarioOf('test-line-following');
    const sim = new Simulation(
      { ...base, safetySystems: [] },
      { safetyFactory: () => new AtcSystem({ mode: 'digital' }) },
    );
    sim.input = input({ powerNotch: 2 });
    run(sim, 10);
    const snap = sim.snapshot();
    expect(snap.safety.indication.cabSignalSpeed).not.toBeNull();
    expect(snap.safety.indication.patternSpeed).not.toBeNull();
  });
});

describe('抑速ブレーキ（運転士の抑速位置）', () => {
  /** 33‰ の下り勾配（4600〜6000m）の途中から、抑速位置に入れたまま走らせる */
  function runHolding(seconds: number, startSpeedKmh = 70) {
    const sim = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: 4750,
      startSpeed: kmhToMps(startSpeedKmh),
    });
    sim.input = input({ holding: true });
    const notches: number[] = [];
    run(sim, seconds, (s) => notches.push(s.snapshot().holdingNotch));
    return { sim, notches };
  }

  it('段を指示しなくても、装置が電気ブレーキの段を選んで速度を保つ', () => {
    const { sim, notches } = runHolding(60);
    const snap = sim.snapshot();
    // 33‰ を下りながら、入れた時点の速度（70km/h）付近に収まっている
    expect(mpsToKmh(sim.speed)).toBeGreaterThan(66);
    expect(mpsToKmh(sim.speed)).toBeLessThan(76);
    // 運転士は段を指示していないが、装置は段を選んでいる
    expect(sim.input.holdingNotch).toBe(0);
    expect(Math.max(...notches)).toBeGreaterThan(0);
    // 抑速は電気ブレーキだけで受け持つ（空気ブレーキは立たない）
    expect(snap.brakeNotch).toBe(0);
    expect(snap.electricBrakeForce).toBeGreaterThan(0);
    expect(snap.airBrakeForce).toBeLessThan(1000);
  });

  it('平坦線では段を出さない（抑速は勾配を抑える装置であって、止める装置ではない）', () => {
    // 目標速度を上回らないかぎり段は出ない。したがって平坦線で抑速位置に入れっぱなしに
    // しても、走行抵抗だけで減っていく惰行とまったく同じ走りになる。
    const base = {
      ...scenarioOf('test-line-local'),
      startPosition: 700,
      startSpeed: kmhToMps(70),
    };
    const holding = new Simulation(base);
    holding.input = input({ holding: true });
    run(holding, 60);

    const coasting = new Simulation(base);
    coasting.input = input();
    run(coasting, 60);

    expect(holding.snapshot().holdingNotch).toBe(0);
    expect(holding.snapshot().electricBrakeForce).toBe(0);
    expect(mpsToKmh(holding.speed)).toBeCloseTo(mpsToKmh(coasting.speed), 6);
  });

  it('常用ブレーキを込めると抑速は外れる', () => {
    const sim = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: 4750,
      startSpeed: kmhToMps(70),
    });
    sim.input = input({ holding: true });
    run(sim, 20);
    expect(sim.snapshot().holdingNotch).toBeGreaterThan(0);

    sim.input = input({ holding: true, brakeNotch: 3 });
    run(sim, 2);
    const snap = sim.snapshot();
    expect(snap.holdingNotch).toBe(0);
    expect(snap.brakeNotch).toBe(3);
  });

  it('抑速ブレーキを持たない車両では効かない', () => {
    const base = scenarioOf('test-line-local');
    const sim = new Simulation({
      ...base,
      consist: { ...base.consist, brake: { ...base.consist.brake, hasHoldingBrake: false } },
      startPosition: 4750,
      startSpeed: kmhToMps(70),
    });
    sim.input = input({ holding: true });
    run(sim, 30);
    expect(sim.snapshot().holdingNotch).toBe(0);
    // 抑えるものが無いので 33‰ で加速していく
    expect(mpsToKmh(sim.speed)).toBeGreaterThan(72);
  });
});

describe('逆転ハンドル', () => {
  /** 平坦線の駅で止まっている状態から始める */
  const standing = (): Simulation => new Simulation(scenarioOf('test-line-local'));

  it('中立では力行が出ない', () => {
    const sim = standing();
    sim.input = input({ powerNotch: 4, reverser: 0 });
    run(sim, 10);
    expect(sim.snapshot().powerNotch).toBe(0);
    expect(mpsToKmh(sim.speed)).toBeLessThan(0.1);
  });

  it('後位では逆向きに走り、距離程が減る', () => {
    const sim = standing();
    const start = sim.dynamics.frontPosition;
    sim.input = input({ powerNotch: 2, reverser: -1 });
    run(sim, 20);

    expect(sim.speed).toBeLessThan(0);
    expect(sim.dynamics.frontPosition).toBeLessThan(start);
    // 前位で同じノッチを入れたときと速さの出方は変わらない（向きだけが違う）
    const forward = standing();
    forward.input = input({ powerNotch: 2 });
    run(forward, 20);
    expect(Math.abs(sim.speed)).toBeCloseTo(forward.speed, 1);
  });

  it('後退中は地上子を踏まない（保安装置は前進を前提にしている）', () => {
    const sim = standing();
    sim.input = input({ powerNotch: 2, reverser: -1 });
    run(sim, 20);
    // 逆走で地上子を踏んでパターンが立てば非常が落ちる。落ちていないことを見る。
    expect(sim.snapshot().safety.emergencyBrake).toBe(false);
  });
});

describe('耐雪ブレーキ', () => {
  it('入れると緩解中でも BC 圧が立ち、惰行の伸びが鈍る', () => {
    const coast = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: 1000,
      startSpeed: kmhToMps(60),
    });
    coast.input = input();
    run(coast, 20);

    const snow = new Simulation({
      ...scenarioOf('test-line-local'),
      startPosition: 1000,
      startSpeed: kmhToMps(60),
    });
    snow.input = input({ snowproofBrake: true });
    run(snow, 20);

    expect(snow.snapshot().cylinderPressure).toBeGreaterThan(1000);
    expect(coast.snapshot().cylinderPressure).toBeLessThan(1000);
    expect(snow.speed).toBeLessThan(coast.speed);
  });
});
