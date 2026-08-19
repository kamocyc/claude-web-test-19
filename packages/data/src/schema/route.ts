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

/**
 * 分岐器（ポイント）。
 *
 * 分岐側へ開通していれば、その先の線形は**この路線データの `horizontal` が続けて
 * 書いているもの**になる。すなわち「直進する進路」と「分岐する進路」は別々の路線
 * データであり、この項目はその路線が分岐器のどちら側を通るのかを宣言する。
 * 分岐器そのもの（トングレール・クロッシング）は開通方向によらず同じ場所にあり、
 * どちらを通っても揺れと音が出る。
 */
export const turnoutSchema = z.object({
  id: z.string(),
  /** 列車が進入する側の端（分岐器の始端）の距離程 [m] */
  at: z.number(),
  /** 番数 N（クロッシング角 α は tan α = 1/N）。8・12・16 などを入れる。 */
  number: z.number().positive().default(12),
  /** 分岐側が出る向き（進行方向から見て） */
  side: z.enum(['left', 'right']).default('right'),
  /** 対向（トングレール側から進入）／背向（クロッシング側から進入＝合流） */
  orientation: z.enum(['facing', 'trailing']).default('facing'),
  /** この路線が通る側 */
  route: z.enum(['through', 'diverging']).default('through'),
  /** 可動ノーズクロッシング（欠線が無いので衝撃が小さい） */
  swingNose: z.boolean().default(false),
  /** リード曲線半径 [m]（省略すると番数から標準値を求める） */
  radius: z.number().positive().optional(),
  /** 分岐側の制限速度 [km/h]（省略するとリード半径と許容カント不足から求める） */
  divergingSpeed: z.number().positive().optional(),
});

export const tunnelSchema = z.object({
  id: z.string().optional(),
  start: z.number(),
  end: z.number(),
});

/**
 * 橋りょう。
 *
 * 形式（`kind`）と床（`deck`）を書けば、桁の寸法は形式ごとの標準値から作られる。
 * 音を決めているのは形式そのものではなく寸法なので、寸法を書けばそちらが優先される
 * （薄い腹板の桁はよく鳴り、厚い床版は鳴らない、というのはどの形式でも同じである）。
 */
export const bridgeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /** 橋りょうの始端（橋台の前面）の距離程 [m] */
  start: z.number(),
  /** 橋りょうの終端の距離程 [m] */
  end: z.number(),
  kind: z.enum(['plate-girder', 'truss', 'concrete']).default('plate-girder'),
  /**
   * 床の作り。省略すると形式ごとの標準（鋼桁は無道床、コンクリート桁は有道床）になる。
   *
   * - `open`（無道床）— 橋まくらぎを主桁へ直接締結する。加振力がそのまま桁へ入る。
   * - `ballasted`（有道床）— 床版の上に道床を敷く。砕石が力を食うので静かになる。
   */
  deck: z.enum(['open', 'ballasted']).optional(),
  /** 径間長（支間）[m]。省略すると形式ごとの標準値。 */
  spanLength: z.number().positive().optional(),
  /** 主構・主桁の高さ [m]。省略すると支間から求める。 */
  girderDepth: z.number().positive().optional(),
  /** 音を出す板（腹板・床版）の厚さ [mm]。省略すると形式ごとの標準値。 */
  plateThickness: z.number().positive().optional(),
  /** 補剛材（板を区切る部材）の間隔 [m]。省略すると形式ごとの標準値。 */
  stiffenerSpacing: z.number().positive().optional(),
});

/**
 * 踏切道。
 *
 * 警報開始距離を書かなければ「警報時間 × 線路最高速度」で求める。実物の踏切制御子も
 * この決め方なので、線区の最高速度を上げれば踏切の鳴り始めも自動的に手前へ動く。
 */
export const levelCrossingSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /** 踏切道の中心の距離程 [m] */
  at: z.number(),
  /** 道路の幅 [m]（踏切道の長さ） */
  roadWidth: z.number().positive().default(6),
  /** 踏切道の舗装 */
  surface: z.enum(['rubber', 'concrete']).default('rubber'),
  /** 警報機の方式（電鐘式 / 電子式） */
  bell: z.enum(['gong', 'electronic']).default('electronic'),
  /** 警報時間 [s]（列車が来るまでに最低これだけ鳴らす） */
  warningTime: z.number().positive().default(30),
  /** 警報開始距離 [m]（省略時は 警報時間 × 線路最高速度） */
  warningDistance: z.number().positive().optional(),
});

