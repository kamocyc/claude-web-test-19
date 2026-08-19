import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_INPUT,
  Simulation,
  gearMeshFrequencyAt,
  type ControlInput,
  type Scenario,
} from '@railsim/core';
import {
  compileRoute,
  createDefaultLibrary,
  testLineLoopRoute,
  testLineRoute,
} from '@railsim/data';

const main = compileRoute(testLineRoute);
const loop = compileRoute(testLineLoopRoute);
const lib = createDefaultLibrary();

const input = (over: Partial<ControlInput> = {}): ControlInput => ({ ...NEUTRAL_INPUT, ...over });

/** dt 刻みで進めながら毎ステップ観測する */
function run(sim: Simulation, seconds: number, onStep?: (s: Simulation) => void, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.step(dt);
    onStep?.(sim);
  }
}

describe('橋りょうのコンパイル', () => {
  it('4 基の橋が距離程どおりに置かれる', () => {
    expect(main.bridges.bridges.map((b) => b.id)).toEqual(['br-3', 'br-1', 'br-2', 'br-4']);
    expect(main.bridges.at(3000)?.id).toBe('br-1');
    expect(main.bridges.at(3200)).toBeUndefined();
  });

  it('形式から床と桁の寸法が決まる', () => {
    const girder = main.bridges.at(3000)!;
    expect(girder.kind).toBe('plate-girder');
    // 鋼桁は既定で無道床。腹板は 12mm で、桁高は支間の 1/12。
    expect(girder.deck).toBe('open');
    expect(girder.panel.thickness).toBeCloseTo(0.012, 9);
    expect(girder.girderDepth).toBeCloseTo(girder.spanLength / 12, 9);

    const concrete = main.bridges.at(1950)!;
    // コンクリート桁は既定で有道床。床版は 250mm。
    expect(concrete.deck).toBe('ballasted');
    expect(concrete.panel.thickness).toBeCloseTo(0.25, 9);
  });

  it('同じ形式でも床の作りを書けばそちらが優先される', () => {
    // br-4 は「有道床のプレートガーダー橋」。桁は br-1 と同じでも音は 1 桁静かになる。
    const ballasted = main.bridges.at(6630)!;
    expect(ballasted.kind).toBe('plate-girder');
    expect(ballasted.deck).toBe('ballasted');
  });
});

describe('踏切のコンパイル', () => {
  it('3 か所の踏切が置かれ、警報開始距離は最高速度から決まる', () => {
    expect(main.levelCrossings.crossings.map((c) => c.id)).toEqual(['xg-1', 'xg-2', 'xg-3']);
    const crossing = main.levelCrossings.get('xg-1')!;
    // 警報時間 30 秒 × 線路最高速度 110km/h
    expect(crossing.warningDistance).toBeCloseTo(30 * (110 / 3.6), 6);
  });

  it('踏切道の幅がそのまま踏切板の長さになる', () => {
    // 12m の 2 車線道路と 4.5m の生活道路では、渡る時間も目地の間隔も違う
    expect(main.levelCrossings.get('xg-3')!.roadWidth).toBe(12);
    expect(main.levelCrossings.get('xg-2')!.roadWidth).toBe(4.5);
    expect(main.levelCrossings.crossing(6790, 6810).map((e) => e.value.crossingId)).toEqual([
      'xg-3',
      'xg-3',
    ]);
    // 駅のすぐ先にある踏切は、制御子を駅の出発側へ寄せてある
    expect(main.levelCrossings.get('xg-2')!.warningDistance).toBe(250);
  });

  it('電鐘式の踏切がひとつある', () => {
    expect(main.levelCrossings.get('xg-2')!.bell).toBe('gong');
    expect(main.levelCrossings.get('xg-1')!.bell).toBe('electronic');
  });
});

describe('ロングレール区間の中の継目', () => {
  /** ロングレール区間（2600〜4300m） */
  const inLongRail = (s: number): boolean => main.railJointSpacing.at(s) === 0;

  it('ロングレール区間には周期的な継目が無い', () => {
    expect(inLongRail(3000)).toBe(true);
    expect(inLongRail(4500)).toBe(false);
  });

  it('その中に橋りょうと分岐器がある', () => {
    expect(inLongRail(main.bridges.at(3000)!.start)).toBe(true);
    const depot = main.turnouts.get('to-4')!;
    expect(inLongRail(depot.position)).toBe(true);
  });

  it('橋の両端には伸縮継目がある（桁が伸び縮みするので）', () => {
    const bridge = main.bridges.at(3000)!;
    const joints = main.railJoints.inRange(bridge.start - 1, bridge.end + 1);
    expect(joints.map((j) => j.value.kind)).toEqual(['expansion', 'expansion']);
    expect(joints[0]!.s).toBeCloseTo(bridge.start, 9);
    expect(joints[1]!.s).toBeCloseTo(bridge.end, 9);
  });

  it('分岐器の前後には絶縁継目がある（軌道回路の区切り）', () => {
    const depot = main.turnouts.get('to-4')!;
    const joints = main.railJoints.inRange(depot.position - 5, depot.position + depot.length + 5);
    expect(joints.map((j) => j.value.kind)).toEqual(['insulated', 'insulated']);
    // 分岐器の端から 3m 外側
    expect(joints[0]!.s).toBeCloseTo(depot.position - 3, 9);
    expect(joints[1]!.s).toBeCloseTo(depot.position + depot.length + 3, 9);
  });

  it('有道床の短い橋には伸縮継目を置かない（道床が逃がすので要らない）', () => {
    const concrete = main.bridges.at(1950)!;
    expect(main.railJoints.inRange(concrete.start - 1, concrete.end + 1)).toHaveLength(0);
  });

  it('継目の強さは種類で決まる（突合せ継目がいちばん強い）', () => {
    const kinds = main.railJoints.all.map((j) => j.value);
    const expansion = kinds.find((k) => k.kind === 'expansion')!;
    const insulated = kinds.find((k) => k.kind === 'insulated')!;
    expect(expansion.strength).toBeLessThan(1);
    expect(insulated.strength).toBeLessThan(1);
  });
});

