// 街景全景檢視器＋跑步 —— 自己抓磚塊、自己算圖、自己做轉場。
//
// 座標約定（2026-08-21 用已知的連結方位角驗出來的，不要用猜的改）：
//   全景影像是等距長方投影，正中央（s = 0.5）對應的羅盤方位＝photometa 給的 yaw。
//   要看向羅盤方位 H，經度偏移就是 radians(H - yaw)。
//   驗法：大石公園那顆全景 yaw=143.6，連結在 320° 與 174°。用這個約定看 174°
//   會看到越過湖面的富士山（北岸往南看），地理上對得上；另一個候選約定
//   （s=0 對應 yaw）會把「往北看」畫成湖面，明顯錯。
//
// 每顆全景兩層貼圖：
//   底圖  zoom 2 整顆球，8 塊，先載好 —— 轉頭時不會看到黑的。
//   細節  目標 zoom，只載「現在看得到」的那幾塊。
// zoom 5 整顆球是 338 塊、354 MB 的貼圖；只取可見範圍剩 108 塊、1.4 MB。
//
// 同時保留兩顆全景（現在這顆＋下一顆），轉場時兩顆疊著畫、用 alpha 混。
// 下一顆在「跑這一步的時間裡」就先抓好，所以前進時不需要等。

const cv = document.getElementById('gl');
const hud = document.getElementById('hud');
const gl = cv.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
if (!gl) hud.textContent = '這個瀏覽器沒有 WebGL';

const VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() { vUV = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uBase, uDet;
uniform float uYaw, uPitch, uTanHalf, uAspect, uAlpha;
uniform float uOff;           // 這一片在相機座標系裡的水平偏移（弧度）
uniform vec3 uTravel;         // 行進方向（已轉到這顆全景的影像經度座標系）
uniform float uT, uR;         // 相機沿行進方向平移多少公尺、場景近似半徑
uniform float uPanoPos;       // 這顆全景在共用世界座標裡的位置（沿行進方向，公尺）
uniform float uCyl;           // 0 = 多片直線透視／1 = Panini 連續投影
uniform float uKx, uKy, uD;   // Panini：水平尺度、垂直尺度、鏡頭距離參數
uniform float uFadeA, uFadeB; // 底部淡出：從這個緯度開始，到這個緯度全暗（弧度）
uniform float uCamH;          // 相機離地高度（公尺）。0 = 不用地平面模型
uniform vec2 uBaseScale, uDetScale;
uniform float uDetS0, uDetSpanS, uDetT0, uDetSpanT, uHasDet;
const float PI = 3.14159265358979;
void main() {
  vec3 d;
  if (uCyl > 0.5) {
    // 連續投影，沒有接縫可以折。uD < 0 是圓柱，否則是 Panini。
    //
    // 圓柱：水平角度跟畫面 x 成正比 —— 這就是「無限多片」的極限，
    // 每度的像素數處處相同，中央解析度是所有投影裡最高的。
    //
    // Panini：中央幾乎等同直線透視（不像圓柱那樣中央會鼓），往兩側才壓縮。
    // 正向式 X = sin(lon)(d+1)/(d+cos(lon))，這裡是它的反解。
    // d→0 退化成直線透視。注意 d 不能太大 —— 實測 d=5、半視野 105° 時
    // asin 的引數會飽和，算出 98° 而不是 105°，所以上限壓在 2。
    float lo, la;
    if (uD < 0.0) {
      lo = vUV.x * uKx;                       // uKx = 半視野（弧度）
      la = atan(vUV.y * uKy);
    } else {
      float k = vUV.x * uKx;
      lo = atan(k) + asin(clamp(k * uD / sqrt(1.0 + k * k), -1.0, 1.0));
      float sf = (uD + 1.0) / (uD + cos(lo));
      la = atan(vUV.y * uKy / sf);
    }
    d = vec3(sin(lo) * cos(la), sin(la), cos(lo) * cos(la));
  } else {
    d = normalize(vec3(vUV.x * uAspect * uTanHalf, vUV.y * uTanHalf, 1.0));
  }
  // 旋轉順序：Ry(uYaw) · Rx(uPitch) · Ry(uOff) · d
  //
  // 三片要當成「同一台相機的三個扇區」，所以片間偏移 uOff 必須在仰角**之前**
  // 套用，仰角與朝向則是三片共用。先前寫成 Ry(heading + off) · Rx(pitch)，
  // 等於每片各自繞自己的軸去仰；繞 X 與繞 Y 不可交換，仰角一不為零接縫就錯開。
  // 這個順序下，左片的右緣（局部 +hHalf、偏移 −2hHalf）與中片的左緣
  //（局部 −hHalf、偏移 0）在相機座標系裡是同一個方向，之後受到完全相同的
  // 仰角與朝向旋轉，必然對齊。
  float co = cos(uOff), so = sin(uOff);
  d = vec3(d.x * co + d.z * so, d.y, -d.x * so + d.z * co);
  // 仰角：正 = 往上看。代入正前方 (0,0,1) 要得到 y' = +sin(p)。
  // 取磚塊那邊的 t0 = 0.5 − (pitch + vHalf)/180 也是照「正 = 往上」寫的，
  // 兩邊符號一定要一致，不然一有仰角就會抓錯列。
  float cp = cos(uPitch), sp = sin(uPitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  // 轉到影像經度座標系
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 w = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  // 相機平移。把場景當成半徑 uR 的球面，反解出「原本要取樣哪個方向」：
  //   場景點 = R·u，相機在 t·T，看到方向 w ∝ R·u − t·T
  //   → R·u = λ·w + t·T，|λw + tT| = R
  //   → λ = −t(w·T) + sqrt(t²(w·T)² − t² + R²)
  // 正前方自然變成放大、正側面自然變成往後刷、正後方自然縮小 ——
  // 一條式子就把三個面板都處理掉，不用分別寫。
  if (uT != 0.0 || uPanoPos != 0.0) {
    // 共用世界座標：以「現在這顆全景」為原點，行進方向為 +T。
    // 相機在 uT·T，下一顆全景在 uPanoPos·T（現在這顆就是 0）。
    //
    // 關鍵：兩顆全景必須解出**同一個世界點**，再各自換算成自己的取樣方向。
    // 先前是各自以自己為球心、各自用自己的相機位移，等於在描述兩個不同的世界 ——
    // 實測轉場中點時同一條射線的方位角差到 12.9°，溶解時兩張圖對不齊。
    vec3 cam = uT * uTravel;
    float depthPlane = (uCamH > 0.0 && w.y < -0.001) ? uCamH / (-w.y) : 1e9;
    vec3 pt;
    if (depthPlane < uR) {
      pt = cam + depthPlane * w;                 // 地面：與 y = −相機高度 的交點
    } else {
      // 以原點（現在這顆全景）為球心、半徑 uR 的球面
      float b = dot(cam, w);
      float c = dot(cam, cam) - uR * uR;
      pt = cam + (-b + sqrt(max(b * b - c, 0.0))) * w;
    }
    w = normalize(pt - uPanoPos * uTravel);      // 換算成「這顆全景」看出去的方向
  }
  float lon = atan(w.x, w.z);
  float lat = asin(clamp(w.y, -1.0, 1.0));
  // fract 自己處理左右環繞 —— 貼圖是 CLAMP_TO_EDGE，不能靠 REPEAT，
  // 因為貼圖比影像大（右邊和下面有補白），REPEAT 會把補白捲進畫面。
  vec2 sn = vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI);
  vec4 c = texture2D(uBase, sn * uBaseScale);
  if (uHasDet > 0.5) {
    // 細節窗可能跨過 s=0 的接縫，所以先平移到以 uDetS0 為原點再比較
    float ls = fract(sn.x - uDetS0), lt = sn.y - uDetT0;
    if (ls <= uDetSpanS && lt >= 0.0 && lt <= uDetSpanT)
      c = texture2D(uDet, vec2(ls / uDetSpanS, lt / uDetSpanT) * uDetScale);
  }
  // 底部淡出。街景車自己被 Google 打上馬賽克，正下方是一團糊的 ——
  // 實測相鄰像素差：−20° 是 10.8、−40° 剩 6.2、−60° 只有 1.8、正下方 0.06。
  // 與其讓它糊在畫面裡，不如順順地暗掉，看起來像陰影而不是失誤。
  float fade = 1.0 - smoothstep(uFadeA, uFadeB, -lat);
  gl_FragColor = vec4(c.rgb * mix(0.12, 1.0, fade), uAlpha);
}`;

const compile = (type, src) => {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
};
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
gl.useProgram(prog);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
const U = n => gl.getUniformLocation(prog, n);

const mkTex = () => {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
};

const BASE_ZOOM = 2;
// 角色要在建立 BroadcastChannel 之前就決定，所以先從網址讀
const Q0 = new URLSearchParams(location.search);
const rad = x => x * Math.PI / 180;
const ad = (a, b) => ((a - b) % 360 + 540) % 360 - 180;

const S = {
  zoom: 4, heading: 0, pitch: 0, fov: 70, panels: 3,
  cur: null, nxt: null,                 // 兩顆全景
  proj: 'pan',                          // 'pan' 連續投影（預設）／'flat' 多片直線透視
  span: 200,                            // Panini 的總水平視野
  // −1 = 圓柱（無限多片的極限，中央解析度最高）、0 = 直線透視、1 = 標準 Panini。
  // 1.0 = 標準 Panini（中央接近直線透視、兩側平滑壓縮）。
  // −1 = 圓柱（中央解析度最高但會鼓）。d 鍵可循環切換。
  paniniD: 1.0,
  // 底部淡出的起訖緯度。實測細節量：−20° 是 10.8、−30° 剩 7.1、−40° 是 6.2、
  // −60° 只有 1.8、正下方 0.06。三面板 fov 70 的畫面底部剛好在 −35°，
  // 起點設 34 等於沒作用（實測底部亮度 136，跟中央差不多），所以提前到 30。
  fadeFrom: 30, fadeTo: 52,
  gap: false,                           // 分片之間不留間隔線
  // 自動比例。垂直視野決定畫面下緣看到影像的哪個緯度，而街景車的馬賽克
  // 就在下方 —— 實測畫質：-20° 是 10.8、-30° 掉到 7.1、-40° 只剩 6.2。
  // 所以下緣要停在 -26° 左右。要同時保有 210° 水平，畫布比例得是 4.3:1。
  // 視窗通常沒那麼扁，就在上下留黑邊把繪製區裁成正確比例（信箱式）。
  // 三螢幕輸出：一個主控視窗跑迴圈，另外兩個只負責畫自己那一片。
  // panelIdx = null 表示單一視窗畫全部（預設）；0/1/2 表示只畫左/中/右。
  // 三個視窗用 BroadcastChannel 同步 —— 同來源同瀏覽器，延遲很低。
  // 只有明確帶 role=follow 才是從屬。帶 panel 但沒帶 role 的仍是主控 ——
  // 先前寫成「有 panel 就是 follow」，結果中間那個視窗也變從屬，三個都在等別人。
  role: Q0.get('role') === 'follow' ? 'follow' : 'master',
  panelIdx: Q0.has('panel') ? +Q0.get('panel') : null,
  fit: true,
  bottomDeg: 26,                        // 畫面下緣離水平線幾度
  // 每片的水平視野。要「幾何正確」（畫面裡的角度＝眼睛看到的角度），
  // 這個值應該等於螢幕在你眼中的實際張角：2·atan(螢幕可視寬/2 ÷ 觀看距離)。
  // 設得比實際張角大＝廣角效果，看起來比較有速度感但比例被壓縮。
  hFovPer: 70,
  // 實體三螢幕用：邊框補償（像素）。三片各在一台螢幕上時，兩台之間的邊框
  // 會遮掉一段畫面；把 bezel 設成「邊框寬度換算成的像素數」，那一段就不畫，
  // 視覺上才連得起來（賽車模擬器叫 bezel correction）。
  // 換算：像素 = 邊框實體寬度(mm) / 螢幕可視寬度(mm) × 單螢幕水平像素。
  bezel: 0,
  mix: 0, tMove: 0, stepD: 10,          // 轉場進度、相機前移公尺數、這一步的距離
  // 場景近似半徑。街道兩側大概就是這個量級；太小側面會滑得太誇張，
  // 太大就退化回「只有放大」，側面又沒有後移感。
  // 每一步正前方的放大倍率。1.35 是使用者在 street-runner 上挑出來的值。
  //
  // 場景被當成半徑 R 的球面，往前 t 公尺時正前方放大 R/(R−t)。
  // 先前是把 R 固定在 20 —— 一步 10 公尺就變成 2.0 倍（太多），
  // 而且會隨步距變動：連結 20 公尺時 20/(20−20) 直接爆掉。
  // 改成由倍率反推 R = d / (1 − 1/M)，每一步的推近感就一致，
  // 側移量 t/R = 1 − 1/M 也跟著固定，不管連結是 5 公尺還是 20 公尺。
  zoomPer: 1.35,
  dissolveMs: 260,                      // 溶解只佔中間這麼久
  sceneR: 38,                           // 由 zoomPer 與步距算出來的，只是顯示用
  // 地平面模型：往下看的射線改用「相機高度 / 俯角」當深度，路面的流動才對。
  // 預設關掉 —— 近處的車子不在地平面上卻被當成地面投影，會被拉成一團。
  // 用 h 鍵開關；街景拍攝車的相機大約離地 2.5 公尺。
  camH: 0,
  running: false, kmh: 12, travelDir: 0,
  mic: false, micKmh: null, micAt: 0, micHeld: false, kmhCap: 12,
  voice: false,
  // 轉向意圖。不是「原地轉 45 度」—— 那會讓你面對牆壁。
  // 說了左轉之後記著，到下一個真的有左邊岔路的路口才用掉；
  // 跑了 200 公尺還沒遇到就放棄（street-runner 驗過的做法）。
  wish: null, wishAt: 0, probedAt: 0,
  // 依序要跑到的目標點。到 60 公尺內就算到達，換下一個。
  // 景點導覽
  narrate: true,                        // 開關
  // 詢問模式：到景點附近先問「要不要導覽」，說「導覽」才跑過去介紹。
  // 不說話就是不要 —— 完全不需要辨識「是」這種單音節（那在跑步機上最不準）。
  askMode: true,
  asking: null,                         // 正在問的景點
  askedIds: new Set(),                  // 問過的不再問
  detourFrom: null,                     // 為了看景點而繞路前，原本的目標
  spoken: new Set(),                    // 播過的不再播
  lastSpokeAt: -9999,                   // 上次播報時跑了多遠
  nearbyAt: -9999, nearby: [],          // 附近景點快取
  speaking: false, nowSpeaking: '',
  // 播報中把視角轉去盯著景點。真的繞一圈需要環形道路，多數景點沒有 ——
  // 改成「跑過去的時候頭一直轉向它」，視覺上就是繞著它轉，而且不用環路。
  watchLm: null,
  nextLm: null,                         // 前方最近、還沒播過的景點（給 HUD 顯示）
  targets: [], target: null, targetNo: 1,
  bestToTarget: Infinity, targetSetAt: 0, bestAt: 0,
  // 轉向世代序號。轉向指令下達時，那一步的動畫往往還在跑；動畫結束時
  // stepOnce 會執行 travelDir = aimHead，把剛轉好的方向覆寫回舊連結的角度
  //（實測「回頭」轉了 180° 之後，十幾秒又自己轉回去）。
  // 進 stepOnce 時記下序號，結束時比對，中途變過就不要覆寫。
  turnSeq: 0,
  steps: 0, moved: 0, waited: 0, lastMs: 0, fps: [], movingMs: 0, t0: 0,
  track: [], runId: null,               // 這一趟跑過的點
  note: '',
};

// ── 磚塊 ──
// Google 對靠近天頂／天底的列會送 256×256 而不是 512×512（極區相鄰欄位重複度高，
// 這是他們自己的省頻寬做法）。直接 texSubImage2D 貼上去只會填滿該格的左上四分之一，
// 剩下四分之三是黑的 —— 畫面上下就出現一排黑色梳齒。尺寸不符就先放大到整格。
const upscale = (bm, size) => {
  if (bm.width === size && bm.height === size) return bm;
  const c = new OffscreenCanvas(size, size);
  c.getContext('2d').drawImage(bm, 0, 0, size, size);
  bm.close();
  return c;
};

let netBytes = 0;
const fetchTile = async (pano, x, y, z) => {
  const u = 'https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile'
    + `&panoid=${pano}&x=${x}&y=${y}&zoom=${z}&nbt=1&fover=2`;
  // 一定要有逾時。瀏覽器的 fetch 沒有預設逾時，連線掛住就永遠不回 ——
  // 而 stepOnce 是 await 它的，整個跑步迴圈會靜靜停住不動，也沒有錯誤訊息。
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(r.status);
      const b = await r.blob();
      netBytes += b.size;
      return await createImageBitmap(b);
    } catch { if (k >= 2) return null; await new Promise(r => setTimeout(r, 150 * (k + 1))); }
  }
  return null;
};

const pool = async (items, n, fn) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
};

// shader 裡的 fov 是「垂直」視野 —— 方向向量是 (vUV.x * aspect * tanHalf, vUV.y * tanHalf, 1)，
// 所以垂直半角就是 fov/2，水平半角是 atan(aspect * tan(fov/2))，比 fov/2 大。
// 曾經把垂直半角寫成水平那條公式反過來用，算出來偏小、取磚塊時上下各少一列 ——
// zoom 4 只有 7 列粒度粗看不出來，zoom 5 有 13 列就出現黑色梳齒。
const panelW = () => cv.clientWidth / S.panels;
// 繪製區的高度（開了自動比例時比畫布矮，上下是黑邊）。
// 取磚塊範圍與 HUD 都要用這個，不然跟實際畫出來的不一致。
let viewH = 0;
const hHalfDeg = () =>
  Math.atan(panelW() / (viewH || cv.clientHeight) * Math.tan(rad(S.fov / 2))) * 180 / Math.PI;

function tileWindow(meta, heading) {
  const g = meta.geom.zooms[S.zoom], TS = meta.geom.tile;
  const cols = Math.ceil(g.w / TS), rows = Math.ceil(g.h / TS);
  const spanDeg = S.proj === 'pan'
    ? Math.min(360, S.span + 30)
    : Math.min(360, hHalfDeg() * 2 * S.panels + 30);
  const s0 = ((heading - meta.yaw - spanDeg / 2) / 360 + 0.5) % 1;
  // 只有「影像寬剛好是磚塊的整數倍」的 zoom 才能只取一段：
  //   zoom 4 = 6656 = 13×512、zoom 5 = 13312 = 26×512  → 可以開窗
  //   zoom 2 = 1664 = 3.25×512、zoom 3 = 3328 = 6.5×512 → 最後一欄有補白，
  //   開窗跨過 s=0 接縫時那塊補白會夾進有效資料變成爛縫。那兩級整顆球抓完更省事。
  const exact = g.w % TS === 0;
  const cx0 = exact ? Math.floor(((s0 % 1 + 1) % 1) * g.w / TS) : 0;
  const cw = exact ? Math.min(cols, Math.ceil(spanDeg / 360 * g.w / TS) + 1) : cols;
  const vHalf = S.fov / 2;
  const t0 = Math.max(0, 0.5 - (S.pitch + vHalf + 14) / 180);
  const t1 = Math.min(1, 0.5 - (S.pitch - vHalf - 14) / 180);
  const cy0 = Math.max(0, Math.floor(t0 * g.h / TS));
  const cy1 = Math.min(rows - 1, Math.floor(t1 * g.h / TS));
  return { cols, rows, cx0, cw, cy0, ch: cy1 - cy0 + 1, TS, gw: g.w, gh: g.h, exact };
}

const mkPano = () => ({ meta: null, texBase: mkTex(), texDet: mkTex(),
                        baseScale: [1, 1], det: null, tiles: 0 });

async function load(P, panoId, heading) {
  let meta;
  try {
    meta = await (await fetch('/api/meta?pano=' + encodeURIComponent(panoId),
      { signal: AbortSignal.timeout(12000) })).json();
  } catch (e) { S.note = '⚠ 街景資料逾時，重試中'; return false; }
  if (meta.error) { S.note = meta.error; return false; }
  P.meta = meta; P.det = null; P.tiles = 0;

  const TSb = meta.geom.tile, gb = meta.geom.zooms[BASE_ZOOM];
  const cb = Math.ceil(gb.w / TSb), rb = Math.ceil(gb.h / TSb);
  gl.bindTexture(gl.TEXTURE_2D, P.texBase);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cb * TSb, rb * TSb, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  P.baseScale = [gb.w / (cb * TSb), gb.h / (rb * TSb)];
  const bj = [];
  for (let x = 0; x < cb; x++) for (let y = 0; y < rb; y++) bj.push([x, y]);
  await pool(bj, 8, async ([x, y]) => {
    if (P.dead) return;
    const raw = await fetchTile(panoId, x, y, BASE_ZOOM);
    if (!raw || P.dead) return;
    const bm = upscale(raw, TSb);
    gl.bindTexture(gl.TEXTURE_2D, P.texBase);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x * TSb, y * TSb, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    if (bm.close) bm.close();
    if (P === S.cur) draw();          // 邊載邊畫 —— 少了這行就要等整顆載完才有畫面
  });

  const w = tileWindow(meta, heading), TS = w.TS;
  gl.bindTexture(gl.TEXTURE_2D, P.texDet);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w.cw * TS, w.ch * TS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  P.det = { ...w, texW: w.cw * TS, texH: w.ch * TS };
  const dj = [];
  for (let i = 0; i < w.cw; i++) for (let j = 0; j < w.ch; j++) dj.push([i, j]);
  // 併發 16。55 塊磚在併發 12 下要 5 輪往返，光延遲就吃掉大半秒。
  // 不要再往上加 —— 一次打幾百個請求時 Google 會開始擋。
  await pool(dj, 16, async ([i, j]) => {
    if (P.dead) return;
    const raw = await fetchTile(panoId, (w.cx0 + i) % w.cols, w.cy0 + j, S.zoom);
    if (!raw || P.dead) return;
    const bm = upscale(raw, TS);
    gl.bindTexture(gl.TEXTURE_2D, P.texDet);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, i * TS, j * TS, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    if (bm.close) bm.close();
    P.tiles++;
    if (P === S.cur) draw();
  });
  return true;
}

// ── 畫 ──
function drawOne(P, alpha, tanHalf, aspect, tMove, off, panoPos) {
  if (!P || !P.meta) return;
  gl.uniform1i(U('uBase'), 0); gl.uniform1i(U('uDet'), 1);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P.texBase);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, P.texDet);
  gl.uniform2fv(U('uBaseScale'), P.baseScale);
  gl.uniform1f(U('uTanHalf'), tanHalf);
  gl.uniform1f(U('uAspect'), aspect);
  gl.uniform1f(U('uPitch'), rad(S.pitch));
  gl.uniform1f(U('uAlpha'), alpha);
  gl.uniform1f(U('uOff'), rad(off || 0));
  // 行進方向轉進這顆全景的影像經度座標系
  const lonT = rad(S.travelDir - P.meta.yaw);
  gl.uniform3f(U('uTravel'), Math.sin(lonT), 0, Math.cos(lonT));
  gl.uniform1f(U('uT'), tMove || 0);
  gl.uniform1f(U('uPanoPos'), panoPos || 0);
  gl.uniform1f(U('uR'), S.sceneR);
  gl.uniform1f(U('uCamH'), S.camH);
  gl.uniform1f(U('uCyl'), S.proj === 'pan' ? 1 : 0);
  gl.uniform1f(U('uD'), S.paniniD);
  gl.uniform1f(U('uFadeA'), rad(S.fadeFrom));
  gl.uniform1f(U('uFadeB'), rad(S.fadeTo));
  const d = P.det;
  gl.uniform1f(U('uHasDet'), d ? 1 : 0);
  if (d) {
    // 水平：整數倍的 zoom 沒有補白（scale = 1）；非整數倍時是整顆球，最後一欄要夾掉。
    const validH = Math.min(d.gh, (d.cy0 + d.ch) * d.TS) - d.cy0 * d.TS;
    gl.uniform1f(U('uDetS0'), (d.cx0 * d.TS / d.gw) % 1);
    gl.uniform1f(U('uDetSpanS'), d.exact ? d.cw * d.TS / d.gw : 1);
    gl.uniform1f(U('uDetT0'), d.cy0 * d.TS / d.gh);
    gl.uniform1f(U('uDetSpanT'), validH / d.gh);
    gl.uniform2fv(U('uDetScale'), [d.exact ? 1 : d.gw / d.texW, validH / d.texH]);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function draw() {
  // draw() 裡丟例外的話畫面就永遠是清除色（近黑），HUD 也停在「載入中」，
  // 看起來像網路問題其實是程式錯誤 —— 實測被這樣騙過一次。包起來，把訊息秀出來。
  try { drawInner(); }
  catch (e) {
    hud.style.display = '';
    hud.textContent = '畫面繪製出錯：\n' + (e && e.message || e);
    throw e;
  }
}

function drawInner() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  gl.clearColor(0.05, 0.055, 0.065, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!S.cur || !S.cur.meta) return;

  // 這一顆的相機已經往前走了 S.tMove 公尺；下一顆則是「還在後面 tMove − d」，
  // 走到 0 時剛好抵達它自己的位置。兩顆的幾何在整個轉場中一致，溶解才疊得準。
  // 三螢幕模式下這個視窗只畫一片，但幾何要照「三片」算，接縫才對得上
  const N = (S.panelIdx !== null) ? 1 : (S.proj === 'pan' ? 1 : S.panels);
  const GAP = (S.gap && N > 1) ? Math.round(6 * dpr) : 0;
  const pw = Math.floor((w - GAP * (N - 1)) / N);

  // 自動比例：由「下緣要停在哪個緯度」定出垂直視野，再由「每片要多寬」
  // 反推繪製高度。視窗比這個高就上下留黑邊，比這個矮就退而求其次用滿。
  let vh = h, y0 = 0;
  if (S.fit && S.proj === 'pan') {
    // 連續投影也要套自動比例。先前只對分片模式生效，這裡就用滿整個視窗高度，
    // 垂直視野直接衝到 97°（下緣 −48°）—— 街景車的馬賽克整片跑回畫面裡。
    // 中央的像素是方的，所以由「下緣要停在哪」反推高度。
    const hs = rad(S.span / 2), D = S.paniniD;
    const sc = D < 0 ? hs : Math.sin(hs) * (D + 1) / (D + Math.cos(hs));
    const need = Math.round(Math.tan(rad(S.bottomDeg + S.pitch)) * w / sc);
    if (need <= h) { vh = need; y0 = Math.round((h - vh) / 2); }
  }
  if (S.fit && S.proj !== 'pan') {
    S.fov = 2 * (S.bottomDeg + S.pitch);
    const need = Math.round(pw * Math.tan(rad(S.fov / 2)) / Math.tan(rad(S.hFovPer / 2)));
    if (need <= h) { vh = need; y0 = Math.round((h - vh) / 2); }
    else { S.fov = 2 * Math.atan(Math.tan(rad(S.hFovPer / 2)) * h / pw) * 180 / Math.PI; }
  }
  viewH = vh / dpr;                        // 換回 CSS 像素，hHalfDeg 用得到
  if (S.proj === 'pan') {
    // Panini 的尺度參數。由總水平視野反推水平尺度，再由畫面比例推垂直尺度，
    // 這樣兩個方向在中央的「每像素幾度」才一致。
    // （這幾行曾經在改自動比例時被整段覆蓋掉，uKx/uKy 一直是 0 → 按 0 切過去全黑。）
    const hs = rad(S.span / 2), D = S.paniniD;
    const sc = D < 0 ? hs : Math.sin(hs) * (D + 1) / (D + Math.cos(hs));
    gl.uniform1f(U('uKx'), D < 0 ? hs : sc / (D + 1));
    gl.uniform1f(U('uKy'), sc * vh / pw);
  }
  bcast();
  const tanHalf = Math.tan(rad(S.fov / 2));
  // 面板間距＝每片的水平視野。要用「繪製區」的高度算，不是整個畫布 ——
  // 開了自動比例之後上下有黑邊，用畫布高會算出偏窄的間距，接縫就對不上。
  const step = 2 * Math.atan(pw / vh * tanHalf) * 180 / Math.PI;
  for (let i = 0; i < N; i++) {
    const off = S.proj === 'pan' ? 0
      : ((S.panelIdx !== null ? S.panelIdx : i) - (S.panels - 1) / 2) * step;
    gl.viewport(i * (pw + GAP), y0, pw, vh);
    gl.uniform1f(U('uYaw'), rad(S.heading - S.cur.meta.yaw));
    drawOne(S.cur, 1, tanHalf, pw / vh, S.tMove, off, 0);
    if (S.mix > 0 && S.nxt && S.nxt.meta) {
      gl.uniform1f(U('uYaw'), rad(S.heading - S.nxt.meta.yaw));
      // 相機位置一樣是 S.tMove（共用世界座標），差別只在這顆全景本身在 stepD 處
      drawOne(S.nxt, S.mix, tanHalf, pw / vh, S.tMove, off, S.stepD);
    }
  }

  voiceBanner();
  const m = S.cur.meta;
  if (hud.classList.contains('fold')) {
    // 收合時只留最需要一眼看到的：速度、距離、還有語音／步頻是不是活著
    hud.textContent = `${S.running ? '▶' : '⏸'} ${S.kmh.toFixed(1)} km/h　`
      + `${(S.moved / 1000).toFixed(2)} km`
      + (S.mic ? `　🎙${window.__cad?.spm ? Math.round(window.__cad.spm) : '…'}` : '')
      + (S.voice ? `　🗣${voiceState()}` : '')
      + (S.watchLm ? `　👁 盯著 ${S.watchLm.name}` : '')
    + (S.speaking ? `　🔊 ${S.nowSpeaking}`
         : S.nextLm ? `　🎧 ${S.nextLm.name} ${Math.round(S.nextLm.d)} m` : '')
      + (S.note ? `　${S.note}` : '');
    return;
  }
  hud.textContent =
    `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}   ${m.indoor ? '室內' : '戶外'}\n`
    + `朝向 ${Math.round((S.heading % 360 + 360) % 360)}°   `
    + (S.proj === 'pan'
       ? `${S.paniniD < 0 ? '圓柱' : 'Panini d=' + S.paniniD.toFixed(1)} ${S.span}°\n`
       : `垂直 ${S.fov.toFixed(0)}°（下緣 −${S.bottomDeg}°）/ 水平 `
         + `${Math.round(hHalfDeg() * 2)}° × ${S.panels} ＝ `
         + `${Math.round(hHalfDeg() * 2 * S.panels)}°${S.fit ? '　自動比例' : ''}\n`)
    + (S.panelIdx !== null ? `🖥 ${['左', '中', '右'][S.panelIdx]}片（${S.role === 'master' ? '主控' : '從屬'}）   ` : '')
    + `zoom ${S.zoom}   ${S.running ? `▶ ${S.kmh.toFixed(1)} km/h` : '⏸ 停著'}   `
    + (S.mic ? `🎙 ${window.__cad?.spm ? Math.round(window.__cad.spm) + ' spm' : '聽…'}   ` : '')
    + (S.voice ? `🗣 ${voiceState()}   ` : '')
    + `推近 ${S.zoomPer.toFixed(2)}×${S.camH ? '+地面' : ''}   `
    + `${S.steps} 步 ${(S.moved / 1000).toFixed(2)} km`
    + (S.watchLm ? `　👁 盯著 ${S.watchLm.name}` : '')
    + (S.speaking ? `　🔊 ${S.nowSpeaking}`
       : S.nextLm ? `　🎧 ${S.nextLm.name} ${Math.round(S.nextLm.d)} m` : '')
    + (S.target ? `　⌖ 第 ${S.targetNo} 點 ${Math.round(distM(S.cur.meta, S.target))} m`
       + (S.targets.length ? `（還有 ${S.targets.length} 個）` : '') : '')
    + (S.track.length ? `　紀錄 ${S.track.length} 點（按 s 匯出 GPX）` : '') + '\n'
    + `這顆 ${S.cur.tiles} 塊　等 ${Math.round(S.lastMs)} ms　排隊 ${queue.length}　`
    + `共 ${(netBytes / 1048576).toFixed(1)} MB\n`
    + (S.note || `連結 ${m.links.map(l => Math.round(l.heading) + '°').join('  ') || '無'}`);
}

// ── 跑 ──
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 步頻偵測（cadence.js）掛出 window.__cad = {spm, kmh}。
// 它一載入就會要麥克風權限，所以要等使用者按下空白鍵那一下再載 ——
// 沒有使用者手勢的 getUserMedia 在 Chrome 會被直接拒絕。
let cadLoading = false;
function startMic() {
  if (cadLoading || window.__cad) return;
  cadLoading = true;
  const sc = document.createElement('script');
  sc.src = '/cadence.js';
  document.head.appendChild(sc);
}

// 沒聽到腳步聲不要硬切成停 —— 三秒內平順滑到零，跟 street-runner 一樣。
function micSpeed() {
  const c = window.__cad;
  if (!c) return S.kmhCap;
  if (c.kmh != null && c.at) { S.micKmh = c.kmh; S.micAt = c.at; }
  const age = Date.now() - (S.micAt || 0);
  if (!S.micAt || age > 6000) { S.micHeld = true; return 0; }
  const fade = age <= 3000 ? 1 : Math.max(0, 1 - (age - 3000) / 3000);
  S.micHeld = fade < 1;
  return Math.min(S.kmhCap, Math.max(0, (S.micKmh || 0) * fade));
}

function pickLink(meta, dir, wish) {
  if (!meta.links.length) return null;
  // 「不要往回走」一定要用實際行進方向（傳進來的 dir），不是目標方位。
  // 用目標方位的話，一旦目標在側面，來路就不會被濾掉 —— 會在兩顆全景之間
  // 來回震盪（實測 200 步只前進 318 公尺）。離線模擬顯示修好之後，
  // 走得到的景點從 3/12 變成 6/12。
  const back = (dir + 180) % 360;
  // 有目標時只改「往哪個方向挑」，不改「哪些算往回」
  const aim = (S.target && !wish) ? bearingTo(meta, S.target) : dir;
  // 不要往回走 —— 只留跟來向夾角大於 60° 的連結
  const fwd = meta.links.filter(l => Math.abs(ad(l.heading, back)) > 60);
  const cand = fwd.length ? fwd : meta.links;
  if (wish === 'left' || wish === 'right') {
    const sign = wish === 'left' ? -1 : 1;
    // 想轉的那一側、而且偏離直行至少 35° 的岔路
    const side = cand.filter(l => sign * ad(l.heading, dir) > 35);
    // 取最接近正側面的那一條；這個路口沒有那一側的路就回 null，
    // 呼叫端會改走直行並把意圖留著，等下一個路口
    if (!side.length) return null;
    const side90 = dir + sign * 90;
    return side.reduce((a, b) =>
      Math.abs(ad(b.heading, side90)) < Math.abs(ad(a.heading, side90)) ? b : a);
  }
  return cand.reduce((a, b) => Math.abs(ad(b.heading, aim)) < Math.abs(ad(a.heading, aim)) ? b : a);
}

// 預抓佇列。深度 2 —— 只預抓一顆的話，遇到巴黎那種密集街區會剛好打平：
// 每顆全景 2.9 MB、載一顆三秒多，跟跑一步的時間一樣長，等於毫無餘裕
// （實測平均每步要等 919 ms，速度掉到 9.0 km/h）。抓兩顆就有一整步的緩衝。
// 河口湖那種每顆 1.3 MB 的地方本來就夠，深度 2 也不會多花什麼。
// 深度 3 而不是 2：巴黎那種每顆 3 MB 的地方，一步 3.2 秒、載一顆 2–3 秒，
// 深度 2 剛好在打平邊緣 —— 同樣設定兩次實測一次 11.5 km/h、一次 8.9，差在網路抖動。
// 加一層純粹是買緩衝，穩定的地方也不會多花（總量一樣，只是提早抓）。
const DEPTH = 3;
let queue = [];
// 填充不可重入，而且要能作廢。轉向時會 dropQueue + fillQueue，如果原本那個
// 填充迴圈還在跑，兩邊會同時抓磚塊互搶頻寬 —— 實測等預抓從每步 39 ms
// 暴增到累積 35 秒，跑步變成 2 km/h。
let filling = false, pendingFill = false, qEpoch = 0;

async function fillQueue() {
  // 填充中又被要求填充，要記下來等一下重跑。
  // 直接 return 的話會死結：轉向時 dropQueue 讓進行中的那個因世代不符而退出，
  // 新的又因為 filling 而被跳過，兩邊都收工，佇列永遠是空的（實測整個卡住不動）。
  if (filling) { pendingFill = true; return; }
  filling = true;
  try {
    do { pendingFill = false; await fillLoop(); } while (pendingFill);
  } finally { filling = false; }
}

async function fillLoop() {
  const ep = qEpoch;
  while (queue.length < DEPTH) {
    if (ep !== qEpoch) return;                 // 中途轉向了，這一批不要了
    const last = queue[queue.length - 1];
    let meta, dir;
    if (last) {
      await last.done;                       // 要有它的中繼資料才知道下一條連結
      if (ep !== qEpoch) return;
      if (!last.P.meta) return;
      meta = last.P.meta; dir = last.link.heading;
    } else {
      if (!S.cur?.meta) return;
      meta = S.cur.meta; dir = S.travelDir;
    }
    // 只有佇列第一顆才吃轉向意圖 —— 後面那幾顆是推測，不該把意圖用掉
    const useWish = queue.length === 0 ? S.wish : null;
    let link = pickLink(meta, dir, useWish);
    if (link && useWish) { S.wish = null; S.note = ''; }
    if (!link) link = pickLink(meta, dir, null);      // 這個路口沒有那一側的路，先直行
    if (!link) return;
    const P = mkPano();
    // 預抓要用「屆時實際會看的方向」。播報中視角是盯著景點的，
    // 跟連結方位可能差一百多度 —— 用連結方位預抓的話，等一下顯示的那一段
    // 磚塊完全沒抓到，每一步都要現抓一批，畫面就會卡住
    //（實測盯著景點時有一步停了十五秒）。
    const viewHead = S.watchLm ? bearingTo({ lat: link.lat, lng: link.lng }, S.watchLm)
                               : link.heading;
    queue.push({ link, P, done: load(P, link.id, viewHead) });
  }
}

// 轉向或跳點之後佇列就作廢了 —— 裡面排的是舊方向的路。
// 被丟掉的全景要標記 dead，它們正在抓的磚塊才會停下來，不然那些請求
// 還是會佔著頻寬，讓新方向的預抓變慢。
const dropQueue = () => {
  for (const q of queue) q.P.dead = true;
  queue = [];
  qEpoch++;
};

async function stepOnce() {
  const seq = S.turnSeq;
  const _t0 = Date.now();
  if (!queue.length) {
    await fillQueue();
    // 還是空的有可能是另一個填充正在進行（或側移跳點還沒回來），等一下再看，
    // 不要馬上判定「沒路可走」
    for (let i = 0; i < 60 && !queue.length && S.running; i++) await sleep(100);
  }
  if (!queue.length) { S.note = '⚠ 沒路可走了'; S.running = false; return; }
  const { link, P, done } = queue.shift();
  const t0 = performance.now();
  const ok = await done;                       // 預抓成功的話這裡幾乎不等
  S.lastMs = performance.now() - t0;
  S.waited += S.lastMs;
  if (!ok) { S.note = '⚠ 下一顆載不起來'; S.running = false; return; }
  fillQueue();                                 // 不等它，讓它在背景補滿

  if (S.mic) {
    S.kmh = micSpeed();
    // 停住的時候不要一直丟出轉場，等腳步聲回來
    while (S.running && S.kmh < 1.5) { S.note = '⏸ 沒有腳步聲，畫面停住'; draw(); await sleep(400); S.kmh = micSpeed(); }
    if (!S.running) return;
    S.note = '';
  }
  const d = link.d || 10;
  // 動畫佔滿整步的時間。先前是「動 0.8 倍步時、然後 sleep 補足配速」，
  // 而且還被 min(900,…) 夾住 —— 12 km/h 一步 10 公尺時變成動 0.9 秒、
  // 停 2.1 秒，七成時間畫面是靜止的，跑起來一頓一頓。跑愈慢愈明顯。
  // 動畫時間上限 6 秒。街景的取樣點不是等距的 —— 橋上、高架、郊區常常隔著
  // 七八十公尺沒有點。照速度算的話 79 公尺要走 20 秒，畫面就像卡住
  //（實測塞納河那座橋就是這樣，而且會誤觸看門狗）。
  // 超過上限就走快一點，寧可那一段稍微快轉，也不要停在原地二十秒。
  const want = d / Math.max(1, S.kmh / 3.6) * 1000;
  const span = Math.min(6000, Math.max(240, want));
  if (want > 6000) S.note = `⏩ 這一段隔了 ${Math.round(d)} m，快轉通過`;
  S.nxt = P; S.stepD = d;
  // 由這一步的實際距離與目標倍率算出場景半徑
  S.sceneR = Math.max(6, d / (1 - 1 / Math.max(1.05, S.zoomPer)));
  // 溶解只壓在中間這一小段。兩顆全景在轉場中都被扭曲（誤差隨平移量變大），
  // 同時各佔一半的時候重影最重 —— 所以讓大部分時間只看到其中一顆，
  // 中間快速交換。這就是你說的「先推近、再切」，只是切的那一下用溶解接。
  const DISS = Math.min(0.5, S.dissolveMs / span);
  const startHead = S.heading, aimHead = link.heading;
  let frames = 0;
  await new Promise(res => {
    const t = performance.now();
    const tick = () => {
      frames++;
      const k = Math.min(1, (performance.now() - t) / span);
      // 平移用線性 —— 跑步是等速的。先前用 smoothstep 等於每步都慢快慢。
      S.tMove = d * k;
      S.mix = Math.max(0, Math.min(1, (k - (0.5 - DISS / 2)) / DISS));
      // 只有轉向才需要平滑進出
      const e = k * k * (3 - 2 * k);
      if (S.watchLm && S.cur && S.cur.meta) {
        // 播報中：視角追著景點跑。位置一直在變，所以每一格重算方位；
        // 用比例逼近而不是直接指過去，才不會在經過它的瞬間甩頭。
        const want = bearingTo(S.cur.meta, S.watchLm);
        S.heading += ad(want, S.heading) * Math.min(1, 0.06 + 2.5 / span * 16);
      } else {
        S.heading = startHead + ad(aimHead, startHead) * e;
      }
      draw();
      k < 1 ? requestAnimationFrame(tick) : res();
    };
    tick();
  });
  S.fps.push(frames / (span / 1000)); S.movingMs += span;
  (S.stepLog = S.stepLog || []).push({ ms: Date.now() - _t0, d: Math.round(d),
    mv: Math.round(S.moved), wait: Math.round(S.lastMs), q: queue.length });
  if (S.stepLog.length > 60) S.stepLog.shift();           // 這次轉場的實際畫格率

  S.cur = P; S.nxt = null; S.mix = 0; S.tMove = 0;
  // 這一步進行中如果下過轉向指令，就不要用舊連結的角度覆寫方向
  if (seq === S.turnSeq) {
    S.travelDir = aimHead;
    // 播報中視角是盯著景點的，不要被行進方向蓋掉；播完會自己轉回來
    if (!S.watchLm) S.heading = aimHead;
  }
  S.steps++; S.moved += d;
  trackPoint(P.meta);
  checkTarget(P.meta);
  maybeNarrate(P.meta);
  if (S.wish) {
    // 有效距離放到 600 公尺。城市街廓比想像的長 —— 曼哈頓的大道間距就有 270 公尺，
    // 原本設 200 公尺會在還沒跑到路口時就自己取消（實測就是這樣）。
    if (S.moved - S.wishAt > 600) { S.wish = null; S.note = '⟲ 六百公尺內沒有岔路，取消轉向'; }
    else {
      S.note = (S.wish === 'left' ? '⟲ 左轉待命' : '⟳ 右轉待命')
        + `（已等 ${Math.round(S.moved - S.wishAt)} m）`;
      // 每跑四十公尺試一次側移 —— 有些路段的連結圖根本沒有橫向的路
      if (S.moved - S.probedAt > 40) { S.probedAt = S.moved; lateralHop(S.wish); }
    }
  }
  // 只有還在跑的時候才清訊息。結束指令下達時這一步的動畫往往還在跑，
  // 它跑完就把「已存檔」那行洗掉了 —— 實測結束後提示是空的。
  if (S.running && !/^🖥/.test(S.note)) S.note = '';
  draw();
  // 不再另外 sleep —— 動畫本身就是這一步的時間，中間沒有靜止的空檔
}

async function runLoop() {
  while (S.running) {
    // 看門狗：動畫最長 6 秒，加上載入的餘裕，一步超過 25 秒就是真的卡住了。
    // （先前設 20 秒會誤判 —— 街景取樣點間隔 79 公尺時動畫本來就要跑 20 秒。）
    const before = S.steps;
    const t0 = Date.now();
    await Promise.race([
      stepOnce(),
      (async () => {
        while (Date.now() - t0 < 25000 && S.steps === before && S.running) await sleep(500);
      })(),
    ]);
    if (S.steps === before && S.running && Date.now() - t0 >= 25000) {
      S.note = '⚠ 這一步卡住，重新排隊';
      dropQueue(); fillQueue(); draw();
      await sleep(500);
    }
    if (S.steps > 4000) break;
  }
  draw();
}

// ── 三螢幕同步 ──
// 主控每畫一格就廣播一次狀態；從屬只套用、只畫，不跑自己的迴圈。
// 全景的磚塊各自抓（各自只抓看得到的那段，總流量跟單視窗差不多）。
// 單一視窗（沒帶 panel）也當 master —— 開了側翼視窗才會有人收，沒開就沒成本
const CH = new BroadcastChannel('pano-runner');

function bcast() {
  if (S.role !== 'master' || !CH) return;
  CH.postMessage({
    heading: S.heading, pitch: S.pitch, tMove: S.tMove, mix: S.mix, stepD: S.stepD,
    travelDir: S.travelDir, kmh: S.kmh, moved: S.moved, steps: S.steps,
    note: S.note, running: S.running, zoomPer: S.zoomPer, sceneR: S.sceneR,
    cur: S.cur && S.cur.meta ? S.cur.meta.pano : null,
    nxt: S.nxt && S.nxt.meta ? S.nxt.meta.pano : null,
    pre: queue.length ? queue[0].link.id : null,
  });
}

// 從屬端：照主控說的載入全景、套用狀態、畫出來
const followCache = new Map();
async function followPano(id, head) {
  if (!id) return null;
  let P = followCache.get(id);
  if (!P) {
    P = mkPano();
    followCache.set(id, P);
    await load(P, id, head);
    // 只留最近幾顆，免得貼圖把記憶體吃光
    while (followCache.size > 5) {
      const k = followCache.keys().next().value;
      const old = followCache.get(k);
      if (old !== S.cur && old !== S.nxt) {
        gl.deleteTexture(old.texBase); gl.deleteTexture(old.texDet);
      }
      followCache.delete(k);
    }
  }
  return P;
}

if (S.role === 'follow' && CH) {
  let busy = false;
  CH.onmessage = async e => {
    const m = e.data;
    S.heading = m.heading; S.pitch = m.pitch; S.tMove = m.tMove; S.mix = m.mix;
    S.stepD = m.stepD; S.travelDir = m.travelDir; S.kmh = m.kmh;
    S.moved = m.moved; S.steps = m.steps; S.note = m.note; S.running = m.running;
    S.zoomPer = m.zoomPer; S.sceneR = m.sceneR;
    if (!busy) {
      busy = true;
      try {
        if (m.pre) followPano(m.pre, m.travelDir);          // 先抓起來，不等它
        if (m.cur && (!S.cur || S.cur.meta.pano !== m.cur)) S.cur = await followPano(m.cur, m.travelDir);
        S.nxt = m.nxt ? (followCache.get(m.nxt) || await followPano(m.nxt, m.travelDir)) : null;
      } finally { busy = false; }
    }
    draw();
  };
}

// 開側翼視窗。瀏覽器一次操作只允許開一個彈出視窗（實測第二個會被擋），
// 所以每按一次 t 開一個 —— 按兩次就有左右兩片。
// 主控自己會切成只畫中間那一片。
const wings = {};
function openWing() {
  if (S.panelIdx === null) S.panelIdx = 1;        // 主控改成只畫中間
  const idx = !wings[0] ? 0 : (!wings[2] ? 2 : null);
  if (idx === null) { S.note = '🖥 左右兩個視窗都開好了'; draw(); return; }
  const q = new URLSearchParams(location.search);
  q.set('panel', idx); q.set('role', 'follow');
  q.delete('run'); q.delete('mic'); q.delete('voice');
  const url = location.origin + '/run.html?' + q;
  const w = Math.round(screen.width / 3);
  const win = window.open(url, 'pano-wing-' + idx,
    `width=${w},height=${Math.round(screen.height * 0.7)},left=${idx ? w * 2 : 0},top=0`);
  if (win) {
    wings[idx] = true;
    S.note = (!wings[0] || !wings[2])
      ? `🖥 已開${idx === 0 ? '左' : '右'}邊　再按一次 t 開另一邊`
      : '🖥 左右都開好了　把三個視窗分別拖到三台螢幕';
  } else {
    S.note = '⚠ 被瀏覽器擋掉了　允許彈出視窗，或手動開：' + url;
  }
  draw();
}

// ── 路線紀錄 ──
// 每抵達一顆全景就記一個點，存進 localStorage（跑到一半關掉也不會全丟）。
// 匯出 GPX 是為了能丟進一般的跑步 App —— 那是這類資料的通用格式。
const RUN_KEY = id => 'pr-run-' + id;

function saveTrack() {
  if (!S.runId || !S.track.length) return;
  try {
    localStorage.setItem(RUN_KEY(S.runId), JSON.stringify({
      id: S.runId, at: S.runId, steps: S.steps, moved: Math.round(S.moved),
      secs: Math.round((Date.now() - S.runId) / 1000),
      kmh: S.kmh, pts: S.track,
    }));
    // 只留最近 20 趟，免得把 localStorage 塞爆
    const keys = Object.keys(localStorage).filter(k => k.startsWith('pr-run-')).sort();
    while (keys.length > 20) localStorage.removeItem(keys.shift());
  } catch {}
}

function trackPoint(meta) {
  if (!S.runId) S.runId = Date.now();
  S.track.push({ lat: +meta.lat.toFixed(6), lng: +meta.lng.toFixed(6), t: Date.now() });
  if (S.track.length % 10 === 0) saveTrack();
}

function toGPX(run) {
  const iso = t => new Date(t).toISOString();
  const name = `pano-runner ${new Date(run.at).toLocaleString('zh-TW')}`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="pano-runner" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + `<metadata><time>${iso(run.at)}</time></metadata>\n`
    + `<trk><name>${name}</name><trkseg>\n`
    + run.pts.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${iso(p.t)}</time></trkpt>`).join('\n')
    + '\n</trkseg></trk></gpx>\n';
}

