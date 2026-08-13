import type { RouteDefinition } from '../schema/route.ts';

/** 分岐器の番数。#12 → リード R350・分岐制限 45km/h */
const TURNOUT_NUMBER = 12;
/** リード曲線の半径 [m]（#12 の標準値） */
const TURNOUT_RADIUS = 350;
/**
 * リード長 [m] = R α。分岐器の寸法はコンパイラが番数から求めるが、分岐側の線形は
 * 路線データの側で書くので、同じ寸法をここでも組み立てる。
 */
const LEAD = TURNOUT_RADIUS * Math.atan(1 / TURNOUT_NUMBER);
/**
 * リード曲線より先の部分の長さ [m]。
 * 分岐器の全長は `turnoutLengthOf()` でリード長の 1.4 倍になるので、その残り。
 * クロッシングの翼レールと護輪軌条が続く区間で、線形としては直線である。
 */
const TAIL = LEAD * 0.4;

/** 交換設備の入口（対向分岐器のトングレール先端）の距離程 [m] */
const LOOP_ENTRY = 40;
/** 交換設備の出口（背向分岐器のクロッシング）の距離程 [m] */
const LOOP_EXIT = 420;
/** 2 番線（副本線）のホーム部分の長さ [m]。入口の戻し曲線から出口の戻し曲線まで。 */
const PLATFORM_TRACK = LOOP_EXIT - LEAD - (LOOP_ENTRY + LEAD + TAIL + LEAD);
/** 交換設備の終わり（本線へ戻る点）の距離程 [m] */
const LOOP_END = LOOP_EXIT + TAIL + LEAD;

/** 側線への分岐器（下り出発方）の始端の距離程 [m] */
const SIDING_TURNOUT_AT = 6300;

/**
 * 保守基地への分岐器の始端の距離程 [m]。
 *
 * **ロングレール区間（2600〜4300m）の中**に置いてある。ロングレールでも分岐器の
 * 前後には軌道回路を区切る絶縁継目が入るので、継目音の無い区間を走っていて
 * ここだけ「タン…タン」と入る。分岐器そのものの音（トングレール・クロッシング）と
 * 合わせて、何を踏んだ音なのかが聴き分けられる。
 */
const DEPOT_TURNOUT_AT = 3950;

/**
 * 架空の試験線「試験線（南武試験線）」。
 *
 * 物理・信号の検証に必要な要素をひととおり含む最小の路線:
 *
 *  - 直線 → R600 左曲線（カント 75mm）→ 直線 → R400 右曲線（カント 90mm）→ 直線
 *  - 0‰ → 25‰ 上り → 0‰ → 33‰ 下り → 0‰（すべて縦曲線 200m 付き）
 *  - トンネル 1 区間（下り勾配の途中）
 *  - 駅 3 つ（起点駅・中間駅・終点駅）とダイヤ
 *  - 閉塞信号機 8 基（約 1km 間隔）。ATS-P / ATS-SN の地上子は自動配置される。
 *  - 起点駅（試験台）は**交換可能駅**。#12 分岐器 2 基で 1 番線と 2 番線に分かれる。
 *    単線なので、対向列車とすれ違えるのはこの区間だけである。
 *  - 6300m に側線への #12 片開き分岐器（本線側へ開通）、3950m に保守基地への分岐器
 *  - 橋りょう 4 か所（無道床プレートガーダー・下路トラス・有道床コンクリート桁・
 *    有道床プレートガーダー）。桁の作りで音がまるで違う。
 *  - 踏切 3 か所（電子式 2・電鐘式 1）
 *
 * 曲線の制限速度は許容カント不足 60mm から自動計算される
 * （R600/C75 → 95km/h、R400/C90 → 80km/h）。
 *
 * @param loop 起点駅で 2 番線（分岐側）を通るか
 */
