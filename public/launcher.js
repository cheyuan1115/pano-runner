// 啟動器：在地圖上點起跑點與朝向，設速度，然後跳到 run.html。
//
// 自己寫一個很小的滑動地圖，不引外部函式庫 —— 只需要 Web Mercator 換算加上
// 一層 <img> 磚塊。底圖走自家 /maptile 代理(OSM 磚+本機快取)。
//
// 按「開始跑」之前會先問 /api/find：點的地方沒有街景就當場說，
// 不要讓使用者跳過去才看到一片黑。

const TS = 256;
const el = id => document.getElementById(id);
const map = el('map'), ink = el('ink'), ctx = ink.getContext('2d');

const V = { lat: 48.8698, lng: 2.3078, z: 15 };     // 預設：香榭麗舍
// 使用者點的一串點：第 1 個是起跑點，之後每個都是要依序跑到的目標。
// 朝向由起跑點指向第 2 個點自動決定 —— 不需要再單獨點一次方向。
let pts = [];
// 目前視野內的景點。地圖一動就重抓（節流過），只在放大到看得清時才顯示名字。
let lms = [], lmTimer = null;

function loadLandmarks() {
  clearTimeout(lmTimer);
  lmTimer = setTimeout(async () => {
    if (V.z < 12) { lms = []; drawInk(); return; }   // 太遠就不顯示，會糊成一團
    const { w, h } = size();
    const nw = toLL(0, 0), se = toLL(w, h);
    try {
      const r = await fetch(`/api/landmarks?bbox=${se.lat},${nw.lng},${nw.lat},${se.lng}`);
      const j = await r.json();
      lms = j.items || [];
    } catch { lms = []; }
    drawInk();
  }, 200);
}
// 鬧區疊層:店家密度熱區 + 徒步區/商業區塊。「哪條街熱鬧」地圖上看不出來,
// 店家密度是最好的代理指標(實際反饋:查都市地圖不知道哪裡熱鬧)。
let vibe = null, vibeTimer = null;
let vibeOn = localStorage.getItem('pano-vibe') !== '0';
function loadVibe() {
  clearTimeout(vibeTimer);
  if (!vibeOn || V.z < 13) return;         // 縮太遠一格才幾個像素,畫了也看不出層次
  vibeTimer = setTimeout(async () => {
    const { w, h } = size();
    const nw = toLL(0, 0), se = toLL(w, h);
    try {
      const r = await fetch(`/api/vibe?bbox=${se.lat},${nw.lng},${nw.lat},${se.lng}`);
      const j = await r.json();
      if (j.pts && j.pts.length) { vibe = j; drawInk(); }
    } catch {}
  }, 350);
}

// 街景涵蓋:選百度/Apple 時,放大後在地圖撒網格探測、畫綠點(有街景的地方)。
// 讀 localStorage 判斷來源(SRC 變數在檔案後面才宣告,這裡會踩 TDZ)。
let cov = null, covTimer = null;
function coverSrc() { const s = localStorage.getItem('pano-src2'); return ['apple','baidu','yandex','kakao'].includes(s) ? s : ''; }
function loadCoverage() {
  clearTimeout(covTimer);
  const src = coverSrc();
  if (!src || V.z < 14) { if (cov) { cov = null; drawInk(); } return; }   // 縮太遠不撒網
  covTimer = setTimeout(async () => {
    const { w, h } = size();
    const nw = toLL(0, 0), se = toLL(w, h);
    try {
      const r = await fetch(`/api/coverage?src=${src}&bbox=${se.lat},${nw.lng},${nw.lat},${se.lng}`);
      const j = await r.json();
      cov = (j.pts || []); drawInk();
    } catch {}
  }, 400);
}

let shown = null;                                    // 現在畫在地圖上的那一趟

