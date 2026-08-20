import { describe, expect, it } from 'vitest';
import { DriverState } from '../src/input/driverState.ts';

/** 通勤形と同じ段数（力行 4・常用ブレーキ 7・抑速 7）。段数は関数で読ませる。 */
function makeState(power = 4, brake = 7, holding = brake): DriverState {
  return new DriverState({
    powerNotchCount: () => power,
    brakeNotchCount: () => brake,
    holdingNotchCount: () => holding,
  });
}

describe('運転台のハンドル位置', () => {
  it('初期状態は切・戸閉め', () => {
    const state = makeState();
    expect(state.handles).toEqual({
      power: 0,
      brake: 0,
      holding: 0,
      emergency: false,
      doorsClosed: true,
    });
    expect(state.input.powerNotch).toBe(0);
    expect(state.input.doorsClosed).toBe(true);
  });

  it('力行とブレーキは同時に入らない', () => {
    const state = makeState();
    state.apply('brakeUp');
    state.apply('brakeUp');
    expect(state.handles.brake).toBe(2);

    state.apply('powerUp');
    expect(state.handles.power).toBe(1);
    expect(state.handles.brake).toBe(0);

    state.apply('brakeUp');
    expect(state.handles.power).toBe(0);
    expect(state.handles.brake).toBe(1);
  });

  it('ノッチは段数で頭打ちになる', () => {
    const state = makeState();
    for (let i = 0; i < 10; i += 1) state.apply('powerUp');
    expect(state.handles.power).toBe(4);
    for (let i = 0; i < 10; i += 1) state.apply('powerDown');
    expect(state.handles.power).toBe(0);

    for (let i = 0; i < 20; i += 1) state.apply('brakeUp');
    expect(state.handles.brake).toBe(7);
  });

  it('段数は操作のたびに読み直す（車両を替えても追従する）', () => {
    let brakeCount = 7;
    const state = new DriverState({
      powerNotchCount: () => 4,
      brakeNotchCount: () => brakeCount,
    });
    state.setBrake(99);
    expect(state.handles.brake).toBe(7);

    brakeCount = 8;
    state.setBrake(99);
    expect(state.handles.brake).toBe(8);
  });
});

describe('非常ブレーキ', () => {
  it('入れると力行が切れ、常用は最大段になる', () => {
    const state = makeState();
    state.apply('powerUp');
    state.apply('emergency');
    expect(state.handles).toMatchObject({ power: 0, brake: 7, emergency: true });
    expect(state.input.emergency).toBe(true);
  });

  it('緩める操作と力行では解けるが、込める操作では解けない', () => {
    const state = makeState();

    state.apply('emergency');
    state.apply('brakeUp');
    // 込めていく操作で非常が緩んでは事故になる
    expect(state.handles.emergency).toBe(true);

    state.apply('brakeDown');
    expect(state.handles.emergency).toBe(false);

    state.apply('emergency');
    state.apply('powerUp');
    expect(state.handles.emergency).toBe(false);
    expect(state.handles.power).toBe(1);
  });

  it('レバーを常用位置へ動かすと解ける', () => {
    const state = makeState();
    state.apply('emergency');
    state.setBrake(3);
    expect(state.handles).toMatchObject({ brake: 3, emergency: false });
  });
});

describe('レバーからの直接指定', () => {
  it('0〜段数へ丸める', () => {
    const state = makeState();
    state.setPower(99);
    expect(state.handles.power).toBe(4);
    state.setPower(-5);
    expect(state.handles.power).toBe(0);
    state.setBrake(2.4);
    expect(state.handles.brake).toBe(2);
  });

  it('力行を入れるとブレーキが緩解し、0 に戻すだけならブレーキに触らない', () => {
    const state = makeState();
    state.setBrake(3);
    state.setPower(2);
    expect(state.handles).toMatchObject({ power: 2, brake: 0 });

    state.setBrake(3);
    state.setPower(0);
    expect(state.handles.brake).toBe(3);
  });
});

describe('押している間だけ有効な操作', () => {
  it('押すと立ち、離すと落ちる', () => {
    const state = makeState();
    expect(state.input.horn).toBe(false);
    state.hold('horn');
    expect(state.input.horn).toBe(true);
    state.release('horn');
    expect(state.input.horn).toBe(false);
  });

  it('複数を同時に押せる（マルチタッチ）', () => {
    const state = makeState();
    state.hold('horn');
    state.hold('sanding');
    state.hold('acknowledge');
    expect(state.input).toMatchObject({ horn: true, sanding: true, acknowledge: true });

    state.release('horn');
    expect(state.input).toMatchObject({ horn: false, sanding: true, acknowledge: true });
  });

  it('releaseAll で全部落ちる（指を奪われた・背面へ回った）', () => {
    const state = makeState();
    state.hold('horn');
    state.hold('safetyReset');
    state.releaseAll();
    expect(state.input).toMatchObject({ horn: false, safetyReset: false });
    expect(state.isHeld('horn')).toBe(false);
  });
});

