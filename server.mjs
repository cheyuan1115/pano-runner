// 很小的一支：靜態檔 + 兩個代理端點。
//
// 為什麼只有 photometa 和 SingleImageSearch 要代理，磚塊不用：
// 磚塊那個主機的 CORS 是開放的（會把你的 Origin 原樣回在
// access-control-allow-origin 上），瀏覽器可以直接抓；
// google.com 和 maps.googleapis.com 沒開，所以那兩個要從 Node 轉一手。
//
// 沒有 Chrome、沒有 CDP、沒有專用 profile。這支停掉就什麼都不剩。

import { createServer } from 'node:http';
import { createServer as createTls } from 'node:https';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPano, panoMeta } from './pano.mjs';
import { moreImages, wikiNearby, citySpots } from './wiki.mjs';

// 景點資料沿用 run-world 那份（745 個，12 個城市，含導覽稿）。
// 直接讀原檔而不是複製一份 —— 那邊修了座標這邊立刻同步。
// 讀不到就當成沒有景點，不影響跑步。
// ── Apple Look Around 資料層 ────────────────────────────────
// 雙源:pano id 是純數字(Apple 的 64 位元 id)就走這層,其餘走 Google。
// Python worker(tools/apple-worker.py)負責涵蓋查詢/HEIC 解碼/重投影/切磚,
// 磚塔切成跟 Google 一樣的幾何,引擎端零改動。
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const LA_CACHE = join(ROOT_DIR, '.lacache');
const isApple = id => /^\d{12,}$/.test(String(id || ''));
// 只做到 z3(3328):zoom=3 抓面的重投影快 3.5 倍,4560px 縮到 3328 仍銳利。
// z4/z5 對映回 z3,畫質選高也不會要求做不出來的 6656。
// 尺寸全用 512 整數倍(exact=true,跟 Google 同路徑),否則半塊黑邊會滲進中央
const LA_GEOM = { h: 1536, w: 3072, tile: 512, zooms: [
  { w: 384, h: 192 }, { w: 768, h: 384 }, { w: 1536, h: 768 },
  { w: 3072, h: 1536 }, { w: 3072, h: 1536 }, { w: 3072, h: 1536 }] };
let AW = null, awRid = 0; const awPend = new Map();
async function awEnsure() {
  if (AW && !AW.killed && AW.exitCode == null) return;
  const { spawn } = await import('node:child_process');
  AW = spawn(join(ROOT_DIR, '.laenv', 'bin', 'python'),
    [join(ROOT_DIR, 'tools', 'apple-worker.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  AW.stdout.on('data', d => {
    buf += d;
    let i2;
    while ((i2 = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i2); buf = buf.slice(i2 + 1);
      try { const m = JSON.parse(line);
        if (awPend.has(m.rid)) { awPend.get(m.rid)(m); awPend.delete(m.rid); } } catch {}
    }
  });
  AW.stderr.on('data', d => { const t = String(d); if (/Error|error/.test(t)) console.log('apple-worker:', t.slice(0, 200)); });
  AW.on('exit', c => { console.log('apple-worker 退出', c); for (const f of awPend.values()) f({ error: 'worker-died' }); awPend.clear(); });
  console.log('apple-worker 啟動');
}
// 開機就暖:先跑一次涵蓋查詢,首位使用者不吃冷啟動的數十秒
awEnsure().then(() => apple('find', { lat: 25.0330, lng: 121.5654 }, 90000)
  .then(() => console.log('apple-worker 暖機完成')).catch(() => {}));
async function apple(op, params, timeoutMs = 60000) {
  await awEnsure();
  const rid = ++awRid;
  return new Promise(res2 => {
    const t = setTimeout(() => { awPend.delete(rid); res2({ error: 'worker-timeout' }); }, timeoutMs);
    awPend.set(rid, m => { clearTimeout(t); res2(m); });
    AW.stdin.write(JSON.stringify({ op, ...params, rid }) + '\n');
  });
}
// 鄰居雲 → 連結。Apple 點距只有 5-7m,一顆一顆走每步都要重投影(2.2s)追不上,
// 跑起來一步一停。所以稀釋成「約 13m 一步」(等於 Google 的點距):每 30° 扇區
// 挑最接近 13m 的那顆,備圖數量砍半。扇區在 [4,18] 內沒點(稀疏處)才退回最近點。
function laLinks(ns) {
  const near = {}, far = {};
  for (const n of ns || []) {
    if (n.d < 1.5 || n.d > 25) continue;
    const k = Math.round(n.heading / 30) % 12;
    if (!near[k] || n.d < near[k].d) near[k] = n;          // 保底:每扇區最近點
    if (n.d >= 4 && n.d <= 14) {                            // 理想步距候選(接近 google ~10m)
      const sc = Math.abs(n.d - 10);
      if (!far[k] || sc < far[k].sc) far[k] = { ...n, sc };
    }
  }
  const pick = {};
  for (const k of new Set([...Object.keys(near), ...Object.keys(far)]))
    pick[k] = far[k] || near[k];
  return Object.values(pick).map(n => ({ id: n.id, heading: n.heading, lat: n.lat, lng: n.lng, dz: 0, d: n.d }));
}
const laMeta = new Map();   // id -> {lat,lng}(meta/tile 要回頭找座標用)

const LM_PATH = join(fileURLToPath(new URL('.', import.meta.url)),
                     '..', 'run-world', 'data', 'landmarks-extra.json');
let LANDMARKS = [], AUDIDX = {}, PHOTOS = {};
try {
  LANDMARKS = JSON.parse(await readFile(LM_PATH, 'utf8'))
    .filter(l => l.lat != null && l.lng != null)
    .map(l => ({ id: l.id, name: l.name, lat: l.lat, lng: l.lng,
                 city: l.city, cat: l.category, len: (l.script || '').length }));
  const dir = join(LM_PATH, '..');
  // audio-index：每段導覽的逐句時間軸（marks）與句子（lines），689 筆
  // landmark-photos：維基共享資源的照片，1373 個景點、平均 3.6 張
  AUDIDX = JSON.parse(await readFile(join(dir, 'audio-index.json'), 'utf8'));
  PHOTOS = JSON.parse(await readFile(join(dir, 'landmark-photos.json'), 'utf8'));
  console.log(`景點 ${LANDMARKS.length} 個、字幕 ${Object.keys(AUDIDX).length} 筆、`
    + `照片 ${Object.keys(PHOTOS).length} 組`);
} catch { console.log('沒有景點資料，地圖上不會顯示'); }

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
// 照片快取放本機。維基會限流，抓過的就不要再抓。
const PHOTO_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.photocache');
const VLOG = join(fileURLToPath(new URL('.', import.meta.url)), '.voicelog');
const WIKI_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.wikicache');
const MAP_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.maptiles');
// 當場生成的語音,只留記憶體(使用者的決定:免費額度用不完,不必落地)
const ttsMem = new Map();
const geoMem = new Map();          // 反向地理編碼快取(同一格不重查)

// 維基查詢一趟要打六到八次 API，連著打一定 429（實測第二個城市就中）。
// 所以一定要快取。用約 1.1 公里見方的格子當鍵 —— 跑步時位置一直在動，
// 不切格子的話每走十公尺就是一次全新查詢。
const cellKey = (lat, lng) => `${Math.round(lat * 90)}_${Math.round(lng * 90)}`;
import { networkInterfaces } from 'node:os';
function lanIP() {
  for (const l of Object.values(networkInterfaces()))
    for (const i of l || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
// 個人伺服器不該因為一個沒接住的錯就整個死掉(實測:塔林搜尋時
// 整個 process 無聲死亡,日誌零線索)。留下遺言、繼續活著。
process.on('unhandledRejection', e => console.log('未接住的 rejection:', e?.stack || e));
process.on('uncaughtException', e => console.log('未接住的例外:', e?.stack || e));
const xlMem = new Map();   // 地名翻譯快取:星巴克→Starbucks

// ── QZ(qdomyos-zwift)整合:社群 issue #1 ──────────────────
// QZ 用藍牙讀真實跑步機數據,每秒對指定 ip:port 送一包 OSC bundle
// (格式見 qdomyos-zwift/src/osc.cpp):/QZ/Speed 是 float32 km/h,
// 另有 Heart/Cadence/Inclination 等。這裡開 UDP 收、解析、存最新一包,
// 跑步頁每秒來 /api/qz 拿。QZ 那頭設定:OSC ip=本機區網 IP,port=9005
//(可用 PANO_QZ_PORT 改)。
import { createSocket } from 'node:dgram';
const qz = { at: 0, kmh: null, heart: 0, cad: 0, incl: 0 };
function oscParse(buf) {
  const out = {};
  const readMsg = b => {
    let z = b.indexOf(0); if (z < 0) return;
    const addr = b.toString('ascii', 0, z);
    let o = (z + 4) & ~3;
    z = b.indexOf(0, o); if (z < 0) return;
    const tags = b.toString('ascii', o, z);
    o = (z + 4) & ~3;
    const vals = [];
    for (const t of tags.slice(1)) {
      if (t === 'f') { vals.push(b.readFloatBE(o)); o += 4; }
      else if (t === 'i') { vals.push(b.readInt32BE(o)); o += 4; }
      else if (t === 's') { const e = b.indexOf(0, o); if (e < 0) break;
        vals.push(b.toString('ascii', o, e)); o = (e + 4) & ~3; }
      else break;
    }
    out[addr] = vals[0];
  };
  if (buf.length >= 16 && buf.toString('ascii', 0, 7) === '#bundle') {
    let o = 16;
    while (o + 4 <= buf.length) {
      const len = buf.readInt32BE(o); o += 4;
      if (len <= 0 || o + len > buf.length) break;
      readMsg(buf.subarray(o, o + len)); o += len;
    }
  } else readMsg(buf);
  return out;
}
const qzSock = createSocket('udp4');
qzSock.on('message', m => {
  try {
    const o = oscParse(m);
    if (o['/QZ/Speed'] === undefined) return;
    if (!qz.at) console.log('QZ 已連上,速度', o['/QZ/Speed'], 'km/h');
    qz.at = Date.now();
    qz.kmh = o['/QZ/Speed'];
    if (o['/QZ/Heart'] !== undefined) qz.heart = o['/QZ/Heart'];
    if (o['/QZ/Cadence'] !== undefined) qz.cad = o['/QZ/Cadence'];
    if (o['/QZ/Inclination'] !== undefined) qz.incl = o['/QZ/Inclination'];
  } catch {}
});
qzSock.on('error', e => console.log('QZ socket:', e.message));
try { qzSock.bind(Number(process.env.PANO_QZ_PORT) || 9005); } catch {}

// 跨電腦三螢幕:主控 POST 最新狀態,從屬掛在 SSE 上收。
// 同一台電腦的多視窗仍走 BroadcastChannel(零延遲);這條是給
// 「三台電腦各顯示一片」用的,區網延遲個位數毫秒。
// 城市級景點快取:key = 約 5.5 公里網格。記憶體+磁碟(30 天),
// busy 去重(同城市併發只查一次)。
// ── 指名介紹的照片:維基查不到(店家)就問 Google Places ──
// 金鑰只留伺服器:客戶端拿到的是 /pphoto?n=<photo資源名>,由這裡代取。
// Places API(New):searchText 找店 → photos[].name → media 端點取圖。
const pphotoCache = new Map();
async function placesPhotos(query, lat, lng) {
  let key;
  try { key = (await readFile(join(process.env.HOME, '.keys', 'mapskey'), 'utf8')).trim(); }
  catch { return []; }
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.photos,places.location' },
    body: JSON.stringify({ textQuery: query, languageCode: 'zh-TW', pageSize: 1,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 10000 } } }),
    signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j.error) { console.log('Places:', j.error.status || j.error.message); return []; }
  const pl = j.places?.[0];
  // 距離守門:locationBias 只是偏好不是限制,泛泛的關鍵字會撈到
  // 地球另一端的店(實測在巴黎撈到台灣市場)。超過 30 公里就作廢。
  if (pl?.location) {
    const toRad = v => v * Math.PI / 180;
    const dp = toRad(pl.location.latitude - lat), dl = toRad(pl.location.longitude - lng);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(pl.location.latitude)) * Math.sin(dl / 2) ** 2;
    const dist = 2 * 6371000 * Math.asin(Math.sqrt(h));
    if (dist > 30000) {
      console.log(`Places「${query}」→ ${pl.displayName?.text},但在 ${Math.round(dist / 1000)} km 外,照片作廢`);
      return [];
    }
  }
  const ph = pl?.photos || [];
  console.log(`Places「${query}」→ ${pl?.displayName?.text || '無'},照片 ${ph.length} 張`);
  return ph.slice(0, 5).map(p2 => '/pphoto?n=' + encodeURIComponent(p2.name));
}
const elevMem = new Map();   // 海拔快取(~11m 網格)
const cityMem = new Map();
const cityBusy = new Map();
const cityKey = (lat, lng) => `city_${Math.round(lat * 20)}_${Math.round(lng * 20)}`;
async function loadCity(lat, lng, wait, kick = true) {
  const k = cityKey(lat, lng);
  if (cityMem.has(k)) return cityMem.get(k);
  try {
    const o = JSON.parse(await readFile(join(WIKI_DIR, k + '.json'), 'utf8'));
    if (Date.now() - o.at < 30 * 86400e3) { cityMem.set(k, o.items); return o.items; }
  } catch {}
  if (!kick) return [];   // 只拿現貨:地圖亂滑不該引發查詢風暴
  if (cityBusy.has(k)) return wait ? cityBusy.get(k) : [];
  const job = (async () => {
    try {
      const items = await citySpots(lat, lng);
      cityMem.set(k, items);
      await mkdir(WIKI_DIR, { recursive: true });
      await writeFile(join(WIKI_DIR, k + '.json'), JSON.stringify({ at: Date.now(), items }))
        .catch(() => {});
      console.log(`城市景點 ${k}:${items.length} 個`);
      return items;
    } catch (e) { console.log('城市景點查詢失敗:' + (e.message || e)); return []; }
    finally { setTimeout(() => cityBusy.delete(k), 1000); }
  })();
  cityBusy.set(k, job);
  return wait ? job : [];
}
const syncClients = new Set();
let syncLast = null;

