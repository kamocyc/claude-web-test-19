/**
 * 描画に使う実物の寸法。
 *
 * この 1 ファイルに集めてあるのは、3D モデルの形が「それらしく見えるか」ではなく
 * **実物と同じ寸法か**で決まるようにするためである。値はすべて日本の在来線
 * （狭軌 1067mm・直流 1500V・20m 級通勤形電車）の標準値で、単位は m・rad。
 *
 * 主な出典:
 *  - レール断面: JIS E 1101（普通レール）50kgN レール
 *  - まくらぎ: JIS E 1201（PC まくらぎ）3 号、本線 1 級線 44 本 / 25m
 *  - 道床: 在来線 1 級線 まくらぎ下 250mm・肩幅 400mm・のり面 1:1.5
 *  - 架線: シンプルカテナリ トロリ線高さ 5000mm・システム高さ 960mm・
 *          ハンガー間隔 5m・偏位 ±200mm・標準径間 50m
 *  - 信号機: 色灯式 4 灯（5 現示）、灯器レンズ φ250mm、
 *          柱は軌道中心から 1900mm、灯器下端はレール面上 4200mm 以上
 *  - ホーム: 電車専用区間の高さ レール面上 1100mm、縁端は軌道中心から 1600mm
 *  - 車両: 20m 級 4 扉通勤形（連結面間 20000mm・車体幅 2950mm・
 *          床面高さ 1130mm・台車中心間 13800mm・車輪径 860mm）
 *
 * ## 座標の約束
 *
 * `TrackFrame.position` は**レール頭頂面（走行面）の軌道中心**にある。したがって
 * ここでの「高さ」はすべてレール面を 0 とした値で、レールそのものは -0.153..0 を占める。
 */

/** レール（50kgN・JIS E 1101） */
export const RAIL = {
  /** 高さ */
  height: 0.153,
  /** 底部幅 */
  baseWidth: 0.127,
  /** 頭部幅 */
  headWidth: 0.065,
  /** 腹部厚 */
  webThickness: 0.015,
  /** 定尺レール長（継目の位置に使う） */
  standardLength: 25,
} as const;

/** まくらぎ（PC まくらぎ 3 号相当） */
export const SLEEPER = {
  /** 長さ */
  length: 2.0,
  /** 上面の幅 */
  topWidth: 0.22,
  /** 底面の幅 */
  bottomWidth: 0.26,
  /** 高さ（レール座） */
  height: 0.19,
  /** 敷設間隔 [m]。本線 1 級線の 44 本 / 25m */
  spacing: 25 / 44,
} as const;

/** 道床と路盤 */
export const BALLAST = {
  /** まくらぎ下の道床厚 */
  depth: 0.25,
  /** 道床肩幅（まくらぎ端から） */
  shoulder: 0.4,
  /** のり面の勾配（水平 / 垂直） */
  slope: 1.5,
  /** 路盤肩の幅（道床のり尻から） */
  formationShoulder: 0.6,
  /** 路盤面から地表までの高さ（盛土） */
  embankment: 0.6,
  /** 盛土のり面の勾配 */
  embankmentSlope: 1.8,
} as const;

/** 架線（シンプルカテナリ・直流 1500V） */
export const CATENARY = {
  /** トロリ線高さ（レール面上） */
  contactHeight: 5.0,
  /** システム高さ（支持点でのトロリ線とちょう架線の間隔） */
  systemHeight: 0.96,
  /** 標準径間（支持点の間隔） */
  span: 50,
  /** ハンガーの間隔 */
  hangerSpacing: 5,
  /** 偏位（支持点で軌道中心から左右へ振る量） */
  stagger: 0.2,
  /** ちょう架線の径間中央でのたるみ */
  sag: 0.8,
  /** 電化柱の建植位置（軌道中心から。ホームと反対側に立てる） */
  poleOffset: 3.0,
  /** 電化柱の高さ（レール面上） */
  poleHeight: 8.0,
  /** トロリ線の直径（GT-SN 110mm² 相当） */
  contactDiameter: 0.0123,
  /** ちょう架線の直径（CdCu 65mm² 相当） */
  messengerDiameter: 0.0105,
} as const;

/**
 * 色灯式信号機（4 灯式 = 5 現示）。
 *
 * 灯器は上から 黄・緑・黄・赤 の 4 個で、
 * 停止 R = 赤、警戒 YY = 上下の黄 2 灯、注意 Y = 下の黄、
 * 減速 YG = 上の黄 + 緑、進行 G = 緑、という組み合わせで 5 現示を出す。
 */
