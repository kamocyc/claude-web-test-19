import { formatClock, modulationLabel, mpsToKmh, paToKpa, type Simulation } from '@railsim/core';

const ASPECT_TEXT: Record<string, string> = {
  R: '停止',
  YY: '警戒',
  Y: '注意',
  YG: '減速',
  G: '進行',
};

/** 運転士が握っているハンドルの位置 */
export interface HandlePosition {
  readonly power: number;
  readonly brake: number;
  readonly emergency: boolean;
  readonly doorsClosed: boolean;
}

const notchText = (power: number, brake: number, emergency: boolean): string =>
  emergency ? '非常' : brake > 0 ? `B${brake}` : power > 0 ? `P${power}` : '切';

/** 自動運転装置の動作モードの表示名 */
const AUTO_MODE_TEXT: Record<string, string> = {
  standby: '停車中',
  power: '力行',
  coast: '惰行',
  regulate: '抑速',
  brake: '制限へ減速',
  stopping: '停止位置制御',
};

/** 画面左上の運転情報表示 */
export class Hud {
  constructor(private readonly element: HTMLElement) {}

  update(
    sim: Simulation,
    cameraLabel: string,
    rate: number,
    paused: boolean,
    handles: HandlePosition,
  ): void {
    const snap = sim.snapshot();
    const next = sim.nextStation;
    const rows: string[] = [];

    rows.push(
      `<div class="speed">${mpsToKmh(snap.speed).toFixed(1)} <span class="label">km/h</span></div>`,
    );
    rows.push(
      row(
        '制限 / パターン',
        [
          `${mpsToKmh(Math.min(snap.speedLimit, sim.scenario.route.maxSpeed)).toFixed(0)} km/h`,
          snap.safety.indication.patternSpeed === null
            ? '—'
            : `${mpsToKmh(snap.safety.indication.patternSpeed).toFixed(0)} km/h`,
        ].join(' / '),
      ),
    );
    rows.push(row('時刻', `${formatClock(snap.time)}（経過 ${snap.elapsed.toFixed(1)}s）`));
    // 自動運転中は、装置が「何を見て」「どれだけの減速度を出そうとしているか」を出す。
    // ノッチが動かないのが正常なので、動かない理由がここで読み取れる必要がある。
    const auto = snap.autoDrive;
    if (auto) {
      rows.push(
        row(
          '<span class="ok">自動運転</span>',
          `${AUTO_MODE_TEXT[auto.mode] ?? auto.mode} / 目標 ${mpsToKmh(auto.targetSpeed).toFixed(0)} km/h`,
        ),
      );
      const detail: string[] = [];
      if (auto.stopDistance !== null) detail.push(`停止まで ${auto.stopDistance.toFixed(0)} m`);
      if (auto.departureCountdown !== null) {
        detail.push(`発車まで ${auto.departureCountdown.toFixed(0)} s`);
      }
      if (auto.governing !== null) detail.push(auto.governing);
      if (detail.length > 0) rows.push(row('自動運転 対象', detail.join(' / ')));
      rows.push(
        row(
          '要求 / 指令 減速度',
          `${auto.requiredDeceleration.toFixed(2)} / ${auto.commandedDeceleration.toFixed(2)} m/s²` +
            `（勾配等 ${auto.externalDeceleration >= 0 ? '+' : ''}${auto.externalDeceleration.toFixed(2)}）`,
        ),
      );
      rows.push(
        row(
          'ノッチ操作 / 込め',
          `${auto.notchChanges} 回 / ${auto.brakeApplications} 回` +
            (auto.brakeGain < 0.98 || auto.brakeGain > 1.02
              ? `（効き ${(auto.brakeGain * 100).toFixed(0)}%）`
              : ''),
        ),
      );
    }
    rows.push(row('距離程', `${snap.front.toFixed(1)} m`));
    // ハンドル位置（運転士の操作）と実効ノッチ（保安装置・戸閉め条件を通したあと）は
    // 一致しないことがある。取り違えると「ノッチが効かない」と見えるので両方出す。
    const handleLabel = snap.autoDrive ? 'ノッチ（自動）' : 'ノッチ（手元）';
    const handle = notchText(handles.power, handles.brake, handles.emergency);
    const effective = notchText(snap.powerNotch, snap.brakeNotch, snap.emergency);
    const cutOff = handles.power > 0 && snap.powerNotch === 0;
    rows.push(
      row(
        handleLabel,
        handles.emergency
          ? '<span class="danger">非常</span>'
          : handle + (handles.doorsClosed ? '' : ' <span class="warn">戸開</span>'),
      ),
    );
    rows.push(
      row(
        'ノッチ（実効）',
        snap.emergency || snap.safety.emergencyBrake
          ? '<span class="danger">非常</span>'
          : effective + (cutOff ? ' <span class="warn">力行カット</span>' : ''),
      ),
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
    // 元空気溜め圧とコンプレッサ。運転操作と無関係な周期で回り出すので、
    // 音が鳴り始めた理由がここで読み取れる。
    rows.push(
      row(
        'MR 圧 / CP',
        `${paToKpa(snap.compressor.pressure).toFixed(0)} kPa / ` +
          (snap.compressor.running ? '<span class="warn">運転</span>' : '停止'),
      ),
    );
    rows.push(row('主回路電流', `${snap.motorCurrent.toFixed(0)} A`));
    // インバータの変調。音がこの数値どおりに鳴っているかを耳と目で突き合わせられる。
    const inv = snap.inverter;
    rows.push(row('変調', modulationLabel(inv)));
    rows.push(
      row(
        '出力 / すべり',
        inv.mode === 'off'
          ? `— / — （${inv.motorRpm.toFixed(0)} rpm）`
          : `${inv.fundamentalFrequency.toFixed(1)} / ${inv.slipFrequency.toFixed(2)} Hz` +
              `（${inv.motorRpm.toFixed(0)} rpm）`,
      ),
    );
    rows.push(
      row('勾配 / 曲率', `${(snap.grade * 1000).toFixed(1)} ‰ / ${radius(snap.curvature)}`),
    );
    // カントは曲線の要。実カントと、その速度で不足しているか超過しているかを併記する。
    const cantMm = snap.cant * 1000;
    const cdMm = snap.cantDeficiency * 1000;
    rows.push(
      row(
        'カント / 過不足',
        Math.abs(cantMm) < 0.5
          ? '—'
          : `${Math.abs(cantMm).toFixed(0)} mm ${cantMm > 0 ? '右上がり' : '左上がり'}` +
              ` / ${Math.abs(cdMm).toFixed(0)} mm ${cdMm >= 0 ? '不足' : '超過'}`,
      ),
    );
    rows.push(
      row(
        '体感 前後 / 左右',
        `${snap.body.feltLongitudinal.toFixed(2)} / ${snap.body.feltLateral.toFixed(2)} m/s²`,
      ),
    );
    // ロールは「軌道の傾き（カント）」と「車体がその上でさらに傾くぶん」に分けて出す。
    // 合算値だけだとカントが効いているのか車体が揺れているのか区別できない。
    rows.push(
      row(
        'ロール 軌道 + 車体',
        `${deg(snap.body.trackRoll)}° + ${deg(snap.body.roll)}° = ${deg(snap.body.absoluteRoll)}°`,
      ),
    );
    rows.push(
      row(
        'ピッチ 勾配 + 車体',
        `${deg(snap.body.trackPitch)}° + ${deg(snap.body.pitch)}° = ${deg(snap.body.absolutePitch)}°`,
      ),
    );
    // 吊り革は比力に遅れて追従するので、瞬時の平衡角との差がジャークの効き具合になる
    const sway = snap.body.passenger.strap;
    rows.push(
      row(
        '吊り革の振れ 前後 / 左右',
        `${deg(sway.longitudinal)}° / ${deg(sway.lateral)}°` +
          `（遅れ ${deg(sway.equilibriumLongitudinal - sway.longitudinal)}° / ${deg(sway.equilibriumLateral - sway.lateral)}°）`,
      ),
    );
    // 立っている乗客は押される向きと逆へよりかかる（正 = 前／右へ傾く）。
    // 目標の姿勢に追いつけないぶん（ずれ）がよろけになる。
    const stance = snap.body.passenger.stance;
    rows.push(
      row(
        '乗客の姿勢 前後 / 左右',
        `${deg(stance.longitudinal.target)}° / ${deg(stance.lateral.target)}° へよりかかり` +
          `（ずれ ${deg(stance.longitudinal.error)}° / ${deg(stance.lateral.error)}°）`,
      ),
    );
    rows.push(
      row(
        'よろけ / 踏み出し',
        `${(stance.stagger * 100).toFixed(0)} % / ${stance.steps} 回` +
          (stance.stagger > 1 ? ' <span class="danger">よろけ</span>' : ''),
      ),
    );

    // 分岐器。開通方向と、分岐側なら制限速度を手前から出す。
    const turnout = snap.nextTurnout;
    if (turnout && turnout.distance < 1500) {
      const t = turnout.turnout;
      const diverging = t.route === 'diverging';
      const where = turnout.distance > 0 ? `${turnout.distance.toFixed(0)} m` : '通過中';
      rows.push(
        row(
          '次の分岐器',
          `#${t.number} ${t.side === 'right' ? '右' : '左'}分岐 ` +
            (diverging
              ? `<span class="warn">分岐側 ${mpsToKmh(t.divergingSpeed).toFixed(0)} km/h</span>`
              : '<span class="ok">直進</span>') +
            ` ${where}`,
        ),
      );
    }

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
    if (snap.safety.indication.patternApproach)
      flags.push('<span class="warn">パターン接近</span>');
    if (snap.safety.emergencyBrake) flags.push('<span class="danger">保安非常</span>');
    if (snap.safety.serviceBrakeNotch !== null) flags.push('<span class="warn">保安常用</span>');
    // 許容カント不足を超えると乗り心地が悪化し、転覆・脱線に対する余裕も減る
    if (snap.cantDeficiency > sim.scenario.route.maxCantDeficiency) {
      flags.push('<span class="warn">カント不足超過</span>');
    }
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
            (last.delay === null
              ? ''
              : ` / ${last.delay >= 0 ? '+' : ''}${last.delay.toFixed(0)}s`),
        ),
      );
    }

    rows.push(
      row(
        '表示',
        `${cameraLabel} / ${rate.toFixed(2)}x${paused ? ' <span class="warn">停止中</span>' : ''}`,
      ),
    );

    this.element.innerHTML = rows.join('');
  }
}

/** ラジアンを度の文字列に（符号を保つ） */
const deg = (rad: number): string => ((rad * 180) / Math.PI).toFixed(2);

const row = (label: string, value: string): string =>
  `<div class="row"><span class="label">${label}</span><span>${value}</span></div>`;

const radius = (curvature: number): string => {
  if (Math.abs(curvature) < 1e-6) return '直線';
  const r = 1 / Math.abs(curvature);
  return `R${r.toFixed(0)} ${curvature > 0 ? '左' : '右'}`;
};
