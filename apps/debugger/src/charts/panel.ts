import { mpsToKmh, paToKpa, type Simulation } from '@railsim/core';
import { StripChart } from './strip.ts';

/**
 * 検証用のグラフ一式。
 *
 * 「速度がどう変化したか」だけでなく、その速度を作っている力の内訳
 * （引張力・ブレーキ力・勾配・曲線・走行抵抗）と、装置の内部状態
 * （BC 圧・電空の分担・すべり率・連結器力）を同じ時間軸に並べる。
 */
export class ChartPanel {
  private readonly charts: StripChart[] = [];

  constructor(container: HTMLElement) {
    const add = (chart: StripChart) => {
      container.append(chart.element);
      this.charts.push(chart);
      return chart;
    };

    this.speed = add(
      new StripChart({
        title: '速度',
        unit: '',
        series: [
          { key: 'speed', label: '速度', color: '#4ea3ff' },
          { key: 'limit', label: '制限', color: '#ff9f43', dashed: true },
          { key: 'pattern', label: 'パターン', color: '#ff6b6b', dashed: true },
        ],
        min: 0,
      }),
    );
    this.notch = add(
      new StripChart({
        title: 'ノッチ',
        series: [
          { key: 'power', label: '力行', color: '#7ddc8a' },
          { key: 'brake', label: 'ブレーキ', color: '#ff9f43' },
        ],
        min: -9,
        max: 5,
        zeroLine: true,
      }),
    );
    this.effort = add(
      new StripChart({
        title: '引張力・ブレーキ力 [kN]',
        series: [
          { key: 'tractive', label: '引張力', color: '#7ddc8a' },
          { key: 'electric', label: '電気B', color: '#4ea3ff' },
          { key: 'air', label: '空気B', color: '#ff9f43' },
        ],
        zeroLine: true,
      }),
    );
    this.resistance = add(
      new StripChart({
        title: '抵抗の内訳 [kN]',
        series: [
          { key: 'grade', label: '勾配', color: '#c792ea' },
          { key: 'curve', label: '曲線', color: '#ffd23f' },
          { key: 'running', label: '走行', color: '#89a4c7' },
        ],
        zeroLine: true,
      }),
    );
    this.pressure = add(
      new StripChart({
        title: 'ブレーキシリンダ圧 [kPa]',
        series: [{ key: 'bc', label: 'BC 圧', color: '#ff9f43' }],
        min: 0,
      }),
    );
    this.adhesion = add(
      new StripChart({
        title: 'すべり率 [%] と再粘着制御',
        series: [
          { key: 'slip', label: 'すべり率', color: '#ff6b6b' },
          { key: 'readhesion', label: '絞り込み', color: '#7ddc8a' },
        ],
        zeroLine: true,
      }),
    );
    this.ride = add(
      new StripChart({
        title: '体感加速度 [m/s²]・ロール [deg]・カント不足 [cm]',
        series: [
          { key: 'feltLong', label: '前後', color: '#4ea3ff' },
          { key: 'feltLat', label: '左右', color: '#ffd23f' },
          { key: 'trackRoll', label: '軌道ロール', color: '#7ddc8a' },
          { key: 'roll', label: '車体ロール', color: '#c792ea' },
          { key: 'cantDef', label: 'カント不足', color: '#ff9e64' },
        ],
        zeroLine: true,
      }),
    );
    // 乗客の振れは比力に遅れて追従する。平衡角との差がそのままジャークの効き具合。
    this.sway = add(
      new StripChart({
        title: '乗客の振れ [deg]（実線 = 振り子 / 破線 = 瞬時の平衡角）',
        series: [
          { key: 'swayLong', label: '前後', color: '#4ea3ff' },
          { key: 'eqLong', label: '前後 平衡', color: '#2c5e8f' },
          { key: 'swayLat', label: '左右', color: '#ffd23f' },
          { key: 'eqLat', label: '左右 平衡', color: '#8a7526' },
        ],
        zeroLine: true,
      }),
    );
    this.coupler = add(
      new StripChart({
        title: '連結器力 [kN] と車体の揺れ [mm]',
        series: [
          { key: 'coupler', label: '連結器', color: '#c792ea' },
          { key: 'bounce', label: '上下', color: '#7ddc8a' },
          { key: 'sway', label: '左右変位', color: '#ff9f43' },
        ],
        zeroLine: true,
      }),
    );
  }

  private readonly speed: StripChart;
  private readonly notch: StripChart;
  private readonly effort: StripChart;
  private readonly resistance: StripChart;
  private readonly pressure: StripChart;
  private readonly adhesion: StripChart;
  private readonly ride: StripChart;
  private readonly sway: StripChart;
  private readonly coupler: StripChart;

  sample(sim: Simulation): void {
    const snap = sim.snapshot();
    const t = snap.elapsed;

    this.speed.push(t, {
      speed: mpsToKmh(snap.speed),
      limit: mpsToKmh(Math.min(snap.speedLimit, sim.scenario.route.maxSpeed)),
      pattern:
        snap.safety.indication.patternSpeed === null
          ? Number.NaN
          : mpsToKmh(snap.safety.indication.patternSpeed),
    });
    this.notch.push(t, { power: snap.powerNotch, brake: -snap.brakeNotch });
    this.effort.push(t, {
      tractive: Math.max(0, snap.tractiveEffort) / 1000,
      electric: -snap.electricBrakeForce / 1000,
      air: -snap.airBrakeForce / 1000,
    });

    let grade = 0;
    let curve = 0;
    let running = 0;
    for (const veh of sim.dynamics.vehicles) {
      grade += veh.gradeForce;
      curve += veh.curveResistanceForce;
      running += veh.runningResistanceForce;
    }
    this.resistance.push(t, {
      grade: grade / 1000,
      curve: curve / 1000,
      running: running / 1000,
    });

    this.pressure.push(t, { bc: paToKpa(snap.cylinderPressure) });
    this.adhesion.push(t, {
      slip: snap.maxSlip * 100,
      readhesion: snap.reAdhesionFactor * 10,
    });
    this.ride.push(t, {
      feltLong: snap.body.feltLongitudinal,
      feltLat: snap.body.feltLateral,
      trackRoll: (snap.body.trackRoll * 180) / Math.PI,
      roll: (snap.body.roll * 180) / Math.PI,
      // 他の系列と桁を揃えるため cm 表示（60mm = 6）
      cantDef: snap.cantDeficiency * 100,
    });
    const deg = (rad: number) => (rad * 180) / Math.PI;
    this.sway.push(t, {
      swayLong: deg(snap.body.sway.longitudinal),
      eqLong: deg(snap.body.sway.equilibriumLongitudinal),
      swayLat: deg(snap.body.sway.lateral),
      eqLat: deg(snap.body.sway.equilibriumLateral),
    });
    this.coupler.push(t, {
      coupler: snap.maxCouplerForce / 1000,
      bounce: snap.body.vertical * 1000,
      sway: snap.body.lateral * 1000,
    });
  }

  draw(): void {
    for (const c of this.charts) c.draw();
  }

  clear(): void {
    for (const c of this.charts) c.clear();
  }
}
