import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS, lookupKey } from '../src/input/keymap.ts';

describe('キーの割り当て', () => {
  it('指定どおりの機能が割り当たっている', () => {
    // 表そのものを固定する。キーが重複していないことは Record の型が保証するが、
    // 「どの機能がどこへ行ったか」は目で見て確かめるしかないのでここへ書き出す。
    const expected: Record<string, string> = {
      '1': 'emergency',
      q: 'notchToBrake',
      w: 'notchB1',
      s: 'notchNeutral',
      a: 'powerDown',
      z: 'powerUp',
      ',': 'brakeDown',
      '.': 'brakeUp',
      ' ': 'horn',
      '-': 'headlightToggle',
      l: 'headlightDim',
      v: 'wiper',
      y: 'snowproofToggle',
      '2': 'safetyReset',
      delete: 'acknowledge',
      enter: 'acknowledge',
      arrowup: 'reverserForward',
      arrowdown: 'reverserBackward',
      pagedown: 'doorsOpen',
      pageup: 'doorsClose',
      x: 'sanding',
      u: 'uiToggle',
      c: 'cameraCycle',
      o: 'autoDrive',
      p: 'pause',
      f: 'singleStep',
      m: 'mute',
      '[': 'rateDown',
      ']': 'rateUp',
    };
    const actual = Object.fromEntries(
      Object.entries(KEY_BINDINGS).map(([key, action]) => [key, action.command]),
    );
    expect(actual).toEqual(expected);
  });

  it('名前つきのキーは大文字混じりで来ても引ける', () => {
    // `e.key` は `PageUp`・`Delete`・`ArrowUp` のように大文字混じりで来る。
    // 小文字化を忘れると、押しても何も起きないのに気付きにくい。
    expect(lookupKey('PageUp')).toEqual({ kind: 'driver', command: 'doorsClose' });
    expect(lookupKey('PageDown')).toEqual({ kind: 'driver', command: 'doorsOpen' });
    expect(lookupKey('Delete')).toEqual({ kind: 'held', command: 'acknowledge' });
    expect(lookupKey('ArrowUp')).toEqual({ kind: 'driver', command: 'reverserForward' });
    expect(lookupKey('Z')).toEqual({ kind: 'driver', command: 'powerUp' });
  });

  it('押している間だけ効くのは警笛・砂撒き・確認扱い・復帰だけ', () => {
    const held = Object.entries(KEY_BINDINGS)
      .filter(([, action]) => action.kind === 'held')
      .map(([key]) => key)
      .sort();
    expect(held).toEqual([' ', '2', 'delete', 'enter', 'x']);
  });

  it('以前の割り当ては残っていない', () => {
    // 警笛の H・復帰の R・戸閉の D・矢印のノッチ操作・カメラの数字は移設した
    for (const key of ['h', 'r', 'd', 'arrowleft', 'arrowright', '3', '4', '5']) {
      expect(lookupKey(key)).toBeUndefined();
    }
  });
});