// ── Web Mercator ──
const world = z => TS * 2 ** z;
const lng2x = (lng, z) => (lng + 180) / 360 * world(z);
const lat2y = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world(z);
};
const x2lng = (x, z) => x / world(z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI * (1 - 2 * y / world(z));
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const bearing = (a, b) => {
  const φ1 = a.lat * Math.PI/180, φ2 = b.lat * Math.PI/180, Δλ = (b.lng - a.lng) * Math.PI/180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

// 螢幕座標 ↔ 經緯度
const size = () => ({ w: innerWidth, h: innerHeight });
const toScreen = p => {
  const { w, h } = size();
  return { x: lng2x(p.lng, V.z) - lng2x(V.lng, V.z) + w / 2,
           y: lat2y(p.lat, V.z) - lat2y(V.lat, V.z) + h / 2 };
};
const toLL = (sx, sy) => {
  const { w, h } = size();
  return { lat: y2lat(lat2y(V.lat, V.z) - h / 2 + sy, V.z),
           lng: x2lng(lng2x(V.lng, V.z) - w / 2 + sx, V.z) };
};

// ── 磚塊 ──
const cache = new Map();
const svCache = new Map();   // Google 街景涵蓋層圖磚
function drawMap() {
  const { w, h } = size();
  const left = lng2x(V.lng, V.z) - w / 2, top = lat2y(V.lat, V.z) - h / 2;
  const n = 2 ** V.z;
  const x0 = Math.floor(left / TS), y0 = Math.floor(top / TS);
  const x1 = Math.floor((left + w) / TS), y1 = Math.floor((top + h) / TS);
  const keep = new Set();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    const tx = ((x % n) + n) % n, key = `${V.z}/${tx}/${y}`;
    keep.add(key);
    let img = cache.get(key);
    if (!img) {
      img = new Image();
      img.className = 'tile';
      // 改走自家 /maptile 代理:CARTO 斷供後換 OSM,順便吃到本機快取
      img.src = `/maptile?z=${V.z}&x=${tx}&y=${y}`;
      cache.set(key, img);
      map.appendChild(img);
    }
    img.style.left = (x * TS - left) + 'px';
    img.style.top = (y * TS - top) + 'px';
    img.style.display = '';
    // Google 街景涵蓋層(藍線,對齊),疊在底圖上
    if (!coverSrc() && V.z >= 10) {
      let sv = svCache.get(key);
      if (!sv) { sv = new Image(); sv.className = 'svtile'; sv.src = `/svtile?z=${V.z}&x=${tx}&y=${y}`; svCache.set(key, sv); map.appendChild(sv); }
      sv.style.left = (x * TS - left) + 'px'; sv.style.top = (y * TS - top) + 'px'; sv.style.display = '';
    }
  }
  for (const [k, img] of cache) if (!keep.has(k)) img.style.display = 'none';
  for (const [k, sv] of svCache) if (!keep.has(k) || coverSrc() || V.z < 10) sv.style.display = 'none';
  const zl = el('zlvl'); if (zl) zl.textContent = 'z' + V.z;
  loadLandmarks();
  loadVibe();
  loadCoverage();
  drawInk();
}

function drawInk() {
  const dpr = Math.min(2, devicePixelRatio || 1), { w, h } = size();
  ink.width = w * dpr; ink.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (cov && cov.length && V.z >= 14) {
    ctx.fillStyle = 'rgba(70,190,90,.85)';
    for (const p of cov) {
      const q = toScreen(p);
      if (q.x < -10 || q.y < -10 || q.x > w + 10 || q.y > h + 10) continue;
      ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, 7); ctx.fill();
    }
  }
  if (vibeOn && vibe && V.z >= 13) {
    // 徒步區/商業區塊:整塊淡橘,一眼看出「商店街在這」
    ctx.fillStyle = 'rgba(255,150,60,.10)';
    ctx.strokeStyle = 'rgba(255,150,60,.22)'; ctx.lineWidth = 1;
    for (const poly of vibe.polys || []) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const q = toScreen({ lat: poly[i][0], lng: poly[i][1] });
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // 店家熱度:26px 格子計數 → 越密越紅,整層模糊一次就是熱區圖
    const CS = 26, bins = new Map();
    for (const pp of vibe.pts) {
      const q = toScreen({ lat: pp[0], lng: pp[1] });
      if (q.x < -CS || q.y < -CS || q.x > w + CS || q.y > h + CS) continue;
      const k = Math.floor(q.x / CS) + ':' + Math.floor(q.y / CS);
      bins.set(k, (bins.get(k) || 0) + 1);
    }
    const off = loadVibe.cv || (loadVibe.cv = document.createElement('canvas'));
    off.width = w; off.height = h;
    const oc = off.getContext('2d');
    for (const [k, c] of bins) {
      const [bx, by] = k.split(':').map(Number);
      oc.fillStyle = `rgba(255,90,20,${Math.min(.55, c * .07)})`;
      oc.fillRect(bx * CS, by * CS, CS, CS);
    }
    ctx.save(); ctx.filter = 'blur(9px)'; ctx.globalAlpha = .5;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }
  if (typeof shown !== 'undefined' && shown) {
    ctx.strokeStyle = '#8ab4f8'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    shown.pts.forEach((p, i) => {
      const s2 = toScreen(p);
      i ? ctx.lineTo(s2.x, s2.y) : ctx.moveTo(s2.x, s2.y);
    });
    ctx.stroke();
    for (const [p, col] of [[shown.pts[0], '#6fd08c'], [shown.pts[shown.pts.length - 1], '#e06060']]) {
      const s2 = toScreen(p);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s2.x, s2.y, 6, 0, 7); ctx.fill();
    }
  }
  // ── 景點 ──
  // 先畫點，再畫名字，這樣名字不會被別的點蓋住。
  // 縮放不夠大時只畫點不畫名字，免得整片都是字。
  const showName = V.z >= 14;
  const drawn = [];
  for (const l of lms) {
    const q = toScreen(l);
    if (q.x < -40 || q.y < -20 || q.x > innerWidth + 40 || q.y > innerHeight + 20) continue;
    ctx.fillStyle = 'rgba(240,180,90,.95)';
    ctx.strokeStyle = 'rgba(20,20,24,.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, 7); ctx.fill(); ctx.stroke();
    drawn.push({ l, q });
  }
  if (showName) {
    ctx.font = '500 12px -apple-system, "PingFang TC", sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const taken = [];
    for (const { l, q } of drawn) {
      const wtxt = ctx.measureText(l.name).width;
      const box = { x: q.x + 9, y: q.y - 8, w: wtxt + 8, h: 16 };
      // 標籤重疊就跳過，寧可少顯示幾個也不要疊成一團
      if (taken.some(t => box.x < t.x + t.w && box.x + box.w > t.x
                       && box.y < t.y + t.h && box.y + box.h > t.y)) continue;
      taken.push(box);
      ctx.fillStyle = 'rgba(14,15,18,.78)';
      ctx.fillRect(box.x - 4, box.y, box.w, box.h);
      ctx.fillStyle = '#f0c07a';
      ctx.fillText(l.name, box.x, q.y + 0.5);
    }
  }

  if (!pts.length) return;

  const sp = pts.map(toScreen);
  // 點與點之間連線
  if (sp.length > 1) {
    ctx.strokeStyle = 'rgba(111,208,140,.85)'; ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]); ctx.lineJoin = 'round';
    ctx.beginPath();
    sp.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.stroke(); ctx.setLineDash([]);
    // 起跑方向的箭頭
    const a = Math.atan2(sp[1].y - sp[0].y, sp[1].x - sp[0].x);
    ctx.strokeStyle = '#6fd08c'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const t of [-0.45, 0.45]) {
      ctx.moveTo(sp[0].x + Math.cos(a) * 46, sp[0].y + Math.sin(a) * 46);
      ctx.lineTo(sp[0].x + Math.cos(a + t) * 30, sp[0].y + Math.sin(a + t) * 30);
    }
    ctx.stroke();
  }
  // 編號標記：起點綠、中途白、終點紅
  sp.forEach((q, i) => {
    const last = i === sp.length - 1;
    ctx.fillStyle = i === 0 ? '#6fd08c' : (last && sp.length > 1 ? '#e06060' : '#dfe3ea');
    ctx.strokeStyle = '#0d0e10'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0d0e10';
    ctx.font = '600 12px -apple-system, "PingFang TC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), q.x, q.y + 0.5);
  });
}

