import type { RouteDefinition } from '../schema/route.ts';

/** 分岐器（下り出発方）の始端の距離程 [m] */
const TURNOUT_AT = 6300;
/** 分岐器の番数。#12 → リード R350・分岐制限 45km/h */
const TURNOUT_NUMBER = 12;
/** リード曲線の半径 [m]（#12 の標準値） */
const TURNOUT_RADIUS = 350;
/**
 * リード長 [m] = R α。分岐器の寸法はコンパイラが番数から求めるが、分岐側の線形は
 * 路線データの側で書くので、同じ寸法をここでも組み立てる。
 */
const LEAD_LENGTH = TURNOUT_RADIUS * Math.atan(1 / TURNOUT_NUMBER);
/** 分岐器の全長 [m]（`turnoutLengthOf()` と同じ 1.4 倍） */
const TURNOUT_LENGTH = LEAD_LENGTH * 1.4;
/** 分岐器の終端の距離程 [m] */
const TURNOUT_END = TURNOUT_AT + TURNOUT_LENGTH;
/** 分岐線の終端駅までの距離 [m] */
const BRANCH_TAIL = 900;

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
 *  - 6300m に #12 片開き分岐器（右分岐）。**本線と分岐線で別の路線データになる。**
 *
 * 曲線の制限速度は許容カント不足 60mm から自動計算される
 * （R600/C75 → 95km/h、R400/C90 → 80km/h）。
 *
 * @param branch 分岐器を分岐側へ開通させ、その先を分岐線として書くか
 */
function buildTestLine(branch: boolean): RouteDefinition {
  /**
   * 分岐側のリード曲線。
   *
   * **緩和曲線もカントも無い**のがこの線形の要点である。分岐器のリード曲線は
   * 曲率が 0 から 1/R へ一段で立ち上がるので、横加速度が階段状に入る。
   * 本線の曲線（80〜100m の緩和曲線つき）とは、同じ横 G でも体への来方がまるで違う。
   */
  const branchHorizontal = [
    // トングレール先端 → クロッシング。曲率が一段で立ち上がり、α = atan(1/N) だけ振れる
    { length: LEAD_LENGTH, radius: -TURNOUT_RADIUS, transition: 0 },
    // クロッシングから分岐器の終端まではもう直線
    { length: TURNOUT_LENGTH - LEAD_LENGTH },
    { length: BRANCH_TAIL },
  ];
  const horizontal = [
    { length: 1500 },
    { length: 800, radius: 600, transition: 80, cant: 75 },
    { length: 700, transition: 80 },
    { length: 1200 },
    { length: 800, radius: -400, transition: 100, cant: 90 },
    { length: 600, transition: 100 },
    // 分岐器の始端で区間を切っておく（分岐側はここから別の線形になる）
    { length: TURNOUT_AT - 5600 },
    ...(branch ? branchHorizontal : [{ length: 8000 - TURNOUT_AT }]),
  ];
  const length = branch ? TURNOUT_END + BRANCH_TAIL : 8000;

  const vertical = [
    { length: 2000, grade: 0 },
    { length: 1200, grade: 25, verticalCurve: 200 },
    { length: 1400, grade: 0, verticalCurve: 200 },
    { length: 1400, grade: -33, verticalCurve: 200 },
    { length: length - 6000, grade: 0, verticalCurve: 200 },
  ];

  /** 終端駅（本線は 7200m、分岐線はリード曲線の先） */
  const terminus = branch
    ? { id: 'stn-d', name: '分岐終端', stopPosition: TURNOUT_END + 780 }
    : { id: 'stn-c', name: '終端', stopPosition: 7200 };

  return {
    id: branch ? 'test-line-branch' : 'test-line',
    name: branch ? '試験線（分岐線）' : '試験線',
    gauge: 1067,
    maxSpeed: 110,
    sampleStep: 2,

    horizontal,
    vertical,

    tunnels: [{ id: 'tunnel-1', start: 4700, end: 5900 }],

    /**
     * 6300m の片開き分岐器（右分岐・対向）。
     *
     * 本線は直進側へ、分岐線は分岐側へ開通している。分岐器そのものは**どちらの
     * 路線でも同じ場所に同じ寸法である**ため、直進でもトングレールとクロッシングの
     * 衝撃は出る。違うのは、分岐側では欠線を踏むレールが反対側になること、
     * トングレールで輪軸が曲げられること、そしてリード曲線の横 G が加わることである。
     */
    turnouts: [
      {
        id: 'to-1',
        at: TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: branch ? 'diverging' : 'through',
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
        ...terminus,
        platformStart: terminus.stopPosition - 120,
        platformEnd: terminus.stopPosition + 20,
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
      // 分岐器を防護する信号機は分岐器の手前に置く（進路はここから先で分かれる）
      { id: 'sig-7', at: TURNOUT_AT - 250 },
      { id: 'sig-8', at: terminus.stopPosition - 100, kind: 'home' },
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

/** 試験線（分岐器は直進側へ開通。8km） */
export const testLineRoute: RouteDefinition = buildTestLine(false);

/**
 * 試験線 分岐線（6300m の分岐器を分岐側へ）。
 *
 * 中原から先は本線と同じで、分岐器で右へ折れて分岐終端へ向かう。同じ運転を
 * 直進側と分岐側で走り比べれば、リード曲線の横 G と、欠線を踏む側が入れ替わる
 * ことによる揺れの違いがそのまま出る。
 */
export const testLineBranchRoute: RouteDefinition = buildTestLine(true);
