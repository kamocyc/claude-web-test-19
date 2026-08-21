import * as THREE from 'three';
import {
  scheduledTrainState,
  type CompiledRoute,
  type Meters,
  type Simulation,
} from '@railsim/core';
import { buildCatenary } from './catenary.ts';
import { makeFrameAt, type TrackFrame } from './frame.ts';
import { buildHorizon, buildScenery, buildTunnels } from './scenery.ts';
import { aimShadowBox, createDaylight, createSky, type SkyHandle } from './sky.ts';
import { coatMaterial, fogDensity, surfaceCoat, weatherLook, type WeatherLook } from './weather.ts';
import { buildTrack, buildTurnouts } from './track.ts';
import {
  buildBridges,
  buildLevelCrossings,
  groundDepressionAt,
  type CrossingHandle,
} from './structures.ts';
import { buildCar, type FrontLights } from './vehicle.ts';
import { buildCarInterior, type CarInterior } from './interior.ts';
import {
  buildBeacons,
  buildDistancePosts,
  buildCurvePosts,
  buildGradePosts,
  buildSignals,
  buildStations,
  type SignalHandle,
} from './wayside.ts';
import { CAR } from './dimensions.ts';
import { createEnvironment, grassSurface } from './textures.ts';

const GROUND_COLOR = 0x87a06a;

/**
 * 運転席の位置（先頭車の前端からの距離・中心からの左右・レール面からの高さ）。
 *
 * 実物の 20m 級通勤形の運転室にならい、前端から 1550mm 後ろ・車体中心から
 * 左へ 700mm、床面（レール面上 1130mm）から 1200mm の高さに目を置く。
 * 運転台の内装（`cab.ts`）もこの目の位置を原点として組んである。
 */
const CAB_OFFSET = {
  back: 1.55,
  left: CAR.driverOffset,
  height: CAR.floorHeight + CAR.eyeHeight,
};

/**
 * 軌道・列車・信号・駅・沿線の景観を描画するシーン。
 *
 * 構造物はどれも実物の寸法（`dimensions.ts`）から組み立てる。レールは 50kgN の
 * 断面を掃引した立体、まくらぎは PC まくらぎを 25m あたり 44 本、架線は
 * シンプルカテナリを偏位とたるみ込みで、というように、形が「それらしさ」ではなく
 * 実際の寸法で決まるようにしてある。
 *
 * 車両は軌道の座標系に置いたうえで、車体動揺（ロール・ピッチ・ヨー・左右・上下）を
 * 局所回転として重ねる。運転席視点のカメラも同じ変換から作るため、
 * 曲線でのロールや軌道狂いによる揺れがそのまま視界に出る。
 */
export class TrackScene {
  readonly scene = new THREE.Scene();
  /** この走行の天気（降水の側もこれを見る） */
  readonly look: WeatherLook;
  private readonly sky: SkyHandle;
  private readonly vehicleMeshes: THREE.Object3D[] = [];
  /** 自列車の客室内装（車体と同じ数だけある。車内を歩くモードが使う） */
  private readonly interiors: CarInterior[] = [];
  private frontLights: FrontLights | undefined;
  private rearLights: FrontLights | undefined;
  private readonly signalHandles: Map<string, SignalHandle>;
  private readonly crossingHandles: Map<string, CrossingHandle>;
  /** ダイヤ列車（先行列車・対向列車）の車体 */
  private readonly scheduledTrains: ScheduledTrainView[] = [];
  private readonly route: CompiledRoute;
  private readonly frameAt: (s: number) => TrackFrame;
  private readonly sun: THREE.DirectionalLight;
  /** 運転席視点の位置と姿勢（update() で更新される） */
  readonly cabPosition = new THREE.Vector3();
  readonly cabQuaternion = new THREE.Quaternion();