// ── 操作 ──
let down = null, moved = 0;
map.addEventListener('mousedown', e => { down = { x: e.clientX, y: e.clientY, lat: V.lat, lng: V.lng }; moved = 0; });
addEventListener('mousemove', e => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  moved = Math.max(moved, Math.hypot(dx, dy));
  if (moved > 3) {
    map.classList.add('pan');
    V.lng = x2lng(lng2x(down.lng, V.z) - dx, V.z);
    V.lat = y2lat(lat2y(down.lat, V.z) - dy, V.z);
    drawMap();
  }
});
addEventListener('mouseup', e => {
  if (down && moved <= 3) click(e.clientX, e.clientY);
  down = null; map.classList.remove('pan');
});
// 觸控板的兩指滑動會發出 wheel 事件 —— 先前把所有 wheel 都當成縮放，
// 所以想平移時畫面在瘋狂縮放（一個手勢會產生幾十個事件，一次跳一級就直接衝到底）。
// macOS 的捏合手勢會帶 ctrlKey，用它區分：捏合＝縮放，滑動＝平移。
// 縮放還要累積到一個門檻才跳一級，不然滑鼠滾輪也會太靈敏。
let wheelAcc = 0;
addEventListener('wheel', e => {
  if (e.target.closest && e.target.closest('#side')) return;   // 面板裡照常捲動
  e.preventDefault();
  const zooming = e.ctrlKey || e.metaKey;
  if (!zooming) {
    // 兩指滑動：平移
    V.lng = x2lng(lng2x(V.lng, V.z) + e.deltaX, V.z);
    V.lat = y2lat(lat2y(V.lat, V.z) + e.deltaY, V.z);
    drawMap();
    return;
  }
  wheelAcc += e.deltaY;
  const STEP = 40;                       // 累積這麼多才跳一級
  if (Math.abs(wheelAcc) < STEP) return;
  const dir = wheelAcc < 0 ? 1 : -1;
  wheelAcc = 0;
  const before = toLL(e.clientX, e.clientY);
  V.z = Math.max(3, Math.min(19, V.z + dir));
  const after = toLL(e.clientX, e.clientY);
  V.lat += before.lat - after.lat; V.lng += before.lng - after.lng;
  drawMap();
}, { passive: false });

// 縮放按鈕與鍵盤 —— 觸控板不好捏合時用這個
const zoomBy = d => {
  V.z = Math.max(3, Math.min(19, V.z + d));
  drawMap();
};
addEventListener('keydown', e => {
  if (/input|textarea|select/i.test(e.target.tagName)) return;
  if (e.key === '+' || e.key === '=') zoomBy(1);
  else if (e.key === '-' || e.key === '_') zoomBy(-1);
});

addEventListener('resize', drawMap);