describe('扉と引き継ぎ', () => {
  it('戸閉めは押すたびに入れ替わる', () => {
    const state = makeState();
    state.apply('doorsToggle');
    expect(state.handles.doorsClosed).toBe(false);
    state.apply('doorsToggle');
    expect(state.handles.doorsClosed).toBe(true);
  });

  it('takeOver は装置のノッチをそのまま引き継ぐ（非常だけ解く）', () => {
    const state = makeState();
    state.apply('emergency');
    state.takeOver(0, 3, false);
    expect(state.handles).toEqual({
      power: 0,
      brake: 3,
      holding: 0,
      emergency: false,
      doorsClosed: false,
    });
  });

  it('reset で初期状態へ戻る', () => {
    const state = makeState();
    state.apply('powerUp');
    state.apply('doorsToggle');
    state.hold('horn');
    state.reset();
    expect(state.handles).toEqual({
      power: 0,
      brake: 0,
      holding: 0,
      emergency: false,
      doorsClosed: true,
    });
    expect(state.input.horn).toBe(false);
  });
});

describe('ControlInput への写し取り', () => {
  it('割り当てのない項目は中立のまま残る', () => {
    const state = makeState();
    state.setPower(2);
    // 逆転機・抑速・直通予備は運転台に割り当てが無く、中立の既定値が保たれる
    expect(state.input).toMatchObject({
      powerNotch: 2,
      reverser: 1,
      holdingNotch: 0,
      backupBrake: false,
    });
  });
});

describe('抑速ブレーキ', () => {
  it('切より先へ押し込むと抑速に入り、戻すと力行へ抜ける', () => {
    const state = makeState();
    // 実車のマスコンと同じく、抑速は切を挟んで力行の反対側にある
    state.apply('powerDown');
    expect(state.handles).toMatchObject({ power: 0, holding: 1 });
    state.apply('powerDown');
    state.apply('powerDown');
    expect(state.handles.holding).toBe(3);

    state.apply('powerUp');
    expect(state.handles.holding).toBe(2);
    for (let i = 0; i < 3; i += 1) state.apply('powerUp');
    // 切を越えて力行側へ抜ける
    expect(state.handles).toMatchObject({ power: 1, holding: 0 });
  });

  it('力行と抑速は同時に立たない', () => {
    const state = makeState();
    state.setHolding(4);
    expect(state.handles).toMatchObject({ power: 0, holding: 4 });
    state.setPower(2);
    expect(state.handles).toMatchObject({ power: 2, holding: 0 });
    state.setHolding(1);
    expect(state.handles).toMatchObject({ power: 0, holding: 1 });
  });

  it('抑速は段数で頭打ちになる', () => {
    const state = makeState(4, 7, 7);
    for (let i = 0; i < 20; i += 1) state.apply('powerDown');
    expect(state.handles.holding).toBe(7);
  });

  it('常用ブレーキを込めると抑速は落ちる', () => {
    // ブレーキ装置は常用が切のときしか抑速を見ない。ハンドルだけ抑速位置に
    // 残ると、表示と実際の効きが食い違う。
    const state = makeState();
    state.setHolding(4);
    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ brake: 1, holding: 0 });

    state.setHolding(4);
    state.setBrake(3);
    expect(state.handles.holding).toBe(0);

    state.setHolding(4);
    state.apply('emergency');
    expect(state.handles).toMatchObject({ holding: 0, emergency: true });
  });

  it('抑速を持たない車両では切より先へ入らない', () => {
    const state = makeState(4, 7, 0);
    state.apply('powerDown');
    state.apply('powerDown');
    expect(state.handles).toMatchObject({ power: 0, holding: 0 });
    state.setHolding(3);
    expect(state.handles.holding).toBe(0);
  });

  it('抑速を入れると ControlInput へ渡る', () => {
    const state = makeState();
    state.setHolding(4);
    expect(state.input).toMatchObject({ powerNotch: 0, holdingNotch: 4, brakeNotch: 0 });
  });

  it('takeOver は装置の抑速も引き継ぐ', () => {
    // 下り勾配の途中で手を替えたときにここが抜けると、装置が入れていた
    // 電気ブレーキが突然切れて列車が加速しはじめる。
    const state = makeState();
    state.takeOver(0, 0, true, 5);
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: 5 });
    expect(state.input.holdingNotch).toBe(5);
  });
});
