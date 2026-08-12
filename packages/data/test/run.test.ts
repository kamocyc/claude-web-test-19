import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_OPTIONS,
  SAFETY_CHOICES,
  VEHICLE_CHOICES,
  WEATHER_CHOICES,
  createDefaultLibrary,
  parseRunScenarioId,
  runScenarioDefinition,
  runScenarioId,
  type RunOptions,
} from '@railsim/data';

const lib = createDefaultLibrary();
const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  ...DEFAULT_RUN_OPTIONS,
  ...over,
});

describe('走行条件の組み合わせ', () => {
  it('選択肢の車両がすべてコンパイルできる', () => {
    for (const v of VEHICLE_CHOICES) {
      expect(lib.vehicle(v.id).id).toBe(v.id);
    }
  });

  it('組み合わせがそのままシナリオになる', () => {
    const scenario = lib.run(
      options({ vehicleId: 'commuter-4-resistor', weather: 'snow', safety: 'ats-sn' }),
    );
    expect(scenario.consist.id).toBe('commuter-4-resistor');
    expect(scenario.railCondition).toBe('snow');
    expect(scenario.safetySystems).toEqual(['ats-sn']);
    // 降雪だけは架線の受け入れも落とす（回生失効と滑走を同時に試せる条件）
    expect(scenario.regenerationReceptivity).toBe(0.5);
  });

  it('先行列車の入切がダイヤ上の他列車になる', () => {
    expect(lib.run(options({ precedingTrain: false })).scheduledTrains).toHaveLength(0);
    const following = lib.run(options({ precedingTrain: true }));
    expect(following.scheduledTrains).toHaveLength(1);
    expect(following.scheduledTrains[0]!.id).toBe('preceding');
  });

  it('番線の選択が路線データの差し替えになる', () => {
    expect(lib.run(options({ divergingPlatform: false })).route.id).toBe('test-line');
    const loop = lib.run(options({ divergingPlatform: true }));
    expect(loop.route.id).toBe('test-line-loop');
    // 交換可能駅なので、行き先も距離程も駅も変わらない
    expect(loop.route.length).toBe(lib.route('test-line').length);
    expect(loop.startPosition).toBe(lib.run(options()).startPosition);
    expect(loop.route.turnouts.get('to-2')!.route).toBe('diverging');
  });

  it('条件が違えば ID も名前も違う', () => {
    const a = runScenarioId(options());
    const b = runScenarioId(options({ weather: 'snow' }));
    expect(a).not.toBe(b);
    expect(runScenarioDefinition(options({ weather: 'snow' })).name).toContain('降雪');
    expect(runScenarioDefinition(options({ divergingPlatform: true })).name).toContain('2 番線');
  });

  it('ID から条件へ戻せる（記録の再生に使う）', () => {
    for (const vehicle of VEHICLE_CHOICES) {
      for (const weather of WEATHER_CHOICES) {
        for (const safety of SAFETY_CHOICES) {
          for (const platform of [false, true]) {
            for (const preceding of [false, true]) {
              const o = options({
                vehicleId: vehicle.id,
                weather: weather.id,
                safety: safety.id,
                divergingPlatform: platform,
                precedingTrain: preceding,
              });
              expect(parseRunScenarioId(runScenarioId(o))).toEqual(o);
            }
          }
        }
      }
    }
  });

  it('知らない ID は受け付けない', () => {
    expect(parseRunScenarioId('test-line-local')).toBeNull();
    expect(parseRunScenarioId('run/no-such-vehicle/clear/main/ats-p/solo')).toBeNull();
    expect(parseRunScenarioId('run/commuter-4/typhoon/main/ats-p/solo')).toBeNull();
    expect(parseRunScenarioId('run/commuter-4/clear/main/ats-p')).toBeNull();
  });

  it('組み合わせの ID でもライブラリから取り出せる', () => {
    const id = runScenarioId(options({ weather: 'snow' }));
    expect(lib.hasScenario(id)).toBe(true);
    expect(lib.hasScenario('test-line-local')).toBe(true);
    expect(lib.hasScenario('no-such-scenario')).toBe(false);
    expect(lib.scenario(id).railCondition).toBe('snow');
  });
});
