import * as THREE from 'three';

/**
 * 描画の出口。
 *
 * `WebGLRenderer` の設定と、毎フレームの「シーンとカメラを画面へ出す」1 行を
 * ここへ集めてある。分けてあるのは、**画づくりの決めごとを 1 か所に置く**ためで、
 * 露出・トーンマッピング・後処理（ブルームなど）を足すときに、走行ループの側を
 * 触らずに済む。
 *
 * ## 物理的に正しい明るさ
 *
 * 材質は物理ベース（PBR）で書いてあるので、光の量はリニア色空間で足し合わせて
 * から画面のガンマへ変換しないと、影の中と日なたの明暗差が正しく出ない。
 * three.js は `outputColorSpace` を sRGB にしておけばこの変換をやってくれる。
 *
 * ## トーンマッピング
 *
 * 晴天の屋外は、日なたと影の輝度差が 100 倍を超える。そのまま画面の 0..1 へ
 * 押し込むと、明るいところが白く飛ぶか、影が黒く潰れるかのどちらかになる。
 * フィルム的なカーブ（ACES 相当）で圧縮すると、レールの頭頂面の照り返しや
 * 信号の灯火のような**画面より明るいもの**が、色を失わずに階調として残る。
 */
export interface PresenterOptions {
  /** 画素密度の上限（携帯端末では下げる） */
  readonly maxPixelRatio: number;
}

export class Presenter {
  readonly renderer: THREE.WebGLRenderer;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement, options: PresenterOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio));
    // 影を落とす。柔らかい影（PCF）にしないと、レールやまくらぎの細い影が
    // 拡大されたドットの列に見えてしまう。
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // ACES のカーブは中間調をわずかに沈めるので、露出を少し上げて釣り合わせる。
    // 明るさの基準は「曇天でも路盤の砕石の粒が見えること」に置いてある。
    this.renderer.toneMappingExposure = 1.1;
  }

  /**
   * 表示サイズに描画バッファを合わせる。寸法が変わったときだけ通る
   * （伸縮のあいだ毎フレーム作り直すのを避ける）。
   */
  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    return true;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }
}