// 點到景點就用景點的座標（吸附），並記住名字
function nearestLandmark(sx, sy) {
  let best = null, bd = 22;                     // 22 px 內算點到
  for (const l of lms) {
    const q = toScreen(l);
    const d = Math.hypot(q.x - sx, q.y - sy);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

function click(sx, sy) {
  const lm = nearestLandmark(sx, sy);
  const p = lm ? { lat: lm.lat, lng: lm.lng, lm } : toLL(sx, sy);
  pts.push(p);
  // 每個點都吸到最近的街景。景點座標是建築中心，常常不在路上 ——
  // 不吸的話跑步時會一直靠近卻永遠到不了（抵達門檻是 60 公尺）。
  snap(pts.length - 1);
  drawInk();
}

async function snap(i) {
  const p = pts[i];
  el('start').disabled = true;
  el('step').textContent = p.lm ? `找「${p.lm.name}」最近的街景…` : '看看那裡有沒有街景…';
  try {
    const r = await fetch(`/api/find?${SRC ? 'src=' + SRC + '&' : ''}ll=${p.lat},${p.lng}&r=60`).then(x => x.json());
    if (r.error || !r.lat) {
      el('step').textContent = '⚠ 這附近沒有街景，換個點。';
      pts.splice(i, 1); drawInk(); return;
    }
    const moved = Math.round(distM(p, r));
    p.lat = r.lat; p.lng = r.lng; p.pano = r.pano; p.snap = moved;
    drawInk(); say();
    if (moved > 40) {
      el('step').textContent += `（${p.lm ? p.lm.name : '該點'} 吸到 ${moved} m 外的路上）`;
    }
  } catch { el('step').textContent = '⚠ 查不到（伺服器沒回應？）'; }
}

const distM = (a, b) => {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// 沿著點列的總長度（公里）
const routeKm = () => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], R = 6371000, rad = x => x * Math.PI / 180;
    const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
    m += 2 * R * Math.asin(Math.sqrt(h));
  }
  return m / 1000;
};

const say = () => {
  const n = pts.length;
  el('step').textContent = !n ? '先在地圖上點「起跑點」。'
    : n === 1 ? '再點一個點決定往哪跑（可以繼續點，會依序跑過去）。'
    : `${n} 個點　約 ${routeKm().toFixed(2)} km`
      + (pts.filter(q => q.lm).length ? `　含 ${pts.filter(q => q.lm).length} 個景點` : '')
      + '　可以開跑了';
  el('start').disabled = n < 2;
};

// ── 搜尋 ──
// 搜尋後主動暖景點:請伺服器抓中心 3×3 格(約 2.4 公里見方)的維基景點。
// 新城市要現場跟維基要,幾秒到幾十秒才陸續回來 —— 期間每隔幾秒重撈重畫,
// 橘點到了就自己浮出來,不用使用者晃地圖(實際反饋:搜尋完是空地圖)。
let warmSeq = 0;
async function warmSpots(lat, lng) {
  const seq = ++warmSeq;
  fetch(`/api/citywarm?ll=${lat},${lng}`).catch(() => {});   // 整城單一查詢
  for (const d of [2500, 4000, 6000, 8000, 10000, 15000, 20000]) {
    await new Promise(r => setTimeout(r, d));
    if (seq !== warmSeq) return;             // 使用者又搜了別的地方
    loadLandmarks();
  }
}
async function search() {
  const q = el('q').value.trim();
  if (!q) return;
  el('step').textContent = '搜尋中…';
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=zh-TW&q='
      + encodeURIComponent(q);
    const j = await (await fetch(u)).json();
    if (!j.length) { el('step').textContent = '找不到這個地方。'; return; }
    V.lat = +j[0].lat; V.lng = +j[0].lon; V.z = 16;
    pts = []; shown = null;
    drawMap(); say();
    warmSpots(V.lat, V.lng);   // 主動把這一帶的景點標出來
  } catch { el('step').textContent = '搜尋失敗。'; }
}
// 🤖 AI 排路線:以地圖中心為城市,演算法+Gemini 排一條環狀路線,
// 畫上地圖(沿用手點路線的 pts 機制),開場白存起來開跑時唸
el('aiplan').onclick = async () => {
  el('step').textContent = '🤖 AI 規畫路線中…(約十幾秒)';
  try {
    const r = await fetch(`/api/planroute?ll=${V.lat},${V.lng}&km=${el('plankm').value}${langQ()}`,
      { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (j.error) { el('step').textContent = '⚠ ' + j.error; return; }
    pts = j.pts.map(p => ({ lat: p.lat, lng: p.lng }));
    shown = null;
    V.lat = pts[0].lat; V.lng = pts[0].lng;
    try { localStorage.setItem('pano-blurb', j.blurb || ''); } catch {}
    drawMap(); say();
    el('step').textContent = `🤖 約 ${j.km} km 環狀:${j.names.join('→')}。按「開始跑」出發!`;
  } catch { el('step').textContent = '⚠ 規畫失敗,再試一次'; }
};
el('go').onclick = search;
el('q').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });

// 第五個元素（可選）：字串 = 直接起跑的網址參數。
// 🌸 兩條是實際驗證過「畫面裡有滿開櫻花」的官方採集，
// 用 pano= 直接從驗證過的那顆出發 —— 用 ll= 會吸到外面的馬路
//（實測吸去 2015/3 的鏈，整條沒花）：
//   造幣局「桜の通り抜け」2012/4 腳架拍，60+ 顆相連約 300 公尺
//   千鳥ヶ淵 2019/4 綠道
const QUICK = [
  ['🗿馬丘比丘', -13.1631, -72.5450, 16, 'rail=machu'],
  ['🐫吉薩金字塔', 29.9773, 31.1325, 15, 'rail=giza'],
  ['🏚軍艦島廢墟', 32.6278, 129.7386, 16, 'rail=hashima'],
  ['🐧南極', -77.8419, 166.6863, 13, 'rail=antarctica'],
  ['🏔馬特洪冬景', 45.9837, 7.7826, 14, 'rail=gornergrat'],
  ['⛩伏見稻荷', 34.9671, 135.7727, 16, 'rail=fushimi'],
  ['🗻富士山吉田口', 35.3925, 138.7332, 14, 'rail=fuji'],
  ['💜富良野花田', 43.4185, 142.4275, 16, 'rail=furano'],
  ['🌷庫肯霍夫', 52.2697, 4.5460, 16, 'rail=keukenhof'],
  ['🏔EBC聖母峰', 27.8060, 86.7140, 14, 'rail=ebc'],
  ['🏛佩特拉', 30.3225, 35.4517, 15, 'rail=petra'],
  ['🛶威尼斯', 45.4319, 12.3386, 16, 'rail=venice'],
  ['🌸上野公園', 35.7148, 139.7737, 16, 'rail=ueno&season=sakura'],
  ['🌸大阪造幣局', 34.69571, 135.52176, 17, 'rail=mint&season=sakura'],
  ['🌸高遠城址', 35.8340, 138.0626, 16, 'rail=takato&season=sakura'],
  ['🌸千鳥ヶ淵', 35.68993, 139.74772, 16, 'rail=chidori&season=sakura'],
  ['香榭麗舍', 48.8698, 2.3078, 16],
  ['塞納河畔', 48.8566, 2.3450, 16],
  ['河口湖大石公園', 35.5233, 138.7459, 16],
  ['台北大安森林', 25.0330, 121.5350, 16],
  ['紐約中央公園', 40.7713, -73.9740, 16],
  ['京都鴨川', 35.0116, 135.7710, 16],
];
// 軌道路線（第五欄是字串的）收進「特色路線」摺疊區，一般城市留在外面
const isTrail = q => typeof q[4] === 'string';
el('quick').innerHTML = QUICK.map((q, i) => isTrail(q) ? '' : `<span data-i="${i}">${q[0]}</span>`).join('');
el('trails').innerHTML = QUICK.map((q, i) => isTrail(q) ? `<span data-i="${i}">${q[0]}</span>` : '').join('');
el('trailhead').onclick = () => {
  const open = el('trails').classList.toggle('open');
  el('trailhead').textContent = open ? '🌸 特色路線 ▾' : '🌸 特色路線 ▸';
};
el('quick').onclick = e => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  const [, lat, lng, z, opt] = QUICK[i];
  if (typeof opt === 'string' && (opt.includes('pano=') || opt.includes('rail='))) {
    // 驗證過的路線：直接起跑，速度沿用畫面上的設定
    location.href = '/run.html?' + opt + '&kmh=' + (el('kmh').value || 12)
      + '&panels=1&proj=pan&zoom=4&run=1'
      + (el('voice').checked ? '&voice=1' : '&voice=0')
      + (el('narrate').checked ? '&narrate=1' : '&narrate=0')
      + langQ();
    return;
  }
  V.lat = lat; V.lng = lng; V.z = z;
  pts = []; shown = null;
  drawMap(); say();
};
el('trails').onclick = el('quick').onclick;

// ── 跑過的路線 ──
// 跑步頁把每一趟存進 localStorage（同一個來源，這裡讀得到）
const loadRuns = () => Object.keys(localStorage)
  .filter(k => k.startsWith('pr-run-'))
  .map(k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } })
  .filter(r => r && r.pts && r.pts.length > 1)
  .sort((a, b) => b.at - a.at);

const iso = t => new Date(t).toISOString();
const toGPX = run =>
  '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<gpx version="1.1" creator="pano-runner" xmlns="http://www.topografix.com/GPX/1/1">\n'
  + `<metadata><time>${iso(run.at)}</time></metadata>\n`
  + `<trk><name>pano-runner ${new Date(run.at).toLocaleString('zh-TW')}</name><trkseg>\n`
  + run.pts.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${iso(p.t)}</time></trkpt>`).join('\n')
  + '\n</trkseg></trk></gpx>\n';

function renderRuns() {
  const rs = loadRuns();
  el('runs').style.display = rs.length ? '' : 'none';
  el('runlist').innerHTML = rs.map(r => {
    const d = new Date(r.at), p2 = n => String(n).padStart(2, '0');
    return `<div style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid #23262c">
      <span style="flex:1;color:#c9ccd2">${p2(d.getMonth()+1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
      + `　${(r.moved/1000).toFixed(2)} km　${Math.round((r.secs||0)/60)} 分</span>
      <span data-act="show" data-id="${r.at}" style="cursor:pointer;color:#6fd08c">顯示</span>
      <span data-act="gpx"  data-id="${r.at}" style="cursor:pointer;color:#8ab4f8">GPX</span>
      <span data-act="del"  data-id="${r.at}" style="cursor:pointer;color:#8a8f98">刪</span>
    </div>`;
  }).join('');
}

