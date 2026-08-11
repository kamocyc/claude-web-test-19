import * as THREE from 'three';
import {
  InputRecorder,
  Simulation,
  replay,
  type Recording,
  type Scenario,
} from '@railsim/core';
import { createDefaultLibrary } from '@railsim/data';
import { ChartPanel } from './charts/panel.ts';
import { DriverDesk } from './input/keyboard.ts';
import { CAMERA_LABEL, CameraRig, type CameraMode } from './render/cameras.ts';
import { TrackScene } from './render/scene.ts';
import { Hud } from './ui/hud.ts';

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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const cameraRig = new CameraRig(canvas);
const hud = new Hud(hudElement);
const charts = new ChartPanel(chartsElement);

for (const id of library.scenarioIds) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = library.scenarioName(id);
  scenarioSelect.append(option);
}

let scenarioId = library.scenarioIds[0]!;
let scenario: Scenario = library.scenario(scenarioId);
let sim = new Simulation(scenario);
let scene = new TrackScene(scenario.route, sim);
let recorder = new InputRecorder();
let paused = false;
let rateIndex = RATES.indexOf(1);
let singleStep = false;
let sampleTimer = 0;
let replaying: Recording | null = null;

const desk = new DriverDesk({
  powerNotchCount: scenario.consist.traction.notchCount,
  brakeNotchCount: scenario.consist.brake.notchCount,
  onCameraChange: (mode: CameraMode) => cameraRig.setMode(mode),
  onPauseToggle: () => setPaused(!paused),
  onSingleStep: () => {
    singleStep = true;
  },
  onRateChange: (delta) => {
    rateIndex = Math.max(0, Math.min(RATES.length - 1, rateIndex + delta));
    updateRateLabel();
  },
});

function setPaused(value: boolean): void {
  paused = value;
  pauseButton.textContent = paused ? '再開' : '一時停止';
}

function updateRateLabel(): void {
  rateLabel.textContent = `${RATES[rateIndex]!.toFixed(2)}x`;
}

function restart(id = scenarioId): void {
  scenarioId = id;
  scenario = library.scenario(scenarioId);
  sim = new Simulation(scenario);
  scene = new TrackScene(scenario.route, sim);
  recorder = new InputRecorder();
  replaying = null;
  sampleTimer = 0;
  desk.reset();
  charts.clear();
  setPaused(false);
}

scenarioSelect.addEventListener('change', () => restart(scenarioSelect.value));
restartButton.addEventListener('click', () => restart());
pauseButton.addEventListener('click', () => setPaused(!paused));

saveButton.addEventListener('click', () => {
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
const trainLength = (): number =>
  scenario.consist.vehicles.reduce((a, v) => a + v.length, 0);

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

  if (replaying === null) {
    const advance = paused ? (singleStep ? 1 / 60 : 0) : wall * RATES[rateIndex]!;
    singleStep = false;
    if (advance > 0) {
      sim.input = desk.input;
      recorder.record(sim.elapsed, sim.input);
      sim.step(advance);
      sampleTimer += advance;
      if (sampleTimer >= SAMPLE_PERIOD) {
        charts.sample(sim);
        sampleTimer = 0;
      }
    }
  }

  scene.update(sim);
  cameraRig.update({ frame: scene.frontFrame(sim), trainLength: trainLength() });
  renderer.render(scene.scene, cameraRig.camera);
  hud.update(sim, CAMERA_LABEL[cameraRig.mode], RATES[rateIndex]!, paused);
  charts.draw();
}

cameraRig.setMode('chase');
updateRateLabel();
resize();
requestAnimationFrame(frame);
