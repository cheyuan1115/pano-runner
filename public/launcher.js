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

function click(sx, sy) {
  const p = toLL(sx, sy);
  if (!pts.length) { pts.push(p); check(); }      // 第一個點要先確認那裡有街景
  else { pts.push(p); say(); }
  drawInk();
}

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
    : `${n} 個點　直線距離約 ${routeKm().toFixed(2)} km　可以開跑了`;
  el('start').disabled = n < 2;
};

// 按開始之前先確認那裡真的有街景 —— 沒有的話當場說，不要跳過去才看到一片黑
async function check() {
  el('start').disabled = true;
  el('step').textContent = '看看那裡有沒有街景…';
  try {
    const s0 = pts[0];
    const r = await fetch(`/api/find?ll=${s0.lat},${s0.lng}&r=60`).then(r => r.json());
    if (r.error) { el('step').textContent = '⚠ 這附近 60 公尺內沒有街景，換個點。'; pts = []; drawInk(); return; }
    s0.pano = r.pano;
    say();
  } catch { el('step').textContent = '⚠ 查不到（伺服器沒回應？）'; }
}

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

const QUICK = [
  ['香榭麗舍', 48.8698, 2.3078, 16],
  ['塞納河畔', 48.8566, 2.3450, 16],
  ['河口湖大石公園', 35.5233, 138.7459, 16],
  ['台北大安森林', 25.0330, 121.5350, 16],
  ['紐約中央公園', 40.7713, -73.9740, 16],
  ['京都鴨川', 35.0116, 135.7710, 16],
];
el('quick').innerHTML = QUICK.map((q, i) => `<span data-i="${i}">${q[0]}</span>`).join('');
el('quick').onclick = e => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  const [, lat, lng, z] = QUICK[i];
  V.lat = lat; V.lng = lng; V.z = z;
  pts = []; shown = null;
  drawMap(); say();
};

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
const KEEP = ['kmh', 'panels', 'zoom', 'mic', 'voice'];
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
    run: '1',
  });
  location.href = '/run.html?' + p;
};

el('zin').onclick = () => zoomBy(1);
el('zout').onclick = () => zoomBy(-1);

renderRuns();
drawMap(); say();