  /**
   * @param renderer 環境マップを焼くのに使う。渡すと金属が空を映すようになる
   */
  constructor(route: CompiledRoute, sim: Simulation, renderer?: THREE.WebGLRenderer) {
    this.route = route;
    this.frameAt = makeFrameAt(route);
    // 天気は踏面の状態（走りに効く量）から引く。選び直すと組み直されるので、
    // ここで 1 度読めばよい。
    const look = weatherLook(sim.scenario.railCondition);
    this.look = look;
    this.scene.background = new THREE.Color(look.background);
    // 霞は指数で掛ける。手前は締まったまま、遠景だけが空の色へ溶ける
    // （線形の霧では近景まで一様に白んでしまう）。
    this.scene.fog = new THREE.FogExp2(look.fog.color, fogDensity(look));

    this.sky = createSky(look);
    this.scene.add(this.sky.mesh);
    const { sun, ambient } = createDaylight(look);
    this.sun = sun;
    this.scene.add(sun, sun.target, ambient);
    // 金属の映り込みの元。レールの頭頂面・ステンレスの車体・架線金具は、
    // これが無いと「映すものが無い金属」になって黒く沈む。
    if (renderer) {
      this.scene.environment = createEnvironment(look, renderer);
      // 映り込みの元としては十分で、かつ影の中を照らしすぎない強さ。
      // 半球光（`ambient`）と足し合わさるので、両方を強くすると影が消える。
      this.scene.environmentIntensity = 0.34;
    }

    const inTunnel = (s: number): boolean => route.tunnels.at(s).length > 0;

    // 影を落とす側は絞る。トンネルの覆工（中は日が差さない）、地上子、分岐器の
    // 細かい金物まで影の地図に描いても、手間のわりに絵は変わらない。
    this.buildGround();
    this.add(
      buildTrack(route, this.frameAt, (base) => surfaceCoat(base, look)),
      true,
    );
    this.add(buildTurnouts(route, this.frameAt), false);
    this.add(buildDistancePosts(route, this.frameAt), true);
    this.add(buildGradePosts(route, this.frameAt), true);
    this.add(buildCurvePosts(route, this.frameAt), true);
    this.add(buildStations(route, this.frameAt), true);
    this.add(buildBeacons(route, this.frameAt), false);
    this.add(buildTunnels(route, this.frameAt), false);
    this.add(buildBridges(route, this.frameAt), true);
    const crossings = buildLevelCrossings(route, this.frameAt);
    this.add(crossings.objects, true);
    this.crossingHandles = crossings.handles;
    this.add(buildCatenary(route, this.frameAt, inTunnel), true);
    this.add(buildScenery(route, this.frameAt, look), true);
    // 遠景の山なみ。地表の板が尽きるところに立てて、空と地面の境目を埋める
    this.add(buildHorizon(route, this.frameAt), false);

    const signals = buildSignals(route, this.frameAt);
    this.add(signals.objects, true);
    this.signalHandles = signals.handles;

    this.buildTrain(sim);
    this.buildScheduledTrains(sim);
    this.update(sim);
  }

