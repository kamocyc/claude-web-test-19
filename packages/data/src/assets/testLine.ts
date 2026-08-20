import type { RouteDefinition } from '../schema/route.ts';

/** 分岐器の番数。#12 → リード R350・分岐制限 45km/h */
const TURNOUT_NUMBER = 12;
/** リード曲線の半径 [m]（#12 の標準値） */
const TURNOUT_RADIUS = 350;
/**
 * リード長 [m] = R α。分岐器の寸法はコンパイラが番数から求めるが、分岐側の線形は
 * 路線データの側で書くので、同じ寸法をここでも組み立てる。
 */
const LEAD = TURNOUT_RADIUS * Math.atan(1 / TURNOUT_NUMBER);
/**
 * リード曲線より先の部分の長さ [m]。
 * 分岐器の全長は `turnoutLengthOf()` でリード長の 1.4 倍になるので、その残り。
 * クロッシングの翼レールと護輪軌条が続く区間で、線形としては直線である。
 */
const TAIL = LEAD * 0.4;

/** 交換設備の入口（対向分岐器のトングレール先端）の距離程 [m] */
const LOOP_ENTRY = 40;
/** 交換設備の出口（背向分岐器のクロッシング）の距離程 [m] */
const LOOP_EXIT = 420;
/** 2 番線（副本線）のホーム部分の長さ [m]。入口の戻し曲線から出口の戻し曲線まで。 */
const PLATFORM_TRACK = LOOP_EXIT - LEAD - (LOOP_ENTRY + LEAD + TAIL + LEAD);
/** 交換設備の終わり（本線へ戻る点）の距離程 [m] */
const LOOP_END = LOOP_EXIT + TAIL + LEAD;

/** 側線への分岐器（下り出発方）の始端の距離程 [m] */
const SIDING_TURNOUT_AT = 6300;

/**
 * 保守基地への分岐器の始端の距離程 [m]。
 *
 * **ロングレール区間（2600〜4300m）の中**に置いてある。ロングレールでも分岐器の
 * 前後には軌道回路を区切る絶縁継目が入るので、継目音の無い区間を走っていて
 * ここだけ「タン…タン」と入る。分岐器そのものの音（トングレール・クロッシング）と
 * 合わせて、何を踏んだ音なのかが聴き分けられる。
 */
const DEPOT_TURNOUT_AT = 3950;

/**
 * 複線区間の入口（対向分岐器のトングレール先端）の距離程 [m]。
 *
 * ここから先は上下線が別々の線路になる。単線の交換設備と違って**すれ違いに
 * 場所も時刻も要らない**ので、対向列車とは互いに 100km/h 超のまま行き違う。
 */
const DOUBLE_ENTRY_AT = 6850;
/** 複線区間の出口（背向分岐器）の始端の距離程 [m]。ここで単線へ戻る。 */
const DOUBLE_EXIT_AT = 11800;
/**
 * 複線区間の線路中心間隔 [m]。
 *
 * 在来線（車両限界の幅 2900mm）の標準値。分岐器 1 組で寄る量（#12 で 3.38m）では
 * 420mm 足りないので、分岐器の先の緩い S 字で埋める（`passingLoop.ts`）。
 */
const DOUBLE_SPACING = 3.8;
/** 上り線へ渡る片渡り線の始端の距離程 [m]（複線区間の中ほど） */
const CROSSOVER_AT = 9660;
/** 終点の電留線への分岐器の始端の距離程 [m] */
const YARD_TURNOUT_AT = 13700;

