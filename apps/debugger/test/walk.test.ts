import { describe, expect, it } from 'vitest';
import type { VehicleSpec } from '@railsim/core';
import { CAR, INTERIOR } from '../src/render/dimensions.ts';
import { carLayout, seatBays, subtractSpans, windowPanes } from '../src/render/interior.ts';
import {
  confine,
  corridorBounds,
  corridorHalfWidth,
  longitudinalLimits,
} from '../src/render/walk.ts';
import {
  SEATED_KNEE_REACH,
  seatedOccupants,
  type SeatedOccupant,
} from '../src/render/interiorPassengers.ts';
import { WALK_BINDINGS, KEY_BINDINGS, lookupWalkKey } from '../src/input/keymap.ts';

/**
 * 車内を歩くときの当たり判定と割り付け。
 *
 * どれも純粋な計算なので、絵を出さずに確かめられる。ここで見張っているのは
 * 「客室の形」と「歩ける範囲」が食い違わないことで、食い違うと壁を抜けるか、
 * 逆に何も無いところで止まる。
 */

/** 試験用の 20m 級 4 扉車（長さだけが割り付けに効く） */
const SPEC = { length: 20 } as unknown as VehicleSpec;

describe('区間の引き算', () => {
  it('開口を抜いた残りが壁になる', () => {
    expect(subtractSpans(0, 10, [[2, 4]])).toEqual([
      [0, 2],
      [4, 10],
    ]);
  });

  it('重なった開口はまとめて 1 つとして抜く', () => {
    expect(
      subtractSpans(0, 10, [
        [2, 5],
        [4, 6],
      ]),
    ).toEqual([
      [0, 2],
      [6, 10],
    ]);
  });

  it('端まで届く開口は残りを作らない', () => {
    expect(subtractSpans(0, 10, [[0, 10]])).toEqual([]);
  });

  it('範囲の外の開口は無視する', () => {
    expect(subtractSpans(0, 10, [[12, 14]])).toEqual([[0, 10]]);
  });
});

