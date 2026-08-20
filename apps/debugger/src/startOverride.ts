import { kmhToMps, type Scenario } from '@railsim/core';

/**
 * 開始位置と速度を URL で指し示す、確認用の入口。
 *
 * 見たいものが 2km 先にあると、既定の開始位置から走らせて着くまで待つことになる。
 * 待ち時間は速度倍率を上げても消えない。1 フレームで進められるのは実時間 0.25 秒
 * ぶんまで（`main.ts` の `frame`）で、その中で進む物理も最大 2 秒ぶんまで
 * （`Simulation.step` の `MAX_SUBSTEPS`）と決まっているからで、描画が遅い環境では
 * そこが頭打ちになる。着きたい場所から始めれば、待つ理由そのものが無くなる。
 *
 * - `?s=2000` — 開始位置（列車先頭端の距離程）[m]
 * - `?v=60` — 開始速度 [km/h]
 * - `?ui=0` — HUD と操作説明を消しておく（`U` キーと同じ状態で始める）
 *
 * 記録の再生では効かせない。記録は「どのシナリオを、どこから」を含んでいるので、
 * URL で開始位置を動かすと再生が別の走行になってしまう。
 */
export interface StartOverride {
  /** 開始位置 [m]。指定が無ければ null */
  readonly position: number | null;
  /** 開始速度 [m/s]。指定が無ければ null */
  readonly speed: number | null;
  /** 画面の表示（HUD・操作説明）を消して始めるか */
  readonly hideUi: boolean;
}

/** 何も指定されていない状態 */
export const NO_OVERRIDE: StartOverride = { position: null, speed: null, hideUi: false };

/** 数として読めて、負でない有限の値だけを受ける（読めなければ黙って無視する） */
function positiveNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `location.search` を読む */
export function parseStartOverride(search: string): StartOverride {
  const params = new URLSearchParams(search);
  const speed = positiveNumber(params.get('v'));
  return {
    position: positiveNumber(params.get('s')),
    speed: speed === null ? null : kmhToMps(speed),
    hideUi: params.get('ui') === '0',
  };
}

/**
 * シナリオの開始位置・速度を差し替える。
 *
 * `Simulation` は開始位置を組み立てるときにしか読まないので、走り出してから
 * 飛ばすのではなく、シナリオの側を差し替えて組み直す。
 */
export function withStartOverride(scenario: Scenario, override: StartOverride): Scenario {
  if (override.position === null && override.speed === null) return scenario;
  return {
    ...scenario,
    // 路線の外へは出さない。終端を越えて始めると走る前に終わってしまう
    startPosition:
      override.position === null
        ? scenario.startPosition
        : Math.min(override.position, scenario.route.length),
    startSpeed: override.speed ?? scenario.startSpeed,
  };
}
