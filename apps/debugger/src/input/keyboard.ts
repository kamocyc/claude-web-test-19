import type { ControlInput } from '@railsim/core';
import { DriverState, type HandlePosition, type NotchCounts } from './driverState.ts';
import { lookupKey, lookupWalkKey, type UiCommand, type WalkCommand } from './keymap.ts';
import { NotchRepeat } from './notchRepeat.ts';

export interface DriverDeskOptions extends NotchCounts {
  /** 視点を次へ送る */
  onCameraCycle?(): void;
  /** 自動運転の入切 */
  onAutoDriveToggle?(): void;
  onPauseToggle?(): void;
  onSingleStep?(): void;
  onRateChange?(delta: number): void;
  onMuteToggle?(): void;
  /** HUD・操作凡例・G メータの表示切替 */
  onUiToggle?(): void;
  /** どのキーでもよいので「ユーザ操作があった」ことを伝える（自動再生規制の解除用） */
  onUserGesture?(): void;
  /**
   * 車内を歩くモードか。
   *
   * 歩いているあいだは `W` `A` `S` `D` と矢印キーが歩行の操作になり、運転の
   * キーは効かない（`keymap.ts` の `WALK_BINDINGS` を参照）。画面と進行の操作は
   * どちらのモードでも効くので、視点を戻すのも自動運転を入れるのも歩きながら
   * できる — でないと、走行中に歩き始めた人が列車を止められなくなる。
   */
  isWalking?(): boolean;
}

/** 歩行の入力（`render/walk.ts` の `WalkInput` と同じ形） */
export interface WalkKeys {
  readonly forward: number;
  readonly strafe: number;
  readonly run: boolean;
  /** 首を振る量 [rad/s]（正 = 左） */
  readonly turn: number;
  /** 見上げる量 [rad/s]（正 = 上） */
  readonly look: number;
}

/**
 * キー入力を無視すべき相手か。
 *
 * 文字入力中のフィールドだけを除外する。`<select>` やボタンを除外してしまうと、
 * 画面のボタンを一度クリックしただけでノッチ操作を受け付けなくなる。
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['file', 'checkbox', 'radio', 'button', 'submit', 'range'].includes(target.type);
  }
  return false;
}

/**
 * キーボードを運転台に見立てて `ControlInput` を組み立てる。
 *
 * ハンドル位置そのものは `DriverState` が持つ。この class はキーと指令の
 * 対応表に徹していて、タッチ運転台と同じ状態機械を叩く（同じ `DriverState` を
 * 渡せば、キーで入れたノッチが画面のレバーにもそのまま出る）。
 */
export class DriverDesk {
  private readonly state: DriverState;
  /** ノッチキーの長押し（押しっぱなしで段が進む） */
  private readonly repeat: NotchRepeat;
  /** 押しっぱなしになっている歩行のキー */
  private readonly walkHeld = new Set<WalkCommand>();

