import { formatClock, mpsToKmh, paToKpa, type Simulation } from '@railsim/core';

const ASPECT_TEXT: Record<string, string> = {
  R: '停止',
  YY: '警戒',
  Y: '注意',
  YG: '減速',
  G: '進行',
};

/** 画面左上の運転情報表示 */
export class Hud {
  constructor(private readonly element: HTMLElement) {}

  update(sim: Simulation, cameraLabel: string, rate: number, paused: boolean): void {
    const snap = sim.snapshot();
    const next = sim.nextStation;
    const rows: string[] = [];

    rows.push(
      `<div class="speed">${mpsToKmh(snap.speed).toFixed(1)} <span class="label">km/h</span></div>`,
    );
    rows.push(
      row('制限 / パターン', [
        `${mpsToKmh(Math.min(snap.speedLimit, sim.scenario.route.maxSpeed)).toFixed(0)} km/h`,
        snap.safety.indication.patternSpeed === null
          ? '—'
          : `${mpsToKmh(snap.safety.indication.patternSpeed).toFixed(0)} km/h`,
      ].join(' / ')),
    );
    rows.push(row('時刻', `${formatClock(snap.time)}（経過 ${snap.elapsed.toFixed(1)}s）`));
    rows.push(row('距離程', `${snap.front.toFixed(1)} m`));
    rows.push(
      row('ノッチ', snap.emergency ? '<span class="danger">非常</span>' : snap.brakeNotch > 0 ? `B${snap.brakeNotch}` : snap.powerNotch > 0 ? `P${snap.powerNotch}` : '切'),
    );
    rows.push(row('加速度', `${snap.acceleration.toFixed(3)} m/s²`));
    rows.push(row('引張力', `${(snap.tractiveEffort / 1000).toFixed(1)} kN`));
    rows.push(
      row(
        '電気B / 空気B',
        `${(snap.electricBrakeForce / 1000).toFixed(0)} / ${(snap.airBrakeForce / 1000).toFixed(0)} kN`,
      ),
    );
    rows.push(row('BC 圧', `${paToKpa(snap.cylinderPressure).toFixed(0)} kPa`));
    rows.push(row('主回路電流', `${snap.motorCurrent.toFixed(0)} A`));
    rows.push(row('勾配 / 曲率', `${(snap.grade * 1000).toFixed(1)} ‰ / ${radius(snap.curvature)}`));
    rows.push(row('左右加速度', `${snap.lateralAcceleration.toFixed(3)} m/s²`));

    if (snap.nextSignal) {
      const aspect = snap.nextSignal.state.aspect;
      const cls = aspect === 'R' ? 'danger' : aspect === 'G' ? 'ok' : 'warn';
      rows.push(
        row(
          '次の信号',
          `<span class="${cls}">${ASPECT_TEXT[aspect] ?? aspect}</span> ${snap.nextSignal.distance.toFixed(0)} m`,
        ),
      );
    }
    if (next) {
      rows.push(
        row(
          '次の駅',
          `${next.station.name} ${snap.distanceToStop === null ? '' : `${snap.distanceToStop.toFixed(0)} m`}`,
        ),
      );
    }

    const flags: string[] = [];
    if (snap.safety.indication.bell) flags.push('<span class="warn">警報</span>');
    if (snap.safety.indication.chime) flags.push('<span class="ok">確認</span>');
    if (snap.safety.indication.patternApproach) flags.push('<span class="warn">パターン接近</span>');
    if (snap.safety.emergencyBrake) flags.push('<span class="danger">保安非常</span>');
    if (snap.safety.serviceBrakeNotch !== null) flags.push('<span class="warn">保安常用</span>');
    if (snap.regenerationLost) flags.push('<span class="warn">回生失効</span>');
    if (snap.antiSkidActive) flags.push('<span class="warn">滑走防止</span>');
    if (snap.reAdhesionFactor < 0.999) flags.push('<span class="warn">空転</span>');
    if (flags.length > 0) rows.push(row('状態', flags.join(' ')));

    const stops = sim.metrics.stops;
    const last = stops[stops.length - 1];
    if (last) {
      rows.push(
        row(
          '直近の停止',
          `${last.stationName} 誤差 ${last.stopError >= 0 ? '+' : ''}${last.stopError.toFixed(2)} m` +
            (last.delay === null ? '' : ` / ${last.delay >= 0 ? '+' : ''}${last.delay.toFixed(0)}s`),
        ),
      );
    }

    rows.push(
      row('表示', `${cameraLabel} / ${rate.toFixed(2)}x${paused ? ' <span class="warn">停止中</span>' : ''}`),
    );

    this.element.innerHTML = rows.join('');
  }
}

const row = (label: string, value: string): string =>
  `<div class="row"><span class="label">${label}</span><span>${value}</span></div>`;

const radius = (curvature: number): string => {
  if (Math.abs(curvature) < 1e-6) return '直線';
  const r = 1 / Math.abs(curvature);
  return `R${r.toFixed(0)} ${curvature > 0 ? '左' : '右'}`;
};