// 把整條路線框進「沒被面板遮住」的那塊區域。
// 用公式預測放不放得下算不準（試了三次都還是壓在邊緣），改成直接量：
// 設好縮放後把每個點換算成螢幕座標，看實際的包圍框多大，再據此縮放與平移。
function fitTrack() {
  if (!shown) return;
  const freeW = Math.max(240, innerWidth - 330);
  const bbox = () => {
    const xs = shown.pts.map(p => toScreen(p).x), ys = shown.pts.map(p => toScreen(p).y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const las = shown.pts.map(p => p.lat), lns = shown.pts.map(p => p.lng);
  V.lat = (Math.min(...las) + Math.max(...las)) / 2;
  V.lng = (Math.min(...lns) + Math.max(...lns)) / 2;
  for (V.z = 18; V.z > 3; V.z--) {
    const b = bbox();
    if (b.x1 - b.x0 <= freeW * 0.75 && b.y1 - b.y0 <= innerHeight * 0.75) break;
  }
  const b = bbox();
  V.lng = x2lng(lng2x(V.lng, V.z) + ((b.x0 + b.x1) / 2 - freeW / 2), V.z);
  V.lat = y2lat(lat2y(V.lat, V.z) + ((b.y0 + b.y1) / 2 - innerHeight / 2), V.z);
}

el('runlist').onclick = e => {
  const act = e.target.dataset.act, idv = +e.target.dataset.id;
  if (!act) return;
  const run = loadRuns().find(r => r.at === idv);
  if (!run) return;
  if (act === 'del') {
    localStorage.removeItem('pr-run-' + idv);
    if (shown && shown.at === idv) shown = null;
    renderRuns(); drawMap(); return;
  }
  if (act === 'gpx') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toGPX(run)], { type: 'application/gpx+xml' }));
    const d = new Date(run.at), p2 = n => String(n).padStart(2, '0');
    a.download = `pano-runner-${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}`
      + `-${p2(d.getHours())}${p2(d.getMinutes())}.gpx`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return;
  }
  shown = (shown && shown.at === run.at) ? null : run;
  fitTrack();
  drawMap();
};

// ── 記住上次的選擇 ──
const KEEP = ['kmh', 'panels', 'zoom', 'mic', 'voice', 'narrate'];
const saved = (() => { try { return JSON.parse(localStorage.getItem('pr-opts') || '{}'); } catch { return {}; } })();
for (const k of KEEP) {
  const e = el(k); if (!e || saved[k] === undefined) continue;
  if (e.type === 'checkbox') e.checked = !!saved[k]; else e.value = saved[k];
}
el('kmhv').textContent = el('kmh').value;
el('micnote').style.display = el('mic').checked ? '' : 'none';
const remember = () => {
  const o = {};
  for (const k of KEEP) { const e = el(k); if (e) o[k] = e.type === 'checkbox' ? e.checked : e.value; }
  try { localStorage.setItem('pr-opts', JSON.stringify(o)); } catch {}
};
for (const k of KEEP) el(k)?.addEventListener('change', remember);

el('kmh').oninput = e => el('kmhv').textContent = e.target.value;
el('mic').onchange = e => { el('micnote').style.display = e.target.checked ? '' : 'none'; remember(); };
el('reset').onclick = () => {
  pts = []; shown = null;
  // 順便把記住的選項清掉 —— 不然「重設」只重設選點，設定還是舊的，
  // 使用者會覺得「怎麼跟上次不一樣」卻找不到原因。
  try { localStorage.removeItem('pr-opts'); } catch {}
  el('kmh').value = 12; el('kmhv').textContent = '12';
  el('panels').value = 'pan'; el('zoom').value = '4';
  el('mic').checked = false; el('voice').checked = true;
  el('micnote').style.display = 'none';
  drawMap(); say();
};
el('start').onclick = () => {
  remember();
  const head = bearing(pts[0], pts[1]);
  const p = new URLSearchParams({
    ll: `${pts[0].lat.toFixed(6)},${pts[0].lng.toFixed(6)}`,
    head: Math.round(head),
    // 第 2 個點之後都是要依序跑到的目標
    targets: pts.slice(1).map(q => `${q.lat.toFixed(6)},${q.lng.toFixed(6)}`).join('|'),
    kmh: el('kmh').value,
    panels: el('panels').value === 'pan' ? '1' : el('panels').value,
    proj: el('panels').value === 'pan' ? 'pan' : 'flat',
    zoom: el('zoom').value,
    mic: el('mic').checked ? '1' : '0',
    voice: el('voice').checked ? '1' : '0',
    narrate: el('narrate').checked ? '1' : '0',
    ...(el('sakura') && el('sakura').checked ? { season: 'sakura' }
       : el('lockmonth') && el('lockmonth').value ? { months: el('lockmonth').value } : {}),
    run: '1',
    ...(SRC ? { src: SRC } : {}),
  });
  location.href = '/run.html?' + p + langQ();
};

el('zin').onclick = () => zoomBy(1);
el('zout').onclick = () => zoomBy(-1);

