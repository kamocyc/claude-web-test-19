import { NEUTRAL_INPUT, type ControlInput } from '@railsim/core';
import { CAMERA_MODES, type CameraMode } from '../render/cameras.ts';

export interface DriverDeskOptions {
  /** 力行ノッチ段数。シナリオ（車両）を切り替えても追従できるよう関数で受ける。 */
  powerNotchCount(): number;
  /** 常用ブレーキノッチ段数 */
  brakeNotchCount(): number;
  onCameraChange?(mode: CameraMode): void;
  onPauseToggle?(): void;
  onSingleStep?(): void;
  onRateChange?(delta: number): void;
}

/** 「押している間だけ有効」なキー（離すまで状態が続く操作） */
const HELD_KEYS = new Set(['enter', 'r', 'h', 's']);

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
 * 実車のマスコンと同じく、力行とブレーキは別々のハンドルとして扱い、
 * 「押している間だけ有効」なもの（砂撒き・警笛・確認扱い）と
 * 「一度押すと段が変わる」もの（ノッチ）を区別する。
 */
export class DriverDesk {
  private powerNotch = 0;
  private brakeNotch = 0;
  private emergency = false;
  private held = new Set<string>();
  private doorsClosed = true;

  constructor(private readonly options: DriverDeskOptions) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.held.clear());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (!e.repeat) {
      switch (key) {
        case 'z':
        case 'arrowup':
          this.brakeNotch = 0;
          this.emergency = false;
          this.powerNotch = Math.min(this.options.powerNotchCount(), this.powerNotch + 1);
          break;
        case 'a':
        case 'arrowdown':
          this.powerNotch = Math.max(0, this.powerNotch - 1);
          break;
        case '.':
        case 'arrowright':
          this.powerNotch = 0;
          this.brakeNotch = Math.min(this.options.brakeNotchCount(), this.brakeNotch + 1);
          break;
        case ',':
        case 'arrowleft':
          this.emergency = false;
          this.brakeNotch = Math.max(0, this.brakeNotch - 1);
          break;
        case ' ':
          this.powerNotch = 0;
          this.brakeNotch = this.options.brakeNotchCount();
          this.emergency = true;
          break;
        case 'd':
          this.doorsClosed = !this.doorsClosed;
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5': {
          const mode = CAMERA_MODES[Number(key) - 1];
          if (mode) this.options.onCameraChange?.(mode);
          break;
        }
        case 'p':
          this.options.onPauseToggle?.();
          break;
        case 'f':
          this.options.onSingleStep?.();
          break;
        case '[':
          this.options.onRateChange?.(-1);
          break;
        case ']':
          this.options.onRateChange?.(1);
          break;
        default:
          handled = HELD_KEYS.has(key);
          break;
      }
    }
    this.held.add(key);
    // 運転操作に使うキーはブラウザ既定の動作を止める。
    // 特に Space / Enter は、直前にクリックしたボタンを再度押してしまうため
    // （非常ブレーキのつもりが「一時停止」を叩く、といった事故になる）。
    if (handled) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.key.toLowerCase());
  };

  reset(): void {
    this.powerNotch = 0;
    this.brakeNotch = 0;
    this.emergency = false;
    this.doorsClosed = true;
    this.held.clear();
  }

  /** 運転士が握っているハンドルの位置（シミュレーションの実効ノッチとは別） */
  get handles(): { power: number; brake: number; emergency: boolean; doorsClosed: boolean } {
    return {
      power: this.powerNotch,
      brake: this.brakeNotch,
      emergency: this.emergency,
      doorsClosed: this.doorsClosed,
    };
  }

  /** 現在の操作入力 */
  get input(): ControlInput {
    return {
      ...NEUTRAL_INPUT,
      powerNotch: this.powerNotch,
      brakeNotch: this.brakeNotch,
      emergency: this.emergency,
      acknowledge: this.held.has('enter'),
      safetyReset: this.held.has('r'),
      horn: this.held.has('h'),
      sanding: this.held.has('s'),
      doorsClosed: this.doorsClosed,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