// Gemini 免費額度是「每個模型各自每天 20 次」(實測 429:
// GenerateRequestsPerDayPerProjectPerModel-FreeTier, quota=20)。
// 所以做成備援鏈:一款回錯(429/404/空稿)就換下一款,全輪完才放棄。
// 回傳 {text, model} 或 null。
// ok(text):驗收函式,不合格就換下一款(有些備援款會把逐字編號的
// 草稿當正文吐出來 —— 實測字幕唸出「與 (127) 祭 (128) 典 (129)…」)
async function genAI(models, body, timeoutMs = 20000, ok = null) {
  let gkey;
  try { gkey = (await readFile(join(process.env.HOME, '.keys', 'geminikey'), 'utf8')).trim(); }
  catch { return null; }
  for (const mdl of models) {
    try {
      const g = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body) })).json();
      if (g.error) { console.log(`AI ${mdl}:${g.error.code}`); continue; }
      let text = (g.candidates?.[0]?.content?.parts || [])
        .filter(p2 => !p2.thought).map(p2 => p2.text || '').join('').trim();
      if (!text) { console.log(`AI ${mdl}:空稿`); continue; }
      // 輸出額度被思考吃光時稿子會腰斬在半句(實測:22 秒音檔停在
      // 「改建自19世紀的織物商」)—— 退到最後一個完整句,太短就換下一款
      if (g.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        const cut = text.replace(/[^。！？.!?]*$/, '');
        if (cut.length < 60) { console.log(`AI ${mdl}:MAX_TOKENS 且太短`); continue; }
        console.log(`AI ${mdl}:MAX_TOKENS,截到最後完整句`);
        text = cut;
      }
      if (ok && !ok(text)) { console.log(`AI ${mdl}:稿不合格 ${text.slice(0, 60)}`); continue; }
      return { text, model: mdl };
    } catch (e) { console.log(`AI ${mdl}:` + (e.message || e)); }
  }
  return null;
}
// 導覽稿的驗收(語言感知,中文稿驗中文、英文稿驗英文 —— 一開始只驗
// 中文占比,英文模式整條備援鏈全被打槍,502):
// 共同:不得含 (127) 編號雜訊、草稿字眼、markdown 條列。
const guideOk = (t, lang) => {
  if (/[（(]\d+[)）]/.test(t)) return false;
  if (/Drafting|drafting|\*\*|Hard rules|guessing names/.test(t)) return false;
  if (/(^|\n)\s*[*#-]\s/.test(t)) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return lang === 'en' ? cjk < t.length * 0.1 : cjk >= t.length * 0.45;
};
// 看圖的導覽用完整 flash 系(各世代額度分開);翻譯是小事,用 lite 系,
// 不跟導覽搶額度。
// 3.7-flash 實測回應很慢(>25 秒),放最後當底
const AI_VISION = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash',
                   'gemini-3.5-flash-lite', 'gemini-3.7-flash'];
const AI_TEXT = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
                 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'];

const wikiMem = new Map();
const wikiBusy = new Map();

// **絕對不能讓跑步等這個查詢。** 冷查一格要打六到八次維基 API，實測 10–22 秒，
// 而畫面端的 /api/nearby 只等 6 秒 —— 直接逾時，景點一個都拿不到
//（里斯本實測整趟零播報）。所以：有快取就給，沒有就回空並在背景抓，
// 下一次呼叫（跑 150 公尺之後）就有了。
async function wikiFetchCell(k, lat, lng) {
  if (wikiBusy.has(k)) return wikiBusy.get(k);
  const cLat = Math.round(lat * 90) / 90, cLng = Math.round(lng * 90) / 90;
  const job = (async () => {
    try {
      const items = await wikiNearby(cLat, cLng, { radius: 1200, limit: 14 });
      wikiMem.set(k, items);
      await mkdir(WIKI_DIR, { recursive: true });
      await writeFile(join(WIKI_DIR, k + '.json'), JSON.stringify({ at: Date.now(), items }))
        .catch(() => {});
      console.log(`維基 ${k}：${items.length} 個景點`);
      return items;
    } catch (e) { console.log('維基查詢失敗：' + (e.message || e)); return []; }
    finally { setTimeout(() => wikiBusy.delete(k), 1000); }
  })();
  wikiBusy.set(k, job);
  return job;
}

// wait = true 時會等（給地圖與預熱用，那裡不趕時間）
async function wikiCell(lat, lng, wait = false) {
  const k = cellKey(lat, lng);
  if (wikiMem.has(k)) return wikiMem.get(k);
  try {
    const o = JSON.parse(await readFile(join(WIKI_DIR, k + '.json'), 'utf8'));
    // 一個月內的就用。景點不會跑掉，瀏覽量變一點也無所謂。
    if (Date.now() - o.at < 30 * 86400e3) { wikiMem.set(k, o.items); return o.items; }
  } catch {}
  const job = wikiFetchCell(k, lat, lng);
  return wait ? job : [];
}

// commons.wikimedia.org/Special:FilePath/<檔名> → upload.wikimedia.org 的直連縮圖。
// 那個路徑會 302 轉址而且限流很兇；直連的縮圖檔沒有這個問題。
// 網址不能自己用 md5 算 —— 寬度必須是維基的標準級距，算出來的 1200px 一律 400，
// 所以還是要問一次 API（一次可以問 50 個），問到的結果記在記憶體裡。
const thumbCache = new Map();
async function toThumb(src, width = 1280) {
  // 直連原圖的（資料裡有 30 筆）改指到縮圖。路徑本來就帶著 md5 的前兩碼，
  // 所以這種不用問 API 就能算出來。原圖實測有 6.9 MB —— 跑步時那是跟磚塊搶頻寬。
  const m = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/.exec(src);
  if (m && !src.includes('/thumb/')) {
    const file = m[4];
    const ext = file.split('.').pop().toLowerCase();
    const tail = ['jpg', 'jpeg'].includes(ext) ? file : file + '.jpg';
    return `${m[1]}/thumb/${m[2]}/${m[3]}/${file}/${width}px-${tail}`;
  }
  if (!src.includes('Special:FilePath/')) return src;
  if (thumbCache.has(src)) return thumbCache.get(src);
  const name = decodeURIComponent(src.split('Special:FilePath/')[1].split('?')[0]);
  try {
    const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
      + '&prop=imageinfo&iiprop=url&iiurlwidth=' + width
      + '&titles=' + encodeURIComponent('File:' + name);
    const r = await fetch(api, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const pg = Object.values(j?.query?.pages || {})[0];
    const url = pg?.imageinfo?.[0]?.thumburl || pg?.imageinfo?.[0]?.url;
    if (url) { thumbCache.set(src, url); if (thumbCache.size > 4000) thumbCache.clear(); return url; }
  } catch {}
  return src;                        // 問不到就走原本那條，至少還能動
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PORT = 8877;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const handler = async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/find') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      // 半徑逐步放大。景點的座標是那個東西的中心（例如羅浮宮的中庭），
      // 常常不在路上 —— 60 公尺找不到不代表附近沒有街景。
      const want = Number(u.searchParams.get('r')) || 50;
      for (const rad of [want, want * 3, want * 6]) {
        if (u.searchParams.get('src') === 'apple') {
          const j = await apple('find', { lat, lng, r: rad }, 90000);
          if (j.error) return json(res, { error: j.error === 'no-coverage' ? '這裡沒有 Look Around' : '附近找不到 Look Around' }, 404);
          laMeta.set(j.id, { lat: j.lat, lng: j.lng });
          // 起點先開切:回應前不等(不拖慢開跑),但下一顆 meta 來時起點圖多半好了,
          // 冷啟動的頭幾步頓挫因此縮短
          apple('pyramid', { id: j.id, lat: j.lat, lng: j.lng }, 120000).catch(() => {});
          return json(res, { pano: j.id, lat: j.lat, lng: j.lng, d: j.d });
        }
        const r = await findPano(lat, lng, rad);
        if (!r) continue;
        // 順便回傳落點座標，呼叫端才知道吸到哪、差多遠
        const m = await panoMeta(r.pano);
        return json(res, m ? { ...r, lat: m.lat, lng: m.lng, snapped: rad > want } : r);
      }
      return json(res, { error: '附近找不到街景' }, 404);
    }
    // 鬧區資料:店家密度點 + 徒步區/商業區多邊形。「熱鬧」沒有官方資料,
    // 店家密度是拿得到的最好代理(OSM 的 shop/amenity 標得很全)。
    // 走 Overpass API(免金鑰,禮貌 UA);bbox 吸附到 0.02° 格網再查,
    // 平移地圖時大多命中快取,不會每動一下就打一次 Overpass。
    if (u.pathname === '/api/vibe') {
      const b = (u.searchParams.get('bbox') || '').split(',').map(Number);
      if (b.length !== 4 || b.some(x => !isFinite(x))) return json(res, { error: 'bbox 要 s,w,n,e' }, 400);
      let [s0, w0, n0, e0] = b;
      // 太大的範圍(縮太遠)夾到中心 0.12° 見方,Overpass 才回得來
      const cy = (s0 + n0) / 2, cx = (w0 + e0) / 2;
      if (n0 - s0 > 0.12) { s0 = cy - 0.06; n0 = cy + 0.06; }
      if (e0 - w0 > 0.16) { w0 = cx - 0.08; e0 = cx + 0.08; }
      const G = 0.02;
      const key = [Math.floor(s0 / G) * G, Math.floor(w0 / G) * G,
                   Math.ceil(n0 / G) * G, Math.ceil(e0 / G) * G].map(x => x.toFixed(2));
      const ck = key.join(',');
      if (!globalThis.vibeMem) globalThis.vibeMem = new Map();
      const mem = globalThis.vibeMem;
      if (!mem.has(ck)) {
        const bb = key.join(',');
        const q3 = `[out:json][timeout:25];
(node[shop](${bb});
 node[amenity~"^(restaurant|cafe|bar|pub|fast_food|biergarten|food_court|ice_cream|nightclub|marketplace)$"](${bb}););
out skel qt 12000;
(way[highway=pedestrian](${bb});
 way[landuse=retail](${bb});
 way[amenity=marketplace](${bb}););
out geom qt 500;`;
        mem.set(ck, (async () => {
          // 磁碟快取:同一格查過就不再打 Overpass(店家分布變動很慢)
          const vdir = join(fileURLToPath(new URL('.', import.meta.url)), '.vibe');
          const vf = join(vdir, ck.replace(/[^0-9.,-]/g, '') + '.json');
          try { return JSON.parse(await readFile(vf, 'utf8')); } catch {}
          // 主站忙線會 504(每 IP 有配額);kumi/coffee 實測掛著不回,
          // mail.ru 的鏡像快又穩,當第二選擇
          const MIRRORS = ['https://overpass-api.de/api/interpreter',
                           'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
          let j = null, lastErr = null;
          for (const host of MIRRORS) {
            try {
              const r = await fetch(host, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': `pano-runner/1.0 (+https://github.com/cheyuan1115/pano-runner; contact: ${process.env.PANO_CONTACT || 'see-repo'})` },
                body: 'data=' + encodeURIComponent(q3),
                signal: AbortSignal.timeout(30000) });
              if (!r.ok) { lastErr = new Error('overpass ' + r.status); continue; }
              j = await r.json(); break;
            } catch (e) { lastErr = e; }
          }
          if (!j) throw lastErr || new Error('overpass 全掛');
          const pts = [], polys = [];
          for (const el2 of j.elements || []) {
            if (el2.type === 'node' && el2.lat) pts.push([+el2.lat.toFixed(5), +el2.lon.toFixed(5)]);
            else if (el2.type === 'way' && el2.geometry?.length > 2)
              polys.push(el2.geometry.map(g => [+g.lat.toFixed(5), +g.lon.toFixed(5)]));
          }
          console.log(`鬧區 ${ck}:店家 ${pts.length}、區塊 ${polys.length}`);
          try { await mkdir(vdir, { recursive: true }); await writeFile(vf, JSON.stringify({ pts, polys })); } catch {}
          return { pts, polys };
        })().catch(e => { mem.delete(ck); throw e; }));
        if (mem.size > 60) mem.delete(mem.keys().next().value);
      }
      try { return json(res, await mem.get(ck)); }
      catch (e) { return json(res, { error: String(e.message || e).slice(0, 60), pts: [], polys: [] }, 502); }
    }
    // 指定範圍內的景點。地圖只要看得到的那些，不用整包送。
    if (u.pathname === '/api/landmarks') {
      const b = (u.searchParams.get('bbox') || '').split(',').map(Number);
      if (b.length !== 4 || b.some(x => !isFinite(x))) return json(res, { error: 'bbox 要 s,w,n,e' }, 400);
      const [s0, w0, n0, e0] = b;
      const hit = LANDMARKS.filter(l => l.lat >= s0 && l.lat <= n0 && l.lng >= w0 && l.lng <= e0);
      // 太多就先給導覽稿較長的（當作知名度的代理指標）
      hit.sort((a, c) => c.len - a.len);
      // 地圖上這一帶沒有人工景點時，補上維基的（只查中心那一格，
      // 整個 bbox 逐格查會打爆維基）
      if (hit.length < 3 && u.searchParams.get('wiki') !== '0') {
        // 合併中心 3×3 格(搜尋後 warmSpots 已在背景暖這幾格):
        // 中心格等它抓完,鄰格只拿現成快取(沒有就背景補,下次重撈就有)——
        // 只合中心一格的話,暖好的周圍景點永遠上不了地圖(實測里加 22→9)
        const cLat = (s0 + n0) / 2, cLng = (w0 + e0) / 2, step = 1 / 90;
        const seen = new Set(hit.map(x => x.id));
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          // 一律不等(wait=false):維基抓取有全域節流,9 格排隊幾十秒,
          // 等中心格會把整個請求卡到逾時(實測波爾多 60 秒沒回)。
          // 沒現貨就回空+背景抓,客戶端的輪詢會一直重撈,好一格浮一格。
          const w = await wikiCell(cLat + i * step, cLng + j * step, false);
          for (const x of w)
            if (!seen.has(x.id) && x.lat >= s0 && x.lat <= n0 && x.lng >= w0 && x.lng <= e0) {
              seen.add(x.id); hit.push(x);
            }
        }
      }
      // 城市級快取也合進來(bbox 中心與四鄰的 5.5km 網格,現貨才拿)。
      // 用名字去重 —— 人工/逐格/城市級三個來源的 id 系統不同。
      {
        const names = new Set(hit.map(x => x.name));
        const cLat = (s0 + n0) / 2, cLng = (w0 + e0) / 2, g = 1 / 20;
        for (const [di, dj] of [[0,0],[g,0],[-g,0],[0,g],[0,-g]]) {
          // 只有中心格准觸發新查詢,鄰格拿現貨 —— 亂滑地圖不打維基
          for (const x of await loadCity(cLat + di, cLng + dj, false, di === 0 && dj === 0))
            if (!names.has(x.name) && x.lat >= s0 && x.lat <= n0 && x.lng >= w0 && x.lng <= e0) {
              names.add(x.name); hit.push(x);
            }
        }
      }
      return json(res, { n: hit.length, items: hit.slice(0, 400) });
    }
    // 附近的景點（跑步時用），依距離排序，附上導覽稿長度與音檔路徑
    // 「跑到○○」的第三層:維基找不到時搜 OSM 地圖(Nominatim)。
    // bounded=1 + viewbox 限在附近 ~3 公里,不然「凱旋門」會搜到全世界。
    // 名字要真的對得上才算(雙向包含)—— Nominatim 模糊比對太寬,
    // 實測搜「星巴克」回了只對到一個「星」字的共同工作空間。
    // 對不上就請 Gemini 把名字翻成當地通用名稱再搜一次(翻過的記在 xlMem,
    // 免費額度有每分鐘上限,同名不重問)。
    // 反查地名(三螢幕時畫面疊一行位置文字給 Gemini Live 讀 —— 它只看得到分享的
    // 螢幕、看不到左螢幕的地圖,有這行字就不用靠街景猜位置)。重用 geoMem 快取。
    if (u.pathname === '/api/revgeo') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll' }, 400);
      const gk = lat.toFixed(3) + ',' + lng.toFixed(3);
      if (geoMem.has(gk)) return json(res, { place: geoMem.get(gk) });
      try {
        const g = await (await fetch('https://nominatim.openstreetmap.org/reverse?format=json'
          + `&lat=${lat}&lon=${lng}&zoom=17&accept-language=zh-TW`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) })).json();
        const a = g.address || {};
        const place = [a.city || a.town || a.county, a.suburb || a.neighbourhood, a.road]
          .filter(Boolean).join(' ');
        geoMem.set(gk, place);
        if (geoMem.size > 500) geoMem.delete(geoMem.keys().next().value);
        return json(res, { place });
      } catch { return json(res, { place: '' }); }
    }
    if (u.pathname === '/api/findplace') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      const q = (u.searchParams.get('q') || '').trim();
      if (!isFinite(lat) || !isFinite(lng) || !q) return json(res, { error: '要 ll 和 q' }, 400);
      try {
        const vb = 0.09;   // ~10 公里:「跑到」是目的地指令,全城尺度
        const toRad = x => x * Math.PI / 180;
        const dOf = r2 => {
          const dp = toRad(+r2.lat - lat), dl = toRad(+r2.lon - lng);
          const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(+r2.lat)) * Math.sin(dl / 2) ** 2;
          return 2 * 6371000 * Math.asin(Math.sqrt(h));
        };
        const search = async term => {
          const rows = await (await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2'
            + '&limit=5&accept-language=zh-TW&q=' + encodeURIComponent(term)
            + `&viewbox=${lng - vb},${lat + vb},${lng + vb},${lat - vb}&bounded=1`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) })).json();
          return rows.map(r2 => ({
            id: 'osm:' + r2.osm_type + r2.osm_id,
            name: r2.name || (r2.display_name || '').split(',')[0],
            lat: +r2.lat, lng: +r2.lon, d: dOf(r2), ai: true,
          })).filter(x => x.name).sort((x, y) => x.d - y.d);
        };
        const norm = t => (t || '').replace(/[\s。，、！？.,!?]/g, '').toLowerCase();
        const match = (list, term) => list.filter(x =>
          norm(x.name).includes(norm(term)) || norm(term).includes(norm(x.name)));
        let items = match(await search(q), q);
        console.log(`地名搜尋:「${q}」直搜 ${items.length} 個`);
        if (!items.length) {
          let t2 = xlMem.get(q);
          if (t2 === undefined) {
            const out = await genAI(AI_TEXT, { contents: [{ parts: [{ text:
                `「${q}」這個地點/店家名稱,在座標 ${lat.toFixed(2)},${lng.toFixed(2)} 一帶的地圖上`
                + '最可能用什麼名稱標示?只回那個名稱本身,不要任何說明。' }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 2048 } }, 12000);
            t2 = out ? out.text : '';
            console.log(`地名翻譯:「${q}」→「${t2}」` + (out ? `(${out.model})` : ''));
            if (t2 && t2.length < 60) xlMem.set(q, t2);
          }
          if (t2) items = match(await search(t2), t2);
        }
        return json(res, { items });
      } catch (e) { return json(res, { items: [], error: String(e.message || e) }); }
    }
    // 側機零設定入口:側機只要開 /left 或 /right(手機也一樣),
    // 伺服器拿主控最近一次同步裡夾帶的網址參數,自動組出從屬網址轉過去。
    // 使用者不用抄任何參數(實際反饋:「你寫'參數'我實在不會用」)。
    if (u.pathname === '/left' || u.pathname === '/right' || u.pathname === '/mid') {
      let q = null;
      try { q = JSON.parse(syncLast).q; } catch {}
      if (q == null) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta name=viewport content="width=device-width">' +
          '<body style="font:20px/1.8 sans-serif;background:#111;color:#eee;padding:40px">' +
          '主機還沒開始跑。<br>先在主機的啟動器按「開始跑」,再重新整理這頁。' +
          '<script>setTimeout(()=>location.reload(),3000)</script>');
      }
      const sp = new URLSearchParams(q);
      for (const k of ['panel', 'role', 'net', 'run', 'mic', 'voice']) sp.delete(k);
      // 三機模式一定走「三片直線透視」:主機常用的連續超廣角(Panini)
      // 本來就不分片,側機照抄會顯示跟主機一模一樣的全景(實際反饋)。
      sp.delete('proj'); sp.set('panels', '3');
      sp.set('panel', u.pathname === '/left' ? '0' : u.pathname === '/right' ? '2' : '1');
      sp.set('role', 'follow'); sp.set('net', '1');
      // 三螢幕分工(使用者指定):左=大張半透明地圖,右=導覽照片,中=字幕
      if (u.pathname === '/left') sp.set('mini', 'big');
      else if (u.pathname !== '/mid') sp.set('mini', '0');
      if (u.pathname === '/right') sp.set('photos', '1');
      else sp.delete('photos');
      res.writeHead(302, { location: '/run.html?' + sp });
      return res.end();
    }
    if (u.pathname === '/api/qz') {
      return json(res, { ...qz, age: qz.at ? Date.now() - qz.at : null });
    }
    if (u.pathname === '/api/sync' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 20000) break; }
      syncLast = body;
      for (const c of syncClients) { try { c.write(`data: ${body}\n\n`); } catch {} }
      return json(res, { ok: 1, n: syncClients.size });
    }
    if (u.pathname === '/api/sync') {
      res.writeHead(200, { 'content-type': 'text/event-stream',
        'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.write('\n');
      if (syncLast) res.write(`data: ${syncLast}\n\n`);
      syncClients.add(res);
      req.on('close', () => syncClients.delete(res));
      return;
    }
    if (u.pathname === '/api/nearby') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      const rad = Number(u.searchParams.get('r')) || 400;
      // q=名字:語音「跑到某景點」用。比對雙向包含(辨識常少字/多字)。
      const qn = (u.searchParams.get('q') || '').replace(/[\s。，、！？.,!?]/g, '').toLowerCase();
      const nameHit = l => { if (!qn) return true;
        const n = (l.name || '').replace(/\s/g, '').toLowerCase();
        return n.includes(qn) || (qn.length >= 2 && qn.includes(n)); };
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const R = 6371000, toRad = x => x * Math.PI / 180;
      const dist2 = (a, b) => {
        const dp = toRad(b.lat - a.lat), dl = toRad(b.lng - a.lng);
        const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dl / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
      };
      const d2 = l => {
        const dp = toRad(l.lat - lat), dl = toRad(l.lng - lng);
        const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(l.lat)) * Math.sin(dl / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
      };
      const near = LANDMARKS.map(l => ({ ...l, d: d2(l) })).filter(l => l.d <= rad)
        .filter(nameHit).sort((a, b) => a.d - b.d).slice(0, 12);
      const hit = near
        .map(l => {
          const a = AUDIDX[l.id] || {};
          return {
            ...l,
            audio: `/audio/${encodeURIComponent(l.city)}/${encodeURIComponent(l.id)}.mp3`,
            lines: a.lines || [], marks: a.marks || [],
            // 走自家的 /photo：同源（可以 fetch 成 blob）、而且抓過就快取。
            // width 降到 1200 —— 畫面最多顯示 900px 寬，原本的 1600 會拿到
            // 1920px、每張 300–750 KB，跟街景磚塊搶頻寬
            photos: (PHOTOS[l.id] || []).slice(0, 5)
              .map(p => (p.url || '').replace(/width=\d+/, 'width=1200')).filter(Boolean)
              .map(url => '/photo?u=' + encodeURIComponent(url)),
          };
        });
      // 人工資料只有 12 個城市。出了那幾個城市就整片空白 ——
      // 這時候補上維基的景點（全世界都有，繁體中文）。
      // 已經有三個以上人工景點就不補，那幾個城市的稿子比維基好念。
      if (u.searchParams.get('wiki') !== '0' && (qn || near.length < 3)) {
        const w = (await wikiCell(lat, lng))
          .map(x => ({ ...x, d: d2(x) })).filter(x => x.d <= rad).filter(nameHit)
          // 跟人工景點太近的算同一個，不要重複播
          .filter(x => !near.some(l => d2(l) < 9999 && dist2(l, x) < 90))
          .sort((a, b) => a.d - b.d);
        for (const x of w) {
          if (hit.length >= 12) break;
          hit.push({ ...x, audio: '', photos: (x.photos || [])
            .map(url => '/photo?u=' + encodeURIComponent(url)) });
        }
      }
      return json(res, { items: hit });
    }
    // 景點照片轉一手。三個理由，缺一不可：
    //   1. commons.wikimedia.org **沒有開 CORS**（實測回應裡沒有
    //      access-control-allow-origin），所以瀏覽器不能用 fetch 抓成 blob。
    //   2. 直接把網址設成 background-image 可以顯示（那條路徑不受 CORS 限制），
    //      但若先用 new Image() 預載就變成**兩次**請求，第二次常被 429 擋掉 ——
    //      症狀是照片一片黑、而且一直閃。
    //   3. 存到本機之後同一張不會再抓第二次，429 從此絕跡。
    if (u.pathname === '/photo') {
      let src = u.searchParams.get('u') || '';
      // 白名單漏了 flickr —— 資料裡有 42 筆是 live.staticflickr.com，
      // 先前一律 400，那些景點的照片從來就顯示不出來。
      if (!/^https:\/\/(commons\.wikimedia\.org|upload\.wikimedia\.org|live\.staticflickr\.com)\//.test(src))
        return json(res, { error: '不是認得的照片來源' }, 400);
      // 有 72 筆網址沒帶 width，會抓到原圖 —— 實測有一張 6.9 MB，
      // 跑步時那是跟街景磚塊搶頻寬。沒帶就補上。
      if (src.includes('Special:FilePath/') && !/[?&]width=/.test(src))
        src += (src.includes('?') ? '&' : '?') + 'width=1200';
      const key = Buffer.from(src).toString('base64url').slice(-120);
      const f = join(PHOTO_DIR, key + '.jpg');
      const send = body => {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' });
        res.end(body);
      };
      try { return send(await readFile(f)); } catch {}
      try {
        // 先換成 upload.wikimedia.org 的直連縮圖。
        // commons 的 Special:FilePath 限流很兇 —— 實測單一連線每兩秒一次
        // 就有 2/5 回 429；換成直連之後連抓三次都 200 而且愈來愈快。
        const real = await toThumb(src);
        // upload 也會限流，只是寬鬆很多。撞到 429 等一下再來 ——
        // 直接放棄的話畫面端會跳下一張，等於這個景點的照片少一張。
        let r = null;
        for (let i = 0; i < 3; i++) {
          r = await fetch(real, { headers: { 'User-Agent': UA }, redirect: 'follow',
                                  signal: AbortSignal.timeout(20000) });
          if (r.status !== 429) break;
          await new Promise(s => setTimeout(s, 900 * (i + 1)));
        }
        if (!r.ok) return json(res, { error: '抓不到照片 ' + r.status }, 502);
        const buf = Buffer.from(await r.arrayBuffer());
        await mkdir(PHOTO_DIR, { recursive: true });
        await writeFile(f, buf).catch(() => {});
        return send(buf);
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    // 小地圖的磚塊。轉一手是為了存本機 —— 跑同一條路線不用一直跟 CDN 要，
    // 而且跟街景磚塊搶頻寬會讓畫面卡住。
    if (u.pathname === '/maptile') {
      const z = +u.searchParams.get('z'), x = +u.searchParams.get('x'), y = +u.searchParams.get('y');
      if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
          || z < 1 || z > 19) return json(res, { error: '參數不對' }, 400);
      const f = join(MAP_DIR, `${z}_${x}_${y}.png`);
      const send = b => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=2592000' });
        res.end(b);
      };
      try { return send(await readFile(f)); } catch {}
      try {
        // CARTO 2026/8 開始強制 API 金鑰(磚上直接印 API KEY REQUIRED,實測),
        // 換 OSM 官方磚:免金鑰,搭配本機快取+正經 UA,對他們負擔很小
        // OSM 政策:要「自報家門」的 UA,假冒瀏覽器反而進黑名單(實測 403)
        // 磚用官方的(法國社群的 HOT 淡色款實測連不上,志工伺服器不穩);
        // 「太花」的問題改在畫的那端用去飽和濾鏡解決
        const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
          { headers: { 'User-Agent':
              `pano-runner/1.0 (+https://github.com/cheyuan1115/pano-runner; contact: ${process.env.PANO_CONTACT || 'see-repo'})` },
            signal: AbortSignal.timeout(15000) });
        if (!r.ok) return json(res, { error: '抓不到磚塊 ' + r.status }, 502);
        const b = Buffer.from(await r.arrayBuffer());
        await mkdir(MAP_DIR, { recursive: true });
        await writeFile(f, b).catch(() => {});
        return send(b);
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    // 導覽音檔。優先給本機那份（快、離線也能用），沒有才轉到 CDN。
    if (u.pathname.startsWith('/audio/')) {
      const rel = decodeURIComponent(u.pathname.slice('/audio/'.length));
      const f = normalize(join(LM_PATH, '..', 'audio', rel));
      try {
        const body = await readFile(f);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'max-age=86400' });
        return res.end(body);
      } catch {
        res.writeHead(302, { location: 'https://autogpsconfig.web.app/audio/' + rel.split('/').map(encodeURIComponent).join('/') });
        return res.end();
      }
    }
    // 某個景點的導覽稿
    if (u.pathname === '/api/script') {
      const id = u.searchParams.get('id');
      try {
        const all = JSON.parse(await readFile(LM_PATH, 'utf8'));
        const l = all.find(x => x.id === id);
        return json(res, l ? { id, name: l.name, script: l.script || '' } : { error: '沒有這個景點' }, l ? 200 : 404);
      } catch { return json(res, { error: '讀不到景點資料' }, 500); }
    }
    // 找附近「確定在地面」的街景點。地下街裡所有連結都是室內，
    // 靠連結圖爬不出來 —— 只能用座標往外找。
    // 半徑逐圈放大、每圈八個方位；同一顆 pano 只查一次中繼資料。
    if (u.pathname === '/api/findout') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const seen = new Set();
      const toRad = x => x * Math.PI / 180;
      for (const r of [80, 160, 260, 400]) {
        for (let b = 0; b < 360; b += 45) {
          const la = lat + r * Math.cos(toRad(b)) / 111320;
          const ln = lng + r * Math.sin(toRad(b)) / (111320 * Math.cos(toRad(lat)));
          const f = await findPano(la, ln, Math.round(r * 0.7));
          if (!f || seen.has(f.pano)) continue;
          seen.add(f.pano);
          const m = await panoMeta(f.pano);
          if (!m || !m.links.length) continue;
          if (m.indoor || m.below || (m.source && m.source !== 'launch')) continue;
          return json(res, { pano: f.pano, lat: m.lat, lng: m.lng,
                             heading: m.links[0].heading, tried: seen.size, r });
        }
      }
      return json(res, { error: '附近找不到地面街景', tried: seen.size }, 404);
    }
    // 當場生成導覽語音(維基景點沒有預錄 mp3)。
    // 免費額度 100 萬字/月,個人跑步用量的十倍以上 —— 不落地存檔,
    // 記憶體暫存單純是同一趟不重複請求。逐句 <mark> 拿時間戳,字幕同步。
    if (u.pathname === '/api/tts' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 40000) break; }
      let lines, id, lang;
      try { ({ id, lines, lang } = JSON.parse(body)); } catch { return json(res, { error: '格式' }, 400); }
      if (!Array.isArray(lines) || !lines.length) return json(res, { error: '沒有句子' }, 400);
      const ck = id + '|' + (lang || 'zh');
      if (ttsMem.has(ck)) return json(res, ttsMem.get(ck));
      let key;
      try { key = (await readFile(join(process.env.HOME, '.keys', 'mapskey'), 'utf8')).trim(); }
      catch { try { key = (await readFile('/tmp/.mapskey', 'utf8')).trim(); }
              catch { return json(res, { error: '沒有 TTS 金鑰' }, 500); } }
      // 念之前把「(土耳其語:Yerebatan…)」這類外語括號剝掉 ——
      // 維基快取裡的巢狀括號清不乾淨,念出來是一串怪音。跑三輪處理巢狀。
      const strip = t => {
        for (let i = 0; i < 3; i++)
          t = t.replace(/（[^（）]*[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF][^（）]*）/g, '')
               .replace(/\([^()]*[A-Za-z][^()]*\)/g, '');
        return t.replace(/\s{2,}/g, ' ').trim();
      };
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const ssml = '<speak>' + lines.slice(0, 60).map((t, i) => `<mark name="s${i}"/>${esc(strip(t))}`).join('') + '</speak>';
      try {
        const r = await fetch('https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=' + key, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { ssml },
            // 這裡的變數是 lang,不是 q2(那是 aiguide 路由的)——
            // 寫錯成 q2.lang 時整個 TTS 噴 ReferenceError,中英文全退化到
            // 瀏覽器合成,桌面有內建語音沒察覺,Quest 沒有就變啞巴(實測)
            voice: lang === 'en'
              ? { languageCode: 'en-US', name: 'en-US-Wavenet-D' }
              : { languageCode: 'cmn-TW', name: 'cmn-TW-Wavenet-A' },
            audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate: 1.0 },
            enableTimePointing: ['SSML_MARK'],
          }), signal: AbortSignal.timeout(20000),
        });
        const j = await r.json();
        if (!j.audioContent) return json(res, { error: (j.error && j.error.message || 'TTS 失敗').slice(0, 120) }, 502);
        const marks = lines.slice(0, 60).map((_, i) => {
          const tp = (j.timepoints || []).find(t => t.markName === 's' + i);
          return tp ? tp.timeSeconds : 0;
        });
        const out = { audio: j.audioContent, marks };
        ttsMem.set(ck, out);
        if (ttsMem.size > 40) ttsMem.delete(ttsMem.keys().next().value);
        return json(res, out);
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    // AI 即時導覽:沒有內建景點時,傳「目前畫面 + 位置事實包」給 Gemini,
    // 讓它生成導遊稿。鐵律寫死在提示詞裡:只能講事實包裡有的專有名詞,
    // 認不出的建築只能描述外觀,不准命名 —— 位置資料負責「是什麼」,
    // 畫面負責「看起來如何」,AI 只做串接潤飾,不做辨認。
    if (u.pathname === '/api/aiguide' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 900000) break; }
      let q2;
      try { q2 = JSON.parse(body); } catch { return json(res, { error: '格式' }, 400); }
      // 街道名:OSM 反向地理編碼(免費、快取)。查不到就算了,不擋主流程。
      let street = '';
      const gk = q2.lat.toFixed(3) + ',' + q2.lng.toFixed(3);
      if (geoMem.has(gk)) street = geoMem.get(gk);
      else {
        try {
          const g = await (await fetch('https://nominatim.openstreetmap.org/reverse?format=json'
            + `&lat=${q2.lat}&lon=${q2.lng}&zoom=17&accept-language=zh-TW`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) })).json();
          const a = g.address || {};
          street = [a.road, a.suburb || a.neighbourhood, a.city || a.town, a.country]
            .filter(Boolean).join('、');
          geoMem.set(gk, street);
          if (geoMem.size > 500) geoMem.delete(geoMem.keys().next().value);
        } catch {}
      }
      const facts = [
        `座標:${q2.lat.toFixed(5)}, ${q2.lng.toFixed(5)}`,
        street ? `位置:${street}` : '',
        q2.date ? `街景拍攝時間:${q2.date[0]} 年 ${q2.date[1]} 月` : '',
        (q2.nearby || []).length
          ? '附近的已知景點:' + q2.nearby.map(n => `${n.name}(${Math.round(n.d)}公尺)`).join('、') : '',
      ].filter(Boolean).join('\n');
      const subj = (q2.subject || '').slice(0, 40).trim();
      if (subj) {
        // 指名介紹:主角優先用 AI 自身知識,畫面只是現場氛圍的輔助 ——
        // 主角很可能根本不在畫面裡(隔著一條河聽東京鐵塔),
        // 所以防瞎說的重點從「不准命名」轉成「不確定的事不要編年份數字」
        const prompt2 = q2.lang === 'en'
          ? `You are a knowledgeable tour guide. The visitor asked specifically about: "${subj}".
Give an 80-140 word spoken introduction of it — history, origin, purpose, significance, one or two vivid facts. Use your own knowledge of this landmark.
Context (where the visitor is standing now — mention it only if relevant):
${facts}
Rules: don't invent specific dates/numbers you're unsure of; no filler-mood sentences; no mentions of running or exercise; don't open with "this photo"; speak as a guide standing beside the visitor.`
          : `你是知識型導遊。訪客指名想聽「${subj}」的介紹。
用繁體中文(台灣用語)講一段 100 到 160 字的介紹:它的歷史、由來、用途、地位,加一兩個生動的知識點。用你自己對這個景點的知識來講。
訪客目前所在位置(有關聯才提,沒關聯不用硬扯):
${facts}
規則:不確定的年份數字不要編;禁止零資訊的氛圍句;不提跑步運動;不要「這張照片」開頭;像站在訪客身邊的導遊那樣說。`;
        const out2 = await genAI(AI_VISION, {
          contents: [{ parts: [
            { text: prompt2 },
            { inline_data: { mime_type: 'image/jpeg', data: q2.img } },
          ] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
        }, 25000, t => guideOk(t, q2.lang));
        // 照片瀑布與生稿「並行」:維基(地標)→ Places(店家)→ 空(寧缺勿錯)
        const photoJob = (async () => {
          try {
            const m2 = await moreImages([subj], 5);
            const w = (m2.get(subj) || []).map(u2 => '/photo?u=' + encodeURIComponent(u2));
            if (w.length) return w;
          } catch {}
          try { return await placesPhotos(subj, q2.lat, q2.lng); } catch { return []; }
        })();
        if (!out2) return json(res, { error: '今天的 AI 額度用完了(每模型每天 20 次,已全輪過)' }, 502);
        const clean2 = out2.text.replace(/[（(]\d+[)）]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
        return json(res, { text: clean2, photos: await photoJob.catch(() => []) });
      }
      const prompt = q2.lang === 'en' ? `You are a knowledgeable tour guide. The attached photo is the visitor's current street view.
Write a 80-120 word spoken introduction, concise but substantive — every sentence should carry a fact: history, origins, purpose, what an architectural feature means, how this area fits the city.
No filler-mood sentences ("adds a touch of elegance" etc). No mentions of running or exercise, no pep talk, no questions.

Verified facts:
${facts}

Hard rules:
1. Only use proper nouns that appear in the facts above. Never name a building or shop that isn't listed.
2. For anything you can't identify in the photo, describe what's visible (style, materials, street character) — never guess a name.
3. When unsure, talk about the district's history and context; never invent dates or names.
4. Don't open with "this photo" or "this image" — speak as if standing there.
${(q2.recent || []).length ? '5. Already covered, do not repeat: ' + q2.recent.join(' / ') : ''}` : `你是知識型導遊。訪客眼前是附的街景照片。
用繁體中文(台灣用語)寫一段 100 到 150 字的導覽,簡潔但每句都有內容。
每一句都要帶知識點:歷史、由來、用途、建築特徵的意義、這一區的定位。
禁止氛圍填充句:「增添幾分優雅」「感受獨特魅力」「悠閒氣息」這類
沒有資訊量的句子一律不要。不要提到跑步運動,不要加油,不要問句互動。

可驗證的事實:
${facts}

鐵律:
1. 只能說出「事實」清單裡出現過的專有名詞。清單裡沒有的建築或店家,一律不准命名。
2. 照片裡認不出的東西,只能描述看得到的(建築風格、材質、街道氛圍),不准猜名字。
3. 不確定的就往這一區的歷史或文化脈絡講,不要編造具體年份或人名。
4. 不要用「這張照片」「這個畫面」開頭,直接像在現場說話。
${(q2.recent || []).length ? '5. 之前已經講過以下內容,不要重複:' + q2.recent.join(' / ') : ''}`;
      // 思考段過濾與 429 換模型都在 genAI 裡。maxOutputTokens 要放大:
      // 這系列模型會先「思考」,思考也算輸出額度,太少正文會被截掉。
      const out = await genAI(AI_VISION, {
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: q2.img } },
        ] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
      }, 25000, t => guideOk(t, q2.lang));
      if (!out) return json(res, { error: '今天的 AI 額度用完了(每模型每天 20 次,已全輪過)' }, 502);
      // 最後保險:就算通過驗收,殘餘的編號雜訊也清掉
      const clean = out.text.replace(/[（(]\d+[)）]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
      return json(res, { text: clean });
    }
    // 語音黑盒子。辨識這一段沒辦法從我這邊重現（我沒有辦法對麥克風講話），
    // 所以讓瀏覽器把每個事件送回來記著，才有辦法分辨是
    // 「麥克風沒進來」「聽到了但比對不中」還是「被自己的旁白吃掉」。
    if (u.pathname === '/api/vlog' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 8000) break; }
      const t = new Date().toTimeString().slice(0, 8);
      let line = body;
      try { const o = JSON.parse(body); line = o.ev + '　' + JSON.stringify(o).slice(0, 400); } catch {}
      await appendFile(VLOG, `${t} ${line}\n`).catch(() => {});
      console.log(`🗣 ${t} ${line}`);
      res.writeHead(204); return res.end();
    }
    // 預熱：把一個點周圍九格的維基景點先抓好，跑步時就不會有空窗。
    // 搜尋城市後的「整城景點」:單一 SPARQL(半徑 7km、上限 200)
    // Places 照片代取(含磁碟快取,同一張不重抓)
    if (u.pathname === '/pphoto') {
      const n = u.searchParams.get('n') || '';
      if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(n)) return json(res, { error: '格式' }, 400);
      const f = join(PHOTO_DIR, 'places_' + n.replace(/\//g, '_') + '.jpg');
      const send = b2 => { res.writeHead(200, { 'content-type': 'image/jpeg',
        'cache-control': 'max-age=2592000' }); res.end(b2); };
      try { return send(await readFile(f)); } catch {}
      try {
        const key = (await readFile(join(process.env.HOME, '.keys', 'mapskey'), 'utf8')).trim();
        const r = await fetch(`https://places.googleapis.com/v1/${n}/media?maxWidthPx=1200&key=${key}`,
          { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (!r.ok) return json(res, { error: 'places ' + r.status }, 502);
        const b2 = Buffer.from(await r.arrayBuffer());
        await writeFile(f, b2).catch(() => {});
        return send(b2);
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    // 語音「呼叫AI」→ Gemini Live 智慧開關。狀態靠系統視窗清單偵測:
    // Live 的懸浮窗(Chrome、浮動層、約 350×120)存在=開著 → 點它的 ✕ 關;
    // 不在 → ^G 開面板 + 1.3 秒後點輸入框右下的聲波鈕進語音模式。
    // 懸浮窗會移動,座標一律即時查(CGWindowList),不寫死。
    // 需要:同一台機器、輔助使用權限、cliclick、python3+pyobjc。
    // Gemini Live 巡邏:在不在?暫停了沒?(「聽取中」實測幾分鐘內就會
    // 自己變「已暫停」,跑步中看不到浮窗 —— 這就是「Gemini 都聽不到」的真相。
    // tools/gem-status.py 用 OCR 讀狀態,暫停就按波形鈕救回)
    if (u.pathname === '/api/gemini/status') {
      try {
        const { execFile } = await import('node:child_process');
        const mode = u.searchParams.get('onpause') === 'close' ? 'close' : 'resume';
        const out = await new Promise((ok, no) => execFile('python3',
          [join(fileURLToPath(new URL('.', import.meta.url)), 'tools', 'gem-status.py'), mode],
          { timeout: 15000 }, (e, o) => e ? no(e) : ok((o || '').trim())));
        if (out !== 'LIVE') console.log('Gemini 巡邏:', out);
        return json(res, { on: out !== 'NONE' && out !== 'CLOSED', state: out });
      } catch (e) {
        // 巡邏出錯不等於「浮窗不見了」—— 回 err 讓呼叫端自己數,不要誤判成已關閉
        console.log('Gemini 巡邏失敗:', String(e.message || e).slice(0, 80));
        return json(res, { on: true, err: 1, error: String(e.message || e).slice(0, 60) });
      }
    }
    if (u.pathname === '/api/gemini') {
      try {
        const { execFile } = await import('node:child_process');
        const run = (cmd, args) => new Promise((ok, no) =>
          execFile(cmd, args, (e, out) => e ? no(e) : ok((out || '').trim())));
        const PYFIND = `
import Quartz
wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
for w in wl:
    if 'Chrome' in w.get('kCGWindowOwnerName','') and w.get('kCGWindowLayer',0) > 0:
        b = w['kCGWindowBounds']
        if 250 < b['Width'] < 600 and 80 < b['Height'] < 300:
            print(int(b['X'] + b['Width'] - 20), int(b['Y'] + 18)); break
else: print('NONE')`;
        const found = await run('python3', ['-c', PYFIND]);
        if (found !== 'NONE') {
          const [x, y] = found.split(' ');
          await run('/opt/homebrew/bin/cliclick', ['c:' + x + ',' + y]);
          return json(res, { ok: 1, action: 'closed' });
        }
        await run('osascript', ['-e', 'tell application "Google Chrome" to activate',
          '-e', 'delay 0.3',
          '-e', 'tell application "System Events" to keystroke "g" using control down']);
        await new Promise(r2 => setTimeout(r2, 1300));
        const xy = await run('osascript', ['-e', `
          tell application "System Events" to tell process "Google Chrome"
            set w to first window whose value of attribute "AXMain" is true
            set p to value of attribute "AXPosition" of w
            set sz to value of attribute "AXSize" of w
            return ((item 1 of p) + (item 1 of sz) - 42 as string) & " " & ((item 2 of p) + (item 2 of sz) - 43 as string)
          end tell`]);
        const [x2, y2] = xy.split(' ');
        await run('/opt/homebrew/bin/cliclick', ['c:' + x2 + ',' + y2]);
        return json(res, { ok: 1, action: 'opened' });
      } catch (e) { return json(res, { error: String(e.message || e) }, 500); }
    }
    // AI 排路線(混合式):演算法圈候選+把關距離,Gemini 挑選排序+寫開場白。
    // 環狀:終點回到起點。距離估算=相鄰直線和×1.3(繞路係數)。
    // 海拔查詢:open-meteo(免金鑰),座標四捨五入到 ~11m 網格快取。
    // 給自行車台的坡度模擬用:相鄰全景的海拔差 ÷ 距離 = 坡度%。
    // ── Strava:OAuth(一次性授權)+ 上傳代理 ──────────────
    // 設定:~/.keys/strava = {"id":"...","secret":"..."}(API 應用的憑證)
    // 授權:開 /strava/auth 走一次 → refresh token 存 ~/.keys/strava-token.json
    // ── Strava 免 API 上傳:自動化專用 Chrome 分身 ──────────────
    // API 被鎖訂閱牆後的替代:專用 profile 登入一次,之後 CDP 操作
    // strava.com/upload 代傳 TCX(DOM.setFileInputFiles 塞檔案)。
    if (u.pathname === '/strava/weblogin') {
      const { spawn } = await import('node:child_process');
      spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['--user-data-dir=' + join(process.env.HOME, '.keys', 'strava-chrome'),
         '--no-first-run', '--no-default-browser-check', '--window-size=1000,760',
         'https://www.strava.com/login'], { detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<body style="font:19px sans-serif;padding:40px;background:#111;color:#eee">'
        + '開了一個專用瀏覽器視窗 —— 在那裡登入 Strava(記住我),登入完成後關掉那個視窗即可。'
        + '之後每趟結束會自動用它上傳。</body>');
    }
    if (u.pathname === '/api/strava/webupload' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 5e6) break; }
      try {
        const { tcx, fitB64, ride } = JSON.parse(body);
        // 1) 落地存檔(無論上傳成敗,紀錄都在)
        const dir = join(process.env.HOME, 'pano-runs');
        await mkdir(dir, { recursive: true });
        const d = new Date();
        const fname = `pano-${ride ? 'ride' : 'run'}-${d.getMonth() + 1}-${d.getDate()}-`
          + `${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}.${fitB64 ? 'fit' : 'tcx'}`;
        const fpath = join(dir, fname);
        await writeFile(fpath, fitB64 ? Buffer.from(fitB64, 'base64') : tcx);
        // 2) CDP 操作專用 Chrome 上傳
        const { spawn, execSync } = await import('node:child_process');
        try { execSync('pkill -f strava-chrome'); await new Promise(r2 => setTimeout(r2, 800)); } catch {}
        spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ['--user-data-dir=' + join(process.env.HOME, '.keys', 'strava-chrome'),
           '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check',
           '--window-size=900,700', '--window-position=2000,100',
           'https://www.strava.com/upload/select'], { detached: true, stdio: 'ignore' }).unref();
        let target = null;
        for (let i = 0; i < 40 && !target; i++) {
          await new Promise(r2 => setTimeout(r2, 500));
          try {
            const list = await (await fetch('http://127.0.0.1:9333/json')).json();
            target = list.find(t => t.type === 'page' && t.url.includes('strava'));
          } catch {}
        }
        if (!target) throw new Error('自動化瀏覽器沒起來');
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        let mid = 0; const pend = new Map();
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
        await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
        const send = (m2, p2 = {}) => new Promise(r2 => { const i = ++mid; pend.set(i, r2); ws.send(JSON.stringify({ id: i, method: m2, params: p2 })); });
        await send('Runtime.enable'); await send('DOM.enable'); await send('Page.enable');
        // 等頁面就緒,找檔案輸入框(沒登入的話會被轉去 login → 回報要先登入)
        let nodeId = 0, needLogin = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r2 => setTimeout(r2, 700));
          const urlNow = (await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true })).result?.result?.value || '';
          if (urlNow.includes('login')) { needLogin = true; break; }
          const doc = await send('DOM.getDocument');
          const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
          if (q.result?.nodeId) { nodeId = q.result.nodeId; break; }
        }
        if (needLogin) { console.log('Strava 上傳:未登入'); execSync('pkill -f strava-chrome || true'); return json(res, { saved: fname, error: '先開 /strava/weblogin 登入一次' }); }
        if (!nodeId) { console.log('Strava 上傳:找不到檔案輸入框'); execSync('pkill -f strava-chrome || true'); return json(res, { saved: fname, error: '找不到上傳框(Strava 改版?)' }); }
        await send('DOM.setFileInputFiles', { files: [fpath], nodeId });
        // 等處理:成功時頁面會出現活動編輯列或跳轉
        let okUp = false;
        for (let i = 0; i < 40; i++) {
          await new Promise(r2 => setTimeout(r2, 1000));
          const t2 = (await send('Runtime.evaluate', { expression:
            "document.body.innerText.slice(0,2000)", returnByValue: true })).result?.result?.value || '';
          if (/已建立|activity|Activity|編輯|Edit|saved|完成/i.test(t2) && !/error|錯誤|failed/i.test(t2)) { okUp = true; break; }
        }
        await new Promise(r2 => setTimeout(r2, 3000));   // 給它幾秒完成收尾
        execSync('pkill -f strava-chrome || true');
        console.log('Strava 網頁上傳:', fname, okUp ? 'OK' : '未確認');
        return json(res, { ok: okUp ? 1 : 0, saved: fname,
          error: okUp ? undefined : '已存檔;上傳結果未確認,必要時手動拖 strava.com/upload' });
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    // ── Garmin Connect 上傳(同 Strava 的自動化分身招式)──────
    // 免 API:專用 profile 登入一次,CDP 操作 import-data 頁塞 TCX。
    // 加碼:使用者的 Garmin↔Strava 已連動,傳 Garmin 會自動同步 Strava。
    if (u.pathname === '/garmin/weblogin') {
      const { spawn } = await import('node:child_process');
      spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['--user-data-dir=' + join(process.env.HOME, '.keys', 'garmin-chrome'),
         '--no-first-run', '--no-default-browser-check', '--window-size=1000,760',
         'https://connect.garmin.com/signin'], { detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<body style="font:19px sans-serif;padding:40px;background:#111;color:#eee">'
        + '開了專用瀏覽器 —— 登入 Garmin Connect(記住我),完成後關掉那個視窗。</body>');
    }
    if (u.pathname === '/api/garmin/webupload' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 5e6) break; }
      try {
        const { tcx, fitB64, ride } = JSON.parse(body);
        const dir = join(process.env.HOME, 'pano-runs');
        await mkdir(dir, { recursive: true });
        const d = new Date();
        const fname = `pano-${ride ? 'ride' : 'run'}-${d.getMonth() + 1}-${d.getDate()}-`
          + `${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}.${fitB64 ? 'fit' : 'tcx'}`;
        const fpath = join(dir, fname);
        await writeFile(fpath, fitB64 ? Buffer.from(fitB64, 'base64') : tcx);
        // Token 上傳(取代瀏覽器自動化):garth 權杖約一年有效,不開瀏覽器、不會天天過期。
        const { execFile } = await import('node:child_process');
        const py = join(ROOT_DIR, '.laenv', 'bin', 'python');
        const script = join(ROOT_DIR, 'tools', 'garmin-token.py');
        const out = await new Promise(r2 => execFile(py, [script, 'upload', fpath],
          { timeout: 60000 }, (e, so) => r2((so || '') + (e ? ' ' + e.message : ''))));
        const line = out.split('\n').filter(Boolean).pop() || '';
        console.log('Garmin token 上傳:', fname, line.slice(0, 60));
        if (line.startsWith('OK')) return json(res, { ok: 1, saved: fname });
        if (line.startsWith('DUP')) return json(res, { ok: 1, saved: fname, dup: 1 });
        if (line.startsWith('NEEDLOGIN') || line.startsWith('NOTOKEN'))
          return json(res, { saved: fname, error: 'Garmin 權杖失效,要重新登入(跑 tools/garmin-token.py login)' });
        return json(res, { saved: fname, error: '上傳未確認:' + line.slice(0, 50) });
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    if (u.pathname === '/strava/auth') {
      try {
        const cfg = JSON.parse(await readFile(join(process.env.HOME, '.keys', 'strava'), 'utf8'));
        res.writeHead(302, { location: 'https://www.strava.com/oauth/authorize?client_id=' + cfg.id
          + '&redirect_uri=' + encodeURIComponent('http://localhost:8877/strava/cb')
          + '&response_type=code&scope=activity:write&approval_prompt=auto' });
        return res.end();
      } catch { return json(res, { error: '先把 Strava 憑證放到 ~/.keys/strava' }, 500); }
    }
    if (u.pathname === '/strava/cb') {
      try {
        const cfg = JSON.parse(await readFile(join(process.env.HOME, '.keys', 'strava'), 'utf8'));
        const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: cfg.id, client_secret: cfg.secret,
            code: u.searchParams.get('code'), grant_type: 'authorization_code' }) });
        const j = await r.json();
        if (!j.refresh_token) return json(res, j, 502);
        await writeFile(join(process.env.HOME, '.keys', 'strava-token.json'), JSON.stringify(j));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<body style="font:20px sans-serif;padding:40px;background:#111;color:#eee">✅ Strava 已連結!之後每趟自動上傳。這頁可以關了。</body>');
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    if (u.pathname === '/api/strava/status') {
      try {
        await readFile(join(process.env.HOME, '.keys', 'strava-token.json'));
        return json(res, { ok: 1 });
      } catch { return json(res, { ok: 0 }); }
    }
    if (u.pathname === '/api/strava/upload' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 5e6) break; }
      try {
        const { tcx, name, ride } = JSON.parse(body);
        const cfg = JSON.parse(await readFile(join(process.env.HOME, '.keys', 'strava'), 'utf8'));
        let tok = JSON.parse(await readFile(join(process.env.HOME, '.keys', 'strava-token.json'), 'utf8'));
        if ((tok.expires_at || 0) * 1000 < Date.now() + 60000) {   // 過期就用 refresh 換新
          const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: cfg.id, client_secret: cfg.secret,
              refresh_token: tok.refresh_token, grant_type: 'refresh_token' }) });
          tok = await r.json();
          await writeFile(join(process.env.HOME, '.keys', 'strava-token.json'), JSON.stringify(tok));
        }
        const fd = new FormData();
        fd.append('file', new Blob([tcx], { type: 'application/xml' }), 'run.tcx');
        fd.append('data_type', 'tcx');
        fd.append('name', name || 'pano-runner');
        fd.append('trainer', '1');                       // 標成室內/虛擬
        fd.append('activity_type', ride ? 'ride' : 'run');
        const up = await fetch('https://www.strava.com/api/v3/uploads', { method: 'POST',
          headers: { Authorization: 'Bearer ' + tok.access_token }, body: fd });
        const uj = await up.json();
        if (uj.error) return json(res, { error: String(uj.error).slice(0, 120) }, 502);
        console.log('Strava 上傳:', uj.id_str || uj.id, uj.status);
        return json(res, { ok: 1, id: uj.id_str || uj.id });
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    if (u.pathname === '/api/elev') {
      const lls = (u.searchParams.get('lls') || '').split('|')
        .map(t => t.split(',').map(Number)).filter(p2 => p2.length === 2 && p2.every(isFinite));
      if (!lls.length) return json(res, { error: 'lls 格式:lat,lng|lat,lng' }, 400);
      const out = [];
      const miss = [];
      for (const [la, ln] of lls) {
        const k = la.toFixed(4) + ',' + ln.toFixed(4);
        if (elevMem.has(k)) out.push({ k, e: elevMem.get(k) });
        else miss.push([la, ln, k]);
      }
      if (miss.length) {
        try {
          const r = await fetch('https://api.open-meteo.com/v1/elevation?latitude='
            + miss.map(m2 => m2[0]).join(',') + '&longitude=' + miss.map(m2 => m2[1]).join(','),
            { signal: AbortSignal.timeout(8000) });
          const j = await r.json();
          (j.elevation || []).forEach((e, i) => {
            elevMem.set(miss[i][2], e);
            out.push({ k: miss[i][2], e });
          });
        } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
      }
      return json(res, { elev: Object.fromEntries(out.map(o => [o.k, o.e])) });
    }
    if (u.pathname === '/api/planroute') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      const km = Math.max(1, Math.min(20, Number(u.searchParams.get('km')) || 5));
      const lang = u.searchParams.get('lang') === 'en' ? 'en' : 'zh';
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const toRad = x => x * Math.PI / 180;
      const dm = (a2, b2) => {
        const dp = toRad(b2.lat - a2.lat), dl = toRad(b2.lng - a2.lng);
        const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(a2.lat)) * Math.cos(toRad(b2.lat)) * Math.sin(dl / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(h));
      };
      try {
        // 候選:人工景點+城市級快取,錨定在最熱門的景點周圍
        const seen = new Map();
        for (const l of LANDMARKS)
          if (dm({ lat, lng }, l) < 8000) seen.set(l.name, { name: l.name, lat: l.lat, lng: l.lng, w: (l.len || 100) });
        for (const x of await loadCity(lat, lng, true))
          if (!seen.has(x.name)) seen.set(x.name, { name: x.name, lat: x.lat, lng: x.lng, w: (x.links || 1) * 30 });
        let cands = [...seen.values()].sort((a2, b2) => b2.w - a2.w);
        if (cands.length < 3) return json(res, { error: lang === 'en' ? 'Not enough landmarks here' : '這一帶景點不夠排路線' }, 404);
        const anchor = cands[0];
        const R = Math.max(700, km * 260);          // 環狀半徑尺度
        cands = cands.filter(c => dm(anchor, c) < R).slice(0, 25);
        // Gemini 挑選排序
        const list = cands.map((c, i) => `${i + 1}. ${c.name} (${c.lat.toFixed(5)},${c.lng.toFixed(5)})`).join('\n');
        const prompt = lang === 'en'
          ? `Plan a pleasant ~${km} km LOOP running route. Pick 4 to 8 spots from this list, ordered to avoid backtracking; the route returns to the first spot. Also write a 2-sentence spoken intro of the route (English).
Spots:\n${list}\nReply STRICT JSON only: {"route":["name1","name2",...],"blurb":"..."} — names must be copied exactly from the list.`
          : `幫跑者規畫一條約 ${km} 公里的「環狀」跑步路線。從下列景點挑 4 到 8 個,排序要順路不折返,最後會跑回第一個點。再寫兩句話的開場白(繁體中文,像導遊開場)。
景點:\n${list}\n只回严格 JSON:{"route":["名稱1","名稱2",...],"blurb":"..."} —— 名稱必須跟清單一字不差。`;
        const names = new Set(cands.map(c => c.name));
        const out = await genAI(AI_VISION, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 4096 },
        }, 25000, t => {
          try {
            const j2 = JSON.parse(t.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
            return Array.isArray(j2.route) && j2.route.length >= 3 && j2.route.every(n => names.has(n)) && !!j2.blurb;
          } catch { return false; }
        });
        if (!out) return json(res, { error: 'AI 排不出來(額度或格式)' }, 502);
        const plan = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
        let route = plan.route.map(n => cands.find(c => c.name === n));
        // 距離把關:環狀估算=相鄰直線和(含回程)×1.3;超標砍尾、太短補最近的
        const est = r2 => {
          let d = 0;
          for (let i = 0; i < r2.length; i++) d += dm(r2[i], r2[(i + 1) % r2.length]);
          return d * 1.3;
        };
        while (route.length > 3 && est(route) > km * 1250) route.splice(route.length - 2, 1);
        const unused = cands.filter(c => !route.includes(c));
        while (est(route) < km * 750 && unused.length) {
          const last = route[route.length - 1];
          unused.sort((a2, b2) => dm(last, a2) - dm(last, b2));
          route.splice(route.length, 0, unused.shift());
        }
        // 吸附到街景(吸不到的丟掉)
        const snapped = [];
        for (const c of route) {
          try {
            const f = await findPano(c.lat, c.lng, 90);
            if (f) snapped.push({ name: c.name, lat: f.lat ?? c.lat, lng: f.lng ?? c.lng });
          } catch {}
        }
        if (snapped.length < 3) return json(res, { error: '吸附街景後點太少' }, 502);
        snapped.push({ ...snapped[0], name: snapped[0].name });   // 環狀:回到起點
        return json(res, { pts: snapped, km: +(est(snapped.slice(0, -1)) / 1000).toFixed(1),
                           blurb: plan.blurb, names: snapped.slice(0, -1).map(p2 => p2.name) });
      } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    if (u.pathname === '/api/citywarm') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const items = await loadCity(lat, lng, true);
      return json(res, { n: items.length });
    }
    if (u.pathname === '/api/wikiwarm') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const step = 1 / 90;
      const out = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const items = await wikiCell(lat + i * step, lng + j * step, true);
        out.push({ cell: `${i},${j}`, n: items.length });
      }
      return json(res, { cells: out, total: out.reduce((a, b) => a + b.n, 0) });
    }
    if (u.pathname === '/api/meta') {
      const id = u.searchParams.get('pano');
      if (isApple(id)) {
        const known = laMeta.get(id) || {};
        const j = await apple('meta', { id, lat: known.lat, lng: known.lng });
        if (j.error) return json(res, { error: j.error }, 404);
        for (const n of j.links || []) laMeta.set(n.id, { lat: n.lat, lng: n.lng });
        laMeta.set(id, { lat: j.lat, lng: j.lng });
        if (laMeta.size > 5000) for (const k of [...laMeta.keys()].slice(0, 1000)) laMeta.delete(k);
        apple('pyramid', { id, lat: j.lat, lng: j.lng }, 120000);   // 先開工,磚塊端點會等它
        return json(res, { pano: id, lat: j.lat, lng: j.lng, el: 0, yaw: j.yaw,
          date: j.date ? [+j.date.slice(0, 4), +j.date.slice(5, 7)] : null,
          eras: [], indoor: false, car: true, floor: null, below: false,
          geom: LA_GEOM, links: laLinks(j.links) });
      }
      const m = await panoMeta(id);
      return json(res, m || { error: '查不到這顆全景' }, m ? 200 : 404);
    }
    // Apple 磚塊:worker 切好放 .lacache,沒切完就等它(引擎抓磚有 8 秒逾時+重試)
    if (u.pathname === '/atile') {
      const id = u.searchParams.get('pano');
      const z = Math.max(2, Math.min(3, +u.searchParams.get('z') || 2));   // Apple 只切到 z3
      const x = +u.searchParams.get('x') || 0, y = +u.searchParams.get('y') || 0;
      const f = join(LA_CACHE, id, `${z}_${x}_${y}.jpg`);
      const send = b => { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' }); res.end(b); };
      try { return send(await readFile(f)); } catch {}
      const known = laMeta.get(id) || {};
      const j = await apple('pyramid', { id, lat: known.lat, lng: known.lng }, 90000);
      if (j.error) return json(res, { error: j.error }, 404);
      try { return send(await readFile(f)); } catch { return json(res, { error: '切磚失敗' }, 404); }
    }
    // 靜態檔。normalize + 前綴檢查擋掉 ../ 跳出去
    const p = normalize(join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!p.startsWith(ROOT)) return json(res, { error: '不給看' }, 403);
    const body = await readFile(p);
    // 不要讓瀏覽器快取 —— 沒有快取標頭時 Chrome 會自己啟發式快取，
    // 反覆改 view.js 的時候會拿到舊的，看起來像「改了沒效果」。
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream',
                         'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, { error: '沒有這個檔' }, 404);
    json(res, { error: String(e.message || e) }, 500);
  }
};

