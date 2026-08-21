import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

/**
 * 後処理（ブルーム・階調・輪郭の均し）。
 *
 * ## なぜ後処理を挟むのか
 *
 * 材質と光を物理どおりに組んでも、そのまま画面へ出すと「画面より明るいもの」の
 * 情報がそこで捨てられる。信号の赤、前照灯、レール頭頂面に走る太陽の照り返しは、
 * どれも周りの何十倍という輝度を持っていて、実際の目（とカメラ）ではその周りへ
 * 光がにじむ。にじみが無いと、いくら色を強くしても「明るい面」にしかならず
 * 「光っているもの」にならない。
 *
 * ## 順序
 *
 * `RenderPass` は**トーンマッピング前のリニア値**を半精度浮動小数の的へ描く
 * （three.js は描画先が画面でないときトーンマッピングを掛けない）。したがって
 * ブルームは 1.0 を超える値をそのまま見られる — これが「しきい値より明るいもの
 * だけがにじむ」を成り立たせている。最後の `OutputPass` でトーンマッピングと
 * sRGB への変換をまとめて行う。
 *
 *   RenderPass(HDR) → Bloom(HDR) → 階調・周辺減光(HDR) → OutputPass(ACES → sRGB)
 *
 * ## 重さの見積もりと自動の切り下げ
 *
 * ブルームは 5 段のミップに分けたガウスぼかしで、1 フレームに 10 回以上の
 * 全画面描画を行う。実機の GPU では 1080p でも 1ms 台だが、ソフトウェア描画
 * （確認環境の SwiftShader）では 1 段でも数百 ms かかる。そこで**実測した
 * フレーム時間で品質を落とす**。速い環境では全部入り、遅い環境では素通しに
 * なるので、どちらでも「詰まって操作できない」状態にはならない。
 */

/** 品質の段。落ちるほど処理が減る */
export type PostQuality = 'full' | 'bloom' | 'off';

/**
 * 1 フレームの描画にかけてよい時間 [ms]。
 *
 * 60fps は 16.7ms。ここを超えても即座には落とさず、平均が `DEGRADE_MS` を
 * 続けて超えたときだけ 1 段下げる（一瞬の引っかかりで品質が揺れないように）。
 */
const DEGRADE_MS = 34;
/** ここを下回れば 1 段戻す。上げ下げの境目を離しておかないと段が往復する */
const RESTORE_MS = 12;
/** 判定に使う移動平均の重み（1 フレームぶんの寄与） */
const EMA_ALPHA = 0.08;

/**
 * ブルームの設定。
 *
 * しきい値 1.0 は「トーンマッピング後に白飛びする明るさ」の境目である。
 * 昼間の空や白い壁はここを少し超える程度なので弱くにじみ、信号の灯火や
 * 前照灯（`hdrColor()` で数倍の値を持たせてある）は強くにじむ。
 */
const BLOOM = { strength: 0.42, radius: 0.55, threshold: 1.0 } as const;

/**
 * 自ら光る面の色を「画面より明るい」値にする。
 *
 * `THREE.Color` は 0..1 に収まる必要がない。リニア空間の値なので、2 を入れれば
 * 白の 2 倍の輝度になる。ブルームのしきい値を超えるのはこの倍率のおかげで、
 * 灯火が単に「赤い円板」ではなく「光っている灯」に見えるかどうかを決めている。
 *
 * @param hex 見た目の色（sRGB）
 * @param gain 輝度の倍率
 */
export function hdrColor(hex: number, gain: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace).multiplyScalar(gain);
}

/**
 * 階調と周辺減光。
 *
 * トーンマッピングの前に、リニア値のまま次の 2 つを掛ける。
 *
 *  - **周辺減光** — 実際のレンズは画面の隅ほど暗い。運転席から前を見る絵では、
 *    視線の集まる正面（= 前方の線路）が相対的に明るくなる効果がある。
 *  - **わずかな彩度の持ち上げ** — ACES は中間調の彩度をやや落とすので、
 *    その戻しぶん。上げすぎると草と車体が原色になるので、ごく弱くに留める。
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.28 },
    saturation: { value: 1.07 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // 画面中心からの距離。長辺で正規化しないと縦横比で減光の形が変わる
      vec2 d = vUv - 0.5;
      float r = dot(d, d) * 2.0;
      float fall = 1.0 - vignette * r * r;
      vec3 rgb = c.rgb * fall;
      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      rgb = mix(vec3(luma), rgb, saturation);
      gl_FragColor = vec4(max(rgb, 0.0), c.a);
    }
  `,
};

export class Postprocess {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gradePass: ShaderPass;
  private readonly fxaaPass: ShaderPass;
  private readonly renderer: THREE.WebGLRenderer;
  private quality: PostQuality = 'full';
  private ema = 0;
  private samples = 0;
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer);
    // 描いた結果を画面へ出すのは最後の 1 段だけ。ここを false にしておかないと
    // 途中の段がそれぞれ画面を上書きしてしまう。
    this.composer.renderToScreen = true;

    // シーンとカメラは毎フレーム差し替える（運転席視点と外部視点で変わる）
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    );
    this.gradePass = new ShaderPass(GradeShader);
    this.fxaaPass = new ShaderPass(FXAAShader);

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.fxaaPass);
    this.composer.addPass(new OutputPass());
    this.applyQuality();
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    const ratio = this.renderer.getPixelRatio();
    // FXAA は画素の実寸を知らないと効かない。描画バッファの画素数で渡す
    (
      this.fxaaPass.material.uniforms as { resolution: { value: THREE.Vector2 } }
    ).resolution.value.set(1 / (width * ratio), 1 / (height * ratio));
  }

  /**
   * 1 フレーム描く。
   *
   * 併せて所要時間を測り、続けて重ければ品質を 1 段落とす。`renderer.render()`
   * は非同期に GPU へ積むだけなので、ここで測れるのは CPU 側の時間である。
   * ソフトウェア描画では実際に画素を塗る時間がそのまま出るため、
   * **重い環境ほど正しく測れる**（軽い環境では測れないが、そもそも落とす必要がない）。
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.quality === 'off') {
      this.renderer.render(scene, camera);
      return;
    }
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    const t0 = performance.now();
    this.composer.render();
    this.measure(performance.now() - t0);
  }

  private measure(ms: number): void {
    // 最初の数フレームはシェーダの初回コンパイルが混じるので数えない
    this.samples++;
    if (this.samples < 8) return;
    this.ema = this.ema === 0 ? ms : this.ema + (ms - this.ema) * EMA_ALPHA;
    if (this.ema > DEGRADE_MS && this.quality !== 'off') {
      this.quality = this.quality === 'full' ? 'bloom' : 'off';
      this.ema = 0;
      this.applyQuality();
    } else if (this.ema > 0 && this.ema < RESTORE_MS && this.quality === 'bloom') {
      this.quality = 'full';
      this.ema = 0;
      this.applyQuality();
    }
  }

  private applyQuality(): void {
    // 'bloom' では輪郭の均しだけを外す。ブルームは画づくりの根幹なので最後まで残し、
    // それでも間に合わなければ後処理そのものを畳む。
    this.fxaaPass.enabled = this.quality === 'full';
    this.gradePass.enabled = this.quality !== 'off';
    this.bloomPass.enabled = this.quality !== 'off';
  }

  /** 今の品質（表示や試験から見るため） */
  get level(): PostQuality {
    return this.quality;
  }

  dispose(): void {
    this.composer.dispose();
  }
}
