import {
  kmhToMps,
  parseClock,
  type CompiledRoute,
  type ConsistSpec,
  type Scenario,
  type ScheduledTrain,
} from '@railsim/core';
import { scenarioSchema, type ScenarioDefinition } from '../schema/scenario.ts';

/**
 * シナリオ定義とコンパイル済みの路線・車両を組み合わせて、
 * シミュレーションが直接受け取れるシナリオにする。
 */
export function compileScenario(
  definition: ScenarioDefinition,
  route: CompiledRoute,
  consist: ConsistSpec,
): Scenario {
  const def = scenarioSchema.parse(definition);
  if (def.routeId !== route.id) {
    throw new Error(`シナリオの routeId (${def.routeId}) と路線 ID (${route.id}) が一致しません`);
  }
  if (def.vehicleId !== consist.id) {
    throw new Error(
      `シナリオの vehicleId (${def.vehicleId}) と車両 ID (${consist.id}) が一致しません`,
    );
  }

  const scheduledTrains: ScheduledTrain[] = def.scheduledTrains.map((t) => ({
    id: t.id,
    length: t.length,
    waypoints: t.waypoints
      .map((w) => ({ time: parseClock(w.time), position: w.position }))
      .sort((a, b) => a.time - b.time),
  }));

  return {
    id: def.id,
    name: def.name,
    route,
    consist,
    scheduledTrains,
    startTime: parseClock(def.startTime),
    startPosition: def.startPosition,
    startSpeed: kmhToMps(def.startSpeed),
    loadFactor: def.loadFactor,
    railCondition: def.railCondition,
    regenerationReceptivity: def.regenerationReceptivity,
    seed: def.seed,
    safetySystems: def.safetySystems,
    hasVigilance: def.hasVigilance,
    rigidConsist: def.rigidConsist,
  };
}
