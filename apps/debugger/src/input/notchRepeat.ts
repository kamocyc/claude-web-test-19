import type { DriverCommand } from './driverState.ts';

/** 押してから繰り返しが始まるまでの時間 [s] */
export const REPEAT_DELAY = 0.4;
/** 繰り返しの間隔 [s] */
export const REPEAT_INTERVAL = 0.18;
/** 1 回の更新で送る段数の上限。時計が飛んでもハンドルを走らせない */
export const MAX_STEPS_PER_UPDATE = 4;

/**
 * 長押しで繰り返してよい指令。
 *
 * 段が 1 つずつ動くものだけを入れる。非常・即 N・B1・ドア・逆転機・運転台の
 * スイッチは「押した回数」に意味があるので、押しっぱなしでも 1 回しか効かない。
 */
export const REPEATABLE_COMMANDS: ReadonlySet<DriverCommand> = new Set<DriverCommand>([
  'powerUp',
  'powerDown',
  'notchToBrake',
  'brakeUp',
  'brakeDown',
]);

/**
 * 段を送る相手。`DriverState` がそのまま満たす。
 * 非常位置の手前で止めるために、ブレーキ側の位置も見せてもらう。
 */
export interface RepeatTarget {
  apply(command: DriverCommand): void;
  readonly brakePosition: number;
  readonly brakePositionCount: number;
}

/**
 * ノッチキーの長押し。
 *
 * `Z` を押しっぱなしにすれば P1 → P2 → … と進んでいってほしいが、キーボードの
 * 自動リピート（`KeyboardEvent.repeat`）に任せると、繰り返しの速さが OS の設定に
 * よって変わってしまう。実物のハンドルを送る速さが端末の設定で変わるのはおかしいので、
 * 押した時刻を控えておいて自分で数える。
 *
 * 数えるのは**時刻の差**であって、フレームごとの経過時間の足し算ではない。描画が
 * 重い端末では 1 フレームが何百 ms にもなるので、足していくと「軽く押しただけなのに
 * 何段も進む」「押し続けているのに進まない」のどちらかが起きる。
 *
 * DOM には触れない。`update` を描画のたびに呼ぶだけでよい。
 */
export class NotchRepeat {
  private command: DriverCommand | null = null;
  /** 押した時刻 [s] */
  private pressedAt = 0;
  /** 繰り返しで進めた回数 */
  private fired = 0;

  constructor(private readonly state: RepeatTarget) {}

  /** いま押されている指令（無ければ null） */
  get current(): DriverCommand | null {
    return this.command;
  }

  /**
   * キーが押された。繰り返しの対象なら受け付ける。
   * 最初の 1 段は呼び出し側が進めるので、ここでは時刻を控えるだけ。
   *
   * @param now 押した時刻 [s]（`KeyboardEvent.timeStamp` と同じ時計）
   */
  press(command: DriverCommand, now: number): void {
    if (!REPEATABLE_COMMANDS.has(command)) return;
    this.command = command;
    this.pressedAt = now;
    this.fired = 0;
  }

  /** キーが離された。押していたものと違うキーなら何もしない */
  release(command: DriverCommand): void {
    if (this.command === command) this.clear();
  }

  /** 押しっぱなしを断つ（ウィンドウが背面へ回った、運転台を組み直した） */
  clear(): void {
    this.command = null;
    this.fired = 0;
  }

  /** 現在時刻 [s] を渡して、来ている回数だけ段を送る */
  update(now: number): void {
    const command = this.command;
    if (!command) return;
    const elapsed = now - this.pressedAt;
    if (elapsed < REPEAT_DELAY) return;
    const due = Math.floor((elapsed - REPEAT_DELAY) / REPEAT_INTERVAL) + 1;
    const steps = Math.min(MAX_STEPS_PER_UPDATE, Math.max(0, due - this.fired));
    this.fired = due;
    for (let i = 0; i < steps; i++) {
      if (this.atEmergencyDetent(command)) {
        // 非常へは自動では入らない。実車のワンハンドルにも非常位置には節度が
        // あって、意識して越えるようになっている。握り続けただけで非常が入るのでは、
        // 常用最大まで込める操作ができない。
        this.clear();
        return;
      }
      this.state.apply(command);
    }
  }

  /** ブレーキ側の端（非常の 1 つ手前）まで来ているか */
  private atEmergencyDetent(command: DriverCommand): boolean {
    if (command !== 'brakeUp' && command !== 'notchToBrake') return false;
    return this.state.brakePosition >= this.state.brakePositionCount - 1;
  }
}
