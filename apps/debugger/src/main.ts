import * as THREE from 'three';
import { InputRecorder, Simulation, replay, type Recording, type Scenario } from '@railsim/core';
import {
  DEFAULT_RUN_OPTIONS,
  SAFETY_CHOICES,
  VEHICLE_CHOICES,
  WEATHER_CHOICES,
  createDefaultLibrary,
  parseRunScenarioId,
  runScenarioId,
  type RunOptions,
  type SafetyChoice,
  type WeatherChoice,
} from '@railsim/data';
import { TrainAudio } from './audio/engine.ts';
import { ChartPanel } from './charts/panel.ts';
import { DriverState, type HandlePosition } from './input/driverState.ts';
import { DriverDesk } from './input/keyboard.ts';
import { createCabInterior } from './render/cab.ts';
import type { CarInterior } from './render/interior.ts';
import { CarShells, Walker } from './render/walk.ts';
import { Precipitation } from './render/precipitation.ts';
import { CAMERA_LABEL, CAMERA_MODES, CameraRig, type CameraMode } from './render/cameras.ts';
import { Presenter } from './render/renderer.ts';
import { TrackScene } from './render/scene.ts';
import { GMeter } from './ui/gmeter.ts';
import { Hud } from './ui/hud.ts';
import { Mixer } from './ui/mixer.ts';
import { TouchConsole } from './ui/touchConsole.ts';
import {
  NO_OVERRIDE,
  parseStartOverride,
  withStartOverride,
  type StartOverride,
} from './startOverride.ts';

const RATES = [0.1, 0.25, 0.5, 1, 2, 4, 8];
/** グラフのサンプリング周期 [s]（描画フレームごとだと細かすぎる） */
const SAMPLE_PERIOD = 0.05;

const library = createDefaultLibrary();

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hudElement = document.querySelector<HTMLElement>('#hud')!;
const chartsElement = document.querySelector<HTMLElement>('#charts')!;
const vehicleSelect = document.querySelector<HTMLSelectElement>('#vehicle')!;
const weatherSelect = document.querySelector<HTMLSelectElement>('#weather')!;
const safetyGroup = document.querySelector<HTMLElement>('#safety')!;
const precedingCheck = document.querySelector<HTMLInputElement>('#preceding')!;
const opposingCheck = document.querySelector<HTMLInputElement>('#opposing')!;
const platformCheck = document.querySelector<HTMLInputElement>('#platform')!;
const oneHandleCheck = document.querySelector<HTMLInputElement>('#onehandle')!;
const restartButton = document.querySelector<HTMLButtonElement>('#restart')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const rateLabel = document.querySelector<HTMLElement>('#rate')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const loadInput = document.querySelector<HTMLInputElement>('#load')!;
const gmeterElement = document.querySelector<HTMLElement>('#gmeter')!;
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const mixerElement = document.querySelector<HTMLElement>('#mixer')!;
const appElement = document.querySelector<HTMLElement>('#app')!;
const touchElement = document.querySelector<HTMLElement>('#touch')!;
const touchButton = document.querySelector<HTMLButtonElement>('#touchui')!;
const drawerButton = document.querySelector<HTMLButtonElement>('#drawer')!;
const walkHint = document.querySelector<HTMLElement>('#walkhint')!;

/** 指で触る端末か（タッチ運転台を出すかと、描画の重さの判断に使う） */
const coarsePointer = window.matchMedia('(pointer: coarse)');

// 描画の出口。画づくりの決めごと（露出・トーンマッピング・後処理）は
// `render/renderer.ts` にまとめてあり、ここは組み立てて呼ぶだけである。
// 携帯の画面は画素密度が高く、2 倍で描くと影付きの広い面が間に合わない。
// 指で触る端末では上限を下げる（見た目の粗さより、詰まらないことを採る）。
const presenter = new Presenter(canvas, { maxPixelRatio: coarsePointer.matches ? 1.5 : 2 });
const renderer = presenter.renderer;

const cameraRig = new CameraRig(canvas);
const hud = new Hud(hudElement);
const charts = new ChartPanel(chartsElement);
const gmeter = new GMeter(gmeterElement);
const audio = new TrainAudio();
const mixer = new Mixer(mixerElement, {
  onChange: (patch) => {
    startAudio();
    audio.setMix(patch);
  },
});

