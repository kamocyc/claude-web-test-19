import type { RailCondition, SafetySystemKind } from '@railsim/core';
import {
  opposingTrainLoop,
  opposingTrainMain,
  precedingTrain,
  testLineLocal,
} from './assets/scenarios.ts';
import type { ScenarioDefinition } from './schema/scenario.ts';

/**
 * 走行条件の組み合わせ。
 *
 * ビューアの選択肢はこの 6 つで、**互いに独立**である。同梱シナリオのように
 * 「降雪の抵抗制御車」といった組み合わせをあらかじめ数え上げるのではなく、
 * 選んだ条件からシナリオ定義をその場で組み立てる（4 × 4 × 2 × 2 × 2 × 2 = 256 通り）。
 *
 * 車両と天気は択一なのでプルダウン、残りは入切なのでチェックボックスにあたる。
 */
export interface RunOptions {
  /** 車両データの ID */
  readonly vehicleId: string;
  readonly weather: WeatherChoice;
  /** 起点駅（交換可能駅）で 2 番線＝分岐側へ入るか */
  readonly divergingPlatform: boolean;
  /** 先行列車を走らせるか */
  readonly precedingTrain: boolean;
  /**
   * 対向列車と行き違うか。
   *
   * 単線なのですれ違えるのは起点駅の交換設備だけである。自列車が 1 番線なら
   * 対向列車は 2 番線（分岐制限 45km/h）を、2 番線に入っていれば本線を制限なしで
   * 通過するので、**どちらの番線を選んだかですれ違いの速さが変わる**。
   */
  readonly opposingTrain: boolean;
  readonly safety: SafetyChoice;
}

export type WeatherChoice = 'clear' | 'rain' | 'leaves' | 'snow';
export type SafetyChoice = Extract<SafetySystemKind, 'ats-p' | 'ats-sn'>;

export interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
}

/** 選べる車両（同梱車両データのうち、4 両編成の 4 形式） */
export const VEHICLE_CHOICES: ReadonlyArray<Choice<string>> = [
  { id: 'commuter-4', label: 'VVVF インバータ' },
  { id: 'commuter-4-resistor', label: '抵抗制御' },
  { id: 'commuter-4-chopper', label: '電機子チョッパ' },
  { id: 'commuter-4-scale', label: '音階インバータ' },
];

/** 天気と、それがレール踏面と架線に与えるもの */
export interface WeatherSpec extends Choice<WeatherChoice> {
  readonly rail: RailCondition;
  /**
   * 架線の回生負荷受け入れ率。
   *
   * 本来は他列車が力行しているかどうかで決まる量で、天気とは別物である。それでも
   * 降雪だけ低くしてあるのは、**回生失効と滑走を同時に起こす条件**を 1 つ選べる
   * ようにするためで、抵抗制御の発電ブレーキが架線と無関係に効くことを聴き比べる
   * のもこの条件になる。
   */
  readonly regeneration: number;
}

export const WEATHER_CHOICES: readonly WeatherSpec[] = [
  { id: 'clear', label: '晴天', rail: 'dry', regeneration: 1 },
  { id: 'rain', label: '雨', rail: 'wet', regeneration: 1 },
  { id: 'leaves', label: '落葉', rail: 'leaves', regeneration: 1 },
  { id: 'snow', label: '降雪', rail: 'snow', regeneration: 0.5 },
];

export const SAFETY_CHOICES: ReadonlyArray<Choice<SafetyChoice>> = [
  { id: 'ats-p', label: 'ATS-P' },
  { id: 'ats-sn', label: 'ATS-SN' },
];

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  vehicleId: 'commuter-4',
  weather: 'clear',
  divergingPlatform: false,
  precedingTrain: false,
  opposingTrain: false,
  safety: 'ats-p',
};

const weatherOf = (id: WeatherChoice): WeatherSpec =>
  WEATHER_CHOICES.find((w) => w.id === id) ?? WEATHER_CHOICES[0]!;

const labelOf = <T extends string>(choices: ReadonlyArray<Choice<T>>, id: T): string =>
  choices.find((c) => c.id === id)?.label ?? id;

/** 組み合わせから作ったシナリオの ID。記録の保存・再生でも使う。 */
export function runScenarioId(options: RunOptions): string {
  return [
    'run',
    options.vehicleId,
    options.weather,
    options.divergingPlatform ? 'loop' : 'main',
    options.safety,
    options.precedingTrain ? 'following' : 'solo',
    options.opposingTrain ? 'meeting' : 'clear',
  ].join('/');
}

/** `runScenarioId()` の逆。知らない組み合わせなら null。 */
export function parseRunScenarioId(id: string): RunOptions | null {
  const parts = id.split('/');
  if (parts.length !== 7 || parts[0] !== 'run') return null;
  const [, vehicleId, weather, platform, safety, following, meeting] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!VEHICLE_CHOICES.some((v) => v.id === vehicleId)) return null;
  if (!WEATHER_CHOICES.some((w) => w.id === weather)) return null;
  if (!SAFETY_CHOICES.some((s) => s.id === safety)) return null;
  if (platform !== 'main' && platform !== 'loop') return null;
  if (following !== 'following' && following !== 'solo') return null;
  if (meeting !== 'meeting' && meeting !== 'clear') return null;
  return {
    vehicleId,
    weather: weather as WeatherChoice,
    divergingPlatform: platform === 'loop',
    precedingTrain: following === 'following',
    opposingTrain: meeting === 'meeting',
    safety: safety as SafetyChoice,
  };
}

/** 画面に出す名前 */
export function runScenarioName(options: RunOptions): string {
  const parts = [
    labelOf(VEHICLE_CHOICES, options.vehicleId),
    labelOf(WEATHER_CHOICES, options.weather),
    options.divergingPlatform ? '2 番線' : '1 番線',
    labelOf(SAFETY_CHOICES, options.safety),
  ];
  if (options.precedingTrain) parts.push('先行列車あり');
  if (options.opposingTrain) parts.push('対向列車あり');
  return `試験線 各駅停車（${parts.join('・')}）`;
}

/**
 * 組み合わせからシナリオ定義を組み立てる。
 *
 * 土台は同梱の「試験線 各駅停車（晴天）」で、条件にあたるところだけを差し替える。
 * 分岐側は**路線データごと差し替える**（開通方向が違えば別の線形になるため）が、
 * 交換可能駅なので距離程も駅も信号機も同じものになり、走り比べがそのまま成立する。
 */
export function runScenarioDefinition(options: RunOptions): ScenarioDefinition {
  const weather = weatherOf(options.weather);
  return {
    ...testLineLocal,
    id: runScenarioId(options),
    name: runScenarioName(options),
    routeId: options.divergingPlatform ? 'test-line-loop' : 'test-line',
    vehicleId: options.vehicleId,
    railCondition: weather.rail,
    regenerationReceptivity: weather.regeneration,
    safetySystems: [options.safety],
    // 先行列車は自分と同じ線路、対向列車は交換設備の隣の線路を走る。役割が違うので
    // 同時に走らせられる。対向列車のダイヤは、自分がどちらの番線にいるかで変わる
    // （相手が通るのが本線か分岐側かで、制限速度がまるで違うため）。
    scheduledTrains: [
      ...(options.precedingTrain ? precedingTrain : []),
      ...(options.opposingTrain
        ? options.divergingPlatform
          ? opposingTrainMain
          : opposingTrainLoop
        : []),
    ],
  };
}
