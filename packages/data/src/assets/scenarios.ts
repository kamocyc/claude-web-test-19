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
 * 先行列車。10:00 前に 1000m 地点から発車し、ゆっくり終点へ向かう。
 * 追いつくと信号が段階的に現示ダウンする。
 *
 * わざと自列車より遅く走らせてある（表定 30〜40km/h）。単線区間では追い抜けない
 * ので、追いついたぶんだけ現示が落ちて自分が減速することになる。複線区間へ入っても
 * 先行列車は**同じ線路**を走っているので状況は変わらない — 複線が解決するのは
 * すれ違いであって追い越しではない、というのがここで確かめられる。
 */
export const precedingTrain = [
  {
    id: 'preceding',
    length: 80,
    waypoints: [
      { time: '9:59:00', position: 1000 },
      { time: '10:02:00', position: 2400 },
      { time: '10:06:00', position: 4400 },
      { time: '10:12:00', position: 8000 },
      { time: '10:16:00', position: 11000 },
      { time: '10:20:00', position: 14200 },
    ],
  },
];

/**
 * 対向列車（自列車が 1 番線にいるとき）。
 *
 * 単線なので、対向列車とすれ違えるのは交換設備の中だけである。したがってこの列車の
 * ダイヤは**交換設備を通り抜けるあいだだけ**書いてある（その前後は単線を走っていて、
 * 自列車が交換を終えるまで来られない）。
 *
 * 自列車が 1 番線（本線側）にいるので、対向列車は 2 番線＝分岐側を通ることになり、
 * 入口・出口の #12 分岐器の制限 45km/h に従う。通過に 36 秒かかるので、
 * すれ違いはゆっくりで、圧力波よりも警笛のように近づいてくる走行音のほうが目立つ。
 */
export const opposingTrainLoop = [
  {
    id: 'opposing',
    length: 80,
    track: 'adjacent' as const,
    waypoints: [
      { time: '10:00:05', position: 470 },
      { time: '10:00:41', position: 20 },
    ],
  },
];

/**
 * 対向列車（自列車が 2 番線にいるとき）。
 *
 * こちらが副本線へ入っているので、対向列車は**本線側を制限なしで通過**できる。
 * 一線スルーの交換駅で起きることそのもので、停車しているすぐ隣を 100km/h で
 * 通り抜けていく。相対速度が 28m/s あるため、
 *
 *  - 先頭がすれ違う瞬間に圧力波が「バン」と来る（動圧は速度の 2 乗で効く）
 *  - すれ違っているあいだ（80m / 28m/s ≒ 2.9 秒）だけ相手の転動音が至近距離で鳴る
 *  - その音程は、近づくあいだ 1.09 倍・離れるあいだ 0.92 倍（全音以上の落差）
 *
 * が続けて起きる。自列車が止まっていて自分の走行音が無いので、いちばん分かりやすい。
 */
export const opposingTrainMain = [
  {
    id: 'opposing',
    length: 80,
    track: 'adjacent' as const,
    waypoints: [
      { time: '10:00:08', position: 470 },
      { time: '10:00:24', position: 20 },
    ],
  },
];

/**
 * 対向列車（複線区間ですれ違う上り列車）。
 *
 * 交換設備の対向列車と違い、**止まりも減速もしない**。線路が別なので、こちらが
 * 110km/h、相手が 105km/h のまま行き違うことになる。相対速度は 215km/h（60m/s）
 * あり、すれ違いに要する時間は編成長 80m を割って 1.3 秒しかない:
 *
 *  - 先頭がすれ違う瞬間、動圧（速度の 2 乗）で「バン」と圧力波が来る。交換設備の
 *    すれ違い（相対 28m/s）に比べて動圧は 4 倍以上になる
 *  - 相手の転動音は聞こえたと思った瞬間に去る。音程の落差は 1.22 倍 → 0.82 倍で、
 *    ほぼ 1 オクターブに近い
 *  - 線路中心間隔が 3.8m しかないので、相手の車体は窓のすぐ外を通る
 *
 * 単線の交換設備で 45km/h ですれ違うのと聴き比べると、**すれ違いの音を決めて
 * いるのは距離ではなく相対速度である**ことがはっきりする。
 *
 * ダイヤは複線区間（6850〜11841m）を通り抜けるあいだだけ書いてある。その前後は
 * 単線なので、自列車が抜けきるまで来られない。
 */
export const opposingTrainDouble = [
  {
    id: 'opposing-double',
    length: 80,
    track: 'adjacent' as const,
    waypoints: [
      { time: '10:07:40', position: 11840 },
      { time: '10:10:30', position: 6860 },
    ],
  },
];

/** 先行列車シナリオ: 前を走る列車に追いつき、信号現示が段階的に変化する。 */
export const testLineFollowing: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-following',
  name: '試験線 先行列車あり',
  scheduledTrains: precedingTrain,
};