// 運転席の内装はカメラの子として取り付ける。こうすると車体動揺でカメラが揺れても
// 内装は動かず、窓の外の景色だけが揺れる（実際の運転席の見え方と同じ）。
const cabInterior = createCabInterior();
cameraRig.camera.add(cabInterior.group);

// 降水は路線にも編成にも依らないので、シーンを組み直しても作り直さず使い回す。
// 粒の数は端末に合わせる（携帯端末では半分）。
const precipitation = new Precipitation(coarsePointer.matches ? 0.5 : 1);
/** 雨脚の傾きに使う列車の速度ベクトル（毎フレーム確保しないための置き場） */
const trainVelocity = new THREE.Vector3();

/**
 * 走行条件の選択肢はデータ側（`@railsim/data` の `run.ts`）が持っている。
 * 車両を 1 形式足したら、この画面には何も書かずに選べるようになる。
 */
function fillSelect(
  select: HTMLSelectElement,
  choices: ReadonlyArray<{ id: string; label: string }>,
): void {
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    select.append(option);
  }
}
fillSelect(vehicleSelect, VEHICLE_CHOICES);
fillSelect(weatherSelect, WEATHER_CHOICES);
for (const choice of SAFETY_CHOICES) {
  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'safety';
  radio.value = choice.id;
  label.append(radio, choice.label);
  safetyGroup.append(label);
}

/** 画面の選択状態を読む */
function readOptions(): RunOptions {
  const safety = safetyGroup.querySelector<HTMLInputElement>('input:checked');
  return {
    vehicleId: vehicleSelect.value,
    weather: weatherSelect.value as WeatherChoice,
    divergingPlatform: platformCheck.checked,
    precedingTrain: precedingCheck.checked,
    opposingTrain: opposingCheck.checked,
    safety: (safety?.value ?? DEFAULT_RUN_OPTIONS.safety) as SafetyChoice,
  };
}

/** 条件を画面へ反映する（既定値の表示と、記録を読み込んだときの復元） */
function showOptions(options: RunOptions): void {
  vehicleSelect.value = options.vehicleId;
  weatherSelect.value = options.weather;
  platformCheck.checked = options.divergingPlatform;
  precedingCheck.checked = options.precedingTrain;
  opposingCheck.checked = options.opposingTrain;
  for (const radio of safetyGroup.querySelectorAll<HTMLInputElement>('input')) {
    radio.checked = radio.value === options.safety;
  }
}
showOptions(DEFAULT_RUN_OPTIONS);

/**
 * URL で視点を指定する入口（`?view=walk` / `?view=cab` …）。
 *
 * 開始位置（`?s=`）と同じく**見たいものをすぐ見るため**のもので、車内の
 * 見た目を確かめるのに毎回 `C` を押して数える必要がなくなる。知らない名前が
 * 来たら黙って既定（運転席）にする。
 */
function parseCameraMode(search: string): CameraMode | null {
  const value = new URLSearchParams(search).get('view');
  return CAMERA_MODES.find((mode) => mode === value) ?? null;
}

/** URL で指定された開始位置・速度（確認用の入口。`startOverride.ts`） */
const startOverride = parseStartOverride(window.location.search);
if (startOverride.hideUi) document.body.classList.add('ui-hidden');

let scenarioId = runScenarioId(DEFAULT_RUN_OPTIONS);
let scenario: Scenario = withStartOverride(library.scenario(scenarioId), startOverride);
let sim = new Simulation(scenario);
let scene = new TrackScene(scenario.route, sim, renderer);
charts.setDriveKind(sim.traction.driveState.kind);
let recorder = new InputRecorder();
/** 車内を歩くモードの持ち物（シーンを組み直すたびに作り直す） */
let interior = createInteriorView();
let paused = false;
let rateIndex = RATES.indexOf(1);
let singleStep = false;
let sampleTimer = 0;
let replaying: Recording | null = null;
/** 自動運転の入切（シナリオを切り替えても保つ） */
let autoDrive = false;

