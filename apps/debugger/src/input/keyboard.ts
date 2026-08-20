import type { ControlInput } from '@railsim/core';
import { DriverState, type HandlePosition, type NotchCounts } from './driverState.ts';
import { lookupKey, type UiCommand } from './keymap.ts';
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
    const action = lookupKey(e.key);
    if (action?.kind === 'held') this.state.release(action.command);
    if (action?.kind === 'driver') this.repeat.release(action.command);
  };

  /** ウィンドウからフォーカスが外れたら、押しっぱなしのキーは離したものとして扱う */
  private onBlur = (): void => {
    this.state.releaseAll();
    this.repeat.clear();
  };

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
