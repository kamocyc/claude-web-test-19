import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

const TWO_PI = Math.PI * 2;

/**
 * 基準速度 [m/s]。この速度で各成分の音量が既定値になる。
 * 在来線の常用速度域の真ん中あたり（約 108km/h）に取る。
 */
const REFERENCE_SPEED = 30;

/*
 * 走行装置の音は 3 つに分けてある。まとめて 1 つの音源にしないのは、**由来も
 * 速度依存も音源の位置も違う**ためで、実際にそれぞれ別の聞こえ方をする。
 *
 * | 成分     | 音圧の速度依存 | 振幅       | 由来                       | 音源の位置     |
 * | -------- | -------------- | ---------- | -------------------------- | -------------- |
 * | 転動音   | 30·log₁₀v      | ∝ v^1.5    | 車輪・レールの粗さ         | 全車の足元     |
 * | 風切り音 | 60·log₁₀v      | ∝ v³       | 空力音（四重極音源）       | 車体の表面全体 |
 * | 歯車     | 回転数に比例   | 伝達トルク | かみ合いの周期的な剛性変動 | M 車の床下     |
 *
 * 速度依存の指数が違うので、主役が速度とともに入れ替わる。低速では歯車のうなりが
 * 編成でいちばん耳につき、50km/h あたりで転動音に主役を譲る。風切り音が転動音を
 * 追い越すのは 250km/h 以上なので、通勤形の速度域ではずっと埋もれたままになる。
 * 1 つの音量にまとめていたころはこの関係を測れず、歯車が高速域まで支配し、
 * 風切りが 90km/h で転動音を追い越していた。
 *
 * 歯車の音は**惰行しても消えない**のが要点で、これがインバータ音と決定的に
 * 違うところである。ノッチを切るとインバータの音程だけがすっと消え、
 * 歯車と転動音が残る。
 */

/** 転動音を決める量 */
export interface RollingParams {
  /** 車速の大きさ [m/s] */
  readonly speed: number;
  /** 音量 0..1 */
  readonly level: number;
}

/**
 * 転動音。車輪とレールの粗さによる加振で、**編成のすべての軸から**出る。
 * 運転台の真下にも軸があるので、距離減衰はほとんど掛からない。
 */
export class RollingVoice {
  private readonly noise = new Noise(0x51ce);
  private readonly pink = new PinkFilter();
  private readonly band = new Biquad();
  private readonly level: Smoothed;
  private target = 0;

  constructor(private readonly sampleRate: number) {
    this.level = new Smoothed(sampleRate, 0.05);
    this.setParams({ speed: 0, level: 0 });
  }

  setParams(p: RollingParams): void {
    const v = Math.abs(p.speed);
    // スペクトル重心は速度とともに上がる（粗さの短い波長が効いてくる）
    this.band.bandPass(this.sampleRate, 380 + 14 * v, 0.7);
    this.target = p.level * 0.5 * Math.pow(v / REFERENCE_SPEED, 1.5);
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const pink = this.pink.process(this.noise.next());
      out[i] = out[i]! + this.band.process(pink) * this.level.process(this.target);
    }
  }

  reset(): void {
    this.pink.reset();
    this.band.reset();
    this.level.set(0);
  }
}

/**
 * 基準速度での風切り音の音量。
 *
 * 転動音との**逆転点が車両の最高速度よりずっと上**に来るように決めてある。
 * 分けて測るまで気付かなかったが、以前は 90km/h 付近で風切り音が転動音を
 * 追い越していた。鉄道の騒音で空力音が支配するのは 250〜300km/h からなので、
 * 通勤形の速度域ではまだはるか下にいるのが正しい。この値なら最高速度の
 * 120km/h でも転動音より 10dB 低い。
 */
const WIND_LEVEL = 0.035;

/** 風切り音を決める量 */
export interface WindParams {
  /** 車速の大きさ [m/s] */
  readonly speed: number;
  /** 音量 0..1 */
  readonly level: number;
}

/**
 * 風切り音。四重極音源なので音圧は速度の 3 乗に比例し、**高速でだけ効く**。
 * 通勤形の速度域では転動音に埋もれているのが正しい姿で、それが分かるように
 * 転動音とは別のつまみにしてある。
 */
export class WindVoice {
  private readonly noise = new Noise(0x2b91);
  private readonly band = new Biquad();
  private readonly level: Smoothed;
  private target = 0;