/**
 * 架空の試験線「試験線（南武試験線）」。全長 14.2km。
 *
 * 物理・信号の検証に必要な要素をひととおり含む路線:
 *
 *  - 平面線形 — R600（C75）・R400（C90）・R800（C60）・R1200（C50）・R300（C65）。
 *    制限速度は許容カント不足 60mm から自動計算される（95・80・105・110・65km/h）。
 *  - 縦断線形 — 0 → 25‰ 上り → 0 → 33‰ 下り → 0 → 12‰ → −8‰ → 20‰ → −15‰ → 0
 *    （すべて縦曲線つき）
 *  - **単線 → 複線 → 単線**。6850〜11841m が複線区間で、そこだけは対向列車と
 *    すれ違うのに交換設備を要しない。9660m には上り線へ渡る片渡り線がある。
 *  - 起点駅（試験台）は**交換可能駅**。#12 分岐器 2 基で 1 番線と 2 番線に分かれる。
 *    単線区間で対向列車とすれ違えるのはここだけである。
 *  - 駅 5 つ（試験台・中原・稲田堤・向ヶ丘・登戸）とダイヤ
 *  - 閉塞信号機 17 基（約 1km 間隔）。ATS-P / ATS-SN の地上子は自動配置される。
 *  - 分岐器 8 基 — 交換設備 2・側線 1・保守基地 1・複線区間の出入口 2・
 *    片渡り線 1・電留線 1
 *  - トンネル 3 か所（単線 1・複線 1・単線 1）
 *  - 橋りょう 6 か所（無道床プレートガーダー・下路トラス・有道床コンクリート桁・
 *    有道床プレートガーダー）。桁の作りで音がまるで違う。
 *  - 踏切 6 か所（電子式 5・電鐘式 1）
 *
 * @param loop 起点駅で 2 番線（分岐側）を通るか
 */
