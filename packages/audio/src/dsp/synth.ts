import { AuxiliaryVoice, type AuxiliaryParams } from './auxiliary.ts';
import { BrakeVoice, type BrakeParams } from './brake.ts';
import { InverterVoice, type InverterVoiceParams } from './inverterVoice.ts';
import { RailJointVoice, type JointImpact } from './railJointVoice.ts';
import { RunningGearVoice, type RunningGearParams } from './runningGear.ts';

/** 走行音全体を決める量。シミュレーションのスナップショットから素直に写せる。 */
export interface TrainNoiseParams {
  readonly inverter: InverterVoiceParams;
  readonly runningGear: RunningGearParams;
  readonly brake: BrakeParams;
  readonly auxiliary: AuxiliaryParams;
}

/**
 * 走行音の合成全体。
 *
 * すべての音源をここで足し合わせる。Web Audio のノードグラフを組まずに 1 つの
 * ワークレットで完結させているのは、どの音源も**同じシミュレーション状態から
 * 連続的に駆動される**ためで、ノードに分けても配線が増えるだけで得が無い。
 * 唯一の例外はレール継目で、これは離散的な打撃なのでサンプル位置を指定して
 * 予約する形にしてある。
 *
 * このクラスは Web Audio に一切触れないので、node でオフラインレンダして
 * スペクトルや音量の関係を検定できる。
 */
export class TrainNoiseSynth {
  readonly inverter: InverterVoice;
  readonly runningGear: RunningGearVoice;
  readonly brake: BrakeVoice;
  readonly auxiliary: AuxiliaryVoice;
  readonly railJoint: RailJointVoice;

  constructor(readonly sampleRate: number) {
    this.inverter = new InverterVoice(sampleRate);
    this.runningGear = new RunningGearVoice(sampleRate);
    this.brake = new BrakeVoice(sampleRate);
    this.auxiliary = new AuxiliaryVoice(sampleRate);
    this.railJoint = new RailJointVoice(sampleRate);
  }

  setParams(params: TrainNoiseParams): void {
    this.inverter.setParams(params.inverter);
    this.runningGear.setParams(params.runningGear);
    this.brake.setParams(params.brake);
    this.auxiliary.setParams(params.auxiliary);
  }

  /** 継目の衝撃を予約する（`delay` は次に render するバッファの先頭からのサンプル数） */
  triggerJoint(impact: JointImpact): void {
    this.railJoint.trigger(impact);
  }

  render(out: Float32Array): void {
    // インバータ音だけは上書き、以降は加算していく
    this.inverter.render(out);
    this.runningGear.render(out);
    this.brake.render(out);
    this.auxiliary.render(out);
    this.railJoint.render(out);

    // 飽和は最後に 1 回だけ掛ける。音源ごとに掛けると、混ざったときに
    // それぞれが先に潰れて音量の関係が崩れる。
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]!);
  }

  reset(): void {
    this.inverter.reset();
    this.runningGear.reset();
    this.brake.reset();
    this.auxiliary.reset();
    this.railJoint.reset();
  }
}
