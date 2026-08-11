import type { InverterVoiceParams } from '@railsim/audio';
import type { Simulation } from '@railsim/core';
import workletUrl from './trainNoise.worklet.ts?worker&url';

const PROCESSOR = 'train-noise';

/**
 * 走行音の出力。
 *
 * 合成そのものは `@railsim/audio` の素のクラスが AudioWorklet の中で行う。
 * ここはその配線と、シミュレーションの状態から合成パラメータへの写像だけを持つ。
 *
 * 他のサブシステム（`TrackScene` / `Hud` / `ChartPanel`）と同じく `Simulation` を
 * コンストラクタで抱え込まず、毎フレーム引数で受け取る。シナリオを切り替えると
 * `Simulation` は作り直されるためである。
 */
export class TrainAudio {
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private starting: Promise<void> | null = null;
  private failed = false;
  private volume = 0.7;
  private muted = false;
  private paused = false;

  /** 音が出せる状態か（自動再生規制を解除できたか） */
  get running(): boolean {
    return this.context?.state === 'running' && this.worklet !== null;
  }

  get available(): boolean {
    return !this.failed;
  }

  /**
   * 音声を開始する。ブラウザの自動再生規制があるため、
   * 最初のクリックやキー入力（ユーザ操作）の中から呼ぶ必要がある。
   */
  async start(): Promise<void> {
    if (this.failed) return;
    if (this.context) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.build();
    return this.starting;
  }

  private async build(): Promise<void> {
    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(context, PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const master = context.createGain();
      master.gain.value = 0;
      worklet.connect(master).connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      this.context = context;
      this.worklet = worklet;
      this.master = master;
      this.applyGain();
    } catch (error) {
      // 音が出せなくても運転はできる。黙って落とさず、以後は諦める。
      this.failed = true;
      console.warn('走行音を初期化できませんでした', error);
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyGain();
  }

  private applyGain(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const target = this.muted || this.paused ? 0 : this.volume;
    // 急に切ると耳障りなクリックが出るので短くランプする
    master.gain.setTargetAtTime(target, context.currentTime, 0.02);
  }

  /**
   * @param advance この描画フレームで進めたシミュレーション時間 [s]。
   *                一時停止中は 0 になるので、それを見て音を止める。
   */
  update(sim: Simulation, advance: number): void {
    const worklet = this.worklet;
    if (!worklet) return;
    const snap = sim.snapshot();
    const inv = snap.inverter;
    const stopped = advance <= 0;

    // 主回路が切れていれば（惰行・ノッチ切）インバータは黙る。
    // 動いていれば、磁束は V/f 一定で保たれるので音量はトルクよりも
    // 「switching しているかどうか」で決まる。トルクは彩りとして乗せる。
    const active = inv.mode !== 'off' && !stopped;
    const load = Math.min(1, Math.abs(inv.torqueRatio));
    const level = active ? 0.35 + 0.65 * load : 0;

    const params: InverterVoiceParams = {
      fundamental: inv.fundamentalFrequency,
      carrier: inv.carrierFrequency,
      modulation: inv.modulationIndex,
      pulses: inv.pulses,
      slotFrequency: inv.slotFrequency,
      level,
    };
    worklet.port.postMessage({ inverter: params });
  }

  /** シナリオを切り替えたときに合成器の内部状態を捨てる */
  reset(): void {
    this.worklet?.port.postMessage({ reset: true });
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.worklet = null;
    this.master = null;
  }
}