  /**
   * 構造物をシーンに入れ、影の扱いを決める。
   *
   * 影を受けるのはすべての面。落とすのは `cast` を立てたものだけ。
   * 自ら光っている面（信号の灯火・トンネル照明・光のにじみ）は、影を
   * 落とすと光源が黒い板に見えてしまうので外す。
   */
  private add(objects: readonly THREE.Object3D[], cast: boolean): void {
    for (const object of objects) {
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.InstancedMesh)) return;
        const material = node.material as THREE.Material;
        if (material instanceof THREE.MeshBasicMaterial) return;
        node.receiveShadow = true;
        node.castShadow = cast;
      });
      this.scene.add(object);
    }
  }

  /**
   * 線路の両側の地表。
   * 平坦な板を置くと勾配区間で線路が地面に潜るため、軌道中心線に沿って高さを追従させる。
   * 盛土のり尻がちょうどこの面に接するよう、道床の断面と同じ -1.2m に置く。
   */
  private buildGround(): void {
    const step = 20;
    const n = Math.floor(this.route.length / step);
    // 横の刻み。線路の近くは細かく、遠くは粗く取る。等間隔にすると、
    // 線路際で欲しい細かさに合わせたぶんだけ遠くにも三角形が要る。
    const lanes = [
      -260, -180, -125, -85, -58, -38, -24, -14, -6, 0, 6, 14, 24, 38, 58, 85, 125, 180, 260,
    ];
    const m = lanes.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    let u = 0;
    let previous: THREE.Vector3 | null = null;
    const tint = new THREE.Color();
    for (let i = 0; i <= n; i++) {
      const s = Math.min(i * step, this.route.length);
      const f = this.frameAt(s);
      if (previous) u += f.position.distanceTo(previous);
      previous = f.position.clone();
      // 橋の下は谷か川なので、桁の下端より深く掘る。掘らないと地表の板が桁を
      // 突き抜けて「地面の上に架かった橋」になってしまう。
      const level = -1.2 - groundDepressionAt(this.route, s);
      for (const lane of lanes) {
        const p = f.position.clone().addScaledVector(f.right, lane);
        positions.push(p.x, p.y + level, p.z);
        // UV は m 単位。草の模様が線路の近くでも遠くでも同じ大きさになる
        uvs.push(u, lane);
        // 一面同じ緑の板は、どれだけ細かい模様を貼っても「板」に見える。
        // 実際の地面は、草地・枯れ草・裸地・畑が数十 m ごとに入れ替わる
        // まだら模様になっている。頂点の色でその大きなむらを作る。
        groundTint(tint, u, lane, this.look);
        colors.push(tint.r, tint.g, tint.b);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m - 1; j++) {
        const a = i * m + j;
        indices.push(a, a + m, a + 1, a + 1, a + m, a + m + 1);
      }
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const ground = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        ...coatMaterial(grassSurface().maps(7), 1, surfaceCoat(GROUND_COLOR, this.look)),
        // 地面は 1 枚を何十回も繰り返すので、凹凸を強くすると繰り返しが目に付く
        normalScale: new THREE.Vector2(0.45, 0.45),
        vertexColors: true,
        side: THREE.DoubleSide,
      }),
    );
    // 地表は影を受けるだけ。線路の周り数百 m を覆う 1 枚の板なので、
    // これ自身に影を落とさせると自分の裏側を陰にして縞が出る。
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  /**
   * 編成を組む。
   *
   * 両端の車が先頭車（運転室と前面を持つ）、中間は貫通の中間車。
   * 動力車かどうかは塗り分けではなく、屋根のパンタグラフと床下の主回路箱で示す。
   */
  private buildTrain(sim: Simulation): void {
    const cars = sim.dynamics.vehicles;
    for (let i = 0; i < cars.length; i++) {
      const veh = cars[i]!;
      const lead = i === 0 || i === cars.length - 1;
      const { group, lights } = buildCar(veh.spec, lead, i === 0);
      // 客室の内装は車体の子として付ける。車体動揺（ロール・ピッチ・左右）は
      // 車体に掛かるので、内装は車内から見て動かない — 実際の車内と同じで、
      // 揺れているのは車体のほうであり、乗っている側は窓の外が動くのを見る。
      const interior = buildCarInterior(veh.spec, lead, i === 0);
      group.add(interior.group);
      this.interiors.push(interior);
      this.add([group], true);
      this.vehicleMeshes.push(group);
      // 灯火は編成の前端・後端だけが持つ。どちらを前照灯にするかは逆転機で決まる。
      if (lights && i === 0) this.frontLights = lights;
      if (lights && i === cars.length - 1) this.rearLights = lights;
    }
  }

  /**
   * 前照灯と尾灯。
   *
   * 灯火は「列車が向いている先」に点ける。逆転機が前位なら前端が前照灯・後端が
   * 尾灯で、後位ならその逆になる（車体の向きは変わらない）。中立では前位の扱い。
   */
  setLights(on: boolean, high: boolean, reverser: 1 | 0 | -1): void {
    const backwards = reverser === -1;
    const head = backwards ? this.rearLights : this.frontLights;
    const tail = backwards ? this.frontLights : this.rearLights;
    head?.setHeadlight(on, high);
    head?.setTail(false);
    tail?.setHeadlight(false, high);
    tail?.setTail(on);
  }

  /**
   * ダイヤ列車の車体を組む。
   *
   * 先行列車は自分と同じ線路、対向列車は交換設備の隣の線路を走る。編成長から
   * 両数を割り出し、自分と同じ形式の車体を並べる（同じ路線を走る列車なので）。
   */
  private buildScheduledTrains(sim: Simulation): void {
    const spec = sim.scenario.consist.vehicles[0];
    if (!spec) return;
    for (const train of sim.scenario.scheduledTrains) {
      const cars = Math.max(1, Math.round(train.length / spec.length));
      const view = new ScheduledTrainView(train.id, train.track ?? 'own', spec.length);
      for (let i = 0; i < cars; i++) {
        const { group } = buildCar(spec, i === 0 || i === cars - 1, false);
        this.add([group], true);
        group.visible = false;
        view.cars.push(group);
      }
      this.scheduledTrains.push(view);
    }
  }

  /**
   * ダイヤ列車を時刻どおりの位置へ置く。
   *
   * 位置も向きも `scheduledTrainState()`（コア）が返すものをそのまま使う。
   * 距離程が減っていく列車は対向列車なので、車体も逆を向く。
   */
  private updateScheduledTrains(sim: Simulation): void {
    const adjacent = this.route.adjacentTrack;
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    for (const view of this.scheduledTrains) {
      const train = sim.scenario.scheduledTrains.find((t) => t.id === view.id);
      const state = train ? scheduledTrainState(train, sim.time) : null;
      if (!state) {
        for (const car of view.cars) car.visible = false;
        continue;
      }
      for (let i = 0; i < view.cars.length; i++) {
        const car = view.cars[i]!;
        // 先頭端は進行方向の先。編成はそこから後ろへ伸びる。
        const centre = state.leadPosition - state.direction * (i + 0.5) * view.carLength;
        const offset = view.track === 'adjacent' ? adjacent.offsetAt(centre) : 0;
        // 隣の線路が無いところ（交換設備の外）は単線なので、そこには置けない
        car.visible =
          centre >= 0 &&
          centre <= this.route.length &&
          (view.track === 'own' || adjacent.has(centre));
        if (!car.visible) continue;
        const f = this.frameAt(centre);
        car.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(f.forward, f.up, f.cantRight),
        );
        if (state.direction < 0) car.quaternion.multiply(flip);
        car.position.copy(f.position).addScaledVector(f.cantRight, offset);
      }
    }
  }

  /**
   * 車両の姿勢を更新する。
   *
   * 軌道の基準座標系（進行方向・カント込みの上方向・右方向）を作り、
   * そこへ車体動揺のロール・ピッチ・ヨーを局所回転として重ねる。
   * 左右・上下の変位も車体座標系で加える。
   */
  update(sim: Simulation): void {
    const scratch = new THREE.Quaternion();
    for (let i = 0; i < this.vehicleMeshes.length; i++) {
      const veh = sim.dynamics.vehicles[i]!;
      const mesh = this.vehicleMeshes[i]!;
      const f = this.frameAt(veh.s);
      const body = veh.body;

      const up = f.up;
      const right = f.cantRight;
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.forward, up, right));
      // 局所軸: X = 前、Y = 上、Z = 右
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), body.roll));
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -body.pitch));
      mesh.quaternion.multiply(scratch.setFromAxisAngle(new THREE.Vector3(0, 1, 0), body.yaw));

      mesh.position
        .copy(f.position)
        .addScaledVector(right, body.lateral)
        .addScaledVector(up, body.vertical);

      if (i === 0) {
        // 運転席は先頭車の前端寄り・左側
        this.cabQuaternion.copy(mesh.quaternion);
        const cabForward = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
        const cabRight = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
        const cabUp = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
        this.cabPosition
          .copy(mesh.position)
          .addScaledVector(cabForward, veh.spec.length / 2 - CAB_OFFSET.back)
          .addScaledVector(cabRight, -CAB_OFFSET.left)
          .addScaledVector(cabUp, CAB_OFFSET.height);
      }
    }

    for (const s of sim.signalling.snapshot()) {
      this.signalHandles.get(s.id)?.setAspect(s.aspect);
    }

    // 踏切の遮断桿と警報灯。鳴動も遮断も装置（`LevelCrossingSystem`）が決めていて、
    // ここはその状態を絵にするだけである。
    for (const state of sim.levelCrossings.states) {
      this.crossingHandles
        .get(state.crossing.id)
        ?.update(state.barrier, state.ringing, sim.elapsed);
    }

    this.updateScheduledTrains(sim);

    // 雲を流す。空だけが止まっていると、走っていても時間が経っていないように見える
    this.sky.setTime(sim.elapsed);

    // 影を焼く範囲を列車に追従させる。路線全体を 1 枚の影の地図に収めることは
    // できないので、列車の周り 100m ほどだけを高い解像度で焼く。
    const lead = this.vehicleMeshes[0];
    if (lead) {
      // 箱の置き方（前方へ寄せる・画素へ丸める）は `sky.ts` が決める。
      // 光源の距離と near/far は対になっているので、ここで別の値を書くと
      // 影が手前で切れる。
      aimShadowBox(
        this.sun.position,
        this.sun.target.position,
        lead.position,
        this.frameAt(sim.dynamics.vehicles[0]!.s).forward,
      );
    }
  }

  /**
   * 自列車の車両（先頭から順）。車内を歩くモードが、床の位置と車体の姿勢を
   * ここから引く。返すのは同じ配列ではないので、書き換えても壊れない。
   */
  get cars(): ReadonlyArray<{ readonly object: THREE.Object3D; readonly interior: CarInterior }> {
    return this.vehicleMeshes.map((object, i) => ({ object, interior: this.interiors[i]! }));
  }

  /** 運転席視点のとき、先頭車の車体を隠して視界を遮らないようにする */
  setLeadCarVisible(visible: boolean): void {
    const lead = this.vehicleMeshes[0];
    if (lead) lead.visible = visible;
  }

  /** 先頭車の位置と向き（外部視点カメラの追従用） */
  /**
   * 空をカメラへ運ぶ。
   *
   * 空は半径 5000m の球なのに路線は 8km ある。原点に置いたままだと終点側で
   * カメラが球の外へ出てしまい、空が消える。中心をカメラへ合わせておけば
   * どこにいても同じように見える（無限遠の空は動かして構わない）。
   */
  moveSky(camera: THREE.Vector3): void {
    this.sky.mesh.position.copy(camera);
  }

  /** その距離程がトンネルの中か（降水を止める判定に使う） */
  inTunnel(s: Meters): boolean {
    return this.route.tunnels.at(s).length > 0;
  }

  frontFrame(sim: Simulation): TrackFrame {
    return this.frameAt(sim.dynamics.vehicles[0]!.s);
  }
}

