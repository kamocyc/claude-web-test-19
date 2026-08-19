import {
  AdjacentTrack,
  BridgeTrack,
  GRAVITY,
  LevelCrossingTrack,
  PointTable,
  RAIL_JOINT_STRENGTH,
  SpanTable,
  StepTable,
  TrackIrregularity,
  TurnoutTrack,
  bridgeLength,
  buildAlignment,
  crossingAngle,
  leadLengthOf,
  loopSpacingOf,
  standardLeadRadius,
  turnoutLengthOf,
  turnoutMergePoint,
  kmhToMps,
  mmToM,
  parseClock,
  warningDistanceOf,
  type AspectSpeeds,
  type BeaconPayload,
  type BlockSection,
  type Bridge,
  type BridgeDeck,
  type BridgeKind,
  type CompiledRoute,
  type HorizontalSegment,
  type LevelCrossing,
  type PassingLoop,
  type PointEntry,
  type RailJointFeature,
  type SafetySystemKind,
  type SignalDefinition,
  type SpeedLimitEntry,
  type Station,
  type TunnelSection,
  type Turnout,
  type VerticalSegment,
} from '@railsim/core';
import { routeSchema, type ParsedRoute, type RouteDefinition } from '../schema/route.ts';

/** 速度制限の適用区間 */
interface LimitSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  /** [m/s] */
  readonly speed: number;
  readonly reason: SpeedLimitEntry['reason'];
}

/**
 * 曲線の制限速度を自動で求める。
 *
 *   カント不足 Cd = G v^2 / (g R) - C  を Cd_max 以下に保つ条件から
 *   v_max = sqrt((C + Cd_max) g R / G)
 *
 * 実際の線路の曲線制限も同じ考え方（許容カント不足）で決められている。
 */
function curveSpeedLimit(
  radius: number,
  cant: number,
  gauge: number,
  maxCantDeficiency: number,
): number {
  const r = Math.abs(radius);
  if (!Number.isFinite(r) || r <= 0) return Infinity;
  return Math.sqrt(((cant + maxCantDeficiency) * GRAVITY * r) / gauge);
}

/** 制限速度を 5km/h 単位などに切り下げる [m/s] */
function roundDownSpeed(speed: number, stepKmh: number): number {
  const kmh = speed * 3.6;
  return kmhToMps(stepKmh > 0 ? Math.floor(kmh / stepKmh) * stepKmh : kmh);
}

/**
 * 橋りょうの形式ごとの標準寸法。
 *
 * 実在の在来線の橋りょうから採った代表値である。同じ形式でも寸法を書けばそちらが
 * 優先されるので、これは「何も書かなければこうなる」という値でしかない。
 *
 * | 形式             | 床       | 標準支間 | 桁高       | 音を出す板 |
 * | ---------------- | -------- | -------- | ---------- | ---------- |
 * | プレートガーダー | 無道床   | 30m      | 支間の 1/12 | 腹板 12mm（垂直補剛材で区切られる） |
 * | トラス           | 無道床   | 70m      | 支間の 1/8  | 床組の縦桁 9mm（横桁で区切られる） |
 * | コンクリート桁   | 有道床   | 25m      | 支間の 1/15 | 床版 250mm（主桁間 3.6m × 支間） |
 */
const BRIDGE_STANDARD: Readonly<
  Record<
    BridgeKind,
    {
      readonly deck: BridgeDeck;
      readonly spanLength: number;
      readonly depthRatio: number;
      /** 板厚 [mm] */
      readonly plateThickness: number;
      /** 音を出す板 1 区画の高さ（短辺）[m] */
      readonly panelHeight: (span: number, depth: number) => number;
      /** 1 区画の幅（長辺）[m] */
      readonly panelWidth: (span: number, depth: number) => number;
      /** まくらぎ間隔 [m] */
      readonly sleeperSpacing: number;
    }
  >
> = {
  // 腹板は垂直補剛材で区切られる。間隔は桁高の 0.7 倍前後が普通。
  'plate-girder': {
    deck: 'open',
    spanLength: 30,
    depthRatio: 1 / 12,
    plateThickness: 12,
    panelHeight: (_span, depth) => depth,
    panelWidth: (_span, depth) => depth * 0.7,
    sleeperSpacing: 0.58,
  },
  // トラスで音を出すのは主構ではなく床組である。主構は太い部材で動かない。
  truss: {
    deck: 'open',
    spanLength: 70,
    depthRatio: 1 / 8,
    plateThickness: 9,
    panelHeight: () => 0.9,
    panelWidth: () => 1.4,
    sleeperSpacing: 0.55,
  },
  // 床版は厚く重いので、同じ力で叩いてもほとんど動かない。
  concrete: {
    deck: 'ballasted',
    spanLength: 25,
    depthRatio: 1 / 15,
    plateThickness: 250,
    // 床版は主桁のあいだ（3.6m）で支えられ、線路方向には支間いっぱいに続く
    panelHeight: () => 3.6,
    panelWidth: (span) => span,
    sleeperSpacing: 25 / 44,
  },
};