renderRuns();
// 影像來源:Google 街景(預設)或 Apple Look Around(台灣畫質好、街景新,
// 但沒有歷史影像 → 時光機/櫻花模式只有 Google 有)
let SRC = ['apple', 'baidu', 'yandex', 'kakao'].includes(localStorage.getItem('pano-src2')) ? localStorage.getItem('pano-src2') : '';
{
  const b = el('srcbtn');
  const CYCLE = ['', 'apple', 'baidu', 'yandex', 'kakao'];   // …→ Yandex → Kakao → …
  const LABEL = { '': '🌐 Google 街景', 'apple': '🍎 Apple（新影像·較不順）', 'baidu': '🇨🇳 百度街景（中國）', 'yandex': '🇷🇺 Yandex（俄羅斯等）', 'kakao': '🇰🇷 Kakao（韓國）' };
  const TIP = { '': 'Google 街景:順、方向準,跑步建議用這個',
                'apple': 'Apple Look Around:台灣畫質新,但轉彎/流暢度不如 Google',
                'baidu': '百度街景:中國大陸專用(Google/Apple 在中國沒有),有路名與歷史街景',
                'yandex': 'Yandex:俄羅斯、中亞、土耳其等;從台灣連較慢',
                'kakao': 'Kakao:韓國;快、畫質高、方向乾淨' };
  if (b) {
    const paint = () => { b.textContent = LABEL[SRC]; b.style.borderColor = SRC ? '#e08030' : ''; b.title = TIP[SRC]; };
    paint();
    // 各地區來源的預設城市 + 大致範圍(已在範圍內就不跳,免得打斷微調)
    const HOME = {
      baidu:  { lat: 39.9087, lng: 116.3975, box: [18, 73, 54, 135], name: '中國·北京' },
      yandex: { lat: 55.7539, lng: 37.6208,  box: [35, 19, 78, 180], name: '俄羅斯·莫斯科' },
      kakao:  { lat: 37.5665, lng: 126.9780, box: [33, 124, 39, 132], name: '韓國·首爾' },
    };
    b.onclick = () => {
      SRC = CYCLE[(CYCLE.indexOf(SRC) + 1) % CYCLE.length];
      localStorage.setItem('pano-src2', SRC || 'google');
      paint();
      const h = HOME[SRC];
      if (h) {
        const [s, w2, n, e] = h.box;
        const inside = V.lat >= s && V.lat <= n && V.lng >= w2 && V.lng <= e;
        if (!inside) {                       // 不在該地區才跳過去
          V.lat = h.lat; V.lng = h.lng; if (V.z < 15) V.z = 16;
          const st = el('step'); if (st) st.textContent = '📍 已跳到 ' + h.name;
          drawMap();
        } else { drawMap(); }
      } else { drawMap(); }                  // Google/Apple:全球,不跳,但重畫觸發涵蓋
    };
  }
}

// 器材配對:在這裡 requestDevice 一次,Chrome 記住授權;
// 跑步頁開跑用 getDevices() 直連,不再跳選擇視窗(使用者要求移到主選單)
{
  const CFG = [
    ['btpair', 'pano-bt-dev', '🚴', { filters: [{ services: ['fitness_machine'] }],
      optionalServices: ['heart_rate', 'cycling_power', '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e'] }],
    ['hrpair', 'pano-hr-dev', '♥', { filters: [{ services: ['heart_rate'] }] }],
  ];
  if (!navigator.bluetooth) {
    const r = el('pairrow'), lb = el('pairlb');
    if (r) r.style.display = 'none';
    if (lb) lb.style.display = 'none';
  } else for (const [bid, key, icon, opts] of CFG) {
    const b = el(bid); if (!b) continue;
    const base = b.textContent;
    const paint = () => {
      const nm = localStorage.getItem(key + '-name');
      if (nm) { b.textContent = `${icon} ✓ ${nm}`; b.style.borderColor = '#2f7d4f'; b.style.color = '#6fd08c'; }
      else { b.textContent = base; b.style.borderColor = ''; b.style.color = ''; }
    };
    paint();
    b.onclick = async () => {
      try {
        const dev = await navigator.bluetooth.requestDevice(opts);
        localStorage.setItem(key, dev.id);
        localStorage.setItem(key + '-name', (dev.name || '裝置').slice(0, 18));
        paint();
      } catch {}   // 使用者取消選擇視窗就算了
    };
  }
}

// 鬧區開關:亮著=開。關掉記住,下次進來還是關的
{
  const vb = el('vibehot');
  const paint = () => { vb.style.borderColor = vibeOn ? '#e08030' : ''; vb.style.color = vibeOn ? '#ffb37a' : ''; };
  paint();
  vb.onclick = () => {
    vibeOn = !vibeOn;
    localStorage.setItem('pano-vibe', vibeOn ? '1' : '0');
    paint(); if (vibeOn) loadVibe(); drawInk();
  };
}
drawMap(); say();