/** ダイヤ列車 1 本ぶんの車体 */
class ScheduledTrainView {
  readonly cars: THREE.Object3D[] = [];

  constructor(
    readonly id: string,
    readonly track: 'own' | 'adjacent',
    readonly carLength: number,
  ) {}
}

/**
 * 地表のまだら。
 *
 * 2 つの周期の違う波を掛け合わせて、数十 m 級のむらを作る。乱数ではなく
 * 位置の関数にしてあるので、**同じ場所は必ず同じ色になる**（決定論を壊さない）。
 * 値の幅は狭い。ここを広げると地面が斑（まだら）になりすぎて、
 * 「草が生えた土」ではなく「模様の描かれた板」に見えてしまう。
 */
function groundTint(out: THREE.Color, along: number, lateral: number, look: WeatherLook): void {
  const wave = (a: number, b: number, phase: number): number =>
    Math.sin(along / a + phase) * Math.cos(lateral / b + phase * 1.7);
  // 3 つの周期を重ねる。いちばん長い波（170m）が「田んぼの区画・空き地・
  // 造成地」くらいの大きさのむらを作り、短い波が縁を崩す。
  const n = 0.5 + 0.3 * wave(170, 130, 0.7) + 0.24 * wave(46, 39, 0) + 0.13 * wave(17, 13, 2.1);
  // 0 = 湿った濃い草地、1 = 乾いた裸地・枯れ草。線路から離れるほど手入れされない
  const dry = Math.min(1, Math.max(0, (n - 0.18) * 1.25));
  // 緑（草）と黄土（枯れ草・土）のあいだを行き来する。彩度を保ったまま
  // 明度だけ動かすと「照明のむら」に見えてしまうので、色相ごと動かす。
  out.setRGB(0.52 + dry * 1.05, 0.98 - dry * 0.28, 0.62 - dry * 0.28, THREE.SRGBColorSpace);
  // **雪が積もったら草のむらは見えない。** 頂点色は材質の色に掛かるので、
  // ここを枯れ草の黄土のままにしておくと、白いはずの雪原が砂色になる
  // （実際そうなった）。積もる割合ぶんだけ白＝「掛けても何も変わらない値」へ寄せる。
  if (look.surface.mix > 0) out.lerp(NEUTRAL, look.surface.mix);
}

/** 掛け算で何もしない色。雪に埋もれた地面の頂点色はこれへ寄る */
const NEUTRAL = new THREE.Color(1, 1, 1);
