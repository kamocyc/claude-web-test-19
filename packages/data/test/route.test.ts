import { describe, expect, it } from 'vitest';
import { mpsToKmh, mToMm } from '@railsim/core';
import {
  commuter4Vehicle,
  compileRoute,
  compileVehicle,
  createDefaultLibrary,
  testLineLoopRoute,
  testLineRoute,
} from '@railsim/data';

describe('路線のコンパイル', () => {
  const route = compileRoute(testLineRoute);

  it('平面線形と縦断線形の全長が一致し、軌道が組み立てられる', () => {
    expect(route.length).toBe(8000);
    expect(route.alignment.length).toBe(8000);
  });

  it('曲線の位置と半径が定義どおりになる', () => {
    // 1500m から R600 左曲線（緩和曲線 80m）
    expect(route.alignment.radiusAt(1400)).toBe(Infinity);
    expect(route.alignment.radiusAt(1600)).toBeCloseTo(600, 6);
    expect(route.alignment.curvatureAt(1600)).toBeGreaterThan(0);
    // 4200m から R400 右曲線
    expect(route.alignment.radiusAt(4500)).toBeCloseTo(400, 6);
    expect(route.alignment.curvatureAt(4500)).toBeLessThan(0);
  });

  it('カントが曲線区間に付き、向きが曲線に従う', () => {
    expect(mToMm(route.alignment.cantAt(1600))).toBeCloseTo(75, 6);
    expect(mToMm(route.alignment.cantAt(4500))).toBeCloseTo(-90, 6);
    expect(route.alignment.cantAt(1000)).toBeCloseTo(0, 9);
  });

  it('勾配が縦断線形どおりになる', () => {
    expect(route.alignment.gradeAt(1000)).toBeCloseTo(0, 9);
    expect(route.alignment.gradeAt(2600)).toBeCloseTo(0.025, 9);
    expect(route.alignment.gradeAt(5300)).toBeCloseTo(-0.033, 9);
    expect(route.alignment.gradeAt(7500)).toBeCloseTo(0, 9);
  });

  it('曲線の制限速度が許容カント不足から自動生成される', () => {
    // R600 / カント 75mm / 許容カント不足 60mm
    //   v = sqrt((0.075 + 0.060) * 9.80665 * 600 / 1.067) = 27.28 m/s = 98.2 km/h → 95km/h
    expect(mpsToKmh(route.speedLimits.at(1600))).toBeCloseTo(95, 6);
    // R400 / カント 90mm → 84.5 km/h → 80km/h
    expect(mpsToKmh(route.speedLimits.at(4500))).toBeCloseTo(80, 6);
    // 直線区間は線路最高速度
    expect(mpsToKmh(route.speedLimits.at(1000))).toBeCloseTo(110, 6);
    expect(mpsToKmh(route.speedLimits.at(7000))).toBeCloseTo(110, 6);
  });

  it('制限区間は出口側の緩和曲線まで続く', () => {
    // R600 曲線は 1500〜2300、出口緩和曲線は 2300〜2380
    expect(mpsToKmh(route.speedLimits.at(2350))).toBeCloseTo(95, 6);
    expect(mpsToKmh(route.speedLimits.at(2450))).toBeCloseTo(110, 6);
  });

  it('トンネル区間が判定できる', () => {
    expect(route.tunnels.at(5000).length).toBe(1);
    expect(route.tunnels.at(4000).length).toBe(0);
  });

  it('信号機から閉塞区間が導かれる', () => {
    expect(route.signals).toHaveLength(8);
    expect(route.blocks[0]!.start).toBe(200);
    expect(route.blocks[0]!.end).toBe(1200);
    expect(route.blocks[7]!.start).toBe(7100);
    expect(route.blocks[7]!.end).toBe(8000);
  });

  it('ATS-P の地上子が信号機の手前に自動配置される', () => {
    const near = route.beacons
      .inRange(500, 1200)
      .map((e) => e.value)
      .filter((v) => v.kind === 'ats-p-signal');
    expect(near.length).toBeGreaterThanOrEqual(5);
    const first = route.beacons
      .inRange(590, 610)
      .find((e) => e.value.kind === 'ats-p-signal' && e.value.signalId === 'sig-2');
    expect(first).toBeDefined();
    expect(first!.s).toBe(600);
    if (first!.value.kind === 'ats-p-signal') {
      expect(first!.value.distance).toBe(600);
      // 地上子位置 + 距離 = 信号機位置
      expect(first!.s + first!.value.distance).toBe(1200);
    }
  });

  it('ATS-P の速度制限地上子が制限始端の手前に置かれる', () => {
    const limitBeacons = route.beacons
      .inRange(900, 1500)
      .filter((e) => e.value.kind === 'ats-p-limit');
    expect(limitBeacons.length).toBeGreaterThan(0);
    const b = limitBeacons[0]!;
    if (b.value.kind === 'ats-p-limit') {
      expect(b.s + b.value.distance).toBe(1500);
      expect(mpsToKmh(b.value.speed)).toBeCloseTo(95, 6);
    }
  });

  it('ATS-SN の地上子（ロング・直下）が配置される', () => {
    const long = route.beacons.inRange(595, 605).find((e) => e.value.kind === 'ats-sn-long');
    expect(long).toBeDefined();
    const immediate = route.beacons
      .inRange(1198, 1200)
      .find((e) => e.value.kind === 'ats-sn-immediate');
    expect(immediate).toBeDefined();
  });

  it('駅の時刻が秒に変換される', () => {
    const stnB = route.stations.find((s) => s.id === 'stn-b')!;
    expect(stnB.arrivalTime).toBe(10 * 3600 + 3 * 60 + 20);
    expect(stnB.departureTime).toBe(10 * 3600 + 3 * 60 + 50);
  });
});

