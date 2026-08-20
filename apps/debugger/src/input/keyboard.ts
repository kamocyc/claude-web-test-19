import type { ControlInput } from '@railsim/core';
import { CAMERA_MODES, type CameraMode } from '../render/cameras.ts';
import {
  DriverState,
  type DriverCommand,
  type HandlePosition,
  type HeldCommand,
} from './driverState.ts';

export interface DriverDeskOptions {
  /** 力行ノッチ段数。シナリオ（車両）を切り替えても追従できるよう関数で受ける。 */
  powerNotchCount(): number;
  /** 常用ブレーキノッチ段数 */
  brakeNotchCount(): number;
  /** 抑速ブレーキの段数（抑速を持たない車両では 0） */
  holdingNotchCount(): number;
  onCameraChange?(mode: CameraMode): void;
  /** 自動運転の入切 */
  onAutoDriveToggle?(): void;
  onPauseToggle?(): void;
  onSingleStep?(): void;
  onRateChange?(delta: number): void;
  onMuteToggle?(): void;
  /** どのキーでもよいので「ユーザ操作があった」ことを伝える（自動再生規制の解除用） */
  onUserGesture?(): void;
}

/** 一度押すと段が変わるキー */
const NOTCH_KEYS: Readonly<Record<string, DriverCommand>> = {
  z: 'powerUp',
  arrowup: 'powerUp',
  a: 'powerDown',
  arrowdown: 'powerDown',
  '.': 'brakeUp',
  arrowright: 'brakeUp',
  ',': 'brakeDown',
  arrowleft: 'brakeDown',
  ' ': 'emergency',
  d: 'doorsToggle',
};

/** 押している間だけ有効なキー（離すまで状態が続く操作） */
const HELD_KEYS: Readonly<Record<string, HeldCommand>> = {
  enter: 'acknowledge',
  r: 'safetyReset',
  h: 'horn',
  s: 'sanding',
};

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

  constructor(
    private readonly options: DriverDeskOptions,
    state?: DriverState,
  ) {
    this.state = state ?? new DriverState(options);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // AudioContext はユーザ操作の中でしか開始できない（自動再生規制）
    this.options.onUserGesture?.();
    const key = e.key.toLowerCase();
    const heldCommand = HELD_KEYS[key];
    if (heldCommand) this.state.hold(heldCommand);
    let handled = true;
    if (!e.repeat) {
      const notchCommand = NOTCH_KEYS[key];
      if (notchCommand) {
        this.state.apply(notchCommand);
      } else {
        switch (key) {
          case '1':
          case '2':
          case '3':
          case '4':
          case '5': {
            const mode = CAMERA_MODES[Number(key) - 1];
            if (mode) this.options.onCameraChange?.(mode);
            break;
          }
          case 'o':
            this.options.onAutoDriveToggle?.();
            break;
          case 'p':
            this.options.onPauseToggle?.();
            break;
          case 'f':
            this.options.onSingleStep?.();
            break;
          case 'm':
            this.options.onMuteToggle?.();
            break;
          case '[':
            this.options.onRateChange?.(-1);
            break;
          case ']':
            this.options.onRateChange?.(1);
            break;
          default:
            handled = heldCommand !== undefined;
            break;
        }
      }
    }
    // 運転操作に使うキーはブラウザ既定の動作を止める。
    // 特に Space / Enter は、直前にクリックしたボタンを再度押してしまうため
    // （非常ブレーキのつもりが「一時停止」を叩く、といった事故になる）。
    if (handled) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const heldCommand = HELD_KEYS[e.key.toLowerCase()];
    if (heldCommand) this.state.release(heldCommand);
  };

  /** ウィンドウからフォーカスが外れたら、押しっぱなしのキーは離したものとして扱う */
  private onBlur = (): void => {
    this.state.releaseAll();
  };

  reset(): void {
    this.state.reset();
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
