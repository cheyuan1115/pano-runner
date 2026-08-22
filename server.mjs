// 很小的一支：靜態檔 + 兩個代理端點。
//
// 為什麼只有 photometa 和 SingleImageSearch 要代理，磚塊不用：
// 磚塊那個主機的 CORS 是開放的（會把你的 Origin 原樣回在
// access-control-allow-origin 上），瀏覽器可以直接抓；
// google.com 和 maps.googleapis.com 沒開，所以那兩個要從 Node 轉一手。
//
// 沒有 Chrome、沒有 CDP、沒有專用 profile。這支停掉就什麼都不剩。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPano, panoMeta } from './pano.mjs';

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
const PORT = 8877;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
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
      return json(res, { n: hit.length, items: hit.slice(0, 400) });
    }
    // 附近的景點（跑步時用），依距離排序，附上導覽稿長度與音檔路徑
    if (u.pathname === '/api/nearby') {
      const [lat, lng] = (u.searchParams.get('ll') || '').split(',').map(Number);
      const rad = Number(u.searchParams.get('r')) || 400;
      if (!isFinite(lat) || !isFinite(lng)) return json(res, { error: 'll 格式要是 lat,lng' }, 400);
      const R = 6371000, toRad = x => x * Math.PI / 180;
      const d2 = l => {
        const dp = toRad(l.lat - lat), dl = toRad(l.lng - lng);
        const h = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(l.lat)) * Math.sin(dl / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
      };
      const hit = LANDMARKS.map(l => ({ ...l, d: d2(l) })).filter(l => l.d <= rad)
        .sort((a, b) => a.d - b.d).slice(0, 12)
        .map(l => {
          const a = AUDIDX[l.id] || {};
          return {
            ...l,
            audio: `/audio/${encodeURIComponent(l.city)}/${encodeURIComponent(l.id)}.mp3`,
            lines: a.lines || [], marks: a.marks || [],
            photos: (PHOTOS[l.id] || []).slice(0, 6).map(p => p.url).filter(Boolean),
          };
        });
      return json(res, { items: hit });
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
}).listen(PORT, () => console.log(`pano-runner  http://localhost:${PORT}`));