/**
 * 車内を歩くモードの持ち物。
 *
 * 歩行者（`Walker`）は客室の割り付けを知っている必要があり、それは車両の
 * 仕様で決まるので、シナリオを組み直したら作り直す。外板の細工（`CarShells`）
 * も同じ理由で車体ごとに持つ。
 */
interface InteriorView {
  readonly cars: ReadonlyArray<{ object: THREE.Object3D; interior: CarInterior }>;
  readonly walker: Walker;
  readonly shells: CarShells;
}

function createInteriorView(): InteriorView {
  const cars = scene.cars;
  // 編成の何両目かと混雑率をここで教える。`scene.ts` は内装を組むだけで
  // 編成の中の位置を知らないが、乗客の座り方と照明の明るさは車ごとに
  // 違わなければならない（同じだと貫通路の先に同じ絵が並んで模型に見える）。
  for (let i = 0; i < cars.length; i++) {
    cars[i]!.interior.setPlacement(i, sim.scenario.loadFactor);
  }
  return {
    cars,
    // 混雑率は描画側（`setPlacement`）と同じ値を渡す。歩行者が膝を
    // 通り抜けないのは、両者が同じ割り付けを引くからである。
    walker: new Walker(
      cars.map((car) => car.interior.layout),
      sim.scenario.loadFactor,
    ),
    shells: new CarShells(cars),
  };
}

/** 歩行者の目（車体局所座標系での位置と向きを一度ここへ入れてから世界へ移す） */
const walkPose = new THREE.Object3D();
const walkPosition = new THREE.Vector3();
const walkQuaternion = new THREE.Quaternion();

/** ノッチ段数は車両で変わる。切り替えに追従できるよう関数で渡す。 */
const notchCounts = {
  powerNotchCount: () => scenario.consist.traction.notchCount,
  brakeNotchCount: () => scenario.consist.brake.notchCount,
  // 抑速を持たない車両では、ブレーキハンドルに抑速位置そのものが無い
  hasHoldingBrake: () => scenario.consist.brake.hasHoldingBrake,
  // 逆転ハンドルは停止中しか動かせない。運転台の状態機械は速度を知らないので、
  // 判定だけをここから貸す（タッチ運転台にも同じものが渡る）。
  canMoveReverser: () => Math.abs(sim.speed) < 0.05,
};

/**
 * 運転台のハンドル位置。キーボードと画面のタッチ運転台が同じものを握る。
 * 別々に持たせると、キーで入れたノッチが画面のレバーに出ない（逆も同じ）。
 */
const deskState = new DriverState(notchCounts);

const desk = new DriverDesk(
  {
    ...notchCounts,
    onCameraCycle: () => cycleCamera(),
    isWalking: () => cameraRig.mode === 'walk',
    onUiToggle: () => document.body.classList.toggle('ui-hidden'),
    onAutoDriveToggle: () => setAutoDrive(!autoDrive),
    onPauseToggle: () => setPaused(!paused),
    onSingleStep: () => {
      singleStep = true;
    },
    onRateChange: (delta) => {
      rateIndex = Math.max(0, Math.min(RATES.length - 1, rateIndex + delta));
      updateRateLabel();
    },
    onMuteToggle: () => setMuted(!audio.isMuted),
    onUserGesture: () => startAudio(),
  },
  deskState,
);

const touchConsole = new TouchConsole(touchElement, {
  state: deskState,
  ...notchCounts,
  onUserGesture: () => startAudio(),
  onCameraCycle: () => cycleCamera(),
  onAutoDriveToggle: () => setAutoDrive(!autoDrive),
  onPauseToggle: () => setPaused(!paused),
  onDrawerToggle: () => setDrawerOpen(!appElement.classList.contains('drawer-open')),
});

/** 視点を次のカメラへ送る（ボタン 1 つで 5 種類を回す） */
function cycleCamera(): void {
  const index = CAMERA_MODES.indexOf(cameraRig.mode);
  const next = CAMERA_MODES[(index + 1) % CAMERA_MODES.length];
  if (next) applyCameraMode(next);
}