/** 平面線形の区間境界（距離程）を求める */
function segmentBoundaries(segments: ParsedRoute['horizontal']): number[] {
  const out: number[] = [0];
  let s = 0;
  for (const seg of segments) {
    s += seg.length;
    out.push(s);
  }
  return out;
}

/** 区間ごとの制限速度から、距離程 -> 制限速度 の階段関数を作る */
function buildSpeedLimitTable(
  spans: readonly LimitSpan[],
  routeLength: number,
  lineSpeed: number,
): { table: StepTable<number>; entries: SpeedLimitEntry[] } {
  const breakpoints = new Set<number>([0]);
  for (const sp of spans) {
    breakpoints.add(Math.max(0, sp.start));
    breakpoints.add(Math.min(routeLength, sp.end));
  }
  // 同じ点を指しているつもりの切替点が、丸め誤差で 1e-13 だけずれることがある
  // （分岐器の終端は「始端 + 全長」、曲線の終端は区間長の累積で求まるため）。
  // そのまま並べると幅 0 の制限区間ができ、ATS-P の地上子まで生えてしまうので、
  // 1μm 以内に固まっている切替点は最後の 1 つに寄せる。
  const sorted = [...breakpoints]
    .sort((a, b) => a - b)
    .filter((b, i, all) => i === all.length - 1 || all[i + 1]! - b > 1e-6);
  const stepEntries: PointEntry<number>[] = [];
  const entries: SpeedLimitEntry[] = [];
  let previous = Number.NaN;

  for (const b of sorted) {
    if (b > routeLength) break;
    let speed = lineSpeed;
    let winner: LimitSpan | undefined;
    for (const sp of spans) {
      if (sp.start <= b && b < sp.end && sp.speed < speed) {
        speed = sp.speed;
        winner = sp;
      }
    }
    if (speed !== previous) {
      stepEntries.push({ s: b, value: speed });
      entries.push({
        id: winner?.id ?? `line-${b}`,
        start: b,
        speed,
        reason: winner?.reason ?? 'line',
      });
      previous = speed;
    }
  }
  return { table: new StepTable(stepEntries, lineSpeed), entries };
}

/**
 * 路線定義をコンパイルして、シミュレーションが直接使える構造にする。
 *
 * - 現場の単位（km/h・‰・mm）を SI へ変換する
 * - 平面／縦断線形から軌道中心線を組み立てる
 * - 曲線の制限速度を許容カント不足から自動生成する
 * - 信号機の位置から閉塞区間を導出する
 * - ATS-P / ATS-SN の地上子を自動配置する
 */
