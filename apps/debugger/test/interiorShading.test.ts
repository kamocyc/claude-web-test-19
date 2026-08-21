import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VehicleSpec } from '@railsim/core';
import { INTERIOR } from '../src/render/dimensions.ts';
import { carLayout, seatBays } from '../src/render/interior.ts';
import { OcclusionField, fillWhite, tintVertices } from '../src/render/interiorShading.ts';
import { buildPassengers } from '../src/render/interiorPassengers.ts';

/**
 * 接地の陰の焼き込みと、乗客の割り付け。
 *
 * どちらも絵を出さずに確かめられる。ここで見張っているのは
 *
 *  - 陰が**塞がれている側にだけ**付くこと（面の裏の塊で暗くならないこと）
 *  - 自分自身の面が自分の塊で暗くならないこと
 *  - 乗客の並びが seed で決まること（走行のたびに変わると決定論が崩れる）
 *
 * の 3 つで、いずれも間違えると絵が黙って壊れる（暗くなりすぎる・
 * 走り直すたびに車内の人が入れ替わる）。
 */

/** 試験用の 20m 級 4 扉車（長さだけが割り付けに効く） */
const SPEC = { length: 20 } as unknown as VehicleSpec;

describe('接地の陰', () => {
  it('塊のほうを向いた面は暗くなる', () => {
    const field = new OcclusionField();
    // 原点の上 0.5m に大きな板を置く
    field.add([0, 0.5, 0], [2, 0.1, 2], 1, 0.3);
    const up = field.sample(new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, 1, 0));
    expect(up).toBeGreaterThan(0.1);
  });

  it('塊に背を向けた面は暗くならない', () => {
    const field = new OcclusionField();
    field.add([0, 0.5, 0], [2, 0.1, 2], 1, 0.3);
    const down = field.sample(new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, -1, 0));
    expect(down).toBe(0);
  });

  it('離れるほど薄くなる', () => {
    const field = new OcclusionField();
    field.add([0, 0.5, 0], [2, 0.1, 2], 1, 0.3);
    const near = field.sample(new THREE.Vector3(0, 0.35, 0), new THREE.Vector3(0, 1, 0));
    const far = field.sample(new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(0, 1, 0));
    expect(near).toBeGreaterThan(far);
  });

  it('塊の表面に乗った頂点は自分の塊で暗くならない', () => {
    const field = new OcclusionField();
    // 床の板。その上面（y = 0）に乗っている頂点は、床自身では暗くならない。
    field.add([0, -0.05, 0], [4, 0.1, 4], 1, 0.3);
    const onSurface = field.sample(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    expect(onSurface).toBe(0);
  });

  it('焼くと頂点色が 1 以下になり、白で埋めた面は 1 のままになる', () => {
    const field = new OcclusionField();
    field.add([0, 0.3, 0], [2, 0.1, 2], 1.5, 0.3);
    const shaded = new THREE.PlaneGeometry(1, 1, 2, 2).rotateX(-Math.PI / 2);
    field.bake(shaded, 0.6);
    const color = shaded.getAttribute('color');
    expect(color.count).toBe(shaded.getAttribute('position').count);
    for (let i = 0; i < color.count; i++) expect(color.getX(i)).toBeLessThan(1);

    const plain = new THREE.PlaneGeometry(1, 1);
    fillWhite(plain);
    const white = plain.getAttribute('color');
    for (let i = 0; i < white.count; i++) expect(white.getX(i)).toBe(1);
  });

  it('重ねて塗ると掛け算になる', () => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    tintVertices(geometry, () => 0.5);
    tintVertices(geometry, () => 0.5);
    expect(geometry.getAttribute('color').getX(0)).toBeCloseTo(0.25, 6);
  });
});

