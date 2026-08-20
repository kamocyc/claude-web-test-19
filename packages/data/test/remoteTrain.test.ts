import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_INPUT,
  RemoteTrain,
  Simulation,
  gearMeshFrequencyAt,
  type ControlInput,
  type Scenario,
  type ScheduledTrain,
} from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';

const lib = createDefaultLibrary();

const input = (over: Partial<ControlInput> = {}): ControlInput => ({ ...NEUTRAL_INPUT, ...over });

const scenarioOf = (id: string): Scenario => ({ ...lib.scenario(id), hasVigilance: false });

/** ダイヤ列車を差し替えたシナリオ */
function withTrains(id: string, trains: ScheduledTrain[]): Scenario {
  return { ...scenarioOf(id), scheduledTrains: trains };
}

/** dt 刻みで進めながら毎ステップ観測する */
function run(sim: Simulation, seconds: number, onStep?: (s: Simulation) => void, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.step(dt);
    onStep?.(sim);
  }
}

/** 10:00:00 からの秒数で折れ線を書く */
const at = (seconds: number): number => 10 * 3600 + seconds;

function opposing(waypoints: Array<[number, number]>): ScheduledTrain[] {
  return [
    {
      id: 'opposing',
      length: 80,
      track: 'adjacent',
      waypoints: waypoints.map(([time, position]) => ({ time: at(time), position })),
    },
  ];
}

describe('ダイヤ列車の装置', () => {
  it('ダイヤ列車にも自列車と同じ装置一式が付く', () => {
    const sim = new Simulation(scenarioOf('test-line-opposing'));
    run(sim, 12);
    const train = sim.remoteTrains.get('opposing');
    expect(train).toBeInstanceOf(RemoteTrain);
    // 走らせているのは自列車とまったく同じ実装
    expect(train!.traction.driveState.kind).toBe(sim.traction.driveState.kind);
    expect(train!.doors.state.phase).toBe('closed');
  });

  it('ダイヤどおりの位置と速度で走る', () => {
    // 470m から 20m まで 16 秒（＝ 28.1m/s）
    const sim = new Simulation(
      withTrains(
        'test-line-opposing',
        opposing([
          [0, 470],
          [16, 20],
        ]),
      ),
    );
    run(sim, 8);
    const train = sim.remoteTrains.get('opposing')!;
    expect(train.leadPosition).toBeCloseTo(470 - 28.125 * 8, 0);
    expect(train.speed).toBeCloseTo(28.125, 2);
    // 距離程は減っていくが、車輪は前へ回っている（装置は向きを知らない）
    expect(train.direction).toBe(-1);
    expect(train.dynamics.vehicles[0]!.axles[0]!.omega).toBeGreaterThan(0);
  });

  it('編成は先頭端から進行方向の後ろへ伸びる', () => {
    const sim = new Simulation(
      withTrains(
        'test-line-opposing',
        opposing([
          [0, 470],
          [16, 20],
        ]),
      ),
    );
    run(sim, 8);
    const train = sim.remoteTrains.get('opposing')!;
    const centres = train.dynamics.vehicles.map((v) => v.s);
    // 対向列車なので、編成は距離程の**大きい**側へ伸びる
    expect(centres[0]!).toBeLessThan(centres[centres.length - 1]!);
    const half = train.dynamics.vehicles[0]!.spec.length / 2;
    expect(centres[0]! - half).toBeCloseTo(train.leadPosition, 6);
    expect(centres[centres.length - 1]! + half - train.leadPosition).toBeCloseTo(80, 6);
  });

  it('歯車のかみ合いは速度どおりに鳴る', () => {
    const sim = new Simulation(scenarioOf('test-line-opposing'));
    run(sim, 12);
    const train = sim.remoteTrains.get('opposing')!;
    const motored = sim.scenario.consist.vehicles.find((v) => v.traction)!;
    const expected = gearMeshFrequencyAt(motored.traction!, motored.wheelDiameter, train.speed);
    // 空転を積分していないので、車輪は車速どおりに回っている（＝ぴったり一致する）
    expect(train.traction.driveState.gearMeshFrequency).toBeCloseTo(expected, 3);
  });

  it('等速で走るには走行抵抗ぶんの力行が要る（ゲートが開く）', () => {
    const sim = new Simulation(scenarioOf('test-line-opposing'));
    run(sim, 12);
    const train = sim.remoteTrains.get('opposing')!;
    const drive = train.traction.driveState;
    // 平坦を 100km/h で保つには軽い力行が要る。ノッチは入るが最大にはならない。
    expect(train.requiredForce).toBeGreaterThan(0);
    expect(train.powerNotch).toBeGreaterThan(0);
    expect(train.powerNotch).toBeLessThan(sim.scenario.consist.traction.notchCount);
    expect(train.brakeNotch).toBe(0);
    // インバータのゲートが開いているので磁気音が出る
    expect(drive.kind).toBe('vvvf');
    if (drive.kind === 'vvvf') {
      expect(drive.mode).not.toBe('off');
      expect(drive.fundamentalFrequency).toBeGreaterThan(0);
    }
  });

  it('ダイヤが減速していればブレーキが掛かる', () => {
    // 20 秒かけて 28m/s から 0 まで落ちる折れ線（後半ほど遅い）
    const sim = new Simulation(
      withTrains(
        'test-line-opposing',
        opposing([
          [0, 900],
          [10, 620],
          [20, 480],
          [30, 450],
        ]),
      ),
    );
    let braked = 0;
    let cylinder = 0;
    run(sim, 26, () => {
      const train = sim.remoteTrains.get('opposing');
      if (!train) return;
      if (train.brakeNotch > 0) braked++;
      cylinder = Math.max(cylinder, train.brake.averageCylinderPressure());
    });
    expect(braked).toBeGreaterThan(0);
    // 空気ブレーキが込められている（＝制動の音が鳴る）
    expect(cylinder).toBeGreaterThan(10_000);
  });

  it('駅で止まっていれば扉が開く', () => {
    // 中原（ホーム 3380〜3620）にずっと停まっている列車
    const sim = new Simulation(
      withTrains(
        'test-line-opposing',
        opposing([
          [0, 3420],
          [60, 3420],
        ]),
      ),
    );
    run(sim, 20);
    const train = sim.remoteTrains.get('opposing')!;
    expect(train.speed).toBe(0);
    expect(train.doors.state.position).toBeGreaterThan(0);
    // 止まっているので力行もブレーキも要らない
    expect(train.powerNotch).toBe(0);
  });

  it('走り終えた列車は装置ごと消える', () => {
    const sim = new Simulation(
      withTrains(
        'test-line-opposing',
        opposing([
          [0, 470],
          [16, 20],
        ]),
      ),
    );
    run(sim, 8);
    expect(sim.remoteTrains.size).toBe(1);
    run(sim, 12);
    expect(sim.remoteTrains.size).toBe(0);
  });

  it('ダイヤ列車の装置は自列車の走りに影響しない', () => {
    const withOpposing = new Simulation(scenarioOf('test-line-opposing'));
    const alone = new Simulation({ ...scenarioOf('test-line-opposing'), scheduledTrains: [] });
    withOpposing.input = input({ powerNotch: 3 });
    alone.input = input({ powerNotch: 3 });
    run(withOpposing, 20, undefined, 0.1);
    run(alone, 20, undefined, 0.1);
    expect(withOpposing.position).toBeCloseTo(alone.position, 6);
    expect(withOpposing.speed).toBeCloseTo(alone.speed, 9);
  });
});
