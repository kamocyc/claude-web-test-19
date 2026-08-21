import type { DriverCommand, HeldCommand } from './driverState.ts';

/** 運転そのものではない、画面と進行の操作 */
export type UiCommand =
  | 'cameraCycle'
  | 'autoDrive'
  | 'pause'
  | 'singleStep'
  | 'mute'
  | 'rateDown'
  | 'rateUp'
  | 'uiToggle';

export type KeyAction =
  /** 一度押すごとに 1 回効く（ハンドル・スイッチの操作） */
  | { readonly kind: 'driver'; readonly command: DriverCommand }
  /** 押している間だけ立つ（警笛・砂撒き・確認扱いなど） */
  | { readonly kind: 'held'; readonly command: HeldCommand }
  | { readonly kind: 'ui'; readonly command: UiCommand };

const driver = (command: DriverCommand): KeyAction => ({ kind: 'driver', command });
const held = (command: HeldCommand): KeyAction => ({ kind: 'held', command });
const ui = (command: UiCommand): KeyAction => ({ kind: 'ui', command });

/**
 * キーと指令の対応表。
 *
 * 鍵は `KeyboardEvent.key` を小文字にしたもの。`PageUp` や `Delete` のような
 * 名前つきのキーは大文字混じりで来るので、引く前に必ず小文字へ落とす。
 *
 * 1 つのキーに 2 つの役を持たせない。持たせると `preventDefault` の判断が濁り、
 * 「非常のつもりが一時停止を叩いた」といった事故のもとになる。
 */
export const KEY_BINDINGS: Readonly<Record<string, KeyAction>> = {
  // --- ノッチ ---
  z: driver('powerUp'),
  a: driver('powerDown'),
  q: driver('notchToBrake'),
  s: driver('notchNeutral'),
  w: driver('notchB1'),
  '.': driver('brakeUp'),
  ',': driver('brakeDown'),
  '1': driver('emergency'),

  // --- 運転台のスイッチ ---
  arrowup: driver('reverserForward'),
  arrowdown: driver('reverserBackward'),
  pagedown: driver('doorsOpen'),
  pageup: driver('doorsClose'),
  '-': driver('headlightToggle'),
  l: driver('headlightDim'),
  v: driver('wiper'),
  y: driver('snowproofToggle'),

  // --- 押している間だけ効くもの ---
  ' ': held('horn'),
  x: held('sanding'),
  enter: held('acknowledge'),
  delete: held('acknowledge'),
  '2': held('safetyReset'),

  // --- 画面と進行 ---
  c: ui('cameraCycle'),
  u: ui('uiToggle'),
  o: ui('autoDrive'),
  p: ui('pause'),
  f: ui('singleStep'),
  m: ui('mute'),
  '[': ui('rateDown'),
  ']': ui('rateUp'),
};

/** `KeyboardEvent.key` から指令を引く */
export function lookupKey(key: string): KeyAction | undefined {
  return KEY_BINDINGS[key.toLowerCase()];
}

/** 車内を歩くモードの操作 */
export type WalkCommand =
  | 'forward'
  | 'backward'
  | 'left'
  | 'right'
  | 'run'
  | 'turnLeft'
  | 'turnRight'
  | 'lookUp'
  | 'lookDown';

/**
 * 車内を歩くモードのキー。
 *
 * **運転のキーとは別の表**にしてある。歩いているあいだは運転できない
 * （手すりにつかまっている人はハンドルを握れない）という割り切りなので、
 * `W` `A` `S` `D` が運転のノッチと重なっていても取り合いにならない。歩行中は
 * こちらの表だけを引き、運転の表は引かない — 逆に画面と進行の操作
 * （視点・自動運転・一時停止・倍率・消音）は歩きながらでも効く。
 *
 * マウスを使えない場面（ヘッドレスでの撮影など）のために、`Q` `E` で首を振り、
 * `PageUp` `PageDown` で見上げ・見下ろしができるようにしてある。
 */
export const WALK_BINDINGS: Readonly<Record<string, WalkCommand>> = {
  w: 'forward',
  s: 'backward',
  a: 'left',
  d: 'right',
  arrowup: 'forward',
  arrowdown: 'backward',
  arrowleft: 'left',
  arrowright: 'right',
  shift: 'run',
  q: 'turnLeft',
  e: 'turnRight',
  pageup: 'lookUp',
  pagedown: 'lookDown',
};

/** `KeyboardEvent.key` から歩行の指令を引く */
export function lookupWalkKey(key: string): WalkCommand | undefined {
  return WALK_BINDINGS[key.toLowerCase()];
}