/** 走行条件・記録・音量・グラフの引き出し（画面が狭いときだけ引き出しになる） */
function setDrawerOpen(open: boolean): void {
  appElement.classList.toggle('drawer-open', open);
  drawerButton.setAttribute('aria-expanded', String(open));
  drawerButton.textContent = open ? '×' : '≡';
  // 閉じたらフォーカスを運転台へ返す（`releaseFocus` と同じ理由）
  if (!open) canvas.focus();
}

function applyCameraMode(mode: CameraMode): void {
  cameraRig.setMode(mode);
  cabInterior.group.visible = mode === 'cab';
  scene.setLeadCarVisible(mode !== 'cab');
  // 車内を歩くあいだだけ、外板のガラスを透かして外が見えるようにする
  interior.shells.setWalking(mode === 'walk');
  document.body.classList.toggle('walking', mode === 'walk');
  if (mode !== 'walk' && document.pointerLockElement === canvas) document.exitPointerLock();
}

/**
 * 自動運転の入切。
 * 切るときは、装置が握っていたノッチをそのまま運転士のハンドル位置へ引き継ぐ
 * （でないと、ブレーキ中に切り替えた瞬間に緩解して走り出してしまう）。
 */
function setAutoDrive(value: boolean): void {
  if (!value && autoDrive) {
    const held = sim.effectiveInput;
    desk.takeOver(held.powerNotch, held.brakeNotch, held.doorsClosed, held.holdingNotch);
  }
  autoDrive = value;
  sim.setAutoDrive(value);
}

function setPaused(value: boolean): void {
  paused = value;
  pauseButton.textContent = paused ? '再開' : '一時停止';
  audio.setPaused(paused);
}

function setMuted(value: boolean): void {
  audio.setMuted(value);
  refreshAudioButton();
}

/** 音が出せない環境（AudioWorklet 非対応など）ではボタンでそれが分かるようにする */
function refreshAudioButton(): void {
  if (!audio.available) {
    muteButton.textContent = '音: 使用不可';
    muteButton.disabled = true;
    return;
  }
  muteButton.textContent = audio.isMuted ? '音を出す' : '消音';
}

function startAudio(): void {
  void audio.start().then(refreshAudioButton);
}

function updateRateLabel(): void {
  rateLabel.textContent = `${RATES[rateIndex]!.toFixed(2)}x`;
}

function restart(id = scenarioId, override: StartOverride = startOverride): void {
  scenarioId = id;
  scenario = withStartOverride(library.scenario(scenarioId), override);
  sim = new Simulation(scenario);
  scene = new TrackScene(scenario.route, sim, renderer);
  // カメラの子（運転席内装）を描画させるため、カメラをシーングラフに入れる
  scene.scene.add(cameraRig.camera);
  precipitation.setLook(scene.look);
  scene.scene.add(precipitation.group);
  recorder = new InputRecorder();
  interior = createInteriorView();
  replaying = null;
  sampleTimer = 0;
  desk.reset();
  // 制御方式で主回路のグラフの系列が入れ替わる
  charts.setDriveKind(sim.traction.driveState.kind);
  charts.clear();
  gmeter.clear();
  audio.reset();
  sim.setAutoDrive(autoDrive);
  applyCameraMode(cameraRig.mode);
  setPaused(false);
}

/**
 * 画面のコントロールを操作したあとはフォーカスを外して運転台へ返す。
 * `<select>` やボタンにフォーカスが残っていると、Z / A がリストの先頭一致選択に、
 * Space / Enter がボタンの再押下に食われて、ノッチが効かなくなる。
 */
function releaseFocus(element: HTMLElement): void {
  element.blur();
  canvas.focus();
}

/** タッチ運転台を出すかの手動指定。`null` なら端末の判定に任せる。 */
const TOUCH_CONSOLE_KEY = 'railsim.touchConsole';

function readTouchOverride(): boolean | null {
  try {
    const saved = window.localStorage.getItem(TOUCH_CONSOLE_KEY);
    return saved === '1' ? true : saved === '0' ? false : null;
  } catch {
    // プライベートブラウズなどで localStorage が使えないことがある
    return null;
  }
}