describe('乗客の割り付け', () => {
  const layout = carLayout(SPEC, false, false);
  const bays = seatBays(layout);

  /** `InstancedMesh` の総数（＝置いた人数 × 部位の数） */
  const total = (group: THREE.Object3D): number => {
    let n = 0;
    group.traverse((node) => {
      if (node instanceof THREE.InstancedMesh) n += node.count;
    });
    return n;
  };

  it('同じ車・同じ混雑率なら同じ人数になる（決定論）', () => {
    const a = buildPassengers(layout, bays, 2, 0.5);
    const b = buildPassengers(layout, bays, 2, 0.5);
    expect(total(a.group)).toBe(total(b.group));
    expect(total(a.group)).toBeGreaterThan(0);
  });

  it('車が違えば並びも違う（貫通路の先に同じ絵が並ばない）', () => {
    const first = buildPassengers(layout, bays, 0, 0.5);
    const second = buildPassengers(layout, bays, 1, 0.5);
    expect(total(first.group)).not.toBe(total(second.group));
  });

  it('混むほど人が増える', () => {
    const light = total(buildPassengers(layout, bays, 3, 0.2).group);
    const heavy = total(buildPassengers(layout, bays, 3, 0.9).group);
    expect(heavy).toBeGreaterThan(light);
  });

  it('空の車には誰もいない', () => {
    expect(total(buildPassengers(layout, bays, 4, 0).group)).toBe(0);
  });

  it('前へ傾けると頭が前（+X）へ出る', () => {
    // 立客の傾きは足首を支点にした倒立振子なので、足元は動かず頭だけが動く。
    // 向きは**車体座標系**で決まる（同じ比力を全員が受けているのだから、
    // 通路を向いている人も前を向いている人も同じ向きへ倒れなければならない）。
    const car = buildPassengers(layout, bays, 6, 0.8);
    const matrix = new THREE.Matrix4();
    const head = new THREE.Vector3();
    const before: number[] = [];
    const after: number[] = [];
    const sample = (into: number[]): void => {
      into.length = 0;
      car.group.traverse((node) => {
        if (!(node instanceof THREE.InstancedMesh)) return;
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, matrix);
          into.push(head.set(0, 1.5, 0).applyMatrix4(matrix).x);
        }
      });
    };
    car.update(0, 0);
    sample(before);
    car.update(0, 0.1);
    sample(after);
    expect(before.length).toBeGreaterThan(0);
    // 立っている人は前へ、座っている人はほとんど動かない（背ずりに預けている）
    const moved = after.map((x, i) => x - before[i]!);
    expect(Math.max(...moved)).toBeGreaterThan(0.1);
    expect(Math.min(...moved)).toBeGreaterThanOrEqual(0);
  });

  it('右へ傾けると頭が右（+Z）へ出る', () => {
    const car = buildPassengers(layout, bays, 7, 0.8);
    const matrix = new THREE.Matrix4();
    const head = new THREE.Vector3();
    const read = (): number[] => {
      const out: number[] = [];
      car.group.traverse((node) => {
        if (!(node instanceof THREE.InstancedMesh)) return;
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, matrix);
          out.push(head.set(0, 1.5, 0).applyMatrix4(matrix).z);
        }
      });
      return out;
    };
    car.update(0, 0);
    const before = read();
    car.update(0.1, 0);
    const after = read();
    const moved = after.map((z, i) => z - before[i]!);
    expect(Math.max(...moved)).toBeGreaterThan(0.1);
  });

  it('傾きを入れても人は床から浮かない', () => {
    const car = buildPassengers(layout, bays, 5, 0.6);
    car.update(0.1, -0.08);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    let checked = 0;
    car.group.traverse((node) => {
      if (!(node instanceof THREE.InstancedMesh)) return;
      for (let i = 0; i < node.count; i++) {
        node.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        // 足元は床面に置く（傾きは足首を支点にした回転なので原点は動かない）
        expect(position.y).toBeCloseTo(layout.floorHeight, 6);
        // 車体の内側に収まっている
        expect(Math.abs(position.z)).toBeLessThan(INTERIOR.width / 2);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });
});
