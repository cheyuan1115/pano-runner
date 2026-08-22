// 街景資料層 —— 全部不需要金鑰，也不需要 Chrome。
//
// 三個未公開端點，共同的關鍵是：**一定要帶瀏覽器的 User-Agent**。
// 不帶就 403 或回 80 位元組的空殼。street-runner 當初把這個現象誤判成
// 「只能在 google.com/maps 頁面裡 fetch」，於是整套被綁在 CDP 自動化上 ——
// 其實從 Node 直接打就好。2026-08-21 用 curl 逐一隔離出來的。
//
//   SingleImageSearch   lat/lng → 最近的 pano
//   photometa           pano    → 座標、連結、樓層、每個 zoom 的影像尺寸
//   streetviewpixels    pano    → 512×512 的磚塊
//
// 座標系有兩個容易搞錯的地方：
//   1. 影像尺寸在回應裡是 [高, 寬]，不是 [寬, 高]。
//   2. 每顆全景的影像相對正北有一個自己的偏轉角（yaw），算圖一定要補上，
//      否則朝向會整個歪掉，而且歪的量每顆都不一樣。

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const R = 6371000, rad = x => x * Math.PI / 180;
export const dist = (a, b) => {
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const get = async (url, kind = 'text') => {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return kind === 'text' ? r.text() : r.arrayBuffer();
};

// 回應是 `)]}'`（photometa）或 `/**/x && x( … )`（SingleImageSearch）包起來的 JSON。
// 後者尾巴那個右括號也要切掉，不然 JSON.parse 會在最後一個字元爆掉 ——
// 而且錯誤訊息會把整包 360 KB 印出來，看起來像端點壞了。
const parseWrapped = t => {
  const s = t.slice(t.indexOf('['));
  return JSON.parse(s.slice(0, s.lastIndexOf(']') + 1));
};

// 影像尺寸區塊：[2, 2, [高,寬], [[各zoom的[[高,寬]]], [磚塊寬,磚塊高]], …]
const readGeom = g => {
  if (!g || !g[2] || !g[3]) return null;
  return {
    h: g[2][0], w: g[2][1],
    tile: g[3][1][0],
    zooms: g[3][0].map(z => ({ h: z[0][0], w: z[0][1] })),
  };
};

export async function findPano(lat, lng, radius = 50) {
  const pb = `!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d${radius}`
    + '!3m10!2m2!1sen!2sGB!9m1!1e2!11m4!1m3!1e2!2b1!3e2!4m10!1e1!1e2!1e3!1e4!1e8!1e6!5m1!1e2!6m1!1e2';
  const j = parseWrapped(await get(
    'https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=' + pb + '&callback=x'));
  // j[0][0] === 0 代表有結果；找不到時整包只有狀態碼
  const box = j[1];
  const id = box && box[1] && box[1][1];
  if (!id) return null;
  return { pano: id, geom: readGeom(box[2]) };
}

// 從深度圖取出「相機離地多高」。photometa 回應裡最長的那個 base64 字串就是
// 深度圖（url-safe，不是 zlib，直接是二進位）。認法：解碼後第一個 byte 是 8，
// 而且 8 + 寬×高 + 平面數×16 剛好等於總長度。
//
// 座標系是 z 軸朝上。影像最底一列（正下方）一定落在地面那個平面，
// 而地面平面的 d 就是相機高度。
// 2026-08-22 實測：河口湖 1.60 m、巴黎 2.40 m、台北 2.50 m —— 每顆都不同，
// 寫死一個值是不對的。
function readCamHeight(raw) {
  const cands = [...raw.matchAll(/"([A-Za-z0-9_-]{2000,})"/g)]
    .map(m => m[1]).sort((a, b) => b.length - a.length);
  for (const c of cands) {
    let b;
    try { b = Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { continue; }
    if (b.length < 9 || b[0] !== 8) continue;
    const n = b.readUInt16LE(1), w = b.readUInt16LE(3), h = b.readUInt16LE(5), off = b.readUInt16LE(7);
    if (8 + w * h + n * 16 !== b.length) continue;
    const gi = b[off + (h - 1) * w];                    // 最底一列的平面索引
    if (!gi) continue;
    const d = Math.abs(b.readFloatLE(off + w * h + gi * 16 + 12));
    if (d > 0.5 && d < 5) return d;                     // 合理範圍才採用
  }
  return 0;
}

const PB = pano => '!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1szh-TW!2stw!3m3!1m2!1e2!2s' + pano
  + '!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2'
  + '!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3'
  + '!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3';

export async function panoMeta(pano) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(pano || '')) return null;
  const raw = await get('https://www.google.com/maps/photometa/v1?authuser=0&hl=zh-TW&gl=tw&pb=' + PB(pano));
  if (raw.length < 500) return null;                 // 空殼（多半是使用者上傳的球形照片）
  const box = parseWrapped(raw)[1][0];
  const P = box[5][0];

  const self = P[1][0], geom = readGeom(box[2]);
  // P[3][0] 是鄰居清單；每筆的 [2][2] 是 [自身偏轉角, 傾角, 滾轉角]
  const nb = P[3][0].map(n => ({
    id: n[0] && n[0][1],
    lat: n[2] && n[2][0] && n[2][0][2],
    lng: n[2] && n[2][0] && n[2][0][3],
    el: n[2] && n[2][1] ? n[2][1][0] : null,
    yaw: n[2] && n[2][2] ? n[2][2][0] : null,
  }));

  const me = { lat: self[2], lng: self[3], el: P[1][1][0] };
  // 自己的偏轉角就藏在鄰居清單第一筆（那一筆的 pano id 等於自己）
  const mine = nb.find(n => n.id === pano);

  return {
    pano,
    ...me,
    camH: readCamHeight(raw) || 2.5,   // 拿不到就用街景車的常見值

    yaw: mine ? mine.yaw : 0,
    // P[7] 有值＝這顆屬於某個樓層集合，也就是室內或地下。這是 Google 自己的判斷。
    indoor: !!P[7],
    geom,
    links: (P[6] || []).map(([i, a]) => {
      const n = nb[i];
      if (!n || n.el === null) return null;
      return { id: n.id, heading: a[3], lat: n.lat, lng: n.lng,
               dz: n.el - me.el, d: dist(me, n) };
    }).filter(Boolean),
  };
}

export const tileUrl = (pano, x, y, zoom) =>
  'https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile'
  + `&panoid=${pano}&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fover=2`;

export async function tile(pano, x, y, zoom) {
  return Buffer.from(await get(tileUrl(pano, x, y, zoom), 'buf'));
}