function download(text, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 結束跑步：停下來、存檔、匯出 GPX。
// 跟空白鍵的「暫停」不一樣 —— 暫停只是停住畫面，這個是收工。
function finishRun(text) {
  const wasRunning = S.running;
  S.running = false;
  saveTrack();
  const pts = S.track.length;
  if (pts > 1) {
    exportGPX();
    S.note = `⏹ 結束${text ? `（聽到「${text}」）` : ''}　`
      + `${S.steps} 步　${(S.moved / 1000).toFixed(2)} km　GPX 已存檔`;
  } else {
    S.note = `⏹ 結束${text ? `（聽到「${text}」）` : ''}　還沒跑到可以存檔的距離`;
  }
  hud.classList.remove('fold');      // 收工時把完整數字攤開來看
  draw();
  return wasRunning;
}

function exportGPX() {
  if (!S.track.length) { S.note = '⚠ 還沒有跑過的點'; draw(); return; }
  saveTrack();
  const run = JSON.parse(localStorage.getItem(RUN_KEY(S.runId)));
  const d = new Date(run.at);
  const pad = n => String(n).padStart(2, '0');
  download(toGPX(run),
    `pano-runner-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gpx`,
    'application/gpx+xml');
  S.note = `⇩ 已匯出 ${run.pts.length} 個點　${(run.moved/1000).toFixed(2)} km`;
  draw();
}

// ── 景點導覽 ──
//
// 觸發規則參考 VoiceMap 與 Autio 的做法，但因為我們的座標是虛擬的、沒有 GPS 跳動，
// 可以做得更準：
//   · 在前方（跟行進方向夾角 90° 內）且距離 150 公尺內才播 —— 背後的不播
//   · 播了就播到完，不中斷（VoiceMap 也是這樣，硬切比講完更難受）
//   · 兩次之間至少隔 400 公尺，東京那種每 300 公尺一個景點的地方才不會一直講
//   · 開始前先一聲短提示音，不然突然有人講話會嚇一跳（Autio 的細節）
let audioEl = null;
// 預載過的音檔（id → HTMLAudioElement）。景點還在 300 公尺外就先抓，
// 不然 460 KB 的下載會跟磚塊搶頻寬 —— 實測觸發當下有一步慢到二十秒被看門狗抓。
const preAudio = new Map();
function preloadAudio(lm) {
  if (!lm || preAudio.has(lm.id)) return;
  const a = new Audio();
  a.preload = 'auto';
  a.src = lm.audio;
  preAudio.set(lm.id, a);
  if (preAudio.size > 6) {
    const k = preAudio.keys().next().value;
    const old = preAudio.get(k);
    if (old !== audioEl) { try { old.src = ''; } catch {} preAudio.delete(k); }
  }
}

function chime() {
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    const ac = new C();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.setValueAtTime(880, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ac.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.45);
    o.start(); o.stop(ac.currentTime + 0.5);
    setTimeout(() => ac.close().catch(() => {}), 900);
  } catch {}
}

