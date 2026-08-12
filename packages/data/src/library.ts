import type { CompiledRoute, ConsistSpec, Scenario } from '@railsim/core';
import { commuter4Vehicle } from './assets/commuter4.ts';
import { commuter4ChopperVehicle } from './assets/commuter4Chopper.ts';
import { commuter4ResistorVehicle } from './assets/commuter4Resistor.ts';
import { commuter4ScaleVehicle } from './assets/commuter4Scale.ts';
import { scenarios } from './assets/scenarios.ts';
import { testLineLoopRoute, testLineRoute } from './assets/testLine.ts';
import { parseRunScenarioId, runScenarioDefinition, type RunOptions } from './run.ts';
import { compileRoute } from './compile/route.ts';
import { compileScenario } from './compile/scenario.ts';
import { compileVehicle } from './compile/vehicle.ts';
import type { RouteDefinition } from './schema/route.ts';
import type { ScenarioDefinition } from './schema/scenario.ts';
import type { VehicleDefinition } from './schema/vehicle.ts';

/**
 * 同梱データのライブラリ。
 * コンパイル結果をキャッシュするので、同じ路線を何度取り出しても再構築されない。
 */
export class DataLibrary {
  private readonly routeDefs = new Map<string, RouteDefinition>();
  private readonly vehicleDefs = new Map<string, VehicleDefinition>();
  private readonly scenarioDefs = new Map<string, ScenarioDefinition>();
  private readonly routeCache = new Map<string, CompiledRoute>();
  private readonly vehicleCache = new Map<string, ConsistSpec>();

  addRoute(def: RouteDefinition): void {
    this.routeDefs.set(def.id, def);
    this.routeCache.delete(def.id);
  }

  addVehicle(def: VehicleDefinition): void {
    this.vehicleDefs.set(def.id, def);
    this.vehicleCache.delete(def.id);
  }

  addScenario(def: ScenarioDefinition): void {
    this.scenarioDefs.set(def.id, def);
  }

  route(id: string): CompiledRoute {
    const cached = this.routeCache.get(id);
    if (cached) return cached;
    const def = this.routeDefs.get(id);
    if (!def) throw new Error(`路線データが見つかりません: ${id}`);
    const compiled = compileRoute(def);
    this.routeCache.set(id, compiled);
    return compiled;
  }

  vehicle(id: string): ConsistSpec {
    const cached = this.vehicleCache.get(id);
    if (cached) return cached;
    const def = this.vehicleDefs.get(id);
    if (!def) throw new Error(`車両データが見つかりません: ${id}`);
    const compiled = compileVehicle(def);
    this.vehicleCache.set(id, compiled);
    return compiled;
  }

  /**
   * シナリオを取り出す。
   *
   * 同梱シナリオの ID のほかに、走行条件の組み合わせから作られた ID
   * （`runScenarioId()`）も受け付ける。記録の保存・再生はシナリオ ID だけを持ち歩くので、
   * 組み合わせで作ったシナリオもここから復元できる必要がある。
   */
  scenario(id: string): Scenario {
    const options = parseRunScenarioId(id);
    if (options) return this.run(options);
    const def = this.scenarioDefs.get(id);
    if (!def) throw new Error(`シナリオが見つかりません: ${id}`);
    return compileScenario(def, this.route(def.routeId), this.vehicle(def.vehicleId));
  }

  /** 走行条件の組み合わせからシナリオを組み立てる */
  run(options: RunOptions): Scenario {
    const def = runScenarioDefinition(options);
    return compileScenario(def, this.route(def.routeId), this.vehicle(def.vehicleId));
  }

  /** その ID のシナリオを取り出せるか */
  hasScenario(id: string): boolean {
    return this.scenarioDefs.has(id) || parseRunScenarioId(id) !== null;
  }

  get routeIds(): string[] {
    return [...this.routeDefs.keys()];
  }

  get vehicleIds(): string[] {
    return [...this.vehicleDefs.keys()];
  }

  get scenarioIds(): string[] {
    return [...this.scenarioDefs.keys()];
  }

  scenarioName(id: string): string {
    return this.scenarioDefs.get(id)?.name ?? id;
  }
}

/** 同梱データを登録済みの標準ライブラリを作る */
export function createDefaultLibrary(): DataLibrary {
  const lib = new DataLibrary();
  lib.addRoute(testLineRoute);
  lib.addRoute(testLineLoopRoute);
  lib.addVehicle(commuter4Vehicle);
  lib.addVehicle(commuter4ResistorVehicle);
  lib.addVehicle(commuter4ChopperVehicle);
  lib.addVehicle(commuter4ScaleVehicle);
  for (const s of scenarios) lib.addScenario(s);
  return lib;
}
