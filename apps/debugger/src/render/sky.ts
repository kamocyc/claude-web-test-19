import * as THREE from 'three';
import type { WeatherLook } from './weather.ts';

/**
 * 空と大気。
 *
 * ## なぜグラデーション 1 枚では足りないか
 *
 * 天頂から地平線へ色を混ぜただけの球は、遠くから見れば空の色をしているが、
 * **画面の中で空が果たす仕事**をしない。屋外の絵で空が担っているのは
 *
 *  1. **地平線をぼかすこと** — 大気の散乱で、遠くのものは空の色へ溶ける。
 *     溶けないと、地面と空のあいだに定規で引いたような線が残る。
 *  2. **太陽のありかを示すこと** — 影の向きと画面の中の太陽が食い違うと、
 *     どれだけ影を作り込んでも嘘に見える。
 *  3. **時間を止めないこと** — 雲は空にただ浮かんでいるのではなく、
 *     光の当たる面と影の面を持った立体である。
 *
 * ここではこの 3 つを、外部画像を 1 枚も使わずに出す。
 *
 * ## 散乱の近似
 *
 * まともな大気散乱（Rayleigh / Mie の積分）は屋外 1 シーンには重すぎるので、
 * **同じ形をした安い式**に置き換える。
 *
 *  - **Rayleigh（空気分子）** — 波長の 4 乗に反比例するので短波長（青）が強く
 *    散る。視線が長いほど散乱が積もるから、地平線ほど白くなる。
 *    ここでは天頂色と地平色を `pow(h, exponent)` で混ぜることで代える
 *    （実測の空の輝度分布に近い形になる）。
 *  - **Mie（エアロゾル・水滴）** — 波長に鈍く、前方に強く散る。太陽の周りに
 *    白い暈（かさ）を作る。これは太陽との角度だけの関数なので、
 *    Henyey-Greenstein 位相関数を 1 本入れれば足りる。
 *
 * ## 雲
 *
 * 値ノイズを 3 オクターブ重ね、それを高度 `CLOUD_HEIGHT` の平面へ視線を
 * 伸ばして拾う（平面投影なので、地平線に近いほど雲が寝て詰まって見える —
 * 実際の雲の見え方と同じ理由で正しい）。密度そのものではなく**密度の勾配**を
 * 太陽方向に取って明暗を付けるので、積雲の陰影が出る。
 */

const VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  uniform float exponent;
  uniform float cloudCover;
  uniform float cloudLight;
  uniform float sunDisk;
  uniform float skyGain;
  uniform float time;
  varying vec3 vWorldPosition;

  /** 太陽の視半径 [rad]（実際の 0.267 度）。円板の縁をここでぼかす */
  const float SUN_ANGULAR_RADIUS = 0.00466;
  /** 雲底の高さ [m]。積雲の雲底は 1000m 前後 */
  const float CLOUD_HEIGHT = 1400.0;
  /**
   * 雲の塊 1 つの大きさ [m]。
   *
   * 積雲 1 つは水平に 1km 前後ある。ここを小さくすると、空一面に細かい白点が
   * 散った「紙吹雪の空」になってしまう（実際そうなった）。雲底の高さと同じ
   * 桁にしておくと、視野の中に雲が数個だけ入るという実際の見え方になる。
   */
  const float CLOUD_SIZE = 620.0;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  /** 値ノイズ。格子点の乱数を滑らかに補間する */
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }

  /** 3 オクターブの重ね合わせ。雲の「大きな塊の中に細かい起伏」を作る */
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.6;
    for (int i = 0; i < 3; i++) {
      v += a * valueNoise(p);
      p = p * 2.07 + vec2(37.1, 11.7);
      // 細かい段の寄与を強く落とす。等比 0.5 だと細部が勝って雲が粒に見える
      a *= 0.42;
    }
    return v * 1.05;
  }

  /** 雲の密度 0..1。しきい値より濃いところだけが雲になる（＝雲のあいだに空が見える） */
  float cloudDensity(vec2 p) {
    float n = fbm(p);
    // cloudCover が 0 なら快晴、1 なら一面の雲。しきい値を動かして覆いを変える
    // fbm の平均は 0.48 前後。しきい値がそれを下回ると空の半分以上が雲になるので、
    // 覆い 0.5 でちょうど平均に来るように写す。
    float threshold = mix(0.78, 0.30, cloudCover);
    // 縁を広く取る。狭いと雲の輪郭が切り紙のようになる
    return smoothstep(threshold, threshold + 0.30, n);
  }

  /** Henyey-Greenstein 位相関数（Mie 散乱の前方への偏り） */
  float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  }

  void main() {
    vec3 dir = normalize(vWorldPosition);
    float h = dir.y;
    float cosSun = dot(dir, sunDirection);

    // --- Rayleigh 相当: 天頂 → 地平線 ---
    // skyGain はトーンマッピングの露出に対する釣り合いを取る係数。空の色は
    // 照明の結果ではなく直接書いた値なので、露出を上げるとそのぶん白へ寄る。
    // ここで割り戻さないと、露出を地面に合わせた瞬間に空が水色に抜けてしまう。
    vec3 sky = mix(horizonColor, topColor, pow(max(h, 0.0), exponent)) * skyGain;

    // --- Mie 相当: 太陽の周りの暈。地平線側ほど大気が厚いので強くなる ---
    float mie = henyeyGreenstein(cosSun, 0.76) * 0.055;
    mie *= mix(1.6, 1.0, clamp(h, 0.0, 1.0));
    sky += sunColor * mie;

    // --- 太陽の円板 ---
    // 縁を視半径の 3 割ぶんだけぼかす。ちょうど 0 にすると、離れた画素で
    // 標本化しきれず円板がぎざぎざになる。
    float angle = acos(clamp(cosSun, -1.0, 1.0));
    float disk = 1.0 - smoothstep(SUN_ANGULAR_RADIUS * 0.7, SUN_ANGULAR_RADIUS * 1.3, angle);
    sky += sunColor * disk * sunDisk;

    // --- 雲 ---
    if (h > 0.008 && cloudCover > 0.01) {
      // 視線を雲底の平面へ伸ばした点（単位は「雲 1 つぶん」）。仰角が高いほど
      // 近くの雲を見るので p は小さくなり、天頂では 1 つの雲が視野を覆う —
      // 実際に見上げたときの見え方と同じである。
      vec2 p = dir.xz / max(h, 0.008) * (CLOUD_HEIGHT / CLOUD_SIZE);
      // 風で流す。上空の風は 10m/s 前後なので、雲 1 つぶんを 25 秒ほどで横切る
      p += vec2(time * 0.04, time * 0.016);
      float d = cloudDensity(p);
      // 太陽の側へ少しずらした密度との差を取ると、積雲の陰影になる。
      // （雲の中を光がどれだけ通るかを、いちばん安く近似したもの）
      vec2 toSun = normalize(sunDirection.xz + vec2(0.0001, 0.0)) * 0.09;
      float lit = clamp((d - cloudDensity(p + toSun)) * 3.0 + 0.55, 0.0, 1.0);
      vec3 cloudTop = sunColor * cloudLight;
      vec3 cloudBase = mix(horizonColor, topColor, 0.25) * 0.62;
      vec3 cloud = mix(cloudBase, cloudTop, lit);
      // 地平線ぎわの雲は大気に溶ける。溶かさないと空の縁で雲が唐突に切れる
      float fade = smoothstep(0.008, 0.13, h);
      sky = mix(sky, cloud, d * fade * 0.94);
    }

    // --- 地平線より下 ---
    // 地表の板は数 km で尽きるが、空の球はその先まである。急に別の色に
    // ならないよう、地平線色から地面色へゆっくり落とす（＝遠景の霞）。
    vec3 color =
      h < 0.0 ? mix(horizonColor, groundColor, smoothstep(0.0, 0.09, -h)) * skyGain : sky;
    gl_FragColor = vec4(color, 1.0);

    // ここから下の 2 行を忘れると、**後処理を通したときと通さないときで空の色が
    // 変わる**。three.js は組み込みの材質にはトーンマッピングと色空間の変換を
    // 自動で足すが、自前のシェーダ材質には足さない。この 2 つの取り込みを
    // 書いておけば、three.js が描画先に応じて中身を切り替えてくれる —
    // 画面へ直接描くときは ACES + sRGB、後処理の的（リニアの浮動小数）へ
    // 描くときは何もしない、という具合に。
    // 空はリニアの放射輝度を出すものとして扱われるようになる。
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** 太陽の向き（列車から見た太陽の位置。影の落ちる方向を決める） */
export const SUN_DIRECTION = new THREE.Vector3(-0.42, 0.66, 0.62).normalize();

/**
 * 太陽の円板の輝度倍率。
 *
 * 実際の太陽面の輝度は空の 10 万倍あるが、そこまで入れると後処理の
 * ブルームが画面を覆ってしまう。円板がはっきり白く、周りへ光がにじむ程度
 * （＝しきい値 1.0 の十数倍）に留める。
 */
const SUN_DISK_GAIN = 16;

/**
 * 空の輝度の係数。
 *
 * 空はリニアの放射輝度として ACES と露出（1.5）を通る。地面と同じ扱いに
 * なったぶん、そのままでは明るすぎて水色に抜けるので落としてある。
 * 0.5 は「天頂の青が濃く残り、地平線ぎわだけ白く抜ける」ところ。
 */
const SKY_GAIN = 0.5;

/** 空の見た目を更新できる把手（雲を流すのに時刻を渡す） */
export interface SkyHandle {
  readonly mesh: THREE.Mesh;
  /** 経過時間 [s] を渡すと雲が流れる */
  setTime(seconds: number): void;
}

/**
 * 昼間の空。
 *
 * 内向きの巨大な球に上の大気の式を貼る。画像テクスチャを持たないので、
 * 外部リソースなしで昼光の雰囲気が出せる。
 */
export function createSky(look: WeatherLook, radius = 5000): SkyHandle {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color().setHex(look.sky.top, THREE.SRGBColorSpace) },
      horizonColor: { value: new THREE.Color().setHex(look.sky.horizon, THREE.SRGBColorSpace) },
      groundColor: { value: new THREE.Color().setHex(look.sky.ground, THREE.SRGBColorSpace) },
      sunColor: { value: new THREE.Color().setHex(look.sun.color, THREE.SRGBColorSpace) },
      sunDirection: { value: SUN_DIRECTION.clone() },
      exponent: { value: look.sky.exponent },
      cloudCover: { value: look.sky.cloudCover },
      cloudLight: { value: look.sky.cloudLight },
      // 曇っていれば太陽の円板は雲に隠れて見えない
      sunDisk: { value: look.sun.shadow ? SUN_DISK_GAIN : 0 },
      skyGain: { value: SKY_GAIN },
      time: { value: 0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  // 空は視線方向の関数でしかないので、分割は粗くてよい（球の形は見えない）
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material);
  mesh.renderOrder = -1;
  // 空はカメラと一緒に動く。視錐台の判定にかけると、球の中心が画面外へ出た
  // 拍子に丸ごと消えることがある。
  mesh.frustumCulled = false;
  return {
    mesh,
    setTime(seconds: number): void {
      material.uniforms.time!.value = seconds;
    },
  };
}