describe('客室の割り付け', () => {
  it('中間車は 4 扉で、妻面まで歩ける', () => {
    const layout = carLayout(SPEC, false, false);
    expect(layout.doorCentres).toHaveLength(4);
    expect(layout.cabSide).toBe(0);
    expect(layout.walkableTo).toBeCloseTo(CAR.bodyLength / 2 - INTERIOR.endWallInset, 6);
    expect(layout.walkableFrom).toBeCloseTo(-(CAR.bodyLength / 2 - INTERIOR.endWallInset), 6);
  });

  it('先頭車は運転室のぶんだけ客室が短い', () => {
    const front = carLayout(SPEC, true, true);
    expect(front.cabSide).toBe(1);
    expect(front.walkableTo).toBeCloseTo(CAR.bodyLength / 2 - CAR.cabLength, 6);
    const rear = carLayout(SPEC, true, false);
    expect(rear.cabSide).toBe(-1);
    expect(rear.walkableFrom).toBeCloseTo(-(CAR.bodyLength / 2 - CAR.cabLength), 6);
  });

  it('側窓の開口は扉と重ならない', () => {
    const layout = carLayout(SPEC, false, false);
    for (const [a, b] of windowPanes(layout)) {
      for (const centre of layout.doorCentres) {
        // 開口が扉に掛かっていたら、そこは外板にガラスが無いので穴になる
        const overlaps = a < centre + CAR.doorWidth / 2 && b > centre - CAR.doorWidth / 2;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('座席は扉と扉のあいだに入り、車端が優先席になる', () => {
    const bays = seatBays(carLayout(SPEC, false, false));
    expect(bays.length).toBeGreaterThanOrEqual(3);
    expect(bays[0]!.priority).toBe(true);
    expect(bays[bays.length - 1]!.priority).toBe(true);
    expect(bays.some((bay) => !bay.priority)).toBe(true);
    // 7 人掛けの区画は 3.2m 以上ある（460mm × 7 + 袖仕切り）
    const long = bays.filter((bay) => bay.to - bay.from > 3);
    expect(long.length).toBeGreaterThanOrEqual(1);
  });
});

describe('通路の広さ', () => {
  const layout = carLayout(SPEC, false, false);
  const bays = seatBays(layout);
  const inner = INTERIOR.width / 2;

  it('座席の前は座席の奥行きぶん狭い', () => {
    const bay = bays.find((b) => b.to - b.from > 3)!;
    const middle = (bay.from + bay.to) / 2;
    expect(corridorHalfWidth(layout, bays, middle)).toBeCloseTo(inner - INTERIOR.seatDepth, 6);
  });

  it('戸口の前は内壁の近くまで寄れる', () => {
    const centre = layout.doorCentres[1]!;
    expect(corridorHalfWidth(layout, bays, centre)).toBeGreaterThan(inner - INTERIOR.seatDepth);
  });

  it('袖仕切りのところは座席の前より狭い', () => {
    const bay = bays.find((b) => b.to - b.from > 3)!;
    const atEnd = corridorHalfWidth(layout, bays, bay.from + 0.01);
    expect(atEnd).toBeLessThan(inner - INTERIOR.seatDepth);
  });

  it('貫通路は幌の内法まで絞られる', () => {
    expect(corridorHalfWidth(layout, bays, layout.walkableTo + 0.2)).toBeCloseTo(
      INTERIOR.gangwayWidth / 2,
      6,
    );
  });
});

describe('当たり判定', () => {
  const middle = carLayout(SPEC, false, false);
  const middleBays = seatBays(middle);
  const lead = carLayout(SPEC, true, true);
  const leadBays = seatBays(lead);
  const r = INTERIOR.bodyRadius;

  it('座席へは入り込めない', () => {
    const bay = middleBays.find((b) => b.to - b.from > 3)!;
    const x = (bay.from + bay.to) / 2;
    const pushed = confine(middle, middleBays, x, 5, r);
    expect(pushed.z).toBeCloseTo(INTERIOR.width / 2 - INTERIOR.seatDepth - r, 6);
    expect(pushed.exit).toBe(0);
  });

  it('壁を抜けない（左右どちらへ押しても内法の中に留まる）', () => {
    for (const x of [-8, -5, 0, 3, 7]) {
      for (const z of [-9, 9]) {
        const pushed = confine(middle, middleBays, x, z, r);
        expect(Math.abs(pushed.z)).toBeLessThanOrEqual(INTERIOR.width / 2 - r + 1e-9);
      }
    }
  });

  it('運転室の仕切りから先へは行けない', () => {
    const limits = longitudinalLimits(lead, r);
    expect(limits.max).toBeCloseTo(lead.walkableTo - r, 6);
    const pushed = confine(lead, leadBays, 100, 0, r);
    expect(pushed.x).toBeCloseTo(lead.walkableTo - r, 6);
    // 運転室の側では隣の車両へ抜けない
    expect(pushed.exit).toBe(0);
  });

  it('貫通路の側では車端を越えると隣の車両へ移る', () => {
    const limits = longitudinalLimits(middle, r);
    expect(confine(middle, middleBays, limits.gangwayEnd + 0.1, 0, r).exit).toBe(1);
    expect(confine(middle, middleBays, -limits.gangwayEnd - 0.1, 0, r).exit).toBe(-1);
    // 先頭車の運転室と反対の端は貫通路なので、こちらへは抜けられる
    expect(confine(lead, leadBays, -limits.gangwayEnd - 0.1, 0, r).exit).toBe(-1);
  });

  it('4 両編成なら端から端まで歩ける', () => {
    // 先頭（運転室あり）→ 中間 → 中間 → 後尾（運転室あり）とつながっていて、
    // 途中で行き止まりにならないことを、車端の抜けやすさで確かめる。
    const layouts = [
      carLayout(SPEC, true, true),
      carLayout(SPEC, false, false),
      carLayout(SPEC, false, false),
      carLayout(SPEC, true, false),
    ];
    for (let i = 0; i < layouts.length - 1; i++) {
      const here = layouts[i]!;
      const next = layouts[i + 1]!;
      // 後ろ（-X）へ抜けられて、隣は前（+X）から受け取れる
      expect(here.cabSide).not.toBe(-1);
      expect(next.cabSide).not.toBe(1);
      const end = longitudinalLimits(here, r).gangwayEnd;
      expect(confine(here, seatBays(here), -end - 0.05, 0, r).exit).toBe(-1);
    }
  });
});

describe('歩行のキー', () => {
  it('W A S D と矢印で歩き、Shift で早足になる', () => {
    expect(lookupWalkKey('w')).toBe('forward');
    expect(lookupWalkKey('S')).toBe('backward');
    expect(lookupWalkKey('ArrowLeft')).toBe('left');
    expect(lookupWalkKey('Shift')).toBe('run');
  });

  it('マウスを使わなくても首を振れる', () => {
    expect(lookupWalkKey('q')).toBe('turnLeft');
    expect(lookupWalkKey('e')).toBe('turnRight');
    expect(lookupWalkKey('PageUp')).toBe('lookUp');
    expect(lookupWalkKey('PageDown')).toBe('lookDown');
  });

  it('画面と進行の操作は歩行のキーと取り合いにならない', () => {
    // 歩行中も効かせるのは `ui` の指令だけ。これが歩行のキーと重なっていると、
    // 歩きながら視点を戻すことも自動運転を入れることもできなくなる。
    for (const [key, action] of Object.entries(KEY_BINDINGS)) {
      if (action.kind !== 'ui') continue;
      expect(WALK_BINDINGS[key]).toBeUndefined();
    }
  });

  it('歩行のキーはすべて運転か画面の表に載っているか、新しく足したものだけ', () => {
    // 重なってよいのは運転のキー（歩行中は効かない）だけ。
    for (const key of Object.keys(WALK_BINDINGS)) {
      const action = KEY_BINDINGS[key];
      if (action) expect(action.kind).not.toBe('ui');
    }
  });
});

/**
 * 座っている人の膝。
 *
 * 見えている膝を通り抜けたら、その場で嘘になる。当たり判定は描画とまったく
 * 同じ割り付け（`seatedOccupants`）を引くので、**人が座っているところだけ**
 * 通路が狭くなる。
 */
describe('座っている人の膝', () => {
  const layout = carLayout(SPEC, false, false);
  const bays = seatBays(layout);
  const inner = INTERIOR.width / 2;
  const bay = bays[1] ?? bays[0]!;
  const seat = (side: -1 | 1): SeatedOccupant => ({
    x: (bay.from + bay.to) / 2,
    side,
    kneeReach: inner - INTERIOR.seatDepth + 0.02 - SEATED_KNEE_REACH,
  });

  it('誰も座っていなければ座席の前縁まで寄れる', () => {
    const x = (bay.from + bay.to) / 2;
    const bounds = corridorBounds(layout, bays, [], x);
    expect(bounds.right).toBeCloseTo(corridorHalfWidth(layout, bays, x), 6);
    expect(bounds.left).toBeCloseTo(-corridorHalfWidth(layout, bays, x), 6);
  });

  it('座っている側だけ通路が狭くなる', () => {
    const x = (bay.from + bay.to) / 2;
    const bounds = corridorBounds(layout, bays, [seat(1)], x);
    expect(bounds.right).toBeLessThan(corridorHalfWidth(layout, bays, x));
    // 反対側は空いたまま
    expect(bounds.left).toBeCloseTo(-corridorHalfWidth(layout, bays, x), 6);
  });

  it('離れたところの膝は効かない', () => {
    const x = (bay.from + bay.to) / 2 + 1.5;
    const bounds = corridorBounds(layout, bays, [seat(1)], x);
    expect(bounds.right).toBeCloseTo(corridorHalfWidth(layout, bays, x), 6);
  });

  it('膝を通り抜けない', () => {
    const x = (bay.from + bay.to) / 2;
    const knees = [seat(1)];
    // 右の壁へ向かって突っ込む
    const result = confine(layout, bays, x, 5, INTERIOR.bodyRadius, knees);
    expect(result.z).toBeLessThanOrEqual(knees[0]!.kneeReach - INTERIOR.bodyRadius + 1e-9);
  });

  it('両側に座られても通路は残る（膝どうしの間は 1.4m ある）', () => {
    const x = (bay.from + bay.to) / 2;
    const knees = [seat(1), seat(-1)];
    const bounds = corridorBounds(layout, bays, knees, x);
    // 膝から膝まで。ここが体の幅（480mm）を割ると誰も通れなくなる。
    expect(bounds.right - bounds.left).toBeGreaterThan(2 * INTERIOR.bodyRadius);
    const result = confine(layout, bays, x, 5, INTERIOR.bodyRadius, knees);
    expect(result.z).toBeLessThanOrEqual(bounds.right - INTERIOR.bodyRadius + 1e-9);
  });

  it('通れないほど詰まったら真ん中で止める（すり抜けさせない）', () => {
    const x = (bay.from + bay.to) / 2;
    // 体の幅より狭い隙間を作って、押し合いになる場合を確かめる
    const tight: SeatedOccupant[] = [
      { x, side: 1, kneeReach: 0.1 },
      { x, side: -1, kneeReach: 0.1 },
    ];
    const result = confine(layout, bays, x, 5, INTERIOR.bodyRadius, tight);
    expect(Math.abs(result.z)).toBeLessThan(0.05);
  });

  it('描画と当たり判定は同じ割り付けを引く（決定論）', () => {
    const a = seatedOccupants(layout, bays, 2, 0.5);
    const b = seatedOccupants(layout, bays, 2, 0.5);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // 膝は必ず座席の前縁より通路側にある
    for (const person of a) {
      expect(person.kneeReach).toBeLessThan(inner - INTERIOR.seatDepth);
    }
  });
});
