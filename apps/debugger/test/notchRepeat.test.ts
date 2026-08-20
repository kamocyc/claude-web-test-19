import { describe, expect, it } from 'vitest';
import { DriverState } from '../src/input/driverState.ts';
import {
  MAX_STEPS_PER_UPDATE,
  NotchRepeat,
  REPEAT_DELAY,
  REPEAT_INTERVAL,
  REPEATABLE_COMMANDS,
} from '../src/input/notchRepeat.ts';

/** 通勤形と同じ段数（力行 4・常用ブレーキ 7・抑速あり） */
function makeState(): DriverState {
  return new DriverState({
    powerNotchCount: () => 4,
    brakeNotchCount: () => 7,
    hasHoldingBrake: () => true,
  });
}

/**
 * `from` 秒から `seconds` 秒ぶん、`dt` 刻みで時計を進める。
 * 返り値は最後の時刻（続けて回すときに渡す）。
 */
function run(repeat: NotchRepeat, from: number, seconds: number, dt = 1 / 60): number {
  const steps = Math.round(seconds / dt);
  let now = from;
  for (let i = 0; i < steps; i++) {
    now += dt;
    repeat.update(now);
  }
  return now;
}

describe('ノッチキーの長押し', () => {
  it('握り続けると P1 から P4 まで送られる', () => {
    const state = makeState();
    const repeat = new NotchRepeat(state);
    // 最初の 1 段はキーを押した側が進める
    state.apply('powerUp');
    repeat.press('powerUp', 0);
    expect(state.handles.power).toBe(1);

    const t = run(repeat, 0, REPEAT_DELAY - 0.05);
    expect(state.handles.power).toBe(1);

    run(repeat, t, REPEAT_INTERVAL * 3 + 0.1);
    expect(state.handles.power).toBe(4);
  });

  it('繰り返す速さは描画の間隔によらない（OS のリピート速度にも依存しない）', () => {
    // 数えるのは時刻の差なので、1 フレームが 8ms でも 500ms でも同じだけ送られる
    const fine = makeState();
    const fineRepeat = new NotchRepeat(fine);
    fine.apply('powerUp');
    fineRepeat.press('powerUp', 0);
    run(fineRepeat, 0, 1, 1 / 120);

    const coarse = makeState();
    const coarseRepeat = new NotchRepeat(coarse);
    coarse.apply('powerUp');
    coarseRepeat.press('powerUp', 0);
    run(coarseRepeat, 0, 1, 0.5);

    expect(coarse.handles.power).toBe(fine.handles.power);
  });

  it('軽く押しただけでは繰り返さない（描画が重くても）', () => {
    // 押して離すまで 50ms。次の描画が 1 秒後でも、押していた時間で決まる
    const state = makeState();
    const repeat = new NotchRepeat(state);
    state.apply('powerUp');
    repeat.press('powerUp', 0);
    repeat.release('powerUp');
    repeat.update(1);
    expect(state.handles.power).toBe(1);
  });

  it('離せば止まる', () => {
    const state = makeState();
    const repeat = new NotchRepeat(state);
    state.apply('powerUp');
    repeat.press('powerUp', 0);
    const t = run(repeat, 0, REPEAT_DELAY + REPEAT_INTERVAL);
    const stopped = state.handles.power;

    repeat.release('powerUp');
    run(repeat, t, 2);
    expect(state.handles.power).toBe(stopped);
  });

  it('別のキーを離しても止まらない', () => {
    const state = makeState();
    const repeat = new NotchRepeat(state);
    repeat.press('powerUp', 0);
    repeat.release('brakeUp');
    expect(repeat.current).toBe('powerUp');
  });

  it('非常へは自動では入らない（節度がある）', () => {
    const state = makeState();
    const repeat = new NotchRepeat(state);
    state.apply('brakeUp');
    repeat.press('brakeUp', 0);
    run(repeat, 0, 10);

    // 常用最大で止まる
    expect(state.handles).toMatchObject({ brake: 7, emergency: false });
    expect(repeat.current).toBeNull();

    // 改めて押せば非常へ入る
    state.apply('brakeUp');
    expect(state.handles.emergency).toBe(true);
  });

  it('段を 1 つずつ動かすキーだけが繰り返す', () => {
    // 非常・即 N・B1・ドア・逆転機・運転台のスイッチは押した回数に意味があるので、
    // 押しっぱなしでも 1 回しか効かない
    const oneShot = [
      'emergency',
      'notchNeutral',
      'notchB1',
      'doorsOpen',
      'reverserBackward',
      'headlightToggle',
      'wiper',
      'snowproofToggle',
    ] as const;
    for (const command of oneShot) {
      const repeat = new NotchRepeat(makeState());
      repeat.press(command, 0);
      expect(repeat.current).toBeNull();
    }
    expect([...REPEATABLE_COMMANDS].sort()).toEqual([
      'brakeDown',
      'brakeUp',
      'notchToBrake',
      'powerDown',
      'powerUp',
    ]);
  });

  it('フレームが飛んでもハンドルを走らせない', () => {
    const state = makeState();
    const repeat = new NotchRepeat(state);
    state.apply('brakeUp');
    repeat.press('brakeUp', 0);
    // 10 秒ぶん時計が飛んでも、1 回の更新で送るのは上限（4 段）まで
    repeat.update(10);
    expect(state.brakePosition).toBe(1 + MAX_STEPS_PER_UPDATE);
  });

  it('ワンハンドルでも同じように送られる', () => {
    const state = makeState();
    state.setLayout('one-handle');
    const repeat = new NotchRepeat(state);
    state.apply('notchToBrake');
    repeat.press('notchToBrake', 0);
    expect(state.handles.holding).toBe(true);

    run(repeat, 0, 10);
    // N を越えて常用最大まで来て、非常の手前で止まる
    expect(state.handles).toMatchObject({ brake: 7, emergency: false });
  });
});
