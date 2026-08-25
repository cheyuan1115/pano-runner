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
import { wikiNearby } from './wiki.mjs';

// 景點資料沿用 run-world 那份（745 個，12 個城市，含導覽稿）。
// 直接讀原檔而不是複製一份 —— 那邊修了座標這邊立刻同步。
// 讀不到就當成沒有景點，不影響跑步。
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
const xlMem = new Map();   // 地名翻譯快取:星巴克→Starbucks

// Gemini 免費額度是「每個模型各自每天 20 次」(實測 429:
// GenerateRequestsPerDayPerProjectPerModel-FreeTier, quota=20)。
// 所以做成備援鏈:一款回錯(429/404/空稿)就換下一款,全輪完才放棄。
// 回傳 {text, model} 或 null。
async function genAI(models, body, timeoutMs = 20000) {
  let gkey;
  try { gkey = (await readFile(join(process.env.HOME, '.keys', 'geminikey'), 'utf8')).trim(); }
  catch { return null; }
  for (const mdl of models) {
    try {
      const g = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body) })).json();
      if (g.error) { console.log(`AI ${mdl}:${g.error.code}`); continue; }
      const text = (g.candidates?.[0]?.content?.parts || [])
        .filter(p2 => !p2.thought).map(p2 => p2.text || '').join('').trim();
      if (text) return { text, model: mdl };
      console.log(`AI ${mdl}:空稿`);
    } catch (e) { console.log(`AI ${mdl}:` + (e.message || e)); }
  }
  return null;
}
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
        const r = await findPano(lat, lng, rad);
        if (!r) continue;
        // 順便回傳落點座標，呼叫端才知道吸到哪、差多遠
        const m = await panoMeta(r.pano);
        return json(res, m ? { ...r, lat: m.lat, lng: m.lng, snapped: rad > want } : r);
      }
      return json(res, { error: '附近找不到街景' }, 404);
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
        const w = await wikiCell((s0 + n0) / 2, (w0 + e0) / 2, true);
        for (const x of w)
          if (x.lat >= s0 && x.lat <= n0 && x.lng >= w0 && x.lng <= e0) hit.push(x);
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
    if (u.pathname === '/api/findplace') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      const q = (u.searchParams.get('q') || '').trim();
      if (!isFinite(lat) || !isFinite(lng) || !q) return json(res, { error: '要 ll 和 q' }, 400);
      try {
        const vb = 0.03;
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
        const r = await fetch(`https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
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
      let lines, id;
      try { ({ id, lines } = JSON.parse(body)); } catch { return json(res, { error: '格式' }, 400); }
      if (!Array.isArray(lines) || !lines.length) return json(res, { error: '沒有句子' }, 400);
      if (ttsMem.has(id)) return json(res, ttsMem.get(id));
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
            voice: { languageCode: 'cmn-TW', name: 'cmn-TW-Wavenet-A' },
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
        ttsMem.set(id, out);
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
      const prompt = `你是知識型導遊。訪客眼前是附的街景照片。
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
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
      }, 25000);
      if (!out) return json(res, { error: '今天的 AI 額度用完了(每模型每天 20 次,已全輪過)' }, 502);
      return json(res, { text: out.text });
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
      const m = await panoMeta(u.searchParams.get('pano'));
      return json(res, m || { error: '查不到這顆全景' }, m ? 200 : 404);
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

createServer(handler).listen(PORT, () => console.log(`pano-runner  http://localhost:${PORT}`));

// HTTPS 給 VR 用。WebXR 只在安全脈絡下存在 —— Quest 的瀏覽器開
// http://192.168.x.x 時 navigator.xr 直接是 undefined。
// 自簽憑證第一次連會警告，按「繼續」一次就好。憑證不存在就跳過，不影響一般使用。
try {
  const [key, cert] = await Promise.all([
    readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'cert', 'key.pem')),
    readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'cert', 'cert.pem')),
  ]);
  createTls({ key, cert }, handler).listen(PORT + 1, () =>
    console.log(`pano-runner  https://192.168.0.117:${PORT + 1}  （VR 用）`));
} catch { console.log('沒有憑證，HTTPS 未啟動（VR 需要它）'); }