  constructor(
    private readonly options: DriverDeskOptions,
    state?: DriverState,
  ) {
    this.state = state ?? new DriverState(options);
    this.repeat = new NotchRepeat(this.state);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // AudioContext はユーザ操作の中でしか開始できない（自動再生規制）
    this.options.onUserGesture?.();

    // 歩いているあいだは歩行の表だけを引く。運転のキーは受け付けない。
    if (this.options.isWalking?.()) {
      const walk = lookupWalkKey(e.key);
      if (walk) {
        this.walkHeld.add(walk);
        e.preventDefault();
        return;
      }
      const uiOnly = lookupKey(e.key);
      if (uiOnly?.kind === 'ui' && !e.repeat) {
        this.runUi(uiOnly.command);
        e.preventDefault();
      }
      return;
    }

    const action = lookupKey(e.key);
    if (!action) return;

    if (action.kind === 'held') {
      // 押しっぱなしの指令は自動リピートで何度来ても構わない（集合に入れるだけ）
      this.state.hold(action.command);
    } else if (!e.repeat) {
      // キーボードの自動リピートは使わない（繰り返しの速さが OS の設定で変わる）。
      // ノッチを送るキーだけ、こちらで時間を数えて `tick` から進める。
      if (action.kind === 'driver') {
        this.state.apply(action.command);
        // 時刻は「こちらが押下を受け取った瞬間」で控える。`KeyboardEvent.timeStamp`
        // は入力が生まれた時刻なので、描画が詰まっている端末では受け取るまでに
        // 何秒も開いてしまい、軽く押しただけで長押し扱いになる。
        this.repeat.press(action.command, performance.now() / 1000);
      } else {
        this.runUi(action.command);
      }
    }

    // 割り当てたキーはブラウザ既定の動作を止める。
    //  - Space・PageUp・PageDown・矢印キーは画面がスクロールする
    //  - Space・Enter は直前にクリックしたボタンを再度押してしまう
    //    （非常ブレーキのつもりが「一時停止」を叩く、といった事故になる）
    e.preventDefault();
  };

  private runUi(command: UiCommand): void {
    switch (command) {
      case 'cameraCycle':
        this.options.onCameraCycle?.();
        return;
      case 'uiToggle':
        this.options.onUiToggle?.();
        return;
      case 'autoDrive':
        this.options.onAutoDriveToggle?.();
        return;
      case 'pause':
        this.options.onPauseToggle?.();
        return;
      case 'singleStep':
        this.options.onSingleStep?.();
        return;
      case 'mute':
        this.options.onMuteToggle?.();
        return;
      case 'rateDown':
        this.options.onRateChange?.(-1);
        return;
      case 'rateUp':
        this.options.onRateChange?.(1);
        return;
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const walk = lookupWalkKey(e.key);
    if (walk) this.walkHeld.delete(walk);
    const action = lookupKey(e.key);
    if (action?.kind === 'held') this.state.release(action.command);
    if (action?.kind === 'driver') this.repeat.release(action.command);
  };

  /** ウィンドウからフォーカスが外れたら、押しっぱなしのキーは離したものとして扱う */
  private onBlur = (): void => {
    this.state.releaseAll();
    this.repeat.clear();
    this.walkHeld.clear();
  };

  /** 車内を歩くモードの入力（押しっぱなしのキーから作る） */
  get walkKeys(): WalkKeys {
    const held = this.walkHeld;
    const axis = (plus: WalkCommand, minus: WalkCommand): number =>
      (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    return {
      forward: axis('forward', 'backward'),
      strafe: axis('right', 'left'),
      run: held.has('run'),
      turn: axis('turnLeft', 'turnRight'),
      look: axis('lookUp', 'lookDown'),
    };
  }

  /**
   * 描画のたびに呼ぶ。ノッチキーを押しっぱなしにしているあいだ、段を進める。
   * `now` は実時間の時刻 [s]（一時停止していてもハンドルは動かせる）。
   */
  tick(now: number): void {
    this.repeat.update(now);
  }

  reset(): void {
    this.state.reset();
    this.repeat.clear();
  }

  /** 押しっぱなしのキーを離したものとして扱う（背面へ回ったときなど） */
  releaseKeys(): void {
    this.repeat.clear();
    this.walkHeld.clear();
  }

  /**
   * ハンドル位置を外から合わせる。
   * 自動運転を切った瞬間に運転士へ引き継ぐときに使う。合わせておかないと、
   * 装置が入れていたブレーキが解除に変わって列車が走り出してしまう。
   */
  takeOver(power: number, brake: number, doorsClosed: boolean, holding = 0): void {
    this.state.takeOver(power, brake, doorsClosed, holding);
  }

  /** 運転士が握っているハンドルの位置（シミュレーションの実効ノッチとは別） */
  get handles(): HandlePosition {
    return this.state.handles;
  }

  /** 現在の操作入力 */
  get input(): ControlInput {
    return this.state.input;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
