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

export const scenarios = [testLineLocal, testLineSnow, testLineFollowing, testLineAtsSn] as const;
