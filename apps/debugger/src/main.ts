import * as THREE from 'three';
import { InputRecorder, Simulation, replay, type Recording, type Scenario } from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';
import { TrainAudio } from './audio/engine.ts';
import { ChartPanel } from './charts/panel.ts';
import { DriverDesk } from './input/keyboard.ts';
import { createCabInterior } from './render/cab.ts';
import { CAMERA_LABEL, CameraRig, type CameraMode } from './render/cameras.ts';
import { TrackScene } from './render/scene.ts';
import { GMeter } from './ui/gmeter.ts';
import { Hud } from './ui/hud.ts';
import { Mixer } from './ui/mixer.ts';

const RATES = [0.1, 0.25, 0.5, 1, 2, 4, 8];
/** グラフのサンプリング周期 [s]（描画フレームごとだと細かすぎる） */
const SAMPLE_PERIOD = 0.05;

const library = createDefaultLibrary();

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hudElement = document.querySelector<HTMLElement>('#hud')!;
const chartsElement = document.querySelector<HTMLElement>('#charts')!;
const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!;
const restartButton = document.querySelector<HTMLButtonElement>('#restart')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const rateLabel = document.querySelector<HTMLElement>('#rate')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const loadInput = document.querySelector<HTMLInputElement>('#load')!;
const gmeterElement = document.querySelector<HTMLElement>('#gmeter')!;
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const mixerElement = document.querySelector<HTMLElement>('#mixer')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// 影を落とす。柔らかい影（PCF）にしないと、レールやまくらぎの細い影が
// 拡大されたドットの列に見えてしまう。
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

for (const id of library.scenarioIds) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = library.scenarioName(id);
  scenarioSelect.append(option);
}

let scenarioId = library.scenarioIds[0]!;
let scenario: Scenario = library.scenario(scenarioId);
let sim = new Simulation(scenario);
let scene = new TrackScene(scenario.route, sim, renderer);
let recorder = new InputRecorder();
let paused = false;
let rateIndex = RATES.indexOf(1);
let singleStep = false;
let sampleTimer = 0;
let replaying: Recording | null = null;
/** 自動運転の入切（シナリオを切り替えても保つ） */
let autoDrive = false;

const desk = new DriverDesk({
  powerNotchCount: () => scenario.consist.traction.notchCount,
  brakeNotchCount: () => scenario.consist.brake.notchCount,
  onCameraChange: (mode: CameraMode) => applyCameraMode(mode),
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
});

function applyCameraMode(mode: CameraMode): void {
  cameraRig.setMode(mode);
  cabInterior.group.visible = mode === 'cab';
  scene.setLeadCarVisible(mode !== 'cab');
}

/**
 * 自動運転の入切。
 * 切るときは、装置が握っていたノッチをそのまま運転士のハンドル位置へ引き継ぐ
 * （でないと、ブレーキ中に切り替えた瞬間に緩解して走り出してしまう）。
 */
function setAutoDrive(value: boolean): void {
  if (!value && autoDrive) {
    const held = sim.effectiveInput;
    desk.takeOver(held.powerNotch, held.brakeNotch, held.doorsClosed);
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

function restart(id = scenarioId): void {
  scenarioId = id;
  scenario = library.scenario(scenarioId);
  sim = new Simulation(scenario);
  scene = new TrackScene(scenario.route, sim, renderer);
  // カメラの子（運転席内装）を描画させるため、カメラをシーングラフに入れる
  scene.scene.add(cameraRig.camera);
  recorder = new InputRecorder();
  replaying = null;
  sampleTimer = 0;
  desk.reset();
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

// AudioContext はユーザ操作の中でしか開始できない。画面のどこを触っても解錠する。
canvas.addEventListener('pointerdown', () => startAudio());
muteButton.addEventListener('click', () => {
  releaseFocus(muteButton);
  startAudio();
  setMuted(!audio.isMuted);
});
scenarioSelect.addEventListener('change', () => {
  releaseFocus(scenarioSelect);
  restart(scenarioSelect.value);
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
  if (!library.scenarioIds.includes(recording.scenarioId)) {
    window.alert(`記録のシナリオ "${recording.scenarioId}" が見つかりません`);
    loadInput.value = '';
    return;
  }
  restart(recording.scenarioId);
  scenarioSelect.value = recording.scenarioId;
  replaying = recording;
  // 記録どおりに再生する（入力以外に外部依存が無いので同じ走行が再現される）
  replay(sim, recording, SAMPLE_PERIOD, (s) => charts.sample(s));
  replaying = null;
  loadInput.value = '';
});

/** 編成長 [m] */
const trainLength = (): number => scenario.consist.vehicles.reduce((a, v) => a + v.length, 0);

function resize(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  cameraRig.resize(width, height);
}
window.addEventListener('resize', resize);

let previous = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  const wall = Math.min((now - previous) / 1000, 0.25);
  previous = now;
  resize();

  let advance = 0;
  if (replaying === null) {
    // 一時停止中でもハンドル位置は反映する（再開した瞬間に効くのではなく、
    // 手元の操作がその場で計器と HUD に出るほうが運転台として自然）。
    sim.input = desk.input;
    advance = paused ? (singleStep ? 1 / 60 : 0) : wall * RATES[rateIndex]!;
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
  }

  // 自動運転中は装置が動かしているノッチを「手元」として表示・描画する
  const held = sim.effectiveInput;
  const handles = autoDrive
    ? {
        power: held.powerNotch,
        brake: held.brakeNotch,
        emergency: held.emergency,
        doorsClosed: held.doorsClosed,
      }
    : desk.handles;

  // 音は「シミュレーション時間が進んだか」で判断する。一時停止中は advance が 0 に
  // なるので、止まった絵に音だけが鳴り続けることはない。
  audio.update(sim, advance, wall);
  mixer.update(audio.levels);
  scene.update(sim);
  if (cameraRig.mode === 'cab') cabInterior.update(sim, handles);
  cameraRig.update({
    frame: scene.frontFrame(sim),
    trainLength: trainLength(),
    cabPosition: scene.cabPosition,
    cabQuaternion: scene.cabQuaternion,
  });
  renderer.render(scene.scene, cameraRig.camera);
  hud.update(sim, CAMERA_LABEL[cameraRig.mode], RATES[rateIndex]!, paused, handles);
  gmeter.draw(sim);
  charts.draw();
}

scene.scene.add(cameraRig.camera);
applyCameraMode('cab');
setMuted(false);
updateRateLabel();
resize();
requestAnimationFrame(frame);
