// 啟動器：在地圖上點起跑點與朝向，設速度，然後跳到 run.html。
//
// 自己寫一個很小的滑動地圖，不引外部函式庫 —— 只需要 Web Mercator 換算加上
// 一層 <img> 磚塊。底圖用 CARTO 的 voyager（免金鑰，要標示出處）。
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
      img.src = `https://basemaps.cartocdn.com/rastertiles/voyager/${V.z}/${tx}/${y}.png`;
      cache.set(key, img);
      map.appendChild(img);
    }
    img.style.left = (x * TS - left) + 'px';
    img.style.top = (y * TS - top) + 'px';
    img.style.display = '';
  }
  for (const [k, img] of cache) if (!keep.has(k)) img.style.display = 'none';
  const zl = el('zlvl'); if (zl) zl.textContent = 'z' + V.z;
  loadLandmarks();
  drawInk();
}

function drawInk() {
  const dpr = Math.min(2, devicePixelRatio || 1), { w, h } = size();
  ink.width = w * dpr; ink.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
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
    const r = await fetch(`/api/find?ll=${p.lat},${p.lng}&r=60`).then(x => x.json());
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
  } catch { el('step').textContent = '搜尋失敗。'; }
}
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
      + (el('narrate').checked ? '&narrate=1' : '&narrate=0');
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
  });
  location.href = '/run.html?' + p;
};

el('zin').onclick = () => zoomBy(1);
el('zout').onclick = () => zoomBy(-1);

renderRuns();
drawMap(); say();