describe('車両のコンパイル', () => {
  const consist = compileVehicle(commuter4Vehicle);

  it('質量と長さが SI に変換される', () => {
    expect(consist.vehicles).toHaveLength(4);
    expect(consist.vehicles[0]!.tareMass).toBe(25_000);
    expect(consist.vehicles[1]!.tareMass).toBe(32_000);
    expect(consist.vehicles[0]!.length).toBe(20);
  });

  it('減速度が km/h/s から m/s^2 に変換される', () => {
    expect(consist.brake.maxServiceDeceleration).toBeCloseTo(3.5 / 3.6, 9);
    expect(consist.brake.emergencyDeceleration).toBeCloseTo(4.5 / 3.6, 9);
  });

  it('走行抵抗が kgf/t から N/kg に変換される', () => {
    // 1.65 kgf/t = 1.65 * 9.80665 / 1000 N/kg
    expect(consist.vehicles[0]!.runningResistance.a).toBeCloseTo((1.65 * 9.80665) / 1000, 12);
  });

  it('付随車には動力装置が無い', () => {
    expect(consist.vehicles[0]!.traction).toBeNull();
    expect(consist.vehicles[1]!.traction).not.toBeNull();
    expect(consist.vehicles[1]!.drivenAxleCount).toBe(4);
  });
});