export const SIGNAL = {
  /** レンズの直径 */
  lensDiameter: 0.25,
  /** 灯器（フードを含む外径） */
  unitDiameter: 0.33,
  /** フードの長さ */
  hoodLength: 0.3,
  /** 灯器の上下間隔 */
  unitPitch: 0.36,
  /** 背板の幅 */
  boardWidth: 0.5,
  /** 柱の直径 */
  mastDiameter: 0.165,
  /** 柱の建植位置（軌道中心から。進行方向左側） */
  offset: 2.2,
  /** 最下段（赤）の灯器の中心高さ（レール面上） */
  bottomLampHeight: 4.35,
} as const;

/** プラットホーム（電車専用区間） */
export const PLATFORM = {
  /** 高さ（レール面上） */
  height: 1.1,
  /** 縁端の軌道中心からの距離 */
  edgeOffset: 1.6,
  /** 幅 */
  width: 8.0,
  /** 点字ブロックの縁端からの位置と幅 */
  tactileOffset: 0.8,
  tactileWidth: 0.3,
  /** 上屋の高さ（ホーム面上）と柱の間隔 */
  roofHeight: 3.6,
  roofPitch: 5.0,
} as const;

/**
 * 20m 級 4 扉通勤形電車。
 *
 * 車体は腰部で最大幅 2950mm、床下へ向かって 2800mm へ絞る（裾絞り）。
 * 屋根は肩に R を持ち、中央がレール面上 3655mm になる。
 */
export const CAR = {
  /** 連結面間距離 */
  couplerLength: 20.0,
  /** 車体長（妻面間） */
  bodyLength: 19.5,
  /** 車体幅（腰部の最大幅） */
  bodyWidth: 2.95,
  /** 裾（床下）の幅 */
  skirtWidth: 2.8,
  /** 床面高さ（レール面上） */
  floorHeight: 1.13,
  /** 幕板上端（屋根の肩が始まる高さ） */
  shoulderHeight: 3.24,
  /** 屋根の高さ（レール面上・中央） */
  roofHeight: 3.655,
  /** 屋根の肩の丸み */
  roofRadius: 0.45,
  /** 台枠下端（床下機器の取付面） */
  underframeHeight: 0.94,
  /** 台車中心間距離 */
  bogieSpacing: 13.8,
  /** 固定軸距 */
  wheelbase: 2.1,
  /** 車輪径 */
  wheelDiameter: 0.86,
  /** 側扉の幅と高さ */
  doorWidth: 1.3,
  doorHeight: 1.85,
  /** 側扉の中心間隔（20m 4 扉の標準） */
  doorPitch: 4.82,
  /** 側窓の高さと下端（床面上） */
  windowHeight: 0.86,
  windowSill: 0.9,
  /** 運転室の長さ（先頭車の妻面から仕切りまで） */
  cabLength: 2.05,
  /** 運転士の着座位置（車体中心から左へ） */
  driverOffset: 0.7,
  /** 運転士の目の高さ（床面上） */
  eyeHeight: 1.2,
  /** パンタグラフの折りたたみ高さ（レール面上） */
  pantographFolded: 4.14,
} as const;

/** ATS 地上子（ATS-SN / ATS-P。まくらぎの上、軌道中心のやや左に置く） */
export const BEACON = {
  length: 0.66,
  width: 0.36,
  height: 0.13,
  /** 軌道中心からの偏り */
  offset: -0.28,
} as const;

/** 電気転てつ機（NS 形相当） */
export const POINT_MACHINE = {
  length: 1.0,
  width: 0.45,
  height: 0.42,
  /** 軌道中心からの距離（トングレール先端の脇） */
  offset: 2.0,
} as const;

/**
 * 単線トンネル（電化区間）の内空断面。
 *
 * 架線を張るため、非電化より高い断面を取る。側壁は起拱線まで垂直、
 * その上は半径 `arcRadius` のアーチになる。
 */
export const TUNNEL = {
  /** アーチの半径（= 内空の半幅） */
  arcRadius: 2.5,
  /** 起拱線の高さ（レール面上） */
  springLine: 2.9,
  /** 側壁の下端（レール面から下へ） */
  invert: -0.75,
  /** 覆工の厚さ */
  liningThickness: 0.4,
  /** 待避坑の間隔 */
  refugePitch: 50,
} as const;