const $ = id => document.getElementById(id);

function speak(lm) {
  S.spoken.add(lm.id);
  S.lastSpokeAt = S.moved;
  S.speaking = true; S.nowSpeaking = lm.name;
  // 播報中麥克風收到的是自己的喇叭聲 —— 步頻與語音指令都要跳過
  window.__speaking = true;
  chime();

  // 每段給一個序號。舊的 onended 與圖片 onload 會晚一步觸發，不隔離的話
  // 會把「下一段」的字幕和照片關掉 —— 症狀是停在一張照片上、沒有字幕。
  const token = (S.sayToken = (S.sayToken || 0) + 1);
  const mine = () => token === S.sayToken;

  S.watchLm = { lat: lm.lat, lng: lm.lng, name: lm.name };
  const bar = $('lm-bar'), pv = $('lm-photo');
  const layers = [pv.children[0], pv.children[1]];
  let cur = 0, pi = 0, photoTimer = null, textTimer = null;
  $('lm-name').textContent = lm.name;
  $('lm-text').textContent = (lm.lines && lm.lines[0]) || '';
  bar.classList.add('on');

  // 先預載再顯示 —— 直接換 background-image 會先黑一下才跳出圖
  const showPhoto = k => {
    const ph = lm.photos || [];
    if (!ph.length) return;
    const url = ph[k % ph.length];
    const img = new Image();
    img.onload = () => {
      if (!mine()) return;                     // 已經換下一段了，這張是舊的
      const next = layers[cur ^ 1];
      next.style.backgroundImage = `url("${url}")`;
      next.classList.remove('on'); void next.offsetWidth; next.classList.add('on');
      layers[cur].classList.remove('on');
      cur ^= 1;
      pv.classList.add('on');
    };
    img.src = url;
  };

  setTimeout(() => {
    if (!mine()) return;
    try { if (audioEl) { audioEl.pause(); } } catch {}
    audioEl = preAudio.get(lm.id) || new Audio(lm.audio);
    audioEl.currentTime = 0;
    audioEl.volume = 0.9;

    const done = () => {
      clearInterval(textTimer); clearInterval(photoTimer);
      if (!mine()) return;                     // 舊的收尾不能動到現在這段
      S.speaking = false; S.nowSpeaking = ''; S.watchLm = null;
      bar.classList.remove('on'); pv.classList.remove('on');
      // 喇叭的尾音還在空氣中，晚一點再開始收指令
      setTimeout(() => { window.__speaking = false; }, 800);
      draw();
    };

    // 字幕跟著時間軸逐句換
    const marks = lm.marks || [], lines = lm.lines || [];
    if (marks.length && lines.length) {
      let i = 0;
      textTimer = setInterval(() => {
        if (!mine()) return clearInterval(textTimer);
        while (i + 1 < marks.length && marks[i + 1] <= audioEl.currentTime) i++;
        $('lm-text').textContent = lines[i] || '';
      }, 120);
    }
    audioEl.onended = done;
    audioEl.onerror = () => { S.note = `⚠ ${lm.name} 的音檔放不出來`; done(); };
    audioEl.onloadedmetadata = () => {
      if (!mine()) return;
      showPhoto(pi++);
      // 照片平均分配在整段導覽裡，但每張至少停 4 秒
      const per = Math.max(4000, (audioEl.duration * 1000) / Math.max(1, (lm.photos || []).length));
      photoTimer = setInterval(() => showPhoto(pi++), per);
    };
    if (audioEl.readyState >= 1) audioEl.onloadedmetadata();
    audioEl.play().catch(done);
  }, 550);
  draw();
}