describe('分岐器のコンパイル', () => {
  const main = compileRoute(testLineRoute);
  const loop = compileRoute(testLineLoopRoute);
  /** 起点駅（交換可能駅）の出口の背向分岐器 */
  const exitMain = main.turnouts.get('to-2')!;
  const exitLoop = loop.turnouts.get('to-2')!;
  /** 6300m の側線への分岐器（対向・本線側へ開通） */
  const siding = main.turnouts.get('to-3')!;

  it('番数から寸法が決まる', () => {
    // 交換設備の 2 基（対向・背向）と、側線への 1 基
    expect(main.turnouts.length).toBe(3);
    expect(siding.number).toBe(12);
    expect(siding.radius).toBeCloseTo(350, 6);
    // リード長 = R α、全長はその 1.4 倍
    expect(siding.leadLength).toBeCloseTo(350 * Math.atan(1 / 12), 9);
    expect(siding.crossingPosition - siding.pointsPosition).toBeCloseTo(siding.leadLength, 9);
    expect(siding.length).toBeCloseTo(siding.leadLength * 1.4, 9);
  });

  /** 背向はクロッシング側から進入するので、トングレールとの前後関係が逆になる */
  it('背向分岐器はクロッシングから入ってトングレールで出る', () => {
    expect(exitLoop.orientation).toBe('trailing');
    expect(exitLoop.crossingPosition).toBe(exitLoop.position);
    expect(exitLoop.pointsPosition - exitLoop.crossingPosition).toBeCloseTo(exitLoop.leadLength, 9);
  });

  /** 同じ分岐器が、1 番線のデータでは直進側、2 番線のデータでは分岐側に開通している */
  it('1 番線と 2 番線で開通方向だけが違う', () => {
    expect(exitMain.route).toBe('through');
    expect(exitLoop.route).toBe('diverging');
    expect(exitLoop.position).toBe(exitMain.position);
    expect(exitLoop.length).toBeCloseTo(exitMain.length, 9);
  });

  it('分岐側にだけ制限速度が付く（#12 → 45km/h）', () => {
    // 1 番線は本線と同じ速度で通過できる
    expect(mpsToKmh(main.speedLimits.at(exitMain.position + 10))).toBeCloseTo(110, 6);
    expect(mpsToKmh(exitLoop.divergingSpeed)).toBeCloseTo(45, 6);
    expect(mpsToKmh(loop.speedLimits.at(exitLoop.position + 10))).toBeCloseTo(45, 6);
    // 分岐器を抜ければ制限は解ける
    expect(mpsToKmh(loop.speedLimits.at(exitLoop.position + exitLoop.length + 10))).toBeCloseTo(
      110,
      6,
    );
    const entry = loop.speedLimitEntries.find((e) => e.id === `turnout-${exitLoop.id}`);
    expect(entry?.start).toBeCloseTo(exitLoop.position, 6);
  });

  /** 分岐制限は速度制限の 1 つなので、ATS-P の地上子も自動で置かれる */
  it('分岐制限に ATS-P の地上子が置かれる', () => {
    const beacons = loop.beacons.all.filter(
      (b) => b.value.kind === 'ats-p-limit' && b.value.limitId === `turnout-${exitLoop.id}`,
    );
    // 500m 手前は起点より前になるので置けない
    expect(beacons.map((b) => Math.round(exitLoop.position - b.s)).sort((a, b) => a - b)).toEqual([
      50, 150, 300,
    ]);
  });

  /**
   * リード曲線には**緩和曲線もカントも無い**。曲率が一段で立ち上がるのが、
   * 分岐側を渡るときに横 G が階段状に来る理由そのものである。
   */
  it('リード曲線は緩和曲線もカントも持たない', () => {
    const entry = loop.turnouts.get('to-1')!;
    const s = entry.position + 1;
    expect(loop.alignment.radiusAt(s)).toBeCloseTo(350, 3);
    expect(loop.alignment.curvatureAt(s)).toBeLessThan(0); // 右へ曲がる
    expect(loop.alignment.cantAt(s)).toBe(0);
    // 分岐器の直前は直線のまま
    expect(loop.alignment.radiusAt(entry.position - 1)).toBe(Infinity);
    // リード曲線を抜けると、ちょうどクロッシング角ぶん向きが変わっている
    const turned =
      loop.alignment.headingAt(entry.position) - loop.alignment.headingAt(entry.crossingPosition);
    expect(turned).toBeCloseTo(entry.crossingAngle, 6);
  });

  /**
   * 交換可能駅なので、2 番線は本線と平行に離れてまた戻る。線路中心間隔は
   * リード曲線と戻し曲線の組で決まり、`2R(1 − cos α) + 護輪軌条部 sin α` になる。
   */
  it('2 番線は本線から 3.38m 離れて平行に走り、出口で本線へ戻る', () => {
    const offsetAt = (s: number): number => {
      const a = main.alignment.positionAt(s);
      const b = loop.alignment.positionAt(s);
      return Math.hypot(a.x - b.x, a.z - b.z);
    };
    const spacing =
      2 * 350 * (1 - Math.cos(Math.atan(1 / 12))) +
      350 * Math.atan(1 / 12) * 0.4 * Math.sin(Math.atan(1 / 12));
    expect(spacing).toBeCloseTo(3.38, 2);
    // ホーム（180〜320m）では本線と平行に離れている
    expect(offsetAt(250)).toBeCloseTo(spacing, 2);
    expect(loop.alignment.radiusAt(250)).toBe(Infinity);
    expect(loop.alignment.headingAt(250)).toBeCloseTo(main.alignment.headingAt(250), 9);
    // 出口を抜ければ本線に戻っていて、以降は同じ線形
    expect(offsetAt(600)).toBeLessThan(0.3);
    expect(loop.alignment.headingAt(600)).toBeCloseTo(main.alignment.headingAt(600), 9);
    expect(loop.alignment.radiusAt(4500)).toBeCloseTo(main.alignment.radiusAt(4500), 6);
  });

  /** 行き先も距離程も変わらないので、駅も信号機もそのまま使える */
  it('2 番線を通っても駅と信号機は 1 番線と同じ', () => {
    expect(loop.length).toBe(main.length);
    expect(loop.stations.map((s) => `${s.id}@${s.stopPosition}`)).toEqual(
      main.stations.map((s) => `${s.id}@${s.stopPosition}`),
    );
    expect(loop.signals.map((s) => `${s.id}@${s.position}`)).toEqual(
      main.signals.map((s) => `${s.id}@${s.position}`),
    );
  });
});

describe('データライブラリ', () => {
  it('同梱シナリオをコンパイルできる', () => {
    const lib = createDefaultLibrary();
    expect(lib.scenarioIds).toContain('test-line-local');
    const scenario = lib.scenario('test-line-local');
    expect(scenario.route.id).toBe('test-line');
    expect(scenario.consist.id).toBe('commuter-4');
    expect(scenario.startTime).toBe(10 * 3600);
  });

  it('路線のコンパイル結果がキャッシュされる', () => {
    const lib = createDefaultLibrary();
    expect(lib.route('test-line')).toBe(lib.route('test-line'));
  });
});
