import { NEUTRAL_INPUT, type ControlInput } from '@railsim/core';
import type { CameraMode } from '../render/cameras.ts';

export interface DriverDeskOptions {
  readonly powerNotchCount: number;
  readonly brakeNotchCount: number;
  onCameraChange?(mode: CameraMode): void;
  onPauseToggle?(): void;
  onSingleStep?(): void;
  onRateChange?(delta: number): void;
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
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const key = e.key.toLowerCase();
    if (!e.repeat) {
      switch (key) {
        case 'z':
        case 'arrowup':
          this.brakeNotch = 0;
          this.emergency = false;
          this.powerNotch = Math.min(this.options.powerNotchCount, this.powerNotch + 1);
          break;
        case 'a':
        case 'arrowdown':
          this.powerNotch = Math.max(0, this.powerNotch - 1);
          break;
        case '.':
        case 'arrowright':
          this.powerNotch = 0;
          this.brakeNotch = Math.min(this.options.brakeNotchCount, this.brakeNotch + 1);
          break;
        case ',':
        case 'arrowleft':
          this.emergency = false;
          this.brakeNotch = Math.max(0, this.brakeNotch - 1);
          break;
        case ' ':
          this.powerNotch = 0;
          this.brakeNotch = this.options.brakeNotchCount;
          this.emergency = true;
          break;
        case 'd':
          this.doorsClosed = !this.doorsClosed;
          break;
        case '1':
          this.options.onCameraChange?.('chase');
          break;
        case '2':
          this.options.onCameraChange?.('side');
          break;
        case '3':
          this.options.onCameraChange?.('overhead');
          break;
        case '4':
          this.options.onCameraChange?.('free');
          break;
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
          break;
      }
    }
    this.held.add(key);
    if (key === ' ' || key.startsWith('arrow')) e.preventDefault();
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