/**
 * 昼光の照明（太陽の平行光 + 空と地面からの環境光）。
 *
 * 太陽には影を落とさせる。列車が道床に落とす影、上屋がホームに落とす影、
 * 架線柱がのり面に落とす影 — 晴れた日の線路の見え方は、明るさよりも影の
 * 形で決まる。ただし影を焼く範囲は狭くしないと粗くなるので、列車の周りだけを
 * 追いかける（`TrackScene.update()` が光源を運ぶ）。
 *
 * ## 影の地図の解像度
 *
 * 影の細かさと「影が出るかどうか」は、`SHADOW_EXTENT`（焼く範囲）・
 * `SHADOW_MAP_SIZE`（画素数）・`bias`（ずらし量）の 3 つで決まり、
 * **この 3 つは切り離せない**。範囲を広げれば 1 画素が大きくなり、
 * 縞（シャドウアクネ）を消すのに必要なずらし量も増える。そのずらし量が
 * 構造物の高さに近づくと、今度は影そのものが消える。下の値はその釣り合いを
 * 取ったもので、どれか 1 つだけ動かすと壊れる。
 */
export function createDaylight(look: WeatherLook): {
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
} {
  const sun = new THREE.DirectionalLight(
    new THREE.Color().setHex(look.sun.color, THREE.SRGBColorSpace),
    look.sun.intensity,
  );
  sun.position.copy(SUN_DIRECTION).multiplyScalar(SHADOW_DISTANCE);
  // 曇っていれば影は落とさない。雲を通った光には方向が無く、
  // 弱い平行光の影だけが残ると「薄曇りなのに影がある」という嘘になる。
  sun.castShadow = look.sun.shadow;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  // 影を焼く箱は、光源からの奥行きも切り詰める。near と far のあいだが
  // 深度の全階調に割り当てられるので、ここを 700m も取ると 1 階調が 1cm 以上に
  // なり、ずらし量（bias）を大きくせざるを得ない。列車の周りだけを見るのだから
  // 光源から ±160m もあれば足りる。
  sun.shadow.camera.near = SHADOW_DISTANCE - SHADOW_DEPTH;
  sun.shadow.camera.far = SHADOW_DISTANCE + SHADOW_DEPTH;
  // **これを忘れると影が出ない。** three.js は影を焼くたびに光源の位置と向きから
  // ビュー行列を作り直すが、投影行列（＝焼く範囲）は作り直さない。上で
  // left/right/top/bottom を書き換えても、ここで作り直さなければ
  // `OrthographicCamera` の初期値（±5m）のままで、列車の足元 10m 四方にしか
  // 影が落ちない — 見た目には「影が無い」のと区別が付かない。
  sun.shadow.camera.updateProjectionMatrix();
  /**
   * 自分自身に縞模様の影が出る（シャドウアクネ）のを防ぐずらし。
   *
   * 必要な量は**影の地図の 1 画素が world で何 m か**で決まる。ここでは
   * 一辺 2·SHADOW_EXTENT を SHADOW_MAP_SIZE 画素で割った値で、傾いた面では
   * その 1〜2 倍の深度差が出る。
   *
   * ずらし方は 2 通りある。
   *
   *  - `bias` — 深度そのものをずらす。単位は**正規化した深度**なので、
   *    world での量は (far − near) 倍になる。上で奥行きを 320m に絞ったので、
   *    -0.0004 でも world では 0.13m にしかならない。
   *  - `normalBias` — 標本を取る位置を法線方向へずらす。単位は world の m。
   *    こちらは面が光に正対しているときに効かないぶん、**接地部の影が
   *    浮き上がりにくい**（ペーターパン現象が出にくい）。
   *
   * 大きくしすぎると影そのものが消える。実際、以前は `bias` を深度 700m の
   * 尺度で -0.00025（= world 0.17m）取っていて、それが上屋やホームの影を
   * まるごと打ち消していた。
   */
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.07;
  // 空からの光は太陽より弱くしておく。ここを強くすると影の中まで明るくなり、
  // せっかく落とした影が見えなくなる。
  const ambient = new THREE.HemisphereLight(
    new THREE.Color().setHex(look.ambient.sky, THREE.SRGBColorSpace),
    new THREE.Color().setHex(look.ambient.ground, THREE.SRGBColorSpace),
    look.ambient.intensity,
  );
  return { sun, ambient };
}

