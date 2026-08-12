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
 *  - 6300m に側線への #12 片開き分岐器（本線側へ開通）
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
