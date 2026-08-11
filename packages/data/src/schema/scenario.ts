import { z } from 'zod';

export const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 路線データの ID */
  routeId: z.string(),
  /** 車両データの ID */
  vehicleId: z.string(),
  /** 開始時刻 "H:MM:SS" */
  startTime: z.string().default('10:00:00'),
  /** 開始位置（列車先頭端の距離程）[m] */
  startPosition: z.number(),
  /** 開始速度 [km/h] */
  startSpeed: z.number().nonnegative().default(0),
  /** 乗車率（1 = 定員相当） */
  loadFactor: z.number().min(0).default(0.5),
  /** レール踏面状態 */
  railCondition: z.enum(['dry', 'wet', 'leaves', 'snow']).default('dry'),
  /** 架線の回生負荷受け入れ率 0..1 */
  regenerationReceptivity: z.number().min(0).max(1).default(1),
  /** 乱数シード */
  seed: z.number().int().default(1),
  /** 搭載する保安装置 */
  safetySystems: z.array(z.enum(['ats-sn', 'ats-p', 'atc'])).default(['ats-p']),
  /** EB 装置を搭載するか */
  hasVigilance: z.boolean().default(true),
  /** 単一質点モード（BVE 相当の比較用） */
  rigidConsist: z.boolean().default(false),
  /** ダイヤ上の他列車 */
  scheduledTrains: z
    .array(
      z.object({
        id: z.string(),
        /** 編成長 [m] */
        length: z.number().positive().default(80),
        /** 時刻 "H:MM:SS" と先頭端の距離程 [m] */
        waypoints: z.array(z.object({ time: z.string(), position: z.number() })).min(2),
      }),
    )
    .default([]),
});

export type ScenarioDefinition = z.input<typeof scenarioSchema>;
export type ParsedScenario = z.output<typeof scenarioSchema>;
