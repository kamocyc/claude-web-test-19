import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 走行装置（歯車・転動・風）の音を決める量 */
export interface RunningGearParams {
  /** 車速の大きさ [m/s] */
  readonly speed: number;
  /** 歯車のかみ合い周波数 [Hz] = 電動機回転数/60 × 小歯車歯数 */
  readonly gearMeshFrequency: number;
  /** 電動機の回転周波数 [Hz]（歯形誤差による 1 回転ごとのうなりに使う） */
  readonly shaftFrequency: number;
  /** 歯車に掛かっているトルクの大きさ 0..1（惰行なら 0） */
  readonly gearLoad: number;
  /** 全体の音量 0..1 */
  readonly level: number;
}

/**
 * 基準速度 [m/s]。この速度で各成分の音量が既定値になる。
 * 在来線の常用速度域の真ん中あたり（約 108km/h）に取る。
 */
const REFERENCE_SPEED = 30;

/**
 * 走行装置の音。
 *
 * 3 つの成分を、それぞれ実測でよく知られた速度依存に従わせる。
 *
 * | 成分 | 音圧の速度依存 | 振幅 | 由来 |
 * | --- | --- | --- | --- |
 * | 転動音 | 30·log₁₀v | ∝ v^1.5 | 車輪・レールの粗さによる加振 |
 * | 風切り音 | 60·log₁₀v | ∝ v³ | 空力音（四重極音源） |
 * | 歯車 | 回転数に比例した周波数 | 伝達トルク | かみ合いの周期的な剛性変動 |
 *
 * 指数が違うため、低速では転動音が支配し、速度が上がるにつれて風切り音の
 * 比率が増える。通勤形の速度域（〜120km/h）では風切り音は転動音に埋もれた
 * ままで、これが実車の聞こえ方と一致する。
 *
 * 歯車の音は**惰行しても消えない**のが要点で、これがインバータ音と決定的に
 * 違うところである。ノッチを切るとインバータの音程だけがすっと消え、
 * 歯車と転動音が残る。
 */
export class RunningGearVoice {
  private readonly noise = new Noise(0x51ce);
  private readonly pink = new PinkFilter();
  private readonly rollingBand = new Biquad();
  private readonly windBand = new Biquad();
  private readonly gearBody = new Biquad();

  private readonly rollingLevel: Smoothed;
  private readonly windLevel: Smoothed;
  private readonly gearLevel: Smoothed;
  private readonly meshFrequency: Smoothed;
  private readonly shaftFrequencySmooth: Smoothed;

  private thetaMesh = 0;
  private thetaShaft = 0;
  private readonly dt: number;

  constructor(private readonly sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.rollingLevel = new Smoothed(sampleRate, 0.05);
    this.windLevel = new Smoothed(sampleRate, 0.05);
    this.gearLevel = new Smoothed(sampleRate, 0.05);
    this.meshFrequency = new Smoothed(sampleRate, 0.01);
    this.shaftFrequencySmooth = new Smoothed(sampleRate, 0.01);
    // 歯車箱の共振。かみ合いの高調波のうち、この帯だけがよく放射する。
    this.gearBody.bandPass(sampleRate, 1400, 1.2);
    this.setParams({
      speed: 0,
      gearMeshFrequency: 0,
      shaftFrequency: 0,
      gearLoad: 0,
      level: 0,
    });
  }

  setParams(p: RunningGearParams): void {
    const v = Math.abs(p.speed);
    const ratio = v / REFERENCE_SPEED;

    // 転動音のスペクトル重心は速度とともに上がる（粗さの短い波長が効いてくる）
    this.rollingBand.bandPass(this.sampleRate, 380 + 14 * v, 0.7);
    // 風切り音は広帯域で高域寄り
    this.windBand.highPass(this.sampleRate, 700, 0.6);

    this.targetRolling = p.level * 0.5 * Math.pow(ratio, 1.5);
    this.targetWind = p.level * 0.16 * Math.pow(ratio, 3);
    // 歯車は惰行でも鳴り続ける。伝達トルクが乗ると強くなる。
    const gearSpeedGain = Math.min(1, v / 3);
    this.targetGear = p.level * 0.22 * gearSpeedGain * (0.4 + 0.6 * Math.min(1, p.gearLoad));
    this.targetMesh = p.gearMeshFrequency;
    this.targetShaft = p.shaftFrequency;
  }

  private targetRolling = 0;
  private targetWind = 0;
  private targetGear = 0;
  private targetMesh = 0;
  private targetShaft = 0;

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const white = this.noise.next();
      const pink = this.pink.process(white);

      const rolling =
        this.rollingBand.process(pink) * this.rollingLevel.process(this.targetRolling);
      const wind = this.windBand.process(white) * this.windLevel.process(this.targetWind);

      const mesh = this.meshFrequency.process(this.targetMesh);
      const shaft = this.shaftFrequencySmooth.process(this.targetShaft);
      this.thetaMesh = wrap(this.thetaMesh + TWO_PI * mesh * this.dt);
      this.thetaShaft = wrap(this.thetaShaft + TWO_PI * shaft * this.dt);

      // かみ合いの基本波と高調波。歯 1 枚ごとの誤差は 1 回転周期のうなりになる。
      const teeth =
        Math.sin(this.thetaMesh) +
        0.45 * Math.sin(2 * this.thetaMesh) +
        0.2 * Math.sin(3 * this.thetaMesh);
      const toothError = 1 + 0.35 * Math.sin(this.thetaShaft);
      const gear =
        (teeth * 0.6 + this.gearBody.process(teeth) * 0.8) *
        toothError *
        this.gearLevel.process(this.targetGear);

      out[i] = out[i]! + rolling + wind + gear;
    }
  }

  reset(): void {
    this.pink.reset();
    this.rollingBand.reset();
    this.windBand.reset();
    this.gearBody.reset();
    this.thetaMesh = 0;
    this.thetaShaft = 0;
    this.rollingLevel.set(0);
    this.windLevel.set(0);
    this.gearLevel.set(0);
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