// 播報結束後把視角平順轉回行進方向，不要瞬間彈回去
setInterval(() => {
  if (S.watchLm || !S.running) return;
  const off = ad(S.travelDir, S.heading);
  if (Math.abs(off) < 0.5) return;
  S.heading += off * 0.12;
  draw();
}, 50);

// 每一步重算「前方最近景點」的距離。查詢是每 150 公尺一次，
// 但顯示的距離要跟著你跑而變，不然數字會卡住不動。
function refreshNext(meta) {
  let next = null;
  for (const lm of S.nearby || []) {
    if (S.spoken.has(lm.id)) continue;
    const d = distM(meta, lm);
    if (Math.abs(ad(bearingTo(meta, lm), S.travelDir)) > 90) continue;
    if (!next || d < next.d) next = { ...lm, d };
  }
  S.nextLm = next;
  // 進入 300 公尺就先把音檔抓下來
  if (next && next.d < 300) preloadAudio(next);
  return next;
}

// 詢問橫幅
function showAsk(lm) {
  S.asking = lm;
  const el = $('lm-ask');
  el.innerHTML = `<div class="t1">即將經過 ${lm.name}</div>`
    + '<div class="t2">說「導覽」就跑過去介紹</div>'
    + '<div class="t3">不用回答，繼續跑就好</div>';
  el.classList.add('on');
}
function hideAsk() { S.asking = null; $('lm-ask').classList.remove('on'); }