function writeTouchOverride(value: boolean): void {
  try {
    window.localStorage.setItem(TOUCH_CONSOLE_KEY, value ? '1' : '0');
  } catch {
    // 保存できなくても動作には影響しない
  }
}

let touchOverride = readTouchOverride();

/** 指で触る端末か、サイドパネルが入らない幅なら既定で出す */
function prefersTouchConsole(): boolean {
  return coarsePointer.matches || window.innerWidth <= 900;
}

function setTouchConsole(on: boolean): void {
  touchConsole.setVisible(on);
  touchButton.textContent = on ? 'タッチ運転台: 入' : 'タッチ運転台: 切';
  // 運転台を出すときは引き出しを畳んで、画面を運転に明け渡す
  if (on) setDrawerOpen(false);
}

// タブレットにキーボードを繋ぐと粗ポインタでなくなる端末があるので、
// 手で指定されていないあいだは追従する。
coarsePointer.addEventListener('change', () => {
  if (touchOverride === null) setTouchConsole(prefersTouchConsole());
});

touchButton.addEventListener('click', () => {
  releaseFocus(touchButton);
  touchOverride = !touchConsole.isVisible;
  writeTouchOverride(touchOverride);
  setTouchConsole(touchOverride);
});

drawerButton.addEventListener('click', () => {
  startAudio();
  setDrawerOpen(!appElement.classList.contains('drawer-open'));
});

// AudioContext はユーザ操作の中でしか開始できない。画面のどこを触っても解錠する。
canvas.addEventListener('pointerdown', () => startAudio());

// 車内を歩くモードでは、画面を押すとポインタを掴んで首を振れるようにする。
// Pointer Lock はユーザ操作の中でしか要求できないので、click で取る。
canvas.addEventListener('click', () => {
  if (cameraRig.mode !== 'walk') return;
  if (document.pointerLockElement === canvas) return;
  void canvas.requestPointerLock?.();
});
document.addEventListener('mousemove', (e) => {
  if (cameraRig.mode !== 'walk' || document.pointerLockElement !== canvas) return;
  interior.walker.look(e.movementX, e.movementY);
});
muteButton.addEventListener('click', () => {
  releaseFocus(muteButton);
  startAudio();
  setMuted(!audio.isMuted);
});
// 走行条件はどれを触っても、その組み合わせのシナリオで走り直す
for (const control of [
  vehicleSelect,
  weatherSelect,
  safetyGroup,
  precedingCheck,
  opposingCheck,
  platformCheck,
]) {
  control.addEventListener('change', () => {
    releaseFocus(control);
    restart(runScenarioId(readOptions()));
  });
}
/**
 * 運転台の型（ワンハンドル / ツーハンドル）。既定はワンハンドル。
 *
 * 走行条件ではないので、切り替えても走り直さない。段の並びはどちらも同じなので、
 * 走行中に替えても手元のノッチは動かない。型を持っているのは運転台
 * （`DriverState`）のほうなので、チェックボックスはその位置に合わせて起こす。
 */
oneHandleCheck.checked = deskState.layout === 'one-handle';
oneHandleCheck.addEventListener('change', () => {
  releaseFocus(oneHandleCheck);
  deskState.setLayout(oneHandleCheck.checked ? 'one-handle' : 'two-handle');
});

