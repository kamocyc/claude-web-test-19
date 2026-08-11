import type { RouteDefinition } from '../schema/route.ts';

/**
 * 架空の試験線「試験線（南武試験線）」。全長 8 km。
 *
 * 物理・信号の検証に必要な要素をひととおり含む最小の路線:
 *
 *  - 直線 → R600 左曲線（カント 75mm）→ 直線 → R400 右曲線（カント 90mm）→ 直線
 *  - 0‰ → 25‰ 上り → 0‰ → 33‰ 下り → 0‰（すべて縦曲線 200m 付き）
 *  - トンネル 1 区間（下り勾配の途中）
 *  - 駅 3 つ（起点駅・中間駅・終点駅）とダイヤ
 *  - 閉塞信号機 8 基（約 1km 間隔）。ATS-P / ATS-SN の地上子は自動配置される。
 *
 * 曲線の制限速度は許容カント不足 60mm から自動計算される
 * （R600/C75 → 95km/h、R400/C90 → 80km/h）。
 */
export const testLineRoute: RouteDefinition = {
  id: 'test-line',
  name: '試験線',
  gauge: 1067,
  maxSpeed: 110,
  sampleStep: 2,

  horizontal: [
    { length: 1500 },
    { length: 800, radius: 600, transition: 80, cant: 75 },
    { length: 700, transition: 80 },
    { length: 1200 },
    { length: 800, radius: -400, transition: 100, cant: 90 },
    { length: 600, transition: 100 },
    { length: 2400 },
  ],

  vertical: [
    { length: 2000, grade: 0 },
    { length: 1200, grade: 25, verticalCurve: 200 },
    { length: 1400, grade: 0, verticalCurve: 200 },
    { length: 1400, grade: -33, verticalCurve: 200 },
    { length: 2000, grade: 0, verticalCurve: 200 },
  ],

  tunnels: [{ id: 'tunnel-1', start: 4700, end: 5900 }],

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
    { id: 'sig-7', at: 6200 },
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