// 接受導覽：把景點設成目前的目標，原本的目標記著，看完再回去
async function acceptGuide() {
  const lm = S.asking;
  if (!lm) return false;
  hideAsk();
  S.detourFrom = S.target;
  // 先吸到景點最近的街景點再當目標。景點座標是建築中心（羅浮宮那顆在中庭裡），
  // 直接拿它當目標的話會一直靠近卻進不去 —— 實測繞了 400 公尺還差 190 公尺。
  // 啟動器選景點時有做這件事，繞路時也要做。
  let t = { lat: lm.lat, lng: lm.lng, lm };
  S.note = `⌖ 找 ${lm.name} 的路…`; draw();
  try {
    const r = await (await fetch(`/api/find?ll=${lm.lat},${lm.lng}&r=60`,
      { signal: AbortSignal.timeout(8000) })).json();
    if (r.lat) t = { lat: r.lat, lng: r.lng, lm };
  } catch {}
  S.target = t;
  S.bestToTarget = Infinity; S.targetSetAt = S.moved; S.bestAt = S.moved;
  S.note = `⌖ 往 ${lm.name} 去`;
  dropQueue(); fillQueue(); draw();
  return true;
}

// 繞路結束（到了或到不了）—— 回到原本的目標
function endDetour() {
  S.target = S.detourFrom;
  S.detourFrom = null;
  S.bestToTarget = Infinity; S.targetSetAt = S.moved; S.bestAt = S.moved;
  dropQueue(); fillQueue();
}

async function maybeNarrate(meta) {
  if (!S.narrate) { S.nextLm = null; hideAsk(); return; }
  // 附近景點的查詢一定要在最前面。先前放在 askMode 的 return 之後 ——
  // 詢問模式下永遠不會執行到，S.nearby 一直是空的，所以從來不會問。
  if (S.moved - S.nearbyAt > 150) {
    S.nearbyAt = S.moved;
    try {
      const r = await fetch(`/api/nearby?ll=${meta.lat},${meta.lng}&r=400`,
        { signal: AbortSignal.timeout(6000) });
      S.nearby = (await r.json()).items || [];
    } catch { S.nearby = []; }
  }
  refreshNext(meta);
  if (S.speaking) return;

  // 繞路中：到了就播報。判斷依據是「目前的目標帶著 lm」，
  // 不能用 detourFrom（它初始就是 null，!== undefined 永遠成立）。
  if (S.target && S.target.lm) {
    const lm = S.target.lm;
    const d = distM(meta, S.target);
    if (d < 90) { endDetour(); speak(lm); return; }
    // 繞路放寬到 600 公尺沒進步才放棄 —— 景點常常要繞過街廓才到得了
    if (S.moved - S.bestAt > 600) {
      S.note = `⌖ ${lm.name} 過不去，繼續跑`;
      endDetour();
    }
    return;
  }

  if (S.askMode) {
    // 前方 300 公尺內、還沒問過的就問。300 公尺在 14 km/h 下約 77 秒，
    // 夠你反應，也夠繞過去。
    const n = S.nextLm;
    if (S.asking) {
      // 已經在問了：跑過去或太遠就收起來，並記成問過了
      const still = n && n.id === S.asking.id && n.d < 320
        && Math.abs(ad(bearingTo(meta, S.asking), S.travelDir)) < 80;
      if (!still) { S.askedIds.add(S.asking.id); S.spoken.add(S.asking.id); hideAsk(); }
      return;
    }
    if (n && n.d < 300 && !S.askedIds.has(n.id) && S.moved - S.lastSpokeAt > 300) showAsk(n);
    return;
  }

  if (S.moved - S.lastSpokeAt < 400) return;          // 最小間隔
  // 順便找出「前方最近、還沒播過」的那一個，給 HUD 顯示距離
  let next = null;
  for (const lm of S.nearby) {
    if (S.spoken.has(lm.id)) continue;
    const d = distM(meta, lm);
    if (Math.abs(ad(bearingTo(meta, lm), S.travelDir)) > 90) continue;   // 只算前方的
    if (!next || d < next.d) next = { ...lm, d };
  }
  S.nextLm = next;
  if (next && next.d <= 150) speak(next);
}