restartButton.addEventListener('click', () => {
  releaseFocus(restartButton);
  restart();
});
pauseButton.addEventListener('click', () => {
  releaseFocus(pauseButton);
  setPaused(!paused);
});
saveButton.addEventListener('click', () => {
  releaseFocus(saveButton);
  const recording = recorder.toRecording(scenarioId, scenario.seed);
  const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scenarioId}-replay.json`;
  a.click();
  URL.revokeObjectURL(url);
});

loadInput.addEventListener('change', async () => {
  releaseFocus(loadInput);
  const file = loadInput.files?.[0];
  if (!file) return;
  const recording = JSON.parse(await file.text()) as Recording;
  if (!library.hasScenario(recording.scenarioId)) {
    window.alert(`記録のシナリオ "${recording.scenarioId}" が見つかりません`);
    loadInput.value = '';
    return;
  }
  // 記録は「どこから走ったか」まで含んでいるので、URL の開始位置は効かせない
  restart(recording.scenarioId, NO_OVERRIDE);
  // 記録の ID には走行条件が入っているので、画面の選択もそこへ戻す
  const options = parseRunScenarioId(recording.scenarioId);
  if (options) showOptions(options);
  replaying = recording;
  // 記録どおりに再生する（入力以外に外部依存が無いので同じ走行が再現される）
  replay(sim, recording, SAMPLE_PERIOD, (s) => charts.sample(s));
  replaying = null;
  loadInput.value = '';
});

/** 編成長 [m] */
const trainLength = (): number => scenario.consist.vehicles.reduce((a, v) => a + v.length, 0);

/**
 * 表示サイズに描画バッファを合わせる。
 *
 * 毎フレーム呼んでいるのは、`resize` イベントが来ない画面変化（携帯の回転、
 * iOS のアドレスバーの伸縮、引き出しの開閉）に追従するため。ただし寸法が
 * 変わっていないのに `setSize` を呼ぶと、伸縮のあいだ毎フレーム描画バッファを
 * 作り直すことになるので、変化したときだけ通す。
 */
let lastWidth = 0;
let lastHeight = 0;
function resize(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === lastWidth && height === lastHeight) return;
  lastWidth = width;
  lastHeight = height;
  presenter.resize(width, height);
  cameraRig.resize(width, height);
}
window.addEventListener('resize', resize);

let previous = performance.now();

/**
 * シミュレーションを実時間 `wall` 秒ぶん進める。戻り値は進めたシミュレーション時間。
 *
 * 描画とは切り離してある。ページが背面へ回ると `requestAnimationFrame` は止まるが、
 * 音は鳴り続けているので、そのときは音声の時計から呼ぶことになる（`frame` の下）。
 */
function advanceSimulation(wall: number): number {
  if (replaying !== null) return 0;
  // 一時停止中でもハンドル位置は反映する（再開した瞬間に効くのではなく、
  // 手元の操作がその場で計器と HUD に出るほうが運転台として自然）。
  sim.input = desk.input;
  const advance = paused ? (singleStep ? 1 / 60 : 0) : wall * RATES[rateIndex]!;
  singleStep = false;
  if (advance > 0) {
    recorder.record(sim.elapsed, sim.input);
    sim.step(advance);
    sampleTimer += advance;
    if (sampleTimer >= SAMPLE_PERIOD) {
      charts.sample(sim);
      sampleTimer = 0;
    }
  }
  return advance;
}

/**
 * 吊り革の振れの誇張。
 *
 * `core` が出す振れ角は実物どおりで、常用 3km/h/s でも 5 度ほどにしかならない。
 * 5 度は絵にすると「垂れているのと区別が付かない」ので、**描画側で誇張して
 * いる**。物理の値は書き換えていない（`core` は読むだけ）ので、記録・再生や
 * 状態ハッシュには影響しない。乗客の傾きも同じ考えで
 * `interiorPassengers.ts` が誇張している。
 */
const STRAP_SWAY_GAIN = 2.2;

/**
 * 内装をシミュレーションの状態へ合わせる。
 *
 * **視点によらず毎フレーム呼ぶ。**客室は外からも窓ごしに見えているので、
 * 車内を歩いているときだけ動かすと、外から見た電車の扉が開かず、吊り革も
 * 乗客も凍りついたままになる。費用はほとんどが `InstancedMesh` の姿勢の
 * 積み直しで、1 両あたり数百回の行列合成にしかならない。
 */
function updateInteriors(): void {
  const { cars, shells } = interior;
  // 車内案内表示器に出す文言。次の停車駅と、編成の行先（終点）。
  const next = sim.nextStation;
  const stations = sim.scenario.route.stations;
  const destination = stations[stations.length - 1]?.name ?? '';
  const nextName = next?.station.name ?? destination;
  // 「まもなく」は停止位置まで 600m を切ってから（実物の案内もこのあたり）
  const arriving = next ? next.station.stopPosition - sim.dynamics.frontPosition < 600 : false;
  const doorPosition = sim.doors.state.position;

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]!;
    const passenger = sim.dynamics.vehicles[i]?.body.passenger;
    car.interior.update({
      doorPosition,
      strapLateral: (passenger?.strap.lateral ?? 0) * STRAP_SWAY_GAIN,
      strapLongitudinal: (passenger?.strap.longitudinal ?? 0) * STRAP_SWAY_GAIN,
      // 立客の傾きは倒立振子の解そのもの。誇張は描画側（`interiorPassengers.ts`）で掛ける。
      standLateral: passenger?.stance.lateral.lean ?? 0,
      standLongitudinal: passenger?.stance.longitudinal.lean ?? 0,
      nextStation: nextName,
      kind: '各駅停車',
      destination,
      arriving,
    });
  }
  shells.update(doorPosition);
}

/**
 * 車内を歩くモードの 1 フレーム。
 *
 * 歩く速さは**実時間**で進める（時間倍率を上げても人が速く歩くわけではない）。
 * 内装そのものは `updateInteriors()` が視点によらず動かしているので、ここは
 * 歩行者の足と目だけを受け持つ。
 */
function updateWalk(wall: number): void {
  const { walker, cars } = interior;
  const keys = desk.walkKeys;
  // キーで首を振る（マウスを使えない場面のための逃げ道）
  walker.turn(keys.turn * wall * 2.0, keys.look * wall * 1.4);
  const body = sim.dynamics.vehicles[walker.state.carIndex]?.body;
  walker.step(wall, keys, body);

  // 目の位置と向きを車体局所系で組み立て、車体の姿勢で世界座標へ移す。
  const car = cars[walker.state.carIndex];
  if (!car) return;
  walker.pose(body, walkPose);
  walkPosition.copy(walkPose.position).applyMatrix4(car.object.matrixWorld);
  walkQuaternion.copy(car.object.quaternion).multiply(walkPose.quaternion);

  // 歩いているあいだは運転できない。行き止まりにしないため、自動運転を勧める。
  // 毎フレーム同じ文字列を書き込むと DOM を無駄に触るので、変わったときだけ。
  const hint = walkHintText();
  if (hint !== lastWalkHint) {
    lastWalkHint = hint;
    walkHint.innerHTML = hint;
  }
}

/** 直前に出した案内の文言（同じなら書き直さない） */
let lastWalkHint = '';

/** 車内を歩くモードの案内（画面下に出す） */
function walkHintText(): string {
  const auto = autoDrive
    ? '<span class="ok">自動運転で走行中</span>'
    : '<span class="warn">運転士は不在です — <b>O</b> で自動運転（ATO）を入れてください</span>';
  return [
    '<b>車内</b> — <b>W A S D</b> 歩く / <b>Shift</b> 早足 / 画面を押すとマウスで視点',
    '<b>Q E</b> 首を振る / <b>PageUp PageDown</b> 見上げる・見下ろす / <b>C</b> 視点を戻す',
    `歩行中は運転のキーが効きません。${auto}`,
  ]
    .map((line) => `<div>${line}</div>`)
    .join('');
}

/**
 * ページが背面に回っているか。
 *
 * ブラウザは背面のタブで `requestAnimationFrame` を止め、タイマも 1 分に 1 回まで
 * 絞る。一方 **AudioWorklet は音声スレッドで動き続ける**（音を出しているタブは
 * 凍結の対象からも外れる）ので、背面のあいだだけ音声の時計を親時計に使う。
 * こうしないと、絵の更新が止まった瞬間にシミュレーションも止まり、継目・分岐器・
 * 進段・戸当たりのような**イベントで鳴る音だけが消えて**、鳴りっぱなしの音
 * （転動音・インバータ）だけが最後の状態で残り続けることになる。
 */
let hidden = document.visibilityState === 'hidden';

document.addEventListener('visibilitychange', () => {
  hidden = document.visibilityState === 'hidden';
  // 背面へ回ると指もキーも離した通知が来ない。押しっぱなしのまま残ると、
  // 見えないところで警笛が鳴り続けることになる。
  if (hidden) {
    deskState.releaseAll();
    desk.releaseKeys();
  }
  // 戻ってきた瞬間に「背面にいたあいだ」ぶんの大きな dt を作らないよう、
  // 実時間の基準を引き直す。
  if (!hidden) previous = performance.now();
});

/**
 * 背面タブでの親時計。音声がレンダされたぶんだけシミュレーションを進める。
 *
 * 絵と HUD は見えていないので更新しない。音に要るのはシミュレーションの状態だけで、
 * `audio.update` に渡すパラメータもそこから作られる。
 */
audio.onClock = (seconds) => {
  if (!hidden) return;
  const wall = Math.min(seconds, 0.25);
  const advance = advanceSimulation(wall);
  audio.update(sim, advance, wall);
};

function frame(now: number): void {
  requestAnimationFrame(frame);
  // 背面から戻った直後などに一息で何秒も進めないよう、幅に上限を設ける
  const wall = Math.min((now - previous) / 1000, 0.25);
  previous = now;
  // 背面のあいだに呼ばれた場合（ブラウザによっては低頻度で呼ばれる）は
  // 音声の時計と二重に進めないよう、描画も更新も見送る。
  if (hidden) return;
  resize();

  // ノッチキーの長押し。実時間で送るので、一時停止していてもハンドルは動かせる。
  desk.tick(now / 1000);

  const advance = advanceSimulation(wall);

  // 自動運転中は装置が動かしているノッチを「手元」として表示・描画する
  const held = sim.effectiveInput;
  const handles: HandlePosition = autoDrive
    ? {
        ...desk.handles,
        power: held.powerNotch,
        brake: held.brakeNotch,
        // 装置は段まで決めているが、運転台の表示は抑速位置の入切だけを持つ
        holding: held.holdingNotch > 0,
        emergency: held.emergency,
        doorsClosed: held.doorsClosed,
        // 逆転機・灯火・ワイパー・耐雪は自動運転装置が触らないので手元のまま
      }
    : desk.handles;

  // 音は「シミュレーション時間が進んだか」で判断する。一時停止中は advance が 0 に
  // なるので、止まった絵に音だけが鳴り続けることはない。
  audio.update(sim, advance, wall);
  mixer.update(audio.levels);
  scene.update(sim);
  scene.setLights(handles.headlight, handles.headlightHigh, handles.reverser);
  if (cameraRig.mode === 'cab') {
    cabInterior.update(sim, { ...handles, oneHandle: deskState.layout === 'one-handle' }, advance);
  }
  updateInteriors();
  const walking = cameraRig.mode === 'walk';
  if (walking) updateWalk(wall);
  const frontFrame = scene.frontFrame(sim);
  cameraRig.update({
    frame: frontFrame,
    trainLength: trainLength(),
    cabPosition: scene.cabPosition,
    cabQuaternion: scene.cabQuaternion,
    walkPosition: walking ? walkPosition : undefined,
    walkQuaternion: walking ? walkQuaternion : undefined,
  });
  // 降水はカメラが定まってから動かす（巻き戻しの箱をカメラに合わせるため）。
  // 空も同じ理由でここで運ぶ。
  scene.moveSky(cameraRig.camera.position);
  // 降りの速さは実時間で見る。一時停止なら止め、早送りでも実時間より速くしない
  // （8 倍で降らせると絵が読めなくなる）。
  const weatherDt = Math.min(advance, wall);
  trainVelocity.copy(frontFrame.forward).multiplyScalar(sim.speed);
  precipitation.update(
    weatherDt,
    cameraRig.camera.position,
    trainVelocity,
    // トンネルの中では降らない
    scene.inTunnel(sim.dynamics.frontPosition) ? 0 : 1,
  );
  presenter.render(scene.scene, cameraRig.camera);
  hud.update(sim, CAMERA_LABEL[cameraRig.mode], RATES[rateIndex]!, paused, handles);
  touchConsole.update(handles, CAMERA_LABEL[cameraRig.mode], autoDrive, paused);
  gmeter.draw(sim);
  charts.draw();
}

scene.scene.add(cameraRig.camera);
applyCameraMode(parseCameraMode(window.location.search) ?? 'cab');
setTouchConsole(touchOverride ?? prefersTouchConsole());
setMuted(false);
updateRateLabel();
resize();
requestAnimationFrame(frame);
