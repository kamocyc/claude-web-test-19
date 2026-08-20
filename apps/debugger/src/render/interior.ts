import * as THREE from 'three';
import type { VehicleSpec } from '@railsim/core';
import { CAR, INTERIOR } from './dimensions.ts';

/**
 * 客室の内装。
 *
 * 外板（`vehicle.ts`）が車体の**外から見える形**を作るのに対し、こちらは
 * **中から見える形**を作る。運転席視点では見えないが、車内を歩くモード
 * （`walk.ts`）ではここが視界のすべてになる。
 *
 * 内装の寸法は `dimensions.ts` の `INTERIOR` にまとめてある。床面高さ 1130mm・
 * 内法幅 2790mm・天井高さ 2300mm という 3 つの寸法が客室の広さを決めていて、
 * そこからロングシートの奥行き（430mm）を両側で引いた 1930mm が通路になる。
 *
 * 車体（`buildCar`）の局所座標系にそのまま乗る:
 *
 *  - X = 前後（+ が前）、Y = 上（レール面が 0）、Z = 右
 *
 * すなわち床面は `y = CAR.floorHeight`、天井は `y = CAR.floorHeight +
 * INTERIOR.ceilingHeight` にある。
 */
export interface CarInterior {
  readonly group: THREE.Group;
  /**
   * 床の高さ（レール面上）[m]。歩くモードが足を置く面。
   * 車体の局所座標系での値なので、車体動揺はこの外側で掛かる。
   */
  readonly floorHeight: number;
  /** 客室として歩ける前後の範囲（車体中心からの距離）[m] */
  readonly walkableFrom: number;
  readonly walkableTo: number;
}

/**
 * 1 両ぶんの内装を組み立てる。
 *
 * @param spec 車両仕様（長さをここから取る）
 * @param lead 先頭車（運転室の仕切りが客室の端になる）
 * @param front 編成の前を向いているか（運転室が前寄りか後ろ寄りか）
 */
export function buildCarInterior(spec: VehicleSpec, lead: boolean, front: boolean): CarInterior {
  const group = new THREE.Group();
  const bodyLength = spec.length - (CAR.couplerLength - CAR.bodyLength);
  const half = bodyLength / 2;
  // 先頭車は運転室のぶんだけ客室が短い。運転室は編成の外側の端にある。
  const cabSide = front ? 1 : -1;
  const walkableFrom = lead && cabSide < 0 ? -half + CAR.cabLength : -half + INTERIOR.endWallInset;
  const walkableTo = lead && cabSide > 0 ? half - CAR.cabLength : half - INTERIOR.endWallInset;

  group.add(buildFloor(walkableFrom, walkableTo));

  return { group, floorHeight: CAR.floorHeight, walkableFrom, walkableTo };
}

/**
 * 床。
 *
 * 通勤形の床は塩化ビニルの長尺シートで、扉の前だけ色を変えて乗降位置を示す
 * ことが多い。ここでは 1 枚の面として置き、模様は材質側で与える。
 */
function buildFloor(from: number, to: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(to - from, INTERIOR.width);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((from + to) / 2, CAR.floorHeight, 0);
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x8d8b84, roughness: 0.85, metalness: 0.02 }),
  );
}
