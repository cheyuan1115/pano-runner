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

// 深度圖藏在回應裡最長的那個 base64 字串（url-safe，要補 padding）。
// 不是 zlib，直接就是二進位。認法：解碼後第一個 byte 是 8，
// 而且 8 + 寬×高 + 平面數×16 剛好等於總長度。
//
// 結構：標頭 8 bytes（[0] 標頭大小、[1:3] 平面數、[3:5] 寬、[5:7] 高、[7:9] 偏移）
//       接著每像素一個平面索引（0 = 天空），再接著每平面 4 個 float32
//       （法向 nx,ny,nz 與距離 d）。固定 512×256。
//
// 座標系是 **z 軸朝上**：地面平面的法向是 (0,0,±1)，d 就是相機離地高度。
// 深度 t = |d / (v·n)|。水平線落在 y/H = 0.504，跟影像同一套 yaw。
// 2026-08-22 實測：地面深度與 h/sin|仰角| 完全吻合（−10° 時 14.4 vs 14.4）。
//
// 注意它是**合成**的，只有地面與建築輪廓 —— 車、樹、高架橋都不在裡面
// （實測台北路口：天空 45%、地面 49%、立面只有 5%）。
export function parseDepth(raw) {
  const cands = [...raw.matchAll(/"([A-Za-z0-9_-]{2000,})"/g)]
    .map(m => m[1]).sort((a, b) => b.length - a.length);
  for (const c of cands) {
    let b;
    try { b = Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { continue; }
    if (b.length < 9 || b[0] !== 8) continue;
    const n = b.readUInt16LE(1), w = b.readUInt16LE(3), h = b.readUInt16LE(5), off = b.readUInt16LE(7);
    if (8 + w * h + n * 16 !== b.length) continue;
    const idx = b.subarray(off, off + w * h);
    const pl = i => [0, 1, 2, 3].map(k => b.readFloatLE(off + w * h + i * 16 + k * 4));
    // 相機離地高度：取影像最底一列（正下方一定是地面）那個平面的 d
    const gi = idx[(h - 1) * w];
    const camH = gi ? Math.abs(pl(gi)[3]) : 0;

    // 場景的代表深度：水平線附近（−12°～+18°）非天空像素的中位深度。
    // 這就是使用者一直在手動調的「場景深度」—— 街道實際多寬，資料裡就有答案。
    const ds = [];
    for (let y = Math.round((0.5 - 18 / 180) * h); y < Math.round((0.5 + 12 / 180) * h); y++) {
      const el = (0.5 - (y + 0.5) / h) * Math.PI;
      for (let x = 0; x < w; x += 4) {
        const pi = idx[y * w + x];
        if (!pi) continue;
        const [nx, ny, nz, d] = pl(pi);
        const az = (x / w) * 2 * Math.PI;
        const dot = Math.cos(el) * Math.sin(az) * nx + Math.cos(el) * Math.cos(az) * ny + Math.sin(el) * nz;
        if (Math.abs(dot) < 1e-6) continue;
        const t = Math.abs(d / dot);
        if (t > 2 && t < 400) ds.push(t);
      }
    }
    ds.sort((a, b2) => a - b2);
    const sceneR = ds.length ? ds[ds.length >> 1] : 0;

    // 原始 base64 原樣傳給瀏覽器（約 178 KB）—— 展開成 JSON 陣列會變成 400 KB 以上
    return { w, h, n, camH, sceneR, b64: c };
  }
  return null;
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

  const depth = parseDepth(raw);

  return {
    pano,
    ...me,
    // 相機離地高度。每顆不一樣（實測河口湖 1.60 m、台北 2.50 m），
    // 寫死一個值是不對的。拿不到就用 2.5（街景車的常見值）。
    camH: depth && depth.camH > 0.5 && depth.camH < 5 ? depth.camH : 2.5,
    // 這條街實際多寬。拿不到就給 0，畫面端會退回使用者設定的值。
    sceneR: depth && depth.sceneR > 4 ? depth.sceneR : 0,
    depth,
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
