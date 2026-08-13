import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** すれ違う対向列車の音を決める量 */
export interface PassingVoiceParams {
  /** 隣の線路に対向列車がいるか */
  readonly present: boolean;
  /** 相手の先頭端が運転台からどれだけ前方か [m]（負 = すれ違い済み） */
  readonly headGap: number;
  /** 相手の最後尾が運転台からどれだけ前方か [m]（負 = 抜けきった） */
  readonly tailGap: number;
  /** 相対速度 [m/s]（近づく向きが正） */
  readonly closingSpeed: number;
  /** 相手の速度 [m/s] */
  readonly otherSpeed: number;
  /** 線路中心間隔 [m] */
  readonly separation: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_PASSING: PassingVoiceParams = {
  present: false,
  headGap: 1e6,
  tailGap: 1e6,
  closingSpeed: 0,
  otherSpeed: 0,
  separation: 3.4,
  level: 0,
};

/** 空気中の音速 [m/s] */
const SOUND_SPEED = 343;

/** 基準速度 [m/s]（転動音・橋と同じ） */
const REFERENCE_SPEED = 30;

/** この距離で相手の走行音が基準の大きさになる [m] */
const REFERENCE_DISTANCE = 6;

/** 基準距離・基準速度での相手の走行音の大きさ */
const ROLLING_LEVEL = 0.6;

/**
 * 基準の相対速度 [m/s]（110km/h ＋ 0 に相当）。
 * 圧力波の大きさはこの相対速度で 1 になる。
 */
const REFERENCE_CLOSING = 30;

/** 基準の相対速度・基準の線路中心間隔での圧力波の大きさ */
const PULSE_LEVEL = 0.22;

/** 基準の線路中心間隔 [m]（在来線の交換設備の値） */
const REFERENCE_SEPARATION = 3.4;

/**
 * 圧力波の主成分 [Hz]。
 *
 * 先頭部が押しのけた空気の圧力場が通り過ぎる時間は「先頭部の長さ / 相対速度」で、
 * 20m 級の先頭部と相対 30m/s なら 0.5 秒あまり。その逆数の帯域（数 Hz）は耳に
 * 聞こえないので、実際に聞こえるのは**その圧力変化に車体（側窓・妻面）が
 * 応答して鳴る音**である。側窓のガラスと戸袋がまとめて動く帯がこのあたりにある。
 */
const PULSE_BODY = 46;
/** 側窓のがたつき（圧力の急変で建具が鳴る）の帯域 [Hz] */
const PULSE_RATTLE = 380;

/**
 * 対向列車とのすれ違い。
 *
 * 至近距離（線路中心間隔 3.4m）を逆向きに走り抜けるので、短い時間に 3 つのことが
 * 続けて起きる。
 *
 *  1. **先頭がすれ違う瞬間の圧力波** — 相手の先頭部が押しのけた空気が自分の
 *     車体を叩く。車体表面の圧力変化は動圧に比例するので、**相対速度の 2 乗**で
 *     効く。停まっているところを 100km/h で抜かれても、40km/h どうしですれ違っても
 *     相対速度は同じ、というのがこの音の勘どころである。
 *  2. **相手の走行音** — 相手の転動音が 3.4m 先から直接届く。並んでいるあいだ
 *     （相手の編成長 / 相対速度）だけ続くので、80m の 4 両編成を相対 30m/s で
 *     やり過ごすなら 2.7 秒。
 *  3. **最後尾が抜ける瞬間の圧力波** — 今度は逆向き（引かれる側）の圧が来る。
 *     1 と対になって「バン…ゴォォ…バン」になる。
 *
 * 音程の動きはドップラー効果そのもので、近づくあいだは高く、真横で元に戻り、
 * 離れるあいだは低い。効くのは**相対速度**なので、自分が止まっていても相手が
 * 速ければ大きく変わる。
 */
export class PassingVoice {
  private readonly noise = new Noise(0x6ac5);
  private readonly pink = new PinkFilter();
  private readonly rollingBand = new Biquad();
  private readonly rattleBand = new Biquad();
  private readonly rollingLevel: Smoothed;

  private targetRolling = 0;
  /** 転動音の周波数の倍率（ドップラー）。帯域の中心をこれで動かす。 */
  private dopplerFactor = 1;

  /** 圧力波の包絡と位相 */
  private pulseEnvelope = 0;
  private rattleEnvelope = 0;
  private pulsePhase = 0;
  private pulseSign = 1;
  private readonly pulseDecay: number;
  private readonly rattleDecay: number;