/** 影の地図の一辺 [画素] */
const SHADOW_MAP_SIZE = 2048;
/**
 * 影を焼く範囲（正方形の半辺）[m]。
 *
 * 2048 画素をこの 2 倍の幅に割り当てるので、1 画素は 98mm になる。
 * まくらぎ（幅 220mm）の影は形が残り、レール（頭部 65mm）の影は縁がぼける —
 * 晴れた日に道床を見たときの見え方と同じ分かれ方になる。
 */
export const SHADOW_EXTENT = 100;
/**
 * 影の箱を列車のどれだけ前へ寄せるか [m]。
 *
 * **ここが 0 だと、駅に近づいても上屋の影が出ない。** 運転席から見えるのは
 * 前方だけで、列車の後ろは決して見えない。箱を列車の中心に置くと、その半分
 * （後ろ側 100m）を見えないところへ捨てていることになり、前は 100m しか
 * 届かない。100m 先といえば駅の上屋やこれからくぐる橋がちょうどそこにある
 * 距離で、実際「駅へ進入していく絵にだけ影が無い」という状態になっていた。
 *
 * 60m 前へ寄せると、後ろ 40m・前 160m を焼くことになる。編成長 80m の
 * うち先頭 2 両ぶんは箱の中に残るので、自列車が道床に落とす影も消えない。
 */
const SHADOW_LOOKAHEAD = 60;
/** 光源を列車からどれだけ離すか [m]。近すぎると手前の構造物が near で切れる */
export const SHADOW_DISTANCE = 260;
/**
 * 影の箱の奥行き（光源から手前・奥へそれぞれ）[m]。
 *
 * near と far のあいだが深度の全階調に割り当てられるので、広く取るほど
 * 1 階調が粗くなり、縞を消すための `bias` を大きくせざるを得なくなる。
 * 箱の対角（√2 · SHADOW_EXTENT ≒ 141m）に高い構造物のぶんを足した値にする。
 */
const SHADOW_DEPTH = 200;

/**
 * 影の箱の中心を、列車の前方へ寄せた位置に置く。
 *
 * あわせて**影の地図 1 画素の大きさに丸める**。丸めないと、列車が動くたびに
 * 箱が画素の途中でずれ、静止しているはずの影の縁が 1 画素ぶん行ったり来たり
 * する（走っていると縁が沸き立って見える）。丸めておけば、影は画素の格子に
 * 貼り付いたまま滑らかに流れていく。
 *
 * @param out 光源の `position` を書き込む先
 * @param target 光源の `target.position` を書き込む先
 * @param lead 先頭車の位置
 * @param forward 進行方向の単位ベクトル
 */
export function aimShadowBox(
  out: THREE.Vector3,
  target: THREE.Vector3,
  lead: THREE.Vector3,
  forward: THREE.Vector3,
): void {
  target.copy(lead).addScaledVector(forward, SHADOW_LOOKAHEAD);
  const texel = (2 * SHADOW_EXTENT) / SHADOW_MAP_SIZE;
  target.x = Math.round(target.x / texel) * texel;
  target.y = Math.round(target.y / texel) * texel;
  target.z = Math.round(target.z / texel) * texel;
  out.copy(target).addScaledVector(SUN_DIRECTION, SHADOW_DISTANCE);
}