  constructor(sampleRate: number) {
    this.level = new Smoothed(sampleRate, 0.05);
    // 広帯域で高域寄り
    this.band.highPass(sampleRate, 700, 0.6);
    this.setParams({ speed: 0, level: 0 });
  }

  setParams(p: WindParams): void {
    this.target = p.level * WIND_LEVEL * Math.pow(Math.abs(p.speed) / REFERENCE_SPEED, 3);
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! + this.band.process(this.noise.next()) * this.level.process(this.target);
    }
  }

  reset(): void {
    this.band.reset();
    this.level.set(0);
  }
}

/** 歯車の音を決める量 */
export interface GearParams {
  /** かみ合い周波数 [Hz] = 電動機回転数/60 × 小歯車歯数 */
  readonly meshFrequency: number;
  /** 電動機の回転周波数 [Hz]（歯形誤差による 1 回転ごとのうなりに使う） */
  readonly shaftFrequency: number;
  /**
   * 歯車が受け持っている負荷 0..1（1 = 全負荷）。
   * 惰行でも回転部の慣性トルクが歯面に掛かるので 0 にはならない。
   */
  readonly load: number;
  /** 音量 0..1 */
  readonly level: number;
}

/** この回転周波数 [Hz] までは音が立ち上がりきらない（＝ほぼ停止） */
const GEAR_FADE_SHAFT = 8;

/**
 * 全負荷での歯車の音量。
 *
 * 転動音との**逆転点が 50km/h あたり**に来るように決めてある。低速では歯車の
 * うなりが編成でいちばん耳につき、速度が上がると転動音に主役を譲る — これが
 * 通勤形の車内で実際に起きる移り変わりで、80km/h 惰行なら転動音より 6dB 下、
 * 20km/h なら逆に 7dB 上になる。転動音と混ぜて 1 つの音量で扱っていたころは、
 * 分けて測れなかったので歯車が高速域まで支配したままだった。
 */
const GEAR_LEVEL = 0.1;

/**
 * 歯車のかみ合い音。**M 車の床下**にしか無いので、運転台からは編成の中ほどの
 * 距離だけ離れて聞こえる。
 *
 * 車速ではなく**電動機の回転**で駆動するので、空転すれば音程も跳ね上がる。
 */
export class GearVoice {
  private readonly body = new Biquad();
  private readonly level: Smoothed;
  private readonly mesh: Smoothed;
  private readonly shaft: Smoothed;

  private thetaMesh = 0;
  private thetaShaft = 0;
  private readonly dt: number;

  private targetLevel = 0;
  private targetMesh = 0;
  private targetShaft = 0;

  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.level = new Smoothed(sampleRate, 0.05);
    this.mesh = new Smoothed(sampleRate, 0.01);
    this.shaft = new Smoothed(sampleRate, 0.01);
    // 歯車箱の共振。かみ合いの高調波のうち、この帯だけがよく放射する。
    this.body.bandPass(sampleRate, 1400, 1.2);
    this.setParams({ meshFrequency: 0, shaftFrequency: 0, load: 0, level: 0 });
  }

  setParams(p: GearParams): void {
    const spin = Math.min(1, Math.abs(p.shaftFrequency) / GEAR_FADE_SHAFT);
    this.targetLevel = p.level * GEAR_LEVEL * spin * (0.4 + 0.6 * Math.min(1, Math.max(0, p.load)));
    this.targetMesh = p.meshFrequency;
    this.targetShaft = p.shaftFrequency;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const mesh = this.mesh.process(this.targetMesh);
      const shaft = this.shaft.process(this.targetShaft);
      this.thetaMesh = wrap(this.thetaMesh + TWO_PI * mesh * this.dt);
      this.thetaShaft = wrap(this.thetaShaft + TWO_PI * shaft * this.dt);

      // かみ合いの基本波と高調波。歯 1 枚ごとの誤差は 1 回転周期のうなりになる。
      const teeth =
        Math.sin(this.thetaMesh) +
        0.45 * Math.sin(2 * this.thetaMesh) +
        0.2 * Math.sin(3 * this.thetaMesh);
      const toothError = 1 + 0.35 * Math.sin(this.thetaShaft);
      out[i] =
        out[i]! +
        (teeth * 0.6 + this.body.process(teeth) * 0.8) *
          toothError *
          this.level.process(this.targetLevel);
    }
  }

  reset(): void {
    this.body.reset();
    this.thetaMesh = 0;
    this.thetaShaft = 0;
    this.level.set(0);
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
