import type { CompiledRoute, ConsistSpec, Scenario } from '@railsim/core';
import { commuter4Vehicle } from './assets/commuter4.ts';
import { commuter4ChopperVehicle } from './assets/commuter4Chopper.ts';
import { commuter4ResistorVehicle } from './assets/commuter4Resistor.ts';
import { commuter4ScaleVehicle } from './assets/commuter4Scale.ts';
import { scenarios } from './assets/scenarios.ts';
import { testLineBranchRoute, testLineRoute } from './assets/testLine.ts';
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

  scenario(id: string): Scenario {
    const def = this.scenarioDefs.get(id);
    if (!def) throw new Error(`シナリオが見つかりません: ${id}`);
    return compileScenario(def, this.route(def.routeId), this.vehicle(def.vehicleId));
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
  lib.addRoute(testLineBranchRoute);
  lib.addVehicle(commuter4Vehicle);
  lib.addVehicle(commuter4ResistorVehicle);
  lib.addVehicle(commuter4ChopperVehicle);
  lib.addVehicle(commuter4ScaleVehicle);
  for (const s of scenarios) lib.addScenario(s);
  return lib;
}