// 兩點之間的距離（公尺）
const distM = (a, b) => {
  const R = 6371000;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// 從 a 看向 b 的方位角
const bearingTo = (a, b) => {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lng - a.lng);
  return (Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
};

// 抵達判定與換下一個目標。60 公尺是街景節點的間距量級，再嚴格就永遠到不了。
function checkTarget(meta) {
  if (!S.target) return;
  // 為了看景點而繞路的目標不是路線上的點 —— 交給 maybeNarrate 處理，
  // 不然會被當成「到了第 N 點」而吃掉一個真正的路線點。
  if (S.target.lm) return;
  const now = distM(meta, S.target);
  if (now < 60) {
    S.note = `⌖ 到了第 ${S.targetNo} 點（${(S.moved / 1000).toFixed(2)} km）`;
    nextTarget();
    return;
  }
  if (now < S.bestToTarget - 5) { S.bestToTarget = now; S.bestAt = S.moved; }
  // 放棄條件：跑了 400 公尺都沒有更接近，或總共跑超過 2.5 公里。
  // 目標可能落在街廓中間、私有地或路網構不到的地方 —— 沒有這個機制會在它周圍
  // 無限繞（street-runner 實測跑了 2.2 km 還差 339 m；這次台北實測卡在 205 m
  // 不動了兩分鐘）。只看總距離不夠，要看「多久沒進步」。
  if (S.moved - S.bestAt > 400 || S.moved - S.targetSetAt > 2500) {
    S.note = `⌖ 第 ${S.targetNo} 點到不了（還差 ${Math.round(now)} m），跳過`;
    nextTarget();
  }
}

function nextTarget() {
  S.target = S.targets.shift() || null;
  S.bestToTarget = Infinity;
  S.targetSetAt = S.moved; S.bestAt = S.moved;
  if (S.target) { S.targetNo++; dropQueue(); fillQueue(); }
  else { S.note = '⌖ 全部跑完'; S.running = false; finishRoute(); }
}

function finishRoute() {
  saveTrack();
  if (S.track.length > 1) { exportGPX(); }
  hud.classList.remove('fold');
  draw();
}

// 沿方位角推算座標
const destPoint = (lat, lng, brg, d) => {
  const R = 6371000, br = rad(brg);
  return { lat: lat + d * Math.cos(br) / R * 180 / Math.PI,
           lng: lng + d * Math.sin(br) / (R * Math.cos(rad(lat))) * 180 / Math.PI };
};

// 側移跳點。Google 的連結圖常常是「每條街各自一條鏈」，路口並不互連 ——
// 實測曼哈頓 41 街連走十四顆全景，每一顆都只有正前方和正後方兩條連結，
// 完全沒有橫向的。所以「下個路口右轉」在很多地方永遠等不到。
// 改成往想轉的方向平移十幾公尺，直接問那裡有沒有另一條街的全景。
let hopping = false;
async function lateralHop(side) {
  if (hopping || !S.cur?.meta) return false;
  hopping = true;
  try {
    const m = S.cur.meta;
    const sign = side === 'left' ? -1 : 1;
    const want = ((S.travelDir + sign * 90) % 360 + 360) % 360;
    for (const dist of [12, 22, 34]) {
      const p = destPoint(m.lat, m.lng, want, dist);
      const f = await (await fetch(`/api/find?ll=${p.lat},${p.lng}&r=18`)).json();
      if (f.error || !f.pano || f.pano === m.pano) continue;
      const nm = await (await fetch('/api/meta?pano=' + f.pano)).json();
      if (nm.error || !nm.links.length) continue;
      // 落點那條路要真的往我們想去的方向，不然只是跳到同一條街的隔壁而已
      const good = nm.links.find(l => Math.abs(ad(l.heading, want)) < 50);
      if (!good) continue;
      const P = mkPano();
      if (!await load(P, f.pano, good.heading)) continue;
      dropQueue();
      S.cur = P; S.travelDir = good.heading; S.heading = good.heading;
      S.turnSeq++; S.wish = null;
      S.note = `⤳ 側移 ${dist} m 轉進岔路`;
      fillQueue(); draw();
      return true;
    }
    return false;
  } finally { hopping = false; }
}

// 轉向指令。語音（voice.js）和鍵盤共用這一個入口。
window.__turn = (cmd, text) => {
  if (cmd === 'guide') {
    acceptGuide().then(ok => {
      if (!ok) { S.note = '（現在沒有可以導覽的景點）'; draw(); }
    });
    return;
  }
  if (cmd === 'stop') { finishRun(text); return; }
  S.turnSeq++;
  if (cmd === 'back') {
    // 回頭是立刻生效的 —— 掉頭不需要等路口
    S.travelDir = (S.travelDir + 180) % 360;
    S.heading = S.travelDir;
    S.wish = null;
    S.note = '↺ 回頭' + (text ? `（聽到「${text}」）` : '');
  } else {
    S.wish = cmd; S.wishAt = S.moved; S.probedAt = S.moved;
    S.note = (cmd === 'left' ? '⟲ 左轉' : '⟳ 右轉')
      + (text ? `（聽到「${text}」）` : '');
    // 先看現在這顆有沒有那一側的連結；沒有就馬上試側移跳點
    if (!pickLink(S.cur.meta, S.travelDir, cmd)) lateralHop(cmd);
  }
  dropQueue(); fillQueue(); draw();
};

// 語音辨識要使用者手勢才拿得到麥克風，跟步頻偵測同一個道理
let voiceLoading = false;
function startVoice() {
  if (voiceLoading || window.__voice) return;
  voiceLoading = true;
  const sc = document.createElement('script');
  sc.src = '/voice.js';
  document.head.appendChild(sc);
}

// 語音的狀態要能分辨，不然「沒反應」查不出是哪一種
function voiceState() {
  const v = window.__voice;
  if (!v) return voiceLoading ? '載入中' : '未啟用';
  if (v.error === 'not-allowed') return '麥克風被拒';
  if (v.error === 'audio-capture') return '找不到麥克風';
  if (v.on) {
    const l = v.log && v.log[0];
    return '聽著' + (v.heard ? ' ×' + v.heard : '') + (v.dropped ? ' 丟' + v.dropped : '')
      + (l ? `　「${l.text}」${l.cmd ? '→' + l.cmd : '（沒對上）'}` : '');
  }
  return v.error ? '重連中(' + v.error + ')' : '重連中';
}

// 語音沒起來時給一個明顯可以點的入口 —— Chrome 沒有使用者手勢不給麥克風，
// 而使用者不會知道「要先點一下畫面」。
function voiceBanner() {
  let b = document.getElementById('vbanner');
  const need = S.voice && (!window.__voice || (!window.__voice.on && !window.__voice.heard));
  if (!need) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'vbanner';
    b.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9;'
      + 'background:rgba(47,125,79,.94);color:#fff;padding:9px 16px;border-radius:999px;'
      + 'font:600 14px/1 -apple-system,"PingFang TC",sans-serif;cursor:pointer;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.4)';
    b.onclick = () => {
      if (window.__voice?.start) window.__voice.start(); else startVoice();
      b.textContent = '🗣 啟動中…請允許麥克風';
    };
    document.body.appendChild(b);
  }
  b.textContent = window.__voice?.error === 'not-allowed'
    ? '🗣 麥克風被拒 —— 點網址列左邊的圖示改成「允許」，再點這裡重試'
    : '🗣 點一下啟用語音轉向';
}

// 改片數時保持總視野不變 —— 片數只是「把同一片視野切成幾段直線透視」，
// 切得越細，接縫的折角越小（實測 210° 總視野：3 片折 16.9°、5 片 6.2°、7 片 3.2°），
// 而且每片越窄、直線透視的拉伸越少，中央解析度反而更好（12.2 → 13.4 px/度）。
// 極限就是圓柱投影。單一平面螢幕上，片數多是純粹的好處。
function setPanels(n) {
  const total = S.hFovPer * S.panels;
  S.panels = Math.max(1, Math.min(9, n));
  S.hFovPer = total / S.panels;
  S.proj = 'flat';
}

// ── 即時調整面板 ──
// 「場景深度」跟「推近倍率」是同一個旋鈕：R = d / (1 − 1/M)。
// 街道實際多寬會變，所以這個值本來就該現場調 ——
// 寬大道（香榭麗舍那種）約 38 m 對應 1.35，窄巷子要調到 20 m 上下。
const TUNE = [
  ['zoom', 'zoomPer',   v => `${(+v).toFixed(2)}×　${(S.stepD / (1 - 1 / +v)).toFixed(0)} m`],
  ['diss', 'dissolveMs', v => `${v} ms`],
  // 這一格調的是「總視野」而不是每片 —— 每片的值會隨片數變，
  // 拿它當旋鈕的話換片數後意義就跑掉了，使用者無從理解。
  ['hfov', 'totalFov',  v => `${v}°　每片 ${(v / S.panels).toFixed(0)}°`],
  ['bot',  'bottomDeg', v => `−${v}°`],
  ['kmh',  'kmh',       v => `${v} km/h`],
  ['pan',  'panels',    v => `${v} 片　每片 ${(S.hFovPer).toFixed(0)}°`],
];
const tune = document.getElementById('tune');
if (tune) {
  const sync = () => {
    for (const [id, key, fmt] of TUNE) {
      const el = document.getElementById('t-' + id);
      const val = key === 'totalFov' ? Math.round(S.hFovPer * S.panels) : S[key];
      if (document.activeElement !== el) el.value = val;
      document.getElementById('v-' + id).textContent = fmt(val);
    }
  };
  for (const [id, key] of TUNE) {
    document.getElementById('t-' + id).addEventListener('input', e => {
      if (key === 'panels') setPanels(+e.target.value);        // 要連帶改每片視野
      else if (key === 'totalFov') S.hFovPer = +e.target.value / S.panels;
      else S[key] = +e.target.value;
      if (key === 'kmh') S.kmhCap = S.kmh;
      sync(); draw();
    });
  }
  document.getElementById('tclose').onclick = () => tune.classList.remove('on');
  // 面板上的滑桿要吃自己的鍵盤事件，不要被跑步的快捷鍵搶走
  tune.addEventListener('keydown', e => e.stopPropagation());
  setInterval(() => { if (tune.classList.contains('on')) sync(); }, 400);
  window.__tuneSync = sync;
}

// 兩個狀態欄都可以點一下收合／展開，預設收合
const keysEl = document.getElementById('keys');
hud.addEventListener('click', () => { hud.classList.toggle('fold'); draw(); });
keysEl?.addEventListener('click', () => keysEl.classList.toggle('fold'));

