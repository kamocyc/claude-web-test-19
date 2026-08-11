import { z } from 'zod';

/**
 * 路線データのスキーマ。
 *
 * 単位は**鉄道の現場で使われる単位**で書く（速度 km/h、勾配 ‰、カント mm、距離 m）。
 * コンパイラが SI へ変換してコアへ渡すため、コア側は一切の換算を持たない。
 */

export const aspectSchema = z.enum(['R', 'YY', 'Y', 'YG', 'G']);

/** 平面線形の 1 区間 */
export const horizontalSegmentSchema = z.object({
  /** 区間長 [m]（先頭の緩和曲線を含む） */
  length: z.number().positive(),
  /** 曲線半径 [m]。正 = 左曲がり、負 = 右曲がり。省略で直線。 */
  radius: z.number().nullable().optional(),
  /** 緩和曲線長 [m]（区間の先頭に置かれる。カント逓減も同じ区間で行う） */
  transition: z.number().nonnegative().optional(),
  /** カント [mm]（大きさ。符号は曲線の向きから決まる） */
  cant: z.number().optional(),
});

/** 縦断線形の 1 区間 */
export const verticalSegmentSchema = z.object({
  /** 区間長 [m] */
  length: z.number().positive(),
  /** 勾配 [‰]（正 = 上り） */
  grade: z.number(),
  /** 縦曲線長 [m]（勾配変化点を中心に前後へ半分ずつ配置される） */
  verticalCurve: z.number().nonnegative().optional(),
});

export const speedLimitSchema = z.object({
  id: z.string().optional(),
  /** 制限が始まる距離程 [m] */
  at: z.number(),
  /** 制限速度 [km/h] */
  speed: z.number().nonnegative(),
  reason: z.enum(['curve', 'turnout', 'temporary', 'line', 'station']).default('line'),
});

export const stationSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 停止位置目標（列車先頭端を合わせる距離程）[m] */
  stopPosition: z.number(),
  /** ホーム始端 [m]（省略時は停止位置の 220m 手前） */
  platformStart: z.number().optional(),
  /** ホーム終端 [m]（省略時は停止位置の 20m 先） */
  platformEnd: z.number().optional(),
  /** 通過駅 */
  isPass: z.boolean().default(false),
  /** 停車時分 [s] */
  dwellTime: z.number().nonnegative().default(30),
  /** 停止位置の許容誤差 [m] */
  stopTolerance: z.number().positive().default(1),
  /** 着時刻 "H:MM:SS" */
  arrivalTime: z.string().optional(),
  /** 発時刻 "H:MM:SS" */
  departureTime: z.string().optional(),
});

export const signalSchema = z.object({
  id: z.string(),
  /** 信号機の位置 [m] */
  at: z.number(),
  kind: z.enum(['block', 'home', 'starting', 'distant']).default('block'),
  /** 出しうる最大現示 */
  maxAspect: aspectSchema.default('G'),
});

export const tunnelSchema = z.object({
  id: z.string().optional(),
  start: z.number(),
  end: z.number(),
});

export const safetySectionSchema = z.object({
  start: z.number(),
  end: z.number(),
  kind: z.enum(['ats-sn', 'ats-p', 'atc']),
});

/** 手動で配置する地上子 */
export const beaconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ats-sn-long'), at: z.number(), signalId: z.string() }),
  z.object({ kind: z.literal('ats-sn-immediate'), at: z.number(), signalId: z.string() }),
  z.object({
    kind: z.literal('ats-p-signal'),
    at: z.number(),
    signalId: z.string(),
    distance: z.number(),
  }),
  z.object({
    kind: z.literal('ats-p-limit'),
    at: z.number(),
    limitId: z.string(),
    distance: z.number(),
    /** 制限速度 [km/h] */
    speed: z.number().nonnegative(),
  }),
  z.object({ kind: z.literal('ats-p-terminus'), at: z.number(), distance: z.number() }),
]);

export const routeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 軌間 [mm] */
  gauge: z.number().positive().default(1067),
  /** 線路の最高速度 [km/h] */
  maxSpeed: z.number().positive(),
  /** 起点の方位 [度]（東向きが 0、反時計回りが正） */
  originHeading: z.number().default(0),
  /** 位置サンプルの刻み [m] */
  sampleStep: z.number().positive().default(2),

  horizontal: z.array(horizontalSegmentSchema).min(1),
  vertical: z.array(verticalSegmentSchema).min(1),

  speedLimits: z.array(speedLimitSchema).default([]),
  stations: z.array(stationSchema).default([]),
  signals: z.array(signalSchema).default([]),
  tunnels: z.array(tunnelSchema).default([]),
  safetySections: z.array(safetySectionSchema).default([]),
  beacons: z.array(beaconSchema).default([]),

  /** 現示ごとの許容速度 [km/h] */
  aspectSpeeds: z
    .object({
      R: z.number().default(0),
      YY: z.number().default(25),
      Y: z.number().default(45),
      YG: z.number().default(75),
      G: z.number().default(120),
    })
    .default({}),

  /**
   * 曲線の制限速度を自動生成する。
   * カント不足の上限から v = sqrt((C + Cd) g R / G) で求める。
   */
  autoCurveLimits: z
    .object({
      enabled: z.boolean().default(true),
      /** 許容するカント不足 [mm] */
      maxCantDeficiency: z.number().default(60),
      /** 制限速度を 5km/h 単位に切り下げる */
      roundDown: z.number().default(5),
    })
    .default({}),

  /** ATS-P 地上子を信号機・速度制限の手前へ自動配置する */
  autoAtsP: z
    .object({
      enabled: z.boolean().default(true),
      /** 信号機の手前に置く距離 [m] */
      signalDistances: z.array(z.number()).default([600, 380, 230, 130, 60, 15]),
      /** 速度制限の手前に置く距離 [m] */
      limitDistances: z.array(z.number()).default([500, 300, 150, 50]),
    })
    .default({}),

  /**
   * 軌道狂い（軌道の不整）。距離程の関数として生成されるため、
   * 同じ地点では常に同じ揺れ方になる。
   */
  trackIrregularity: z
    .object({
      /** 狂いの大きさの倍率（0 = 完全に平滑、1 = 整備された在来線、2 = 荒れた軌道） */
      level: z.number().nonnegative().default(1),
      /** 狂いの形状を決めるシード */
      seed: z.number().int().default(12345),
      /** 高低狂いの標準偏差 [mm] */
      verticalAmplitude: z.number().nonnegative().default(2.5),
      /** 通り狂いの標準偏差 [mm] */
      lateralAmplitude: z.number().nonnegative().default(2.0),
      /** 水準狂いの標準偏差 [mm] */
      crossLevelAmplitude: z.number().nonnegative().default(2.2),
      /** 最短波長 [m] */
      minWavelength: z.number().positive().default(2.5),
      /** 最長波長 [m] */
      maxWavelength: z.number().positive().default(45),
    })
    .default({}),

  /** ATS-SN 地上子（ロング・直下）を自動配置する */
  autoAtsSn: z
    .object({
      enabled: z.boolean().default(true),
      /** ロング地上子を信号機の手前どれだけに置くか [m] */
      longDistance: z.number().default(600),
    })
    .default({}),
});

export type RouteDefinition = z.input<typeof routeSchema>;
export type ParsedRoute = z.output<typeof routeSchema>;
