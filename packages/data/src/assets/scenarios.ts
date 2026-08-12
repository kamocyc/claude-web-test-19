import type { ScenarioDefinition } from '../schema/scenario.ts';

/** 標準シナリオ: 試験線を起点駅から終点駅まで運転する */
export const testLineLocal: ScenarioDefinition = {
  id: 'test-line-local',
  name: '試験線 各駅停車（晴天）',
  routeId: 'test-line',
  vehicleId: 'commuter-4',
  startTime: '10:00:00',
  startPosition: 300,
  startSpeed: 0,
  loadFactor: 0.5,
  railCondition: 'dry',
  regenerationReceptivity: 1,
  seed: 20240101,
  safetySystems: ['ats-p'],
  hasVigilance: true,
};

/** 悪天候シナリオ: 降雪で粘着が落ち、空転・滑走が起きやすい */
export const testLineSnow: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-snow',
  name: '試験線 各駅停車（降雪）',
  railCondition: 'snow',
  regenerationReceptivity: 0.5,
};

/**
 * 先行列車シナリオ: 前を走る列車に追いつき、信号現示が段階的に変化する。
 * 先行列車は 10:00:00 に 1000m 地点から発車し、ゆっくり終点へ向かう。
 */
export const testLineFollowing: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-following',
  name: '試験線 先行列車あり',
  scheduledTrains: [
    {
      id: 'preceding',
      length: 80,
      waypoints: [
        { time: '9:59:00', position: 1000 },
        { time: '10:02:00', position: 2400 },
        { time: '10:06:00', position: 4400 },
        { time: '10:12:00', position: 8000 },
      ],
    },
  ],
};

/** ATS-SN シナリオ: 確認扱いを要する旧型の保安装置で運転する */
export const testLineAtsSn: ScenarioDefinition = {
  ...testLineFollowing,
  id: 'test-line-ats-sn',
  name: '試験線 ATS-SN 区間',
  safetySystems: ['ats-sn'],
};

/**
 * 分岐器（直進）シナリオ: 中原から発車し、6300m の #12 分岐器を直進側で通過する。
 *
 * 直進側に制限速度は無いので、110km/h のままクロッシングの欠線を踏める。
 * 「ガタン」が 1 両あたり 2 拍ずつ、編成のぶんだけ続く。
 */
export const testLineTurnoutThrough: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-turnout',
  name: '試験線 分岐器（直進）',
  startTime: '10:03:50',
  startPosition: 3500,
};

/**
 * 分岐器（分岐側）シナリオ: 同じ分岐器を分岐側へ渡り、分岐線の終端へ向かう。
 *
 * リード曲線（R350・緩和曲線もカントも無し）に 45km/h の制限が付くので、
 * 手前で速度を落として渡ることになる。落とし切れずに突っ込めば、横 G が階段状に
 * 立ち上がって立っている乗客はよろける。
 */
export const testLineTurnoutDiverging: ScenarioDefinition = {
  ...testLineTurnoutThrough,
  id: 'test-line-turnout-diverging',
  name: '試験線 分岐器（分岐側へ）',
  routeId: 'test-line-branch',
};

/**
 * 抵抗制御シナリオ: 同じ路線を旧型の抵抗制御車で運転する。
 *
 * ノッチを入れるとカム軸が自動で刻んでいくので、進段のたびに引張力が鋸歯状に
 * 上下し、直並列の渡りでは一瞬トルクが抜ける。応荷重制御も無いので、VVVF 車の
 * 平坦な加速とは体感がはっきり違う。
 */
export const testLineResistor: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-resistor',
  name: '試験線 各駅停車（抵抗制御）',
  vehicleId: 'commuter-4-resistor',
  safetySystems: ['ats-sn'],
};

/**
 * 抵抗制御・降雪シナリオ: 架線の回生受け入れ率が落ちても**発電ブレーキは効く**。
 *
 * 抵抗器へ捨てているので架線の都合と無関係だからで、同じ条件の VVVF 車
 * （`test-line-snow`）と乗り比べると、この方式の数少ない長所がそのまま出る。
 * そのかわり 28km/h あたりで自励しなくなり、そこから先は空気ブレーキが受け持つ。
 */
export const testLineResistorSnow: ScenarioDefinition = {
  ...testLineResistor,
  id: 'test-line-resistor-snow',
  name: '試験線 各駅停車（抵抗制御・降雪）',
  railCondition: 'snow',
  regenerationReceptivity: 0.5,
};

/**
 * 電機子チョッパシナリオ: 抵抗制御車と**同じ電動機**を、段の無い通流率制御で回す。
 *
 * 引張力は滑らかに出て、全通流に達してから弱め界磁へ移る。チョッパ音は速度に
 * よらず音程が一定で、全通流に入った瞬間に消える。
 */
export const testLineChopper: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-chopper',
  name: '試験線 各駅停車（電機子チョッパ）',
  vehicleId: 'commuter-4-chopper',
};

/**
 * 音階インバータシナリオ: 走りは既定の通勤形とまったく同じで、変調だけが違う。
 *
 * 力行すると起動から 40km/h あたりまでキャリア周波数が平均律の音名を階段状に
 * 上っていき（ソラシド レミファソ ラシドレ）、そこで同期モードへ移って音の性格が
 * 変わる。減速すれば同じ階段を下りてくる。「試験線 各駅停車（晴天）」と
 * 聴き比べると、走りが同じで音だけが違うことが確かめられる。
 */
export const testLineScale: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-scale',
  name: '試験線 各駅停車（音階インバータ）',
  vehicleId: 'commuter-4-scale',
};

export const scenarios = [
  testLineLocal,
  testLineSnow,
  testLineFollowing,
  testLineAtsSn,
  testLineTurnoutThrough,
  testLineTurnoutDiverging,
  testLineResistor,
  testLineResistorSnow,
  testLineChopper,
  testLineScale,
] as const;