// ── 操作 ──
let dragging = false, lastX = 0, lastY = 0, reload = null;
const reloadSoon = () => {
  clearTimeout(reload);
  reload = setTimeout(() => { if (S.cur?.meta) load(S.cur, S.cur.meta.pano, S.heading).then(draw); }, 200);
};
cv.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; cv.classList.add('drag'); });
addEventListener('mouseup', () => { dragging = false; cv.classList.remove('drag'); });
addEventListener('mousemove', e => {
  if (!dragging) return;
  S.heading += (e.clientX - lastX) * 0.18;
  S.pitch = Math.max(-50, Math.min(50, S.pitch + (e.clientY - lastY) * 0.12));
  lastX = e.clientX; lastY = e.clientY;
  draw(); if (!S.running) reloadSoon();
});
addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    S.running = !S.running;
    if (S.running) { S.t0 = S.t0 || Date.now(); S.runId = S.runId || Date.now();
      if (S.mic) startMic(); if (S.voice) startVoice(); S.travelDir = S.heading; dropQueue(); runLoop(); }
  }
  else if (e.key === 'ArrowLeft') { window.__turn('left'); return; }
  else if (e.key === 'ArrowRight') { window.__turn('right'); return; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); window.__turn('back'); return; }
  else if (e.key === '+' || e.key === '=') S.kmh = Math.min(20, S.kmh + 1);
  else if (e.key === '-') S.kmh = Math.max(4, S.kmh - 1);
  else if (e.key >= '1' && e.key <= '9') setPanels(+e.key);
  else if (e.key === '9') S.pitch = S.pitch >= 12 ? 0 : S.pitch + 4;
  else if (e.key === 'i') hud.classList.toggle('fold');
  else if (e.key === ',') {
    tune.classList.toggle('on');
    if (tune.classList.contains('on') && window.__tuneSync) window.__tuneSync();
    return;
  }
  else if (e.key === 's') { exportGPX(); return; }
  else if (e.key === 'e') { finishRun(); return; }
  else if (e.key === 'g') { window.__turn('guide'); return; }   // 鍵盤版的「導覽」
  else if (e.key === 'N') { S.askMode = !S.askMode; S.note = S.askMode ? '❓ 詢問模式' : '🔊 自動播報'; }
  else if (e.key === 'n') {                            // 導覽開關
    S.narrate = !S.narrate;
    if (!S.narrate) {
      hideAsk();
      S.sayToken = (S.sayToken || 0) + 1;      // 讓進行中那段的收尾失效
      try { if (audioEl) audioEl.pause(); } catch {}
      S.speaking = false; window.__speaking = false;
      $('lm-bar').classList.remove('on'); $('lm-photo').classList.remove('on');
    }
    S.note = S.narrate ? '🔊 景點導覽開' : '🔇 景點導覽關';
  }
  else if (e.key === '0') S.proj = S.proj === 'pan' ? 'flat' : 'pan';
  else if (e.key === 'd') {
    const L = [-1, 0.3, 0.6, 1.0, 1.5, 2.0];      // −1 = 圓柱
    S.paniniD = L[(L.findIndex(x => Math.abs(x - S.paniniD) < 0.01) + 1) % L.length];
  }
  else if (e.key === 'f') S.bottomDeg = S.bottomDeg >= 34 ? 20 : S.bottomDeg + 3;
  else if (e.key === 'b') S.fit = !S.fit;
  else if (e.key === 'h') {                       // 總視野循環
    const T = [120, 150, 180, 210, 240, 280];
    const cur = Math.round(S.hFovPer * S.panels);
    const i = T.findIndex(x => x > cur + 1);
    S.hFovPer = T[i < 0 ? 0 : i] / S.panels;
  }
  else if (e.key === 't') { openWing(); return; }
  else if (e.key === 'g') S.gap = !S.gap;
  else if (e.key === '<') S.span = Math.max(80, S.span - 20);
  else if (e.key === '>') S.span = Math.min(340, S.span + 20);
  else if (e.key === '[') S.fov = Math.max(40, S.fov - 4);
  else if (e.key === ']') S.fov = Math.min(110, S.fov + 4);
  else if (e.key === 'z') S.zoom = S.zoom === 5 ? 4 : (S.zoom === 4 ? 3 : 5);
  else if (e.key === 'r') {
    const M = [1.2, 1.35, 1.5, 1.7];
    const i = M.findIndex(x => Math.abs(x - S.zoomPer) < 0.01);
    S.zoomPer = M[(i + 1) % M.length];
  }
  else if (e.key === 'H') S.camH = S.camH ? 0 : 2.5;   // 地平面模型（大寫 H）
  else return;
  draw(); if (!S.running) reloadSoon();
});
addEventListener('resize', () => { draw(); if (!S.running) reloadSoon(); });

// 給自動化測試看的：跑完之後的統計
window.__S = S;
window.__mix = () => S.mix;
window.__set = (k, v) => { S[k] = v; draw(); };
window.__stats = () => ({ steps: S.steps, moved: S.moved, waited: S.waited,
                          moving: S.movingMs, wall: Date.now() - (S.t0 || Date.now()),
                          mb: netBytes / 1048576, dir: S.travelDir, wish: S.wish, note: S.note, running: S.running, note: S.note,
                          fps: S.fps, lat: S.cur?.meta?.lat, lng: S.cur?.meta?.lng });

// 麥克風權限需要使用者手勢。從啟動器帶 run=1 進來時沒有手勢，
// 所以掛一次性的監聽 —— 使用者按任何一個鍵或點一下畫面就開始聽。
addEventListener('pointerdown', () => { if (S.mic) startMic(); if (S.voice) startVoice(); }, { once: true });
addEventListener('keydown', () => { if (S.mic) startMic(); if (S.voice) startVoice(); }, { once: true });

// ── 起動 ──
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.has('panels')) S.panels = +q.get('panels');
  if (q.get('proj') === 'pan' || q.get('proj') === 'cyl') S.proj = 'pan';
  if (q.has('d')) S.paniniD = +q.get('d');
  if (q.has('zoomper')) S.zoomPer = +q.get('zoomper');
  if (q.get('fit') === '0') S.fit = false;
  if (S.panelIdx !== null) S.panels = 3;
  if (q.has('panels') && S.panelIdx === null) {
    // 網址給的片數要保持總視野 —— 預設 3 片 × 70° = 210°
    const n = Math.max(1, Math.min(9, +q.get('panels')));
    S.hFovPer = (S.hFovPer * 3) / n; S.panels = n;
  }
  if (q.has('bottom')) S.bottomDeg = +q.get('bottom');
  if (q.get('narrate') === '0') S.narrate = false;
  if (q.get('ask') === '0') S.askMode = false;
  if (q.get('targets')) {
    S.targets = q.get('targets').split('|').map(t => {
      const [la, ln] = t.split(',').map(Number);
      return isFinite(la) && isFinite(ln) ? { lat: la, lng: ln } : null;
    }).filter(Boolean);
    S.target = S.targets.shift() || null;
    S.targetNo = 2;                       // 使用者點的第 1 個是起跑點
  }
  if (q.has('hfov')) S.hFovPer = +q.get('hfov');
  // 直接給螢幕尺寸與距離，程式自己算出幾何正確的水平視野。
  // sw = 單片可視寬度(mm)（單螢幕就是整片寬），dist = 眼睛到螢幕(mm)
  if (q.has('sw') && q.has('dist')) {
    S.hFovPer = 2 * Math.atan(+q.get('sw') / 2 / +q.get('dist')) * 180 / Math.PI;
  }
  if (q.get('gap') === '1') S.gap = true;
  if (q.has('bezel')) S.bezel = +q.get('bezel');
  // 實體螢幕：給「單螢幕可視高度(mm)」與「眼睛到螢幕距離(mm)」，
  // 直接算出幾何正確的垂直視野 —— 這樣畫面裡的角度就等於你眼睛看到的角度，
  // 三台螢幕擺成對應的夾角之後，接縫的折角在視覺上會消失。
  if (q.has('sh') && q.has('dist')) {
    S.fov = 2 * Math.atan(+q.get('sh') / 2 / +q.get('dist')) * 180 / Math.PI;
  }
  if (q.has('span')) S.span = +q.get('span');
  if (q.has('fov')) S.fov = +q.get('fov');
  if (q.has('zoom')) S.zoom = +q.get('zoom');
  if (q.has('kmh')) { S.kmh = +q.get('kmh'); S.kmhCap = S.kmh; }
  if (q.get('mic') === '1') S.mic = true;
  if (q.get('voice') === '1') S.voice = true;
  if (q.get('hud') === '0') { hud.style.display = 'none'; document.getElementById('keys').style.display = 'none'; }
  let pano = q.get('pano');
  if (!pano) {
    const ll = q.get('ll') || '35.52326,138.74587';       // 預設：大石公園
    const f = await (await fetch('/api/find?ll=' + encodeURIComponent(ll))).json();
    if (f.error) { hud.textContent = f.error; return; }
    pano = f.pano;
  }
  // 先只拿中繼資料決定朝向，再照那個朝向載磚塊。
  // 先前是「用朝向 0 載一次、再用真朝向載一次」，等於把起動的等待時間加倍。
  const m0 = await (await fetch('/api/meta?pano=' + encodeURIComponent(pano))).json();
  if (m0.error) { hud.textContent = m0.error; return; }
  S.heading = q.has('head') ? +q.get('head')
    : (m0.links.length ? m0.links[0].heading : m0.yaw);
  S.travelDir = S.heading;
  S.cur = mkPano();
  hud.textContent = '載入街景磚塊…';
  await load(S.cur, pano, S.heading);
  draw();
  window.__ready = true;                       // 給自動化測試用：磚塊真的抓完了
  if (S.role !== 'follow') fillQueue();
  // 起跑前就先把下一顆抓起來 —— 不然第一步要現抓，實測會多等一秒多，
  // 而那一下正好是使用者最容易注意到的地方。
  fillQueue();
  if (S.role === 'follow') { draw(); return; }   // 從屬只等主控的廣播
  if (S.voice) startVoice();       // 權限給過的話不需要手勢就能起來
  if (q.get('run') === '1') { S.running = true; S.t0 = Date.now(); S.runId = Date.now(); runLoop(); }
  // 關掉分頁前把最後幾個點存起來
  addEventListener('pagehide', saveTrack);
  addEventListener('visibilitychange', () => { if (document.hidden) saveTrack(); });
  // 語音狀態會變，讓收合的 HUD 也跟著更新
  setInterval(() => { if (!S.running) draw(); }, 1000);
})();
