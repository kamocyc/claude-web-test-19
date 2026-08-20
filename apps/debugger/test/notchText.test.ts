import { describe, expect, it } from 'vitest';
import { notchText } from '../src/ui/hud.ts';

describe('ノッチ位置の表示', () => {
  it('力行・常用ブレーキ・非常を出し分ける', () => {
    expect(notchText(0, 0, false)).toBe('N');
    expect(notchText(4, 0, false)).toBe('P4');
    expect(notchText(0, 7, false)).toBe('B7');
    expect(notchText(0, 7, true)).toBe('非常');
  });

  it('抑速位置を「N」と出さない', () => {
    // 下り勾配を電気ブレーキだけで抑速している間、常用ノッチは 0 のまま制動力が
    // 出ている。ここを出さないと「減速しているのに表示は N」という食い違いになる。
    expect(notchText(0, 0, false, true)).toBe('抑速');
    // 常用ブレーキが入っていればそちらが優先（抑速は常用ノッチ 0 のときだけ効く）
    expect(notchText(0, 3, false, true)).toBe('B3');
    expect(notchText(0, 0, true, true)).toBe('非常');
  });

  it('装置が選んでいる段は数つきで出す', () => {
    // 運転士の手元は抑速位置の入切だけだが、実効側は装置が選んだ段まで出す。
    expect(notchText(0, 0, false, 4)).toBe('抑速4');
    // 段が 0 なら電気ブレーキを出していないので、実効は N である
    expect(notchText(0, 0, false, 0)).toBe('N');
  });
});