export function compileRoute(definition: RouteDefinition): CompiledRoute {
  const def = routeSchema.parse(definition);
  const gauge = mmToM(def.gauge);
  const lineSpeed = kmhToMps(def.maxSpeed);

  const horizontal: HorizontalSegment[] = def.horizontal.map((seg) => ({
    length: seg.length,
    ...(seg.radius === undefined || seg.radius === null ? {} : { radius: seg.radius }),
    ...(seg.transition === undefined ? {} : { transitionLength: seg.transition }),
    ...(seg.cant === undefined ? {} : { cant: mmToM(seg.cant) }),
  }));
  const vertical: VerticalSegment[] = def.vertical.map((seg) => ({
    length: seg.length,
    gradePermil: seg.grade,
    ...(seg.verticalCurve === undefined ? {} : { verticalCurveLength: seg.verticalCurve }),
  }));

  const alignment = buildAlignment({
    gauge,
    horizontal,
    vertical,
    sampleStep: def.sampleStep,
    origin: { heading: (def.originHeading * Math.PI) / 180 },
  });
  const routeLength = alignment.length;

  // --- 分岐器 ---
  // 分岐器の寸法は番数ひとつで決まる。クロッシング角 α（tan α = 1/N）とリード半径から
  // リード長 R α が出て、全長もそれに比例する。分岐側の制限速度は、緩和曲線もカントも
  // 無い曲線として許容カント不足から求める。
  const turnoutCd = mmToM(def.autoTurnoutLimits.maxCantDeficiency);
  const turnouts: Turnout[] = def.turnouts.map((t) => {
    const angle = crossingAngle(t.number);
    const radius = t.radius ?? standardLeadRadius(t.number);
    const leadLength = leadLengthOf(radius, angle);
    const length = turnoutLengthOf(leadLength);
    const divergingSpeed =
      t.divergingSpeed === undefined
        ? roundDownSpeed(
            curveSpeedLimit(radius, 0, gauge, turnoutCd),
            def.autoTurnoutLimits.roundDown,
          )
        : kmhToMps(t.divergingSpeed);
    // 対向はトングレールから、背向はクロッシングから進入する
    const facing = t.orientation === 'facing';
    return {
      id: t.id,
      position: t.at,
      length,
      number: t.number,
      crossingAngle: angle,
      radius,
      leadLength,
      side: t.side,
      orientation: t.orientation,
      route: t.route,
      swingNose: t.swingNose,
      divergingSpeed,
      pointsPosition: facing ? t.at : t.at + leadLength,
      crossingPosition: facing ? t.at + leadLength : t.at,
    } satisfies Turnout;
  });

  const turnoutById = new Map(turnouts.map((t) => [t.id, t]));

  // --- 行き違い設備（隣の線路） ---
  // 線路中心間隔も、隣の線路がどちら側にあるかも、分岐器の寸法と開通方向で決まる。
  // 分岐側を通っているなら本線は反対側にあるので、符号がそのまま入れ替わる。
  const passingLoops: PassingLoop[] = def.passingLoops.map((loop) => {
    const entry = turnoutById.get(loop.entry);
    const exit = turnoutById.get(loop.exit);
    if (!entry || !exit) {
      throw new Error(
        `行き違い設備 ${loop.id} の分岐器が見つかりません: ${loop.entry} / ${loop.exit}`,
      );
    }
    const tailLength = entry.length - entry.leadLength;
    const side: 1 | -1 =
      (entry.side === 'right' ? 1 : -1) * (entry.route === 'through' ? 1 : -1) > 0 ? 1 : -1;
    return {
      id: loop.id,
      entry: turnoutMergePoint(entry),
      exit: turnoutMergePoint(exit),
      radius: entry.radius,
      angle: entry.crossingAngle,
      tailLength,
      spacing: loopSpacingOf(entry.radius, entry.crossingAngle, tailLength),
      side,
    } satisfies PassingLoop;
  });

  // --- 橋りょう ---
  const bridges: Bridge[] = def.bridges.map((b) => {
    const standard = BRIDGE_STANDARD[b.kind];
    const deck = b.deck ?? standard.deck;
    const spanLength = b.spanLength ?? Math.min(standard.spanLength, Math.abs(b.end - b.start));
    const girderDepth = b.girderDepth ?? spanLength * standard.depthRatio;
    const thickness = mmToM(b.plateThickness ?? standard.plateThickness);
    return {
      id: b.id,
      name: b.name ?? b.id,
      start: b.start,
      end: b.end,
      kind: b.kind,
      deck,
      spanLength,
      girderDepth,
      panel: {
        thickness,
        height: standard.panelHeight(spanLength, girderDepth),
        width: b.stiffenerSpacing ?? standard.panelWidth(spanLength, girderDepth),
      },
      // 有道床橋のまくらぎは明かり区間と同じ並びになる（道床がそのまま続くため）
      sleeperSpacing: deck === 'open' ? standard.sleeperSpacing : 25 / 44,
    } satisfies Bridge;
  });

  // --- 踏切 ---
  const levelCrossings: LevelCrossing[] = def.levelCrossings.map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    position: c.at,
    roadWidth: c.roadWidth,
    surface: c.surface,
    bell: c.bell,
    // 警報時間を確保できる距離は、その区間でいちばん速い列車で決まる
    warningDistance: c.warningDistance ?? warningDistanceOf(c.warningTime, lineSpeed),
    barrierDelay: 5,
    barrierFall: 7,
    barrierRise: 6,
  }));

  // --- 個別の継目（絶縁継目・伸縮継目）---
  const railJoints: PointEntry<RailJointFeature>[] = [];
  if (def.autoRailJoints.enabled) {
    const offset = def.autoRailJoints.insulatedOffset;
    for (const t of turnouts) {
      // 分岐器は軌道回路の境目なので、前後に絶縁継目が入る
      for (const s of [t.position - offset, t.position + t.length + offset]) {
        if (s < 0 || s > routeLength) continue;
        railJoints.push({
          s,
          value: {
            kind: 'insulated',
            strength: RAIL_JOINT_STRENGTH.insulated,
            reason: `turnout-${t.id}`,
          },
        });
      }
    }
    for (const b of bridges) {
      // 無道床橋は桁の伸縮がレールへ直に来るので、長さに依らず伸縮継目が要る。
      // 有道床橋は道床が滑って逃がすため、長い橋でだけ要る。
      const needed =
        b.deck === 'open' || bridgeLength(b) >= def.autoRailJoints.ballastedExpansionLength;
      if (!needed) continue;
      for (const s of [b.start, b.end]) {
        if (s < 0 || s > routeLength) continue;
        railJoints.push({
          s,
          value: {
            kind: 'expansion',
            strength: RAIL_JOINT_STRENGTH.expansion,
            reason: `bridge-${b.id}`,
          },
        });
      }
    }
  }

  // --- 速度制限 ---
  const spans: LimitSpan[] = [];
  const boundaries = segmentBoundaries(def.horizontal);
  if (def.autoTurnoutLimits.enabled) {
    for (const t of turnouts) {
      if (t.route !== 'diverging' || t.divergingSpeed >= lineSpeed) continue;
      spans.push({
        id: `turnout-${t.id}`,
        start: t.position,
        end: Math.min(routeLength, t.position + t.length),
        speed: t.divergingSpeed,
        reason: 'turnout',
      });
    }
  }
  if (def.autoCurveLimits.enabled) {
    const cdMax = mmToM(def.autoCurveLimits.maxCantDeficiency);
    for (let i = 0; i < def.horizontal.length; i++) {
      const seg = def.horizontal[i]!;
      if (seg.radius === undefined || seg.radius === null) continue;
      const cant = mmToM(seg.cant ?? 0);
      const raw = curveSpeedLimit(seg.radius, cant, gauge, cdMax);
      if (!Number.isFinite(raw)) continue;
      const speed = roundDownSpeed(raw, def.autoCurveLimits.roundDown);
      if (speed >= lineSpeed) continue;
      const start = boundaries[i]!;
      // 出口側の緩和曲線（次区間の先頭）も曲線の一部なので制限に含める
      const nextTransition = def.horizontal[i + 1]?.transition ?? 0;
      const end = Math.min(routeLength, boundaries[i + 1]! + nextTransition);
      spans.push({ id: `curve-${i}`, start, end, speed, reason: 'curve' });
    }
  }
  // 明示的な速度制限は「次の指定まで続く」階段として扱う
  const explicit = [...def.speedLimits].sort((a, b) => a.at - b.at);
  for (let i = 0; i < explicit.length; i++) {
    const e = explicit[i]!;
    const end = explicit[i + 1]?.at ?? routeLength;
    spans.push({
      id: e.id ?? `limit-${i}`,
      start: e.at,
      end,
      speed: kmhToMps(e.speed),
      reason: e.reason,
    });
  }
  const { table: speedLimits, entries: speedLimitEntries } = buildSpeedLimitTable(
    spans,
    routeLength,
    lineSpeed,
  );

  // --- 駅 ---
  const stations: Station[] = def.stations.map((s) => ({
    id: s.id,
    name: s.name,
    stopPosition: s.stopPosition,
    platformStart: s.platformStart ?? s.stopPosition - 220,
    platformEnd: s.platformEnd ?? s.stopPosition + 20,
    isPass: s.isPass,
    dwellTime: s.dwellTime,
    stopTolerance: s.stopTolerance,
    ...(s.arrivalTime === undefined ? {} : { arrivalTime: parseClock(s.arrivalTime) }),
    ...(s.departureTime === undefined ? {} : { departureTime: parseClock(s.departureTime) }),
  }));

  // --- 信号機と閉塞 ---
  const signals: SignalDefinition[] = [...def.signals]
    .sort((a, b) => a.at - b.at)
    .map((s) => ({ id: s.id, position: s.at, kind: s.kind, maxAspect: s.maxAspect }));
  const blocks: BlockSection[] = signals.map((sig, i) => ({
    id: `block-${sig.id}`,
    start: sig.position,
    end: signals[i + 1]?.position ?? routeLength,
    signalId: sig.id,
  }));

  // --- トンネル・保安装置区間 ---
  const tunnels = new SpanTable<TunnelSection>(
    def.tunnels.map((t, i) => ({
      start: t.start,
      end: t.end,
      value: { id: t.id ?? `tunnel-${i}`, start: t.start, end: t.end },
    })),
  );
  const safetySections = new SpanTable<SafetySystemKind>(
    def.safetySections.map((s) => ({ start: s.start, end: s.end, value: s.kind })),
  );
  const hasSections = def.safetySections.length > 0;
  const inSection = (s: number, kind: SafetySystemKind): boolean =>
    !hasSections || safetySections.at(s).some((sp) => sp.value === kind);

  // --- 地上子 ---
  const beacons: PointEntry<BeaconPayload>[] = def.beacons.map((b) => {
    switch (b.kind) {
      case 'ats-sn-long':
        return { s: b.at, value: { kind: 'ats-sn-long', signalId: b.signalId } };
      case 'ats-sn-immediate':
        return { s: b.at, value: { kind: 'ats-sn-immediate', signalId: b.signalId } };
      case 'ats-p-signal':
        return {
          s: b.at,
          value: { kind: 'ats-p-signal', signalId: b.signalId, distance: b.distance },
        };
      case 'ats-p-limit':
        return {
          s: b.at,
          value: {
            kind: 'ats-p-limit',
            limitId: b.limitId,
            distance: b.distance,
            speed: kmhToMps(b.speed),
          },
        };
      case 'ats-p-terminus':
        return { s: b.at, value: { kind: 'ats-p-terminus', distance: b.distance } };
    }
  });

  if (def.autoAtsP.enabled) {
    for (const sig of signals) {
      for (const d of def.autoAtsP.signalDistances) {
        const at = sig.position - d;
        if (at < 0 || !inSection(at, 'ats-p')) continue;
        beacons.push({
          s: at,
          value: { kind: 'ats-p-signal', signalId: sig.id, distance: d },
        });
      }
    }
    for (const entry of speedLimitEntries) {
      if (entry.speed >= lineSpeed) continue;
      for (const d of def.autoAtsP.limitDistances) {
        const at = entry.start - d;
        if (at < 0 || !inSection(at, 'ats-p')) continue;
        beacons.push({
          s: at,
          value: {
            kind: 'ats-p-limit',
            limitId: entry.id,
            distance: d,
            speed: entry.speed,
          },
        });
      }
    }
  }

  if (def.autoAtsSn.enabled) {
    for (const sig of signals) {
      const longAt = sig.position - def.autoAtsSn.longDistance;
      if (longAt >= 0 && inSection(longAt, 'ats-sn')) {
        beacons.push({ s: longAt, value: { kind: 'ats-sn-long', signalId: sig.id } });
      }
      const immediateAt = sig.position - 1;
      if (immediateAt >= 0 && inSection(immediateAt, 'ats-sn')) {
        beacons.push({
          s: immediateAt,
          value: { kind: 'ats-sn-immediate', signalId: sig.id },
        });
      }
    }
  }

  const aspectSpeeds: AspectSpeeds = {
    R: kmhToMps(def.aspectSpeeds.R),
    YY: kmhToMps(def.aspectSpeeds.YY),
    Y: kmhToMps(def.aspectSpeeds.Y),
    YG: kmhToMps(def.aspectSpeeds.YG),
    G: kmhToMps(def.aspectSpeeds.G),
  };

  const irr = def.trackIrregularity;
  const irregularity = new TrackIrregularity(
    irr.seed,
    {
      verticalAmplitude: mmToM(irr.verticalAmplitude),
      lateralAmplitude: mmToM(irr.lateralAmplitude),
      crossLevelAmplitude: mmToM(irr.crossLevelAmplitude),
      minWavelength: irr.minWavelength,
      maxWavelength: irr.maxWavelength,
      components: 9,
    },
    irr.level,
  );

  return {
    id: def.id,
    name: def.name,
    alignment,
    length: routeLength,
    maxSpeed: lineSpeed,
    stations,
    signals,
    blocks,
    speedLimits,
    speedLimitEntries,
    tunnels,
    beacons: new PointTable(beacons),
    safetySections,
    irregularity,
    turnouts: new TurnoutTrack(turnouts),
    bridges: new BridgeTrack(bridges),
    levelCrossings: new LevelCrossingTrack(levelCrossings),
    adjacentTrack: new AdjacentTrack(passingLoops),
    railJoints: new PointTable(railJoints),
    railJointSpacing: new StepTable(
      def.rail.sections.map((s) => ({ s: s.start, value: s.spacing })),
      def.rail.spacing,
    ),
    railCorrugation: new StepTable(
      def.rail.sections
        .filter((s) => s.corrugation !== undefined)
        .map((s) => ({ s: s.start, value: s.corrugation! })),
      def.rail.corrugation,
    ),
    maxCantDeficiency: mmToM(def.autoCurveLimits.maxCantDeficiency),
    aspectSpeeds,
  };
}
