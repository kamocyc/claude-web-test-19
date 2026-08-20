import type { DriverState, HandlePosition, HeldCommand } from '../input/driverState.ts';
import { notchText } from './hud.ts';

export interface TouchConsoleOptions {
  /** キーボードと共有する運転台の状態。どちらで操作してもハンドルは 1 組。 */
  state: DriverState;
  powerNotchCount(): number;
  brakeNotchCount(): number;
  /** 抑速ブレーキの段数（抑速を持たない車両では 0） */
  holdingNotchCount(): number;
  /** 画面のどこを触っても音声の自動再生規制を解く */
  onUserGesture(): void;
  /** カメラを次の視点へ送る */
  onCameraCycle(): void;
  onAutoDriveToggle(): void;
  onPauseToggle(): void;
  /** 走行条件・ミキサー・グラフの引き出しを開閉する */
  onDrawerToggle(): void;
}

/**
 * 縦ドラッグのレバー 1 本。
 *
 * 段は上から下へ並べる。段数は車両で変わる（力行 4 段・ブレーキ 7〜8 段）ので、
 * 目盛りは表示のたびに段数を見て組み直す。
 */
class Lever {
  readonly element: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private detents: HTMLDivElement[] = [];
  private labels: readonly string[] = [];
  /** ドラッグ中の指。1 本のレバーは 1 本の指だけが握る。 */
  private pointerId: number | null = null;

  constructor(
    role: 'power' | 'brake',
    title: string,
    private readonly options: { onPick(index: number): void; onGesture(): void },
  ) {
    this.element = document.createElement('div');
    this.element.className = `touch-lever ${role}`;

    const heading = document.createElement('div');
    heading.className = 'touch-lever-title';
    heading.textContent = title;

    this.track = document.createElement('div');
    this.track.className = 'touch-lever-track';

    this.thumb = document.createElement('div');
    this.thumb.className = 'touch-lever-thumb';
    this.track.append(this.thumb);

    this.element.append(heading, this.track);

    this.track.addEventListener('pointerdown', this.onPointerDown);
    this.track.addEventListener('pointermove', this.onPointerMove);
    this.track.addEventListener('pointerup', this.onPointerRelease);
    this.track.addEventListener('pointercancel', this.onPointerRelease);
    this.track.addEventListener('lostpointercapture', this.onPointerRelease);
    // Android の長押しメニューでレバーを握ったまま指を奪われるのを防ぐ
    this.track.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /** 目盛りを組み直す（上から下の順。段数が変わったときだけ作り直す） */
  setPositions(labels: readonly string[]): void {
    if (
      this.labels.length === labels.length &&
      this.labels.every((label, i) => label === labels[i])
    ) {
      return;
    }
    this.labels = labels;
    for (const detent of this.detents) detent.remove();
    this.detents = labels.map((label) => {
      const detent = document.createElement('div');
      detent.className = 'touch-lever-detent';
      detent.textContent = label;
      return detent;
    });
    // つまみは目盛りの手前に残す
    this.track.prepend(...this.detents);
    this.thumb.style.height = `${100 / labels.length}%`;
  }

  /** 現在位置へつまみを合わせる */
  setActive(index: number): void {
    const steps = this.labels.length;
    if (steps === 0) return;
    const clamped = Math.max(0, Math.min(steps - 1, index));
    this.thumb.style.top = `${(clamped / steps) * 100}%`;
    this.thumb.textContent = this.labels[clamped] ?? '';
    this.detents.forEach((detent, i) => detent.classList.toggle('on', i === clamped));
  }

  private pick(event: PointerEvent): void {
    const steps = this.labels.length;
    if (steps === 0) return;
    const rect = this.track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (event.clientY - rect.top) / rect.height;
    const index = Math.max(0, Math.min(steps - 1, Math.floor(ratio * steps)));
    this.options.onPick(index);
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 既に握られているレバーには 2 本目の指を受け付けない
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    // 指がレバーの外へ出ても追い続ける（左右のレバーを同時に握れるように、
    // 指ごとに捕まえる）
    this.track.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.options.onGesture();
    this.pick(event);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.pick(event);
  };

  /**
   * 指を離した／システムに指を奪われた。
   * `pointercancel` も同じ扱いにしないと、握ったままのレバーが残る。
   */
  private onPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    if (this.track.hasPointerCapture(event.pointerId)) {
      this.track.releasePointerCapture(event.pointerId);
    }
    this.pointerId = null;
  };
}

/** 力行レバーの目盛り（上ほど強い）。`['P4','P3','P2','P1','切']` */
function powerLabels(count: number, holdingCount: number): string[] {
  const labels: string[] = [];
  for (let notch = count; notch >= 1; notch -= 1) labels.push(`P${notch}`);
  labels.push('切');
  // 抑速は切より先（力行の反対側）に並ぶ。実車のマスコンと同じ並び。
  for (let notch = 1; notch <= holdingCount; notch += 1) labels.push(`抑${notch}`);
  return labels;
}

/** ブレーキレバーの目盛り（上ほど強い）。`['非常','B7',…,'B1','切']` */
function brakeLabels(count: number): string[] {
  const labels: string[] = ['非常'];
  for (let notch = count; notch >= 1; notch -= 1) labels.push(`B${notch}`);
  labels.push('切');
  return labels;
}

