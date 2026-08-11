import { InverterVoice, type InverterVoiceParams } from '@railsim/audio';

/**
 * AudioWorklet 側の殻。
 *
 * ここには DSP を書かない。合成の中身は `InverterVoice` という**素のクラス**に
 * あり、このファイルはそれを `AudioWorkletProcessor` に載せてパラメータを
 * 受け取るだけである。こう分けておくことで、同じ合成コードを node の
 * テストからも呼んでスペクトルを検定できる（`render/frame.ts` を
 * `TrackScene` から切り離してあるのと同じ構造）。
 */

/** メインスレッドから送られてくるメッセージ */
interface TrainNoiseMessage {
  readonly inverter?: InverterVoiceParams;
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

class TrainNoiseProcessor extends AudioWorkletProcessor {
  private readonly inverter = new InverterVoice(sampleRate);
  private readonly scratch = new Float32Array(128);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    // 生成時に渡された初期値。`postMessage` は最初のブロックに間に合わないことが
    // あるため、鳴り始めを取りこぼさないようここでも受け取れるようにしておく。
    const initial = (options?.processorOptions as TrainNoiseMessage | undefined)?.inverter;
    if (initial) this.inverter.setParams(initial);
    this.port.onmessage = (event: MessageEvent<TrainNoiseMessage>) => {
      const data = event.data;
      if (data.reset) this.inverter.reset();
      if (data.inverter) this.inverter.setParams(data.inverter);
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0]!;
    const buffer =
      left.length === this.scratch.length ? this.scratch : new Float32Array(left.length);
    this.inverter.render(buffer);
    for (let channel = 0; channel < output.length; channel++) {
      output[channel]!.set(buffer);
    }
    return true;
  }
}

registerProcessor('train-noise', TrainNoiseProcessor);