describe('交換設備の隣の線路', () => {
  it('1 番線を走っていれば隣の線路は右にある', () => {
    expect(main.adjacentTrack.offsetAt(200)).toBeCloseTo(3.38, 2);
  });

  it('2 番線を走っていれば隣の線路（本線）は左にある', () => {
    expect(loop.adjacentTrack.offsetAt(200)).toBeCloseTo(-3.38, 2);
  });

  it('交換設備の外では隣に線路が無い（単線なので）', () => {
    expect(main.adjacentTrack.has(1000)).toBe(false);
    expect(main.adjacentTrack.has(200)).toBe(true);
  });
});

describe('対向列車とのすれ違い', () => {
  const scenarioOf = (id: string): Scenario => ({ ...lib.scenario(id), hasVigilance: false });

  it('2 番線に停まっているあいだに本線を通過していく', () => {
    const sim = new Simulation(scenarioOf('test-line-opposing'));
    sim.input = input({ brakeNotch: 3 });

    let closest = Infinity;
    let alongside = false;
    let maxClosing = 0;
    run(sim, 30, (s) => {
      const passing = s.snapshot().passing;
      if (!passing) return;
      closest = Math.min(closest, Math.abs(passing.headGap));
      maxClosing = Math.max(maxClosing, passing.closingSpeed);
      if (passing.headGap <= 0 && passing.tailGap >= 0) alongside = true;
    });

    // 目の前を通り抜けていく
    expect(closest).toBeLessThan(5);
    expect(alongside).toBe(true);
    // 自分は止まっているので、相対速度は相手の速度そのもの（約 100km/h）
    expect(maxClosing).toBeGreaterThan(25);
    expect(maxClosing).toBeLessThan(31);
  });

  it('相手の歯車の音は速度だけから求まる（走行状態を知らなくてよい）', () => {
    // ダイヤ列車は位置しか持たないが、歯車の音は力行に依らず鳴るので速度で決まる。
    // 実際に走らせた列車の値と一致することを確かめる。
    const sim = new Simulation(scenarioOf('test-line-local'));
    sim.input = input({ powerNotch: 4 });
    run(sim, 20);
    const motored = sim.scenario.consist.vehicles.find((v) => v.traction)!;
    const estimated = gearMeshFrequencyAt(motored.traction!, motored.wheelDiameter, sim.speed);
    const actual = sim.snapshot().drive.gearMeshFrequency;
    // ぴったり同じにはならない。実際の列車は**輪軸の回転**から求めており、力行中は
    // クリープすべりのぶんだけ車輪のほうが速く回っているためで、その差は 1% 以内。
    expect(estimated).toBeGreaterThan(actual * 0.99);
    expect(estimated).toBeLessThan(actual * 1.001);
  });

  it('対向列車は自分の信号現示に関係しない（別の線路なので）', () => {
    const withOpposing = new Simulation(scenarioOf('test-line-opposing'));
    const alone = new Simulation({ ...scenarioOf('test-line-opposing'), scheduledTrains: [] });
    run(withOpposing, 20, undefined, 0.1);
    run(alone, 20, undefined, 0.1);
    expect(withOpposing.snapshot().nextSignal?.state.aspect).toBe(
      alone.snapshot().nextSignal?.state.aspect,
    );
  });
});

describe('踏切の鳴動', () => {
  const scenarioOf = (id: string): Scenario => ({ ...lib.scenario(id), hasVigilance: false });

  it('駅に停まっているあいだは鳴らず、発車すると鳴り出して、抜けると止まる', () => {
    // 中原（3500m）に停車中。3800m の踏切の制御子は駅の先にあるので、まだ鳴らない。
    const sim = new Simulation(scenarioOf('test-line-structures'));
    const crossing = sim.levelCrossings.state('xg-2')!;
    expect(crossing.ringing).toBe(false);

    sim.input = input({ powerNotch: 4 });
    let rangWhileApproaching = false;
    let barrierDown = false;
    run(sim, 40, (s) => {
      if (s.position < 3790 && crossing.ringing) rangWhileApproaching = true;
      if (crossing.barrier === 1) barrierDown = true;
    });
    expect(rangWhileApproaching).toBe(true);
    // 警報が始まってから 12 秒で遮断桿が下りきる
    expect(barrierDown).toBe(true);
    // 抜けきったので止まっている
    expect(sim.position).toBeGreaterThan(3900);
    expect(crossing.ringing).toBe(false);
  });

  it('警報している踏切と、そこまでの距離がスナップショットに出る', () => {
    const sim = new Simulation(scenarioOf('test-line-structures'));
    sim.input = input({ powerNotch: 4 });
    run(sim, 20);
    const snap = sim.snapshot();
    expect(snap.crossing?.state.crossing.id).toBe('xg-2');
    expect(snap.crossing?.distance).toBeCloseTo(3800 - sim.position, 6);
  });
});