function buildTestLine(loop: boolean): RouteDefinition {
  /**
   * 2 番線（副本線）の線形。
   *
   * 交換可能駅は、対向分岐器で本線から分かれ、本線と平行に走り、背向分岐器で
   * 戻る。分かれるときも戻るときも**リード曲線とその戻し曲線の 2 つで一組**に
   * なっていて、これで進行方向を変えずに横へ 3.4m ずれる（＝線路中心間隔）:
   *
   *   R(1 − cos α) + 護輪軌条部 sin α + R(1 − cos α) = 1.21 + 0.97 + 1.21 = 3.38m
   *
   * **緩和曲線もカントも無い**のがこの線形の要点である。分岐器のリード曲線は
   * 曲率が 0 から 1/R へ一段で立ち上がるので、横加速度が階段状に入る。本線の曲線
   * （80〜100m の緩和曲線つき）とは、同じ横 G でも体への来方がまるで違う。しかも
   * 戻し曲線で逆向きへ折り返すので、2 番線の出入りでは横 G が正負に振れる。
   *
   * 入口と出口で長さが揃っているので、**2 番線を通っても距離程は変わらない**。
   * 駅も信号機も勾配も 1 番線とまったく同じものが使える。
   */
  const loopHorizontal = [
    { length: LOOP_ENTRY },
    // 入口の対向分岐器。リード曲線で右へ α だけ振れ、そのあと護輪軌条部は直線
    { length: LEAD, radius: -TURNOUT_RADIUS, transition: 0 },
    { length: TAIL },
    // 戻し曲線。ここで本線と平行になる
    { length: LEAD, radius: TURNOUT_RADIUS, transition: 0 },
    // 2 番線のホーム（本線から 3.4m 横）
    { length: PLATFORM_TRACK },
    // 出口。本線へ向き直してから、背向分岐器の護輪軌条部 → リード曲線で合流する
    { length: LEAD, radius: TURNOUT_RADIUS, transition: 0 },
    { length: TAIL },
    { length: LEAD, radius: -TURNOUT_RADIUS, transition: 0 },
    { length: 1500 - LOOP_END },
  ];

  /**
   * 平面線形。距離程の合計は 14200m。
   *
   * 前半（〜8000m）は単線の山越え区間で、曲線半径も小さく制限が続く。8000m から
   * 先は複線化された高速区間にあたり、R800 → R1200 と半径が大きくなって線路
   * 最高速度で走れるようになる。終点の手前だけ R300（65km/h）で、市街地へ入る
   * ために線形が急に悪くなる — 実物の路線でよくある「終端に近いほど線形が古い」
   * という形をそのまま置いてある。
   */
  const horizontal = [
    ...(loop ? loopHorizontal : [{ length: 1500 }]),
    { length: 800, radius: 600, transition: 80, cant: 75 },
    { length: 700, transition: 80 },
    { length: 1200 },
    { length: 800, radius: -400, transition: 100, cant: 90 },
    { length: 600, transition: 100 },
    { length: 2400 },
    // --- ここから複線区間を含む後半 ---
    { length: 900, radius: -800, transition: 90, cant: 60 },
    { length: 600, transition: 90 },
    { length: 1100 },
    { length: 900, radius: 1200, transition: 100, cant: 50 },
    { length: 600, transition: 100 },
    { length: 900 },
    // 終点手前の市街地。R300・65km/h 制限
    { length: 600, radius: -300, transition: 60, cant: 65 },
    { length: 600, transition: 60 },
  ];

  const vertical = [
    { length: 2000, grade: 0 },
    { length: 1200, grade: 25, verticalCurve: 200 },
    { length: 1400, grade: 0, verticalCurve: 200 },
    { length: 1400, grade: -33, verticalCurve: 200 },
    { length: 2000, grade: 0, verticalCurve: 200 },
    // 複線区間は勾配も緩い（線増のときに改良された区間、という想定）
    { length: 1200, grade: 12, verticalCurve: 300 },
    { length: 1600, grade: -8, verticalCurve: 300 },
    { length: 1600, grade: 20, verticalCurve: 250 },
    // 下り 15‰ は R300 の**手前で終わらせてある**。制限 65km/h の曲線を下り勾配の
    // 途中に置くと、ブレーキが勾配に食われて ATS-P のパターンに触りやすくなる。
    // 実物でも、速度制限のある曲線は勾配が落ち着いたところへ置くのが定石で、
    // やむをえず勾配中に置くときは速度制限予告の標識を建てて手前から絞らせる。
    { length: 600, grade: -15, verticalCurve: 250 },
    { length: 1200, grade: 0, verticalCurve: 200 },
  ];

  return {
    id: loop ? 'test-line-loop' : 'test-line',
    name: loop ? '試験線（2 番線経由）' : '試験線',
    gauge: 1067,
    maxSpeed: 110,
    sampleStep: 2,

    horizontal,
    vertical,

    /**
     * トンネル 3 か所。
     *
     * `tunnel-2` は**複線区間の中**にあるので、断面が単線トンネルの倍近くある。
     * 断面積が大きいぶん列車が押しのける空気の逃げ場があり、坑口の圧力波も
     * 車内の耳の詰まりも単線トンネルより穏やかになる — 新線が複線断面で
     * 掘られる理由のひとつがこれである。
     */
    tunnels: [
      { id: 'tunnel-1', start: 4700, end: 5900 },
      { id: 'tunnel-2', start: 9800, end: 10300 },
      { id: 'tunnel-3', start: 12550, end: 12950 },
    ],

    /**
     * 分岐器 8 基。
     *
     * `to-1` / `to-2` は起点駅の交換設備で、開通方向が 1 番線と 2 番線を分ける。
     * **どちらの番線を通っても分岐器そのものは同じ場所に同じ寸法である**ため、
     * 1 番線でもトングレールとクロッシングの衝撃は出る。違うのは、分岐側では
     * 欠線を踏むレールが反対側になること、トングレールで輪軸が曲げられること、
     * そしてリード曲線の横 G が加わることである。
     *
     * `to-2` を `side: 'left'` としているのは背向だからである。分岐器の向きは
     * その分岐器を**対向で見たとき**に分岐側がどちらへ出るかで決まり、背向で
     * 進入する列車から見ると左右が入れ替わる。2 番線から本線へ戻る列車は左へ
     * 寄るので、トングレールでのふらつきも左向きになる。
     *
     * `to-3` は側線への分岐器で、本線側へ開通したままにしてある。分岐側の進路が
     * 無い（＝速度制限も無い）ので、線路最高速度のまま欠線を踏むことになる。
     *
     * `to-5` / `to-6` は複線区間の出入口である。交換設備の分岐器とまったく同じ
     * 寸法で、違うのは**そのあいだが 5km あること**だけである。すなわち複線とは
     * 「交換設備をどこまでも長くしたもの」であり、線路が 2 本ある区間の長さが
     * すれ違いの自由度をそのまま決めている。
     *
     * `to-7` は上り線へ渡る片渡り線。分岐側が隣の線路へつながっているので、
     * 離れていく枝ではなく**リード曲線と戻し曲線で隣へ乗り移る**線形になり、
     * 向こう側の端にはもう 1 基の分岐器が背中合わせに据わる。直進側を通る限り
     * 制限は無いが、クロッシングは 2 か所ぶん（自分の分と相手の分）ある。
     */
    turnouts: [
      {
        id: 'to-1',
        at: LOOP_ENTRY,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: loop ? 'diverging' : 'through',
      },
      {
        id: 'to-2',
        at: LOOP_EXIT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'trailing',
        route: loop ? 'diverging' : 'through',
      },
      {
        id: 'to-3',
        at: SIDING_TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: 'through',
      },
      {
        id: 'to-4',
        at: DEPOT_TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'facing',
        route: 'through',
      },
      {
        id: 'to-5',
        at: DOUBLE_ENTRY_AT,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: 'through',
      },
      {
        id: 'to-6',
        at: DOUBLE_EXIT_AT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'trailing',
        route: 'through',
      },
      {
        id: 'to-7',
        at: CROSSOVER_AT,
        number: TURNOUT_NUMBER,
        side: 'right',
        orientation: 'facing',
        route: 'through',
        crossover: true,
      },
      {
        id: 'to-8',
        at: YARD_TURNOUT_AT,
        number: TURNOUT_NUMBER,
        side: 'left',
        orientation: 'facing',
        route: 'through',
      },
    ],

    /**
     * 隣に線路がある区間 2 か所。
     *
     * `loop-a` は起点駅の交換設備で、線路中心間隔も、隣の線路がどちら側にあるかも
     * 書いていない。どちらも分岐器の番数と開通方向から決まるからで、#12 なら
     * 3.38m、1 番線を走っていれば右、2 番線を走っていれば左になる。
     *
     * `double-a` は複線区間で、こちらだけ `spacing` を書く。複線の線路中心間隔を
     * 決めているのは分岐器ではなく**建築限界**（在来線の標準 3.8m）だからで、
     * 分岐器で寄るぶんとの差 420mm を、分岐器の先 140m の緩い S 字（R ≈ 11700m）で
     * 埋める。乗っている側には直線と区別が付かない。
     *
     * 自列車は左の線路を走る（日本の鉄道は左側通行）ので、隣の線路 = 上り線は
     * 右側になる。入口の分岐器を `side: 'right'` にしてあるのがそれを決めている。
     */
    passingLoops: [
      { id: 'loop-a', entry: 'to-1', exit: 'to-2' },
      { id: 'double-a', entry: 'to-5', exit: 'to-6', spacing: DOUBLE_SPACING, wideningLength: 140 },
    ],

    /**
     * 橋りょう 6 か所。**同じ「橋」でも音がまったく違う**ことを聴き比べられるよう、
     * 桁の作りを変えてある。音を決めているのは形式の名前ではなく、
     * 「加振力が桁へ届くか（床の作り）」と「その板がどれだけ動くか（板厚）」の 2 つで、
     * 名前はその結果に付いているにすぎない。
     *
     * | 橋   | 形式・床                     | 音 |
     * | ---- | ---------------------------- | -- |
     * | br-1 | 上路プレートガーダー・無道床 | 桁に直結。腹板が 60〜250Hz で鳴り、渡るあいだじゅう轟音になる |
     * | br-2 | 下路トラス・無道床           | 床組の板が薄く小さいので音程が高い。主構が両脇にあるのでよく反響する |
     * | br-3 | コンクリート桁・有道床       | 道床が力を食い、厚い床版はそもそも動かない。ほとんど音が変わらない |
     * | br-4 | プレートガーダー・有道床     | 同じ鋼桁でも、道床を入れるだけで br-1 より 1 桁静かになる |
     * | br-5 | コンクリート桁・有道床       | 複線区間の橋。断面が広いぶん桁は厚く、いっそう動かない |
     * | br-6 | 下路トラス・無道床           | br-2 と同じ作りを、線路最高速度で渡る |
     *
     * br-1 は**ロングレール区間の中**にある。無道床橋では桁が温度で伸び縮みするので
     * 両端に伸縮継目が入り、継目音の無い区間を走っていて橋の前後だけ「シャッ」と鳴る。
     */
    bridges: [
      { id: 'br-3', name: '第一試験川橋りょう', start: 1900, end: 1980, kind: 'concrete' },
      { id: 'br-1', name: '第二試験川橋りょう', start: 2950, end: 3060, kind: 'plate-girder' },
      { id: 'br-2', name: '試験峡谷橋りょう', start: 4380, end: 4460, kind: 'truss' },
      {
        id: 'br-4',
        name: '試験用水路橋りょう',
        start: 6600,
        end: 6660,
        kind: 'plate-girder',
        deck: 'ballasted',
      },
      { id: 'br-5', name: '向ヶ丘架道橋', start: 11000, end: 11080, kind: 'concrete' },
      { id: 'br-6', name: '第三試験川橋りょう', start: 12300, end: 12420, kind: 'truss' },
    ],

    /**
     * 踏切 6 か所。
     *
     * 警報音は踏切のスピーカから**道路へ向けて**鳴っている音で、運転台はそれを
     * 通りすがりに聞く。したがって近づけば大きく高く、通り過ぎれば小さく低く
     * 聞こえる — 音程の下がり幅は自分の速度が決めるので、110km/h で通れば
     * 全音以上、25km/h なら気付かない程度になる。
     *
     * xg-2 だけ電鐘式（電磁石でハンマーが鐘を叩く旧式）にしてある。電子式の
     * 「カン カン」と違い、音程を持たない金属音が余韻を引くので、同じ踏切でも
     * 方式で聞こえ方がまるで違うことが分かる。
     *
     * xg-4 は複線区間の踏切なので、道路が渡る線路が 2 本ぶんある。
     */
    levelCrossings: [
      { id: 'xg-1', name: '試験台踏切', at: 1300, roadWidth: 7, surface: 'rubber' },
      {
        id: 'xg-2',
        name: '中原第二踏切',
        at: 3800,
        roadWidth: 4.5,
        surface: 'concrete',
        bell: 'gong',
        // 中原駅の出発方すぐにあるので、制御子は駅の先に置く。既定の
        // 「警報時間 × 最高速度」で置くとホームの手前まで届いてしまい、
        // 停車しているあいだじゅう鳴りっぱなしになる。実物の踏切制御も同じ理由で
        // 駅の近くでは制御子を駅の出発側へ寄せる（発車直後の列車は遅いので、
        // 短い距離でも警報時間は足りる）。
        warningDistance: 250,
      },
      { id: 'xg-3', name: '終端街道踏切', at: 6800, roadWidth: 12, surface: 'rubber' },
      { id: 'xg-4', name: '稲田堤第三踏切', at: 9350, roadWidth: 9, surface: 'rubber' },
      { id: 'xg-5', name: '試験坂踏切', at: 12200, roadWidth: 5.5, surface: 'concrete' },
      { id: 'xg-6', name: '登戸街道踏切', at: 13800, roadWidth: 14, surface: 'rubber' },
    ],

    /**
     * 駅 5 つ。
     *
     * 試験台は交換可能駅（1・2 番線）、稲田堤と向ヶ丘は複線区間の駅、登戸は終点で
     * 車止めがある。所要時分は 8 分から 14 分半へ延びた。
     */
    stations: [
      {
        id: 'stn-a',
        name: '試験台',
        stopPosition: 300,
        platformStart: 180,
        platformEnd: 320,
        dwellTime: 30,
        departureTime: '10:00:30',
      },
      {
        id: 'stn-b',
        name: '中原',
        stopPosition: 3500,
        platformStart: 3380,
        platformEnd: 3520,
        dwellTime: 30,
        arrivalTime: '10:03:20',
        departureTime: '10:03:50',
      },
      {
        id: 'stn-c',
        name: '稲田堤',
        stopPosition: 7200,
        platformStart: 7080,
        platformEnd: 7220,
        dwellTime: 30,
        arrivalTime: '10:07:10',
        departureTime: '10:07:40',
      },
      {
        id: 'stn-d',
        name: '向ヶ丘',
        stopPosition: 10600,
        platformStart: 10480,
        platformEnd: 10620,
        dwellTime: 30,
        arrivalTime: '10:10:40',
        departureTime: '10:11:10',
      },
      {
        id: 'stn-e',
        name: '登戸',
        stopPosition: 14100,
        platformStart: 13980,
        platformEnd: 14120,
        dwellTime: 60,
        arrivalTime: '10:14:30',
      },
    ],

    signals: [
      { id: 'sig-1', at: 200, kind: 'starting' },
      { id: 'sig-2', at: 1200 },
      { id: 'sig-3', at: 2200 },
      { id: 'sig-4', at: 3200, kind: 'home' },
      { id: 'sig-5', at: 4200, kind: 'starting' },
      { id: 'sig-6', at: 5200 },
      // 側線への分岐器を防護する信号機は分岐器の手前に置く
      { id: 'sig-7', at: SIDING_TURNOUT_AT - 250 },
      { id: 'sig-8', at: 7000, kind: 'home' },
      { id: 'sig-9', at: 7400, kind: 'starting' },
      { id: 'sig-10', at: 8400 },
      { id: 'sig-11', at: 9400 },
      { id: 'sig-12', at: 10400, kind: 'home' },
      { id: 'sig-13', at: 10800, kind: 'starting' },
      // 複線が単線へ戻る分岐器を防護する信号機
      { id: 'sig-14', at: DOUBLE_EXIT_AT - 200 },
      { id: 'sig-15', at: 12600 },
      { id: 'sig-16', at: 13400 },
      { id: 'sig-17', at: 13950, kind: 'home' },
    ],

    aspectSpeeds: { R: 0, YY: 25, Y: 45, YG: 75, G: 110 },

    /**
     * レールは定尺 25m を基本とし、2 か所をロングレールにしてある。同じ速度でも
     * 継目音の有無で走行音がはっきり変わるので、「ガタン ゴトン」が編成の寸法から
     * 出ていることを聞いて確かめられる。
     *
     * トンネル（4700〜5900m）はあえて定尺のままにしてある。トンネルの反響が
     * いちばん分かるのは継目の衝撃が響くときで、ロングレールを重ねてしまうと
     * その組み合わせが試せないため。
     *
     * 2600〜4300m には波状摩耗を深めに与えてある。継目音が無いぶん、高速で
     * 走ると `速度 / 波長` のうなりが主役になり、加速するにつれて音程が上がって
     * いくのが聞き取れる。R600 曲線の出口にあたるので、波状摩耗が育ちやすい
     * 場所という点でも無理がない。
     *
     * 7500〜12000m は複線区間のロングレールである。線路最高速度で走り続ける
     * 区間なので、実物でも真っ先にロングレール化される。
     *
     * ロングレール区間の中には**橋りょうと分岐器と踏切**がある。継目が無いはずの
     * 区間でも、そこだけは音がする:
     *
     *  - 橋の両端 — 桁の伸縮を逃がす伸縮継目（レール端を斜めに削いで重ねてある
     *    ので、段差を踏まずに乗り移る「シャッ」）
     *  - 分岐器の前後 — 軌道回路を区切る絶縁継目（遊間が樹脂で埋まっているので
     *    段差がほとんど無く、硬く短い「タン」）
     *  - 踏切道の入口と出口 — 舗装と踏切板の目地（弾性体なので鈍い「ゴトッ」）
     *
     * どれも「継目を無くせない場所で、衝撃をできるだけ小さくする」構造なので、
     * 定尺の突合せ継目の「ガタン」とは音が違う。
     */
    rail: {
      spacing: 25,
      corrugation: 0.2,
      sections: [
        { start: 2600, spacing: 0, corrugation: 0.65 },
        { start: 4300, spacing: 25, corrugation: 0.2 },
        { start: 7500, spacing: 0, corrugation: 0.35 },
        { start: 12000, spacing: 25, corrugation: 0.2 },
      ],
    },

    autoCurveLimits: { enabled: true, maxCantDeficiency: 60, roundDown: 5 },
    autoAtsP: { enabled: true },
    autoAtsSn: { enabled: true },
  };
}

/** 試験線（起点駅は 1 番線＝本線側。14.2km） */
export const testLineRoute: RouteDefinition = buildTestLine(false);

/**
 * 試験線（起点駅の 2 番線＝副本線を通る）。
 *
 * 交換可能駅なので、2 番線へ入っても行き先は変わらない。**分かれてすぐ戻る**ため
 * 距離程も駅も信号機も 1 番線と同じで、違うのは 40〜460m の線形だけである。
 * 発車のたびに #12 分岐器の分岐側（45km/h 制限）を渡ることになるので、制限を
 * 守って出るか、渡りきるまで加速を待つか、という運転そのものが変わる。
 */
export const testLineLoopRoute: RouteDefinition = buildTestLine(true);
