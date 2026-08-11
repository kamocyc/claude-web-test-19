import {
  TrainNoiseSynth,
  VOICE_COUNT,
  type JointImpact,
  type TrainNoiseParams,
} from '@railsim/audio';

/**
 * AudioWorklet 側の殻。
 *
 * ここには DSP を書かない。合成の中身は `TrainNoiseSynth` という**素のクラス**に
 * あり、このファイルはそれを `AudioWorkletProcessor` に載せてパラメータと
 * 継目のイベントを受け取るだけである。こう分けておくことで、同じ合成コードを
 * node のテストからも呼んでスペクトルを検定できる（`render/frame.ts` を
 * `TrackScene` から切り離してあるのと同じ構造）。
 */

/** メインスレッドから送られてくるメッセージ */
interface TrainNoiseMessage {
  readonly params?: TrainNoiseParams;
  readonly joints?: readonly JointImpact[];
  readonly reset?: boolean;
}

// AudioWorkletGlobalScope の型は lib.dom に無いので最小限だけ宣言する
declare const sampleRate: number;
declare const registerProcessor: (
  name: string,
  processor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorLike,
) => void;

interface AudioWorkletProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare const AudioWorkletProcessor: {
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessorLike & { port: MessagePort };
};

/** レベルメータを送る周期 [サンプル]（約 60ms。表示の更新に十分で、通信は軽い） */
const LEVEL_PERIOD = 2880;

class TrainNoiseProcessor extends AudioWorkletProcessor {
  private readonly synth = new TrainNoiseSynth(sampleRate);
  private scratch = new Float32Array(128);
  private readonly levels = new Float32Array(VOICE_COUNT);
  private sinceLevels = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    // 生成時に渡された初期値。`postMessage` は最初のブロックに間に合わないことが
    // あるため、鳴り始めを取りこぼさないようここでも受け取れるようにしておく。
    this.apply(options?.processorOptions as TrainNoiseMessage | undefined);
    this.port.onmessage = (event: MessageEvent<TrainNoiseMessage>) => this.apply(event.data);
  }

  private apply(message: TrainNoiseMessage | undefined): void {
    if (!message) return;
    if (message.reset) this.synth.reset();
    if (message.params) this.synth.setParams(message.params);
    if (message.joints) {
      for (const impact of message.joints) this.synth.triggerJoint(impact);
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const length = output[0]!.length;
    if (this.scratch.length !== length) this.scratch = new Float32Array(length);
    this.synth.render(this.scratch);
    for (let channel = 0; channel < output.length; channel++) {
      output[channel]!.set(this.scratch);
    }

    // 音源ごとの実効値をメインスレッドへ返す（ミキサのメータになる）
    this.sinceLevels += length;
    if (this.sinceLevels >= LEVEL_PERIOD) {
      this.sinceLevels = 0;
      this.synth.readLevels(this.levels);
      this.port.postMessage({ levels: Array.from(this.levels) });
    }
    return true;
  }
}

registerProcessor('train-noise', TrainNoiseProcessor);
