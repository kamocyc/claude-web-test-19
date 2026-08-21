import * as THREE from 'three';
import { Postprocess } from './postprocess.ts';

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
 * ## トーンマッピングと露出の釣り合い
 *
 * 晴天の屋外は、日なたと影の輝度差が 100 倍を超える。そのまま画面の 0..1 へ
 * 押し込むと、明るいところが白く飛ぶか、影が黒く潰れるかのどちらかになる。
 * フィルム的なカーブ（ACES 相当）で圧縮すると、レールの頭頂面の照り返しや
 * 信号の灯火のような**画面より明るいもの**が、色を失わずに階調として残る。
 *
 * 露出は光源の強さと釣り合っていなければ意味がない。ここでは
 * **「昼光の地面（反射率 0.2 の灰色）が中間調 0.45 前後に落ちること」**を基準に
 * 決めてある。太陽の平行光を 3.6、空からの環境光を 0.55（`weather.ts`）とすると、
 * 水平面の照度は 3.6·sinθ + 0.55 ≒ 3.4 で、拡散反射の出射輝度は 3.4·0.2/π ≒ 0.22。
 * ACES はこの値を 0.30 ほどへ写すので、露出 1.5 を掛けて 0.45 になる。
 * 露出をこれ以上上げると空と白い壁がまず飛び、下げると影の中の砕石が潰れる。
 *
 * ## 後処理
 *
 * ブルーム・階調・輪郭の均しは `postprocess.ts` にある。`Presenter` が
 * その中で完結して呼ぶので、走行ループ側は今までどおり `render()` を呼ぶだけでよい。
 * 重い環境では後処理が自分で品質を落とす（`Postprocess` を参照）。
 */
export interface PresenterOptions {
  /** 画素密度の上限（携帯端末では下げる） */
  readonly maxPixelRatio: number;
  /** 後処理を使うか（既定は使う。試験や計測で切りたいときだけ false） */
  readonly postprocess?: boolean;
}

/** 昼光の地面が中間調へ落ちる露出（上の計算による） */
const EXPOSURE = 1.5;

export class Presenter {
  readonly renderer: THREE.WebGLRenderer;
  private readonly post: Postprocess | undefined;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement, options: PresenterOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // 後処理を通すときは、最後の全画面処理（FXAA）が輪郭を均すので
      // ハードウェアの多重標本化は要らない。二重に持つと帯域だけ食う。
      antialias: options.postprocess === false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio));
    // 影を落とす。柔らかい影（PCF）にしないと、レールやまくらぎの細い影が
    // 拡大されたドットの列に見えてしまう。
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.post = options.postprocess === false ? undefined : new Postprocess(this.renderer);
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
    this.post?.setSize(width, height);
    return true;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.post) this.post.render(scene, camera);
    else this.renderer.render(scene, camera);
  }
}