/**
 * タッチ運転台。
 *
 * 実車の運転台（`render/cab.ts`）と同じツーハンドルに合わせ、左手に主幹制御器、
 * 右手にブレーキ設定器を置く。両レバーとも**上ほど強い**で揃えてある
 * （左右で向きが逆だと、咄嗟のときに間違える）。
 *
 * ノッチの進め方そのものは `DriverState` が持っていて、キーボードと共有する。
 * ここは指の位置を段へ量子化して渡すだけで、相互排他の規則は書かない。
 */
export class TouchConsole {
  readonly element: HTMLDivElement;
  private readonly powerLever: Lever;
  private readonly brakeLever: Lever;
  private readonly readout: HTMLDivElement;
  private readonly doorsButton: HTMLButtonElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly autoButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private visible = false;

  constructor(
    host: HTMLElement,
    private readonly options: TouchConsoleOptions,
  ) {
    const { state } = options;
    this.element = document.createElement('div');
    this.element.className = 'touch-console';

    this.powerLever = new Lever('power', '力行', {
      onGesture: () => options.onUserGesture(),
      // 目盛りは上が最大段。段数は掴むたびに読み直す（車両を替えても追従する）。
      // 切より下は抑速なので、そのまま負の位置になる。
      onPick: (index) => state.setHandle(options.powerNotchCount() - index),
    });
    this.brakeLever = new Lever('brake', 'ブレーキ', {
      onGesture: () => options.onUserGesture(),
      onPick: (index) => {
        if (index === 0) state.setEmergency(true);
        else state.setBrake(options.brakeNotchCount() + 1 - index);
      },
    });

    const panel = document.createElement('div');
    panel.className = 'touch-panel';

    this.readout = document.createElement('div');
    this.readout.className = 'touch-readout';

    const emergency = this.tapButton('非常', 'danger', () => state.setEmergency(true));
    this.doorsButton = this.tapButton('戸閉', '', () => state.apply('doorsToggle'));
    this.cameraButton = this.tapButton('視点', '', () => options.onCameraCycle());
    this.autoButton = this.tapButton('ATO', '', () => options.onAutoDriveToggle());
    this.pauseButton = this.tapButton('停止', '', () => options.onPauseToggle());
    const drawer = this.tapButton('設定', '', () => options.onDrawerToggle());

    const holds = document.createElement('div');
    holds.className = 'touch-row';
    holds.append(
      this.holdButton('警笛', 'horn'),
      this.holdButton('砂', 'sanding'),
      this.holdButton('確認', 'acknowledge'),
      this.holdButton('復帰', 'safetyReset'),
    );

    const taps = document.createElement('div');
    taps.className = 'touch-row';
    taps.append(this.doorsButton, this.cameraButton, this.autoButton, this.pauseButton, drawer);

    panel.append(this.readout, emergency, holds, taps);
    this.element.append(this.powerLever.element, panel, this.brakeLever.element);
    host.append(this.element);
  }

  /** 押している間だけ効くボタン（警笛・砂撒き・確認扱い・保安復帰） */
  private holdButton(label: string, command: HeldCommand): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'touch-button hold';
    button.textContent = label;
    button.addEventListener('pointerdown', (event) => {
      // 既定の動作を止めるとフォーカスも移らない。ボタンにフォーカスが残ると
      // Space / Enter がボタンの再押下に食われる（`main.ts` の releaseFocus と同じ理由）。
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      this.options.onUserGesture();
      this.options.state.hold(command);
      button.classList.add('on');
    });
    const release = (event: PointerEvent): void => {
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      this.options.state.release(command);
      button.classList.remove('on');
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    // 指を奪われて pointerup が来ないことがある。ここを漏らすと警笛が鳴り止まない。
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }

  /** 一度押すと切り替わるボタン。`click` を待たず `pointerdown` で発火させる。 */
  private tapButton(label: string, extraClass: string, onTap: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `touch-button${extraClass ? ` ${extraClass}` : ''}`;
    button.textContent = label;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.options.onUserGesture();
      onTap();
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }

  /** フレームごとに呼び、レバーと押しボタンの表示を手元のハンドルへ合わせる */
  update(handles: HandlePosition, cameraLabel: string, autoDrive: boolean, paused: boolean): void {
    if (!this.visible) return;
    const powerCount = this.options.powerNotchCount();
    const brakeCount = this.options.brakeNotchCount();
    const holdingCount = this.options.holdingNotchCount();
    this.powerLever.setPositions(powerLabels(powerCount, holdingCount));
    this.brakeLever.setPositions(brakeLabels(brakeCount));
    this.powerLever.setActive(powerCount - handles.power + handles.holding);
    this.brakeLever.setActive(handles.emergency ? 0 : brakeCount + 1 - handles.brake);

    this.readout.textContent = notchText(
      handles.power,
      handles.brake,
      handles.emergency,
      handles.holding,
    );
    this.readout.classList.toggle('danger', handles.emergency);
    this.doorsButton.textContent = handles.doorsClosed ? '戸閉' : '戸開';
    this.doorsButton.classList.toggle('on', !handles.doorsClosed);
    this.cameraButton.textContent = cameraLabel;
    this.autoButton.classList.toggle('on', autoDrive);
    this.pauseButton.textContent = paused ? '再開' : '停止';
    this.pauseButton.classList.toggle('on', paused);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.element.classList.toggle('on', on);
    // 画面内のキー凡例など、タッチでは邪魔になるものを CSS 側で畳むための目印
    document.body.classList.toggle('touch-mode', on);
    // 握ったままの指が残っていても、隠した時点で離したことにする
    if (!on) this.options.state.releaseAll();
  }

  dispose(): void {
    this.element.remove();
    document.body.classList.remove('touch-mode');
  }
}