// 8877 同時聽 http 與 https:很多電視/怪瀏覽器會強制把網址升級成
// https 打進 http 埠(ERR_SSL_PROTOCOL_ERROR,實測電視兩顆瀏覽器都這樣,
// 使用者根本改不掉)。TLS 的第一個位元組一定是 0x16(ClientHello),
// 嗅一下就能分流 —— 對方愛講哪種話都通。
import { createServer as createNet } from 'node:net';
const httpSrv = createServer(handler);
let tlsSrv = null;
try {
  const [key, cert] = await Promise.all([
    readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'cert', 'key.pem')),
    readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'cert', 'cert.pem')),
  ]);
  tlsSrv = createTls({ key, cert }, handler);
  // 8878 維持純 HTTPS(VR 用;WebXR 只在安全脈絡下存在)
  tlsSrv.listen(PORT + 1, () =>
    console.log(`pano-runner  https://${lanIP()}:${PORT + 1}  （VR 用）`));
} catch { console.log('沒有憑證，HTTPS 未啟動（VR 需要它）'); }
createNet(sock => {
  sock.once('data', head => {
    sock.pause();
    sock.unshift(head);
    (head[0] === 0x16 && tlsSrv ? tlsSrv : httpSrv).emit('connection', sock);
    // resume 一定要等下一個 tick:TLS 端要先把自己的監聽掛上,
    // 同步 resume 的話 ClientHello 被吐回去卻沒人接,握手就停在那
    process.nextTick(() => sock.resume());
  });
  sock.on('error', () => {});
}).listen(PORT, () => console.log(`pano-runner  http(s)://localhost:${PORT}`));
