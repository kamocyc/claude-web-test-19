import { NEUTRAL_INPUT, type ControlInput } from '@railsim/core';

/**
 * 運転台への指令。
 *
 * キーボードのキーとも画面のボタンとも独立した語彙にしてある。こうしておくと、
 * ノッチの進め方（力行を上げたらブレーキが落ちる、といった相互排他）を
 * キー入力とタッチ操作で二重に書かずに済む。
 */
export type DriverCommand =
  'powerUp' | 'powerDown' | 'brakeUp' | 'brakeDown' | 'emergency' | 'doorsToggle';

/** 「押している間だけ有効」な指令（離すと戻る操作） */
export type HeldCommand = 'acknowledge' | 'safetyReset' | 'horn' | 'sanding';

/** ノッチ段数。シナリオ（車両）を切り替えても追従できるよう関数で受ける。 */
export interface NotchCounts {
  powerNotchCount(): number;
  brakeNotchCount(): number;
}

/** 運転士が握っているハンドルの位置（シミュレーションの実効ノッチとは別） */
export interface HandlePosition {
  readonly power: number;
  readonly brake: number;
  /** 抑速ブレーキの段（0 = 切）。運転台にハンドルは無く、自動運転装置だけが使う。 */
  readonly holding: number;
  readonly emergency: boolean;
  readonly doorsClosed: boolean;
}

/** 段を 0〜max の整数へ丸める */
function clampNotch(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/**
 * 運転台のハンドル位置を保持する状態機械。
 *
 * DOM には一切触れない。キーボード（`DriverDesk`）とタッチ運転台（`TouchConsole`）が
 * 同じインスタンスを共有するので、どちらで操作しても手元のハンドルは 1 組だけになる。
 *
 * 実車のマスコンと同じく、力行とブレーキは別々のハンドルとして扱い、
 * 一方を入れたら他方は戻す（両方を同時には入れられない）。
 */
export class DriverState {
  private powerNotch = 0;
  private brakeNotch = 0;
  private emergencyOn = false;
  private doorsClosed = true;
  private readonly heldCommands = new Set<HeldCommand>();

  constructor(private readonly counts: NotchCounts) {}

  /** 一度の操作で段が 1 つ動くもの */
  apply(command: DriverCommand): void {
    switch (command) {
      case 'powerUp':
        this.setPower(this.powerNotch + 1);
        break;
      case 'powerDown':
        this.powerNotch = Math.max(0, this.powerNotch - 1);
        break;
      case 'brakeUp':
        // 非常はここでは解かない。込めていく操作で非常が緩んでは事故になる。
        this.powerNotch = 0;
        this.brakeNotch = clampNotch(this.brakeNotch + 1, this.counts.brakeNotchCount());
        break;
      case 'brakeDown':
        this.emergencyOn = false;
        this.brakeNotch = Math.max(0, this.brakeNotch - 1);
        break;
      case 'emergency':
        this.setEmergency(true);
        break;
      case 'doorsToggle':
        this.doorsClosed = !this.doorsClosed;
        break;
    }
  }

  /**
   * 力行ノッチを直接指定する（レバーのドラッグ用）。
   * 入れた時点でブレーキは緩解する。0 に戻すだけならブレーキには触らない。
   */
  setPower(notch: number): void {
    const next = clampNotch(notch, this.counts.powerNotchCount());
    if (next > 0) {
      this.brakeNotch = 0;
      this.emergencyOn = false;
    }
    this.powerNotch = next;
  }

  /**
   * ブレーキノッチを直接指定する（非常は `setEmergency` で扱う）。
   * 常用ブレーキ位置へ動かした時点で非常は解け、力行は切れる。
   */
  setBrake(notch: number): void {
    const next = clampNotch(notch, this.counts.brakeNotchCount());
    if (next > 0) this.powerNotch = 0;
    this.emergencyOn = false;
    this.brakeNotch = next;
  }

  /** 非常ブレーキ。入れると力行は切れ、常用ブレーキは最大段になる。 */
  setEmergency(on: boolean): void {
    if (!on) {
      this.emergencyOn = false;
      return;
    }
    this.powerNotch = 0;
    this.brakeNotch = this.counts.brakeNotchCount();
    this.emergencyOn = true;
  }

  setDoorsClosed(closed: boolean): void {
    this.doorsClosed = closed;
  }

  hold(command: HeldCommand): void {
    this.heldCommands.add(command);
  }

  release(command: HeldCommand): void {
    this.heldCommands.delete(command);
  }

  /** 押しっぱなしの取りこぼしを断つ（ウィンドウが背面へ回った、指が奪われた） */
  releaseAll(): void {
    this.heldCommands.clear();
  }

  isHeld(command: HeldCommand): boolean {
    return this.heldCommands.has(command);
  }

  reset(): void {
    this.powerNotch = 0;
    this.brakeNotch = 0;
    this.emergencyOn = false;
    this.doorsClosed = true;
    this.heldCommands.clear();
  }

  /**
   * ハンドル位置を外から合わせる。
   * 自動運転を切った瞬間に運転士へ引き継ぐときに使う。合わせておかないと、
   * 装置が入れていたブレーキが解除に変わって列車が走り出してしまう。
   */
  takeOver(power: number, brake: number, doorsClosed: boolean): void {
    this.powerNotch = Math.max(0, Math.round(power));
    this.brakeNotch = Math.max(0, Math.round(brake));
    this.emergencyOn = false;
    this.doorsClosed = doorsClosed;
  }

  get handles(): HandlePosition {
    return {
      power: this.powerNotch,
      brake: this.brakeNotch,
      holding: 0,
      emergency: this.emergencyOn,
      doorsClosed: this.doorsClosed,
    };
  }

  /** 現在の操作入力 */
  get input(): ControlInput {
    return {
      ...NEUTRAL_INPUT,
      powerNotch: this.powerNotch,
      brakeNotch: this.brakeNotch,
      emergency: this.emergencyOn,
      acknowledge: this.heldCommands.has('acknowledge'),
      safetyReset: this.heldCommands.has('safetyReset'),
      horn: this.heldCommands.has('horn'),
      sanding: this.heldCommands.has('sanding'),
      doorsClosed: this.doorsClosed,
    };
  }
}