function buildTestLine(loop: boolean): RouteDefinition {
  /**
   * 2 番線（副本線）の線形。
   *
   * 交換可能駅は、対向分岐器で本線から分かれ、本線と平行に走り、背向分岐器で
   * 戻る。分かれるときも戻るときも**リード曲線とその戻し曲線の 2 つで一組**に
   * なっていて、これで進行方向を変えずに横へ 3.4m ずれる（＝線路中心間隔）:
   *
   *   R(1 − cos α) + 護輪軌条部 sin α + R(1 − cos α) = 1.21 + 0.97 + 1.21 = 3.38m
   *
   * **緩和曲線もカントも無い**のがこの線形の要点である。分岐器のリード曲線は
   * 曲率が 0 から 1/R へ一段で立ち上がるので、横加速度が階段状に入る。本線の曲線
   * （80〜100m の緩和曲線つき）とは、同じ横 G でも体への来方がまるで違う。しかも
   * 戻し曲線で逆向きへ折り返すので、2 番線の出入りでは横 G が正負に振れる。
   *
   * 入口と出口で長さが揃っているので、**2 番線を通っても距離程は変わらない**。
   * 駅も信号機も勾配も 1 番線とまったく同じものが使える。
   */
  const loopHorizontal = [
    { length: LOOP_ENTRY },
    // 入口の対向分岐器。リード曲線で右へ α だけ振れ、そのあと護輪軌条部は直線
    { length: LEAD, radius: -TURNOUT_RADIUS, transition: 0 },
    { length: TAIL },
    // 戻し曲線。ここで本線と平行になる
    { length: LEAD, radius: TURNOUT_RADIUS, transition: 0 },
    // 2 番線のホーム（本線から 3.4m 横）
    { length: PLATFORM_TRACK },
    // 出口。本線へ向き直してから、背向分岐器の護輪軌条部 → リード曲線で合流する
    { length: LEAD, radius: TURNOUT_RADIUS, transition: 0 },
    { length: TAIL },
    { length: LEAD, radius: -TURNOUT_RADIUS, transition: 0 },
    { length: 1500 - LOOP_END },
  ];

  const horizontal = [
    ...(loop ? loopHorizontal : [{ length: 1500 }]),
    { length: 800, radius: 600, transition: 80, cant: 75 },
    { length: 700, transition: 80 },
    { length: 1200 },
    { length: 800, radius: -400, transition: 100, cant: 90 },
    { length: 600, transition: 100 },
    { length: 2400 },
  ];

  const vertical = [
    { length: 2000, grade: 0 },
    { length: 1200, grade: 25, verticalCurve: 200 },
    { length: 1400, grade: 0, verticalCurve: 200 },
    { length: 1400, grade: -33, verticalCurve: 200 },
    { length: 2000, grade: 0, verticalCurve: 200 },
  ];

  return {
    id: loop ? 'test-line-loop' : 'test-line',
    name: loop ? '試験線（2 番線経由）' : '試験線',
    gauge: 1067,
    maxSpeed: 110,
    sampleStep: 2,

    horizontal,
    vertical,

    tunnels: [{ id: 'tunnel-1', start: 4700, end: 5900 }],

    /**
     * 分岐器 3 基。
     *
     * `to-1` / `to-2` は起点駅の交換設備で、開通方向が 1 番線と 2 番線を分ける。
     * **どちらの番線を通っても分岐器そのものは同じ場所に同じ寸法である**ため、
     * 1 番線でもトングレールとクロッシングの衝撃は出る。違うのは、分岐側では
     * 欠線を踏むレールが反対側になること、トングレールで輪軸が曲げられること、
     * そしてリード曲線の横 G が加わることである。
     *
     * `to-2` を `side: 'left'` としているのは背向だからである。分岐器の向きは
     * その分岐器を**対向で見たとき**に分岐側がどちらへ出るかで決まり、背向で
     * 進入する列車から見ると左右が入れ替わる。2 番線から本線へ戻る列車は左へ
     * 寄るので、トングレールでのふらつきも左向きになる。
     *
     * `to-3` は側線への分岐器で、本線側へ開通したままにしてある。分岐側の進路が
     * 無い（＝速度制限も無い）ので、線路最高速度のまま欠線を踏むことになる。
     */
    turnouts: [
      {
        id: 'to-1',
        at: LOOP_ENTRY,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: loop ? 'diverging' : 'through',
      },
      {
        id: 'to-2',
        at: LOOP_EXIT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'trailing',
        route: loop ? 'diverging' : 'through',
      },
      {
        id: 'to-3',
        at: SIDING_TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: 'through',
      },
      {
        id: 'to-4',
        at: DEPOT_TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'facing',
        route: 'through',
      },
    ],

    /**
     * 行き違い設備。起点駅の分岐器 2 基が 1 番線と 2 番線を挟んでいる。
     *
     * 線路中心間隔も、隣の線路がどちら側にあるかも書いていない。どちらも
     * 分岐器の番数と開通方向から決まるからで、#12 なら 3.38m、1 番線を走って
     * いれば右、2 番線を走っていれば左になる。対向列車はこの隣の線路を走る。
     */
    passingLoops: [{ id: 'loop-a', entry: 'to-1', exit: 'to-2' }],

    /**
     * 橋りょう 4 か所。**同じ「橋」でも音がまったく違う**ことを聴き比べられるよう、
     * 桁の作りを 4 通りに変えてある。音を決めているのは形式の名前ではなく、
     * 「加振力が桁へ届くか（床の作り）」と「その板がどれだけ動くか（板厚）」の 2 つで、
     * 名前はその結果に付いているにすぎない。
     *
     * | 橋   | 形式・床                     | 音 |
     * | ---- | ---------------------------- | -- |
     * | br-1 | 上路プレートガーダー・無道床 | 桁に直結。腹板が 60〜250Hz で鳴り、渡るあいだじゅう轟音になる |
     * | br-2 | 下路トラス・無道床           | 床組の板が薄く小さいので音程が高い。主構が両脇にあるのでよく反響する |
     * | br-3 | コンクリート桁・有道床       | 道床が力を食い、厚い床版はそもそも動かない。ほとんど音が変わらない |
     * | br-4 | プレートガーダー・有道床     | 同じ鋼桁でも、道床を入れるだけで br-1 より 1 桁静かになる |
     *
     * br-1 は**ロングレール区間の中**にある。無道床橋では桁が温度で伸び縮みするので
     * 両端に伸縮継目が入り、継目音の無い区間を走っていて橋の前後だけ「シャッ」と鳴る。
     */
    bridges: [
      { id: 'br-3', name: '第一試験川橋りょう', start: 1900, end: 1980, kind: 'concrete' },
      { id: 'br-1', name: '第二試験川橋りょう', start: 2950, end: 3060, kind: 'plate-girder' },
      { id: 'br-2', name: '試験峡谷橋りょう', start: 4380, end: 4460, kind: 'truss' },
      {
        id: 'br-4',
        name: '試験用水路橋りょう',
        start: 6600,
        end: 6660,
        kind: 'plate-girder',
        deck: 'ballasted',
      },
    ],

    /**
     * 踏切 3 か所。
     *
     * 警報音は踏切のスピーカから**道路へ向けて**鳴っている音で、運転台はそれを
     * 通りすがりに聞く。したがって近づけば大きく高く、通り過ぎれば小さく低く
     * 聞こえる — 音程の下がり幅は自分の速度が決めるので、110km/h で通れば
     * 全音以上、25km/h なら気付かない程度になる。
     *
     * xg-2 だけ電鐘式（電磁石でハンマーが鐘を叩く旧式）にしてある。電子式の
     * 「カン カン」と違い、音程を持たない金属音が余韻を引くので、同じ踏切でも
     * 方式で聞こえ方がまるで違うことが分かる。
     */
    levelCrossings: [
      { id: 'xg-1', name: '試験台踏切', at: 1300, roadWidth: 7, surface: 'rubber' },
      {
        id: 'xg-2',
        name: '中原第二踏切',
        at: 3800,
        roadWidth: 4.5,
        surface: 'concrete',
        bell: 'gong',
        // 中原駅の出発方すぐにあるので、制御子は駅の先に置く。既定の
        // 「警報時間 × 最高速度」で置くとホームの手前まで届いてしまい、
        // 停車しているあいだじゅう鳴りっぱなしになる。実物の踏切制御も同じ理由で
        // 駅の近くでは制御子を駅の出発側へ寄せる（発車直後の列車は遅いので、
        // 短い距離でも警報時間は足りる）。
        warningDistance: 250,
      },
      { id: 'xg-3', name: '終端街道踏切', at: 6800, roadWidth: 12, surface: 'rubber' },
    ],

    stations: [
      {
        id: 'stn-a',
        name: '試験台',
        stopPosition: 300,
        platformStart: 180,
        platformEnd: 320,
        dwellTime: 30,
        departureTime: '10:00:30',
      },
      {
        id: 'stn-b',
        name: '中原',
        stopPosition: 3500,
        platformStart: 3380,
        platformEnd: 3520,
        dwellTime: 30,
        arrivalTime: '10:03:20',
        departureTime: '10:03:50',
      },
      {
        id: 'stn-c',
        name: '終端',
        stopPosition: 7200,
        platformStart: 7080,
        platformEnd: 7220,
        dwellTime: 60,
        arrivalTime: '10:07:10',
      },
    ],

    signals: [
      { id: 'sig-1', at: 200, kind: 'starting' },
      { id: 'sig-2', at: 1200 },
      { id: 'sig-3', at: 2200 },
      { id: 'sig-4', at: 3200, kind: 'home' },
      { id: 'sig-5', at: 4200, kind: 'starting' },
      { id: 'sig-6', at: 5200 },
      // 側線への分岐器を防護する信号機は分岐器の手前に置く
      { id: 'sig-7', at: SIDING_TURNOUT_AT - 250 },
      { id: 'sig-8', at: 7100, kind: 'home' },
    ],

    aspectSpeeds: { R: 0, YY: 25, Y: 45, YG: 75, G: 110 },

    /**
     * レールは定尺 25m を基本とし、2600〜4300m だけをロングレールにしてある。
     * 同じ速度でも継目音の有無で走行音がはっきり変わるので、「ガタン ゴトン」が
     * 編成の寸法から出ていることを聞いて確かめられる。
     *
     * トンネル（4700〜5900m）はあえて定尺のままにしてある。トンネルの反響が
     * いちばん分かるのは継目の衝撃が響くときで、ロングレールを重ねてしまうと
     * その組み合わせが試せないため。
     *
     * ロングレール区間には波状摩耗を深めに与えてある。継目音が無いぶん、高速で
     * 走ると `速度 / 波長` のうなりが主役になり、加速するにつれて音程が上がって
     * いくのが聞き取れる。R600 曲線の出口にあたるので、波状摩耗が育ちやすい
     * 場所という点でも無理がない。
     *
     * ロングレール区間の中には**橋りょう（br-1）と分岐器（to-4）と踏切（xg-2）**が
     * ある。継目が無いはずの区間でも、この 3 か所だけは音がする:
     *
     *  - 橋の両端 — 桁の伸縮を逃がす伸縮継目（レール端を斜めに削いで重ねてある
     *    ので、段差を踏まずに乗り移る「シャッ」）
     *  - 分岐器の前後 — 軌道回路を区切る絶縁継目（遊間が樹脂で埋まっているので
     *    段差がほとんど無く、硬く短い「タン」）
     *  - 踏切道の入口と出口 — 舗装と踏切板の目地（弾性体なので鈍い「ゴトッ」）
     *
     * どれも「継目を無くせない場所で、衝撃をできるだけ小さくする」構造なので、
     * 定尺の突合せ継目の「ガタン」とは音が違う。
     */
    rail: {
      spacing: 25,
      corrugation: 0.2,
      sections: [
        { start: 2600, spacing: 0, corrugation: 0.65 },
        { start: 4300, spacing: 25, corrugation: 0.2 },
      ],
    },

    autoCurveLimits: { enabled: true, maxCantDeficiency: 60, roundDown: 5 },
    autoAtsP: { enabled: true },
    autoAtsSn: { enabled: true },
  };
}

/** 試験線（起点駅は 1 番線＝本線側。8km） */
export const testLineRoute: RouteDefinition = buildTestLine(false);

/**
 * 試験線（起点駅の 2 番線＝副本線を通る）。
 *
 * 交換可能駅なので、2 番線へ入っても行き先は変わらない。**分かれてすぐ戻る**ため
 * 距離程も駅も信号機も 1 番線と同じで、違うのは 40〜460m の線形だけである。
 * 発車のたびに #12 分岐器の分岐側（45km/h 制限）を渡ることになるので、制限を
 * 守って出るか、渡りきるまで加速を待つか、という運転そのものが変わる。
 */
export const testLineLoopRoute: RouteDefinition = buildTestLine(true);