// 啟動器的 lang 要跟著帶進跑步頁,不然英文模式按「開始跑」就變回中文
function langQ() {
  const l = new URLSearchParams(location.search).get('lang');
  return l ? '&lang=' + l : '';
}
// ── 英文介面 ─────────────────────────────────────────────
// lang=en 強制;沒帶就看瀏覽器語言。做法:整頁走一遍文字節點,
// 對照字典換掉 —— 不動任何邏輯,中文版一個位元組都不變。
(function () {
  const q0 = new URLSearchParams(location.search);
  let EN;
  try {
    const q = q0.get('lang');
    if (q) localStorage.setItem('pano-lang', q);
    const p = q || localStorage.getItem('pano-lang');
    EN = p ? p === 'en'
       : !(navigator.languages || [navigator.language]).some(l => /^zh/i.test(l || ''));
  } catch { EN = false; }
  if (!EN) return;
  document.title = 'pano-runner launcher';
  const D = {
    'pano-runner 啟動器': 'pano-runner launcher',
    '找地方': 'Find a place', '搜尋': 'Search',
    '速度': 'Speed',
    '用麥克風聽跑步聲決定速度': 'Set speed from treadmill footsteps (mic)',
    '上面的滑桿變成沒聽到腳步聲時的上限。跑步機的腳步聲要收得到。':
      'The slider becomes the cap when no footsteps are heard.',
    '景點導覽（到附近會問，說「導覽」才播）': 'Landmark narration (asks when nearby)',
    '🌸 櫻花模式（自動切到 4 月的歷史街景）': '🌸 Sakura mode (April historical imagery)',
    '📅 鎖定月份': '📅 Lock month', '（有歷史街景才切得過去）': '(needs historical imagery)',
    '不限': 'Any', '10–11 月（紅葉）': 'Oct–Nov (autumn)', '12–2 月（雪景）': 'Dec–Feb (snow)',
    '7–8 月（盛夏）': 'Jul–Aug (summer)',
    '1 月': 'Jan', '2 月': 'Feb', '3 月': 'Mar', '4 月': 'Apr', '5 月': 'May', '6 月': 'Jun',
    '7 月': 'Jul', '8 月': 'Aug', '9 月': 'Sep', '10 月': 'Oct', '11 月': 'Nov', '12 月': 'Dec',
    '語音操控（左轉／右轉／回頭／導覽／結束跑步）':
      'Voice control (left / right / turn around / guide / describe / run to …)',
    '畫面': 'View', '解析度': 'Resolution',
    '五片（接縫折角最小）': '5 panels', '三片': '3 panels', '單片': '1 panel',
    '連續超廣角（Panini，無接縫）': 'Seamless ultra-wide (Panini)',
    '3（省流量）': '3 (light)', '4（一般）': '4 (normal)', '5（最清晰）': '5 (sharpest)',
    '跑過的路線': 'Past runs',
    '先在地圖上點一下「起跑點」。': 'Click the map to set a start point.',
    '開始跑': 'Start running', '重設': 'Reset',
    '🌸 特色路線 ▸': '🌸 Special trails ▸',
    '🤖 AI 排路線': '🤖 AI plan a route',
    '🔥 鬧區': '🔥 Busy areas',
    '🌐 Google 街景': 'Google Street View', '🍎 Apple（新影像·較不順）': 'Apple (newer, less smooth)',
    '器材（配對一次，開跑自動連）': 'Equipment (pair once, auto-connects on run)',
    '🚴 跑步機／練習台': '🚴 Treadmill / trainer', '♥ 心率': '♥ Heart rate',
    '🗿馬丘比丘': '🗿 Machu Picchu', '🐫吉薩金字塔': '🐫 Giza Pyramids',
    '🏚軍艦島廢墟': '🏚 Hashima ruins', '🐧南極': '🐧 Antarctica',
    '🏔馬特洪冬景': '🏔 Matterhorn winter', '⛩伏見稻荷': '⛩ Fushimi Inari',
    '🗻富士山吉田口': '🗻 Mt. Fuji trail', '💜富良野花田': '💜 Furano flowers',
    '🌷庫肯霍夫': '🌷 Keukenhof', '🏔EBC聖母峰': '🏔 Everest BC trek',
    '🏛佩特拉': '🏛 Petra', '🛶威尼斯': '🛶 Venice',
    '🌸上野公園': '🌸 Ueno sakura', '🌸大阪造幣局': '🌸 Osaka Mint sakura',
    '🌸高遠城址': '🌸 Takato sakura', '🌸千鳥ヶ淵': '🌸 Chidorigafuchi',
    '香榭麗舍': 'Champs-Élysées', '塞納河畔': 'Seine riverside',
    '河口湖大石公園': 'Lake Kawaguchi', '台北大安森林': 'Taipei Daan Park',
    '紐約中央公園': 'NY Central Park', '京都鴨川': 'Kyoto Kamo River',
  };
  const walk = n => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        const t = c.textContent.trim();
        if (D[t]) c.textContent = c.textContent.replace(t, D[t]);
      } else walk(c);
    }
  };
  walk(document.body);
  const q = document.getElementById('q');
  if (q) q.placeholder = 'Paris, Tokyo, Kyoto…';
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = 'Drag = pan   pinch / ＋－ = zoom\n'
    + '1st click = start point, further clicks add waypoints (run in order)\n'
    + 'Orange dots are landmarks — click one to add it to the route';
  // 之後動態塞進來的節點(快速選單重繪等)也翻一次
  new MutationObserver(() => walk(document.body))
    .observe(document.body, { childList: true, subtree: true });
})();