/**
 * 行き違い設備（交換設備）。
 *
 * 入口と出口の分岐器を指すだけでよい。線路がどこにあるか（線路中心間隔・隣の線路の
 * 側）は分岐器の寸法と開通方向から決まるので、書く値は無い。単線の路線で対向列車と
 * すれ違えるのはこの区間だけである。
 */
export const passingLoopSchema = z.object({
  id: z.string(),
  /** 入口の分岐器の ID */
  entry: z.string(),
  /** 出口の分岐器の ID */
  exit: z.string(),
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
  turnouts: z.array(turnoutSchema).default([]),
  bridges: z.array(bridgeSchema).default([]),
  levelCrossings: z.array(levelCrossingSchema).default([]),
  passingLoops: z.array(passingLoopSchema).default([]),
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

  /**
   * レールの継目。
   *
   * 定尺レール（25m）の区間では、軸が継目を踏むたびに「ガタン ゴトン」が鳴る。
   * ロングレール区間（`spacing: 0`）ではこれが無くなり、走行音が転動音だけになる。
   * 継目を踏む時刻は軸の位置から厳密に決まるので、間隔はそのまま固定軸距・
   * 台車中心間距離・編成長を映す。
   */
  rail: z
    .object({
      /** 継目の間隔 [m]。0 ならロングレール。 */
      spacing: z.number().nonnegative().default(25),
      /** レール波状摩耗の深さ 0..1（0 = 削正直後の滑らかなレール） */
      corrugation: z.number().min(0).max(1).default(0.25),
      /** 区間ごとの上書き */
      sections: z
        .array(
          z.object({
            /** 区間の始まり [m] */
            start: z.number(),
            /** 継目の間隔 [m]（0 = ロングレール） */
            spacing: z.number().nonnegative(),
            /** レール波状摩耗の深さ 0..1（省略すれば既定値のまま） */
            corrugation: z.number().min(0).max(1).optional(),
          }),
        )
        .default([]),
    })
    .default({}),

  /**
   * 個別の継目（絶縁継目・伸縮継目）を自動配置する。
   *
   * 継目はロングレール区間にも**置かざるを得ない場所**がある。
   *
   *  - 分岐器の前後 — 軌道回路（列車検知）の区切りに絶縁継目が要る
   *  - 橋りょうの両端 — 桁が温度で伸び縮みするので、その動きをレールから
   *    切り離す伸縮継目が要る（無道床橋は桁の動きがレールへ直に来るので必須。
   *    有道床橋は道床が滑って逃がすため、長い橋でだけ要る）
   *
   * どちらも「継目を無くせない場所で、継目の衝撃をできるだけ小さくする」ための
   * 構造なので、突合せ継目より小さい音がする。ロングレール区間を走っていて
   * 分岐器と橋の前後だけ継目の音が入るのは、実物でもこのためである。
   */
  autoRailJoints: z
    .object({
      enabled: z.boolean().default(true),
      /** 分岐器の端から絶縁継目までの距離 [m] */
      insulatedOffset: z.number().nonnegative().default(3),
      /** 有道床橋に伸縮継目を置く長さの下限 [m] */
      ballastedExpansionLength: z.number().positive().default(100),
    })
    .default({}),

  /**
   * 分岐側を通るときの制限速度を自動生成する。
   *
   * 分岐器のリード曲線には**緩和曲線もカントも無い**ため、同じ半径の本線曲線より
   * 許容できるカント不足は小さい。50mm を既定にすると、#8/R145 → 25km/h、
   * #10/R245 → 35km/h、#12/R350 → 45km/h と実際の分岐制限に一致する。
   */
  autoTurnoutLimits: z
    .object({
      enabled: z.boolean().default(true),
      /** 許容するカント不足 [mm] */
      maxCantDeficiency: z.number().default(50),
      /** 制限速度を 5km/h 単位に切り下げる */
      roundDown: z.number().default(5),
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