/** ATS-SN シナリオ: 確認扱いを要する旧型の保安装置で運転する */
export const testLineAtsSn: ScenarioDefinition = {
  ...testLineFollowing,
  id: 'test-line-ats-sn',
  name: '試験線 ATS-SN 区間',
  safetySystems: ['ats-sn'],
};

/**
 * 側線分岐器シナリオ: 中原から発車し、6300m の #12 分岐器を直進側で通過する。
 *
 * 側線への分岐器は本線側へ開通したままなので制限速度が無く、110km/h のまま
 * クロッシングの欠線を踏める。「ガタン」が 1 両あたり 2 拍ずつ、編成のぶんだけ続く。
 */
export const testLineTurnoutThrough: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-turnout',
  name: '試験線 分岐器（直進）',
  startTime: '10:03:50',
  startPosition: 3500,
};

/**
 * 2 番線発車シナリオ: 起点駅（交換可能駅）の副本線から発車する。
 *
 * 出口の背向分岐器を分岐側で渡るので、45km/h の制限を受けたまま出ることになる。
 * リード曲線には緩和曲線もカントも無く、しかも戻し曲線で逆へ折り返すので、
 * 横 G が階段状に正負へ振れる。制限を守らずに出れば立っている乗客はよろける。
 *
 * 行き先は 1 番線から出た場合とまったく同じで、距離程も駅も信号機も変わらない。
 */
export const testLineLoop: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-loop',
  name: '試験線 各駅停車（2 番線発車）',
  routeId: 'test-line-loop',
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

/**
 * すれ違いシナリオ: 2 番線に停まっているところへ、本線を対向列車が通過する。
 *
 * 発車時刻（10:00:30）より前に通り抜けるので、停車したまま聴くことになる。
 * 自分の走行音が無いぶん、圧力波・ドップラー・至近距離の転動音がそのまま届く。
 */
export const testLineOpposing: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-opposing',
  name: '試験線 対向列車とすれ違い（2 番線待避）',
  routeId: 'test-line-loop',
  scheduledTrains: opposingTrainMain,
};

/**
 * 橋りょう・踏切シナリオ: 中原を発車し、ロングレール区間の橋と分岐器を渡る。
 *
 * 3700m の電鐘式踏切、3950m の分岐器、4380m の下路トラス橋が続けて来る。継目音の
 * 無いロングレール区間なので、踏切板の目地・分岐器の絶縁継目・橋の伸縮継目が
 * それぞれ違う音で入るのが聞き分けられる。
 */
export const testLineStructures: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-structures',
  name: '試験線 橋りょうと踏切',
  startTime: '10:03:50',
  startPosition: 3500,
};

/**
 * 複線すれ違いシナリオ: 稲田堤を発車し、複線区間で上り列車と 215km/h で行き違う。
 *
 * 起点駅の交換設備でのすれ違い（`test-line-opposing`）と同じ設備・同じ車両で、
 * 違うのは**相対速度だけ**である。聴き比べると、圧力波の強さも、相手の走行音が
 * 聞こえている時間も、ドップラーの落差も、すべてそこから出ていることが分かる。
 */
export const testLineMeeting: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-meeting',
  name: '試験線 複線区間ですれ違い',
  startTime: '10:07:40',
  startPosition: 7200,
  scheduledTrains: opposingTrainDouble,
};

/**
 * 複線区間シナリオ: 稲田堤から向ヶ丘まで、線路最高速度で走る。
 *
 * 7500〜12000m はロングレールなので継目音が無く、代わりに波状摩耗の唸りが
 * 速度に比例して上がっていく。9350m の踏切、9660m の片渡り線、9800m から
 * 500m の複線トンネル、11000m の架道橋が続けて来る。
 */
export const testLineDoubleTrack: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-double',
  name: '試験線 複線区間',
  startTime: '10:07:40',
  startPosition: 7200,
};

/**
 * 終点進入シナリオ: 向ヶ丘を発車し、R300（65km/h 制限）を抜けて登戸へ入る。
 *
 * 複線が単線へ戻る背向分岐器（11800m）、下路トラス橋、トンネル、そして終点手前の
 * 急曲線と、線形の性格が 3km のあいだに何度も変わる。終端には車止めがあるので、
 * ATS-P は終端までの距離でパターンを引いている。
 */
export const testLineTerminus: ScenarioDefinition = {
  ...testLineLocal,
  id: 'test-line-terminus',
  name: '試験線 終点進入',
  startTime: '10:11:10',
  startPosition: 10600,
};

export const scenarios = [
  testLineLocal,
  testLineSnow,
  testLineFollowing,
  testLineAtsSn,
  testLineTurnoutThrough,
  testLineLoop,
  testLineOpposing,
  testLineMeeting,
  testLineDoubleTrack,
  testLineTerminus,
  testLineStructures,
  testLineResistor,
  testLineResistorSnow,
  testLineChopper,
  testLineScale,
] as const;