  private previousHead = 0;
  private previousTail = 0;
  private tracking = false;
  private readonly dt: number;

  constructor(private readonly sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.rollingLevel = new Smoothed(sampleRate, 0.03);
    this.rattleBand.bandPass(sampleRate, PULSE_RATTLE, 1.1);
    // 車体が圧力の階段に応答して鳴る時間と、建具ががたつく時間
    this.pulseDecay = Math.exp(-1 / (sampleRate * 0.16));
    this.rattleDecay = Math.exp(-1 / (sampleRate * 0.05));
    this.setParams(SILENT_PASSING);
  }

  setParams(p: PassingVoiceParams): void {
    if (!p.present) {
      this.targetRolling = 0;
      this.tracking = false;
      return;
    }

    // 運転台と相手の編成との線路方向の隙間。並んでいるあいだは 0 になる。
    const alongside = p.headGap <= 0 && p.tailGap >= 0;
    const along = alongside ? 0 : p.headGap > 0 ? p.headGap : p.tailGap;
    const separation = Math.max(0.5, p.separation);
    const distance = Math.hypot(along, separation);

    // ドップラー。近づく速さの**視線方向の成分**で決まるので、真横（along = 0）で
    // ちょうど元の音程に戻り、そこを境に高いほうから低いほうへ切り替わる。
    const radial = (p.closingSpeed * along) / distance;
    this.dopplerFactor = 1 + radial / SOUND_SPEED;

    // 相手の転動音。音源は相手の全長にわたって並んでいるが、いちばん近い部分が
    // 支配するので、最短距離で減衰させれば足りる。
    const rolling =
      Math.pow(Math.abs(p.otherSpeed) / REFERENCE_SPEED, 1.5) / (1 + distance / REFERENCE_DISTANCE);
    this.targetRolling = p.level * ROLLING_LEVEL * rolling;
    // 速度が上がると粗さの短い波長が効いてくる（転動音と同じ理屈）。それに
    // ドップラーの倍率を掛けたところが、実際に耳へ届く帯域になる。
    const centre = (380 + 14 * Math.abs(p.otherSpeed)) * this.dopplerFactor;
    this.rollingBand.bandPass(this.sampleRate, centre, 0.7);

    // 圧力波は「先頭が並んだ瞬間」と「最後尾が抜けた瞬間」に来る。前フレームからの
    // 符号の変わり目で捉える（すれ違いは数秒かかるので、フレーム精度で足りる）。
    if (this.tracking) {
      const strength =
        Math.pow(Math.max(0, p.closingSpeed) / REFERENCE_CLOSING, 2) *
        (REFERENCE_SEPARATION / separation) *
        p.level *
        PULSE_LEVEL;
      if (this.previousHead > 0 && p.headGap <= 0) this.firePulse(strength, 1);
      // 最後尾が抜けるときは押されるのではなく引かれる（負圧）ので、向きが逆になる
      if (this.previousTail > 0 && p.tailGap <= 0) this.firePulse(strength * 0.8, -1);
    }
    this.previousHead = p.headGap;
    this.previousTail = p.tailGap;
    this.tracking = true;
  }

  private firePulse(strength: number, sign: number): void {
    this.pulseEnvelope = strength;
    this.rattleEnvelope = strength * 0.6;
    this.pulsePhase = 0;
    this.pulseSign = sign;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      let sound = 0;

      const rolling = this.rollingLevel.process(this.targetRolling);
      if (rolling > 1e-6) {
        sound += this.rollingBand.process(this.pink.process(this.noise.next())) * rolling;
      }

      if (this.pulseEnvelope > 1e-5) {
        this.pulsePhase = wrap(this.pulsePhase + TWO_PI * PULSE_BODY * this.dt);
        sound += Math.sin(this.pulsePhase) * this.pulseEnvelope * this.pulseSign;
        this.pulseEnvelope *= this.pulseDecay;
      }
      if (this.rattleEnvelope > 1e-5) {
        sound += this.rattleBand.process(this.noise.next()) * this.rattleEnvelope;
        this.rattleEnvelope *= this.rattleDecay;
      }

      out[i] = out[i]! + sound;
    }
  }

  reset(): void {
    this.pink.reset();
    this.rollingBand.reset();
    this.rattleBand.reset();
    this.rollingLevel.set(0);
    this.pulseEnvelope = 0;
    this.rattleEnvelope = 0;
    this.tracking = false;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
