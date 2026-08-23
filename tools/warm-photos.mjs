// 把某個城市的景點照片先抓到本機快取。
//
// landmark-photos.json 存的是維基共享資源的**網址**，圖片檔不在本機
// （音檔則有 data/audio/ 那一份，所以音檔一播就出來）。
// 先抓好之後 /photo 直接讀 .photocache，跑步時是瞬間顯示。
//
//   node tools/warm-photos.mjs            ← 列出各城市的張數
//   node tools/warm-photos.mjs 巴黎
//
// 為什麼要繞一圈問 API：
//   commons.wikimedia.org/Special:FilePath/<檔名> 會 302 轉址而且限流很兇
//   —— 實測單一連線每兩秒一次就有 2/5 回 429。
//   直連 upload.wikimedia.org 的縮圖快很多，但網址不能自己用 md5 算：
//   寬度必須是維基的標準級距，算出來的 1200px 一律回 400。
//   所以先用 API 問到 thumburl（一次可以問 50 個），再去 upload 抓。
//
// 已經抓過的會跳過，可以隨時中斷再跑。

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DATA = join(HERE, '..', '..', 'run-world', 'data');
const CACHE = join(HERE, '..', '.photocache');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PER = 4, WIDTH = 1280;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const photos = JSON.parse(await readFile(join(DATA, 'landmark-photos.json'), 'utf8'));
const marks = JSON.parse(await readFile(join(DATA, 'landmarks-extra.json'), 'utf8'));
const city = new Map(marks.map(l => [l.id, l.city || '?']));

const want = process.argv[2];
if (!want) {
  const n = new Map();
  for (const [id, ps] of Object.entries(photos)) {
    const c = city.get(id) || '（不在景點清單）';
    n.set(c, (n.get(c) || 0) + Math.min(ps.length, PER));
  }
  console.log('  城市            張數     約略大小');
  for (const [c, v] of [...n].sort((a, b) => b[1] - a[1]))
    console.log(`  ${c.padEnd(14)} ${String(v).padStart(5)}   ${(v * 0.22).toFixed(0)} MB`);
  console.log('\n  用法：node tools/warm-photos.mjs 巴黎');
  process.exit(0);
}

// 這個城市要抓的原始網址（跟 /api/nearby 給畫面端的那幾張一致）
const srcs = [];
for (const [id, ps] of Object.entries(photos)) {
  if ((city.get(id) || '') !== want) continue;
  for (const p of ps.slice(0, PER)) {
    const u = (p.url || '').replace(/width=\d+/, 'width=1200');
    if (u) srcs.push(u);
  }
}
if (!srcs.length) { console.log(`  ${want} 沒有照片。先跑一次不帶參數看有哪些城市。`); process.exit(1); }

await mkdir(CACHE, { recursive: true });
const keyOf = u => join(CACHE, Buffer.from(u).toString('base64url').slice(-120) + '.jpg');

// 還沒抓過的才需要問 API
const todo = [];
for (const u of srcs) { try { await access(keyOf(u)); } catch { todo.push(u); } }
console.log(`  ${want}：共 ${srcs.length} 張，已有 ${srcs.length - todo.length} 張，要抓 ${todo.length} 張`);
if (!todo.length) process.exit(0);

// 一次問 50 個檔名的縮圖網址
// 少數網址不是 Special:FilePath 的形式（直接指向 upload 或別的來源）。
// 先前這裡直接取 [1] 會炸掉整支程式 —— 問 API 時有濾掉，下載時忘了。
const nameOf = u => (u && u.includes('Special:FilePath/'))
  ? decodeURIComponent(u.split('Special:FilePath/')[1].split('?')[0]) : '';
const thumb = new Map();
for (let i = 0; i < todo.length; i += 50) {
  const batch = todo.slice(i, i + 50).filter(u => u.includes('Special:FilePath/'));
  if (!batch.length) continue;
  const titles = batch.map(u => 'File:' + nameOf(u)).join('|');
  try {
    const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
      + `&prop=imageinfo&iiprop=url&iiurlwidth=${WIDTH}&titles=` + encodeURIComponent(titles);
    const j = await (await fetch(api, { headers: { 'User-Agent': UA },
                                        signal: AbortSignal.timeout(25000) })).json();
    // 回傳用的是正規化後的標題，要靠 normalized 對回原本的字串
    const norm = new Map((j?.query?.normalized || []).map(n => [n.to, n.from]));
    for (const pg of Object.values(j?.query?.pages || {})) {
      const url = pg?.imageinfo?.[0]?.thumburl || pg?.imageinfo?.[0]?.url;
      if (!url) continue;
      const title = norm.get(pg.title) || pg.title;
      thumb.set(title.replace(/^File:/, ''), url);
    }
  } catch {}
  process.stdout.write(`\r  問縮圖網址 ${Math.min(i + 50, todo.length)}/${todo.length}   `);
  await sleep(1200);                       // API 也有節流，批次之間停一下
}
console.log(`\r  問到 ${thumb.size}/${todo.length} 個縮圖網址        `);

let done = 0, fail = 0, bytes = 0, n = 0;
const t0 = Date.now();
const queue = todo.slice();
// **單線，而且每張之間停一下。**
// 一開始用 3 條併發，結果 220 張裡失敗 166 張（75%），而維基的 API 直接回
// 「You are making too many requests to the API」—— 是併發打太兇被整個節流，
// 不是被封（同一時間單獨抓一張是 200，額度標頭也顯示幾乎沒用掉）。
// 358 張以每秒一張算約六分鐘，本來就不趕。
const worker = async () => {
  while (queue.length) {
    const src = queue.shift();
    const url = thumb.get(nameOf(src)) || src;
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow',
                                     signal: AbortSignal.timeout(30000) });
        // 429 要退得夠久。節流是整體的，急著重試只會把自己壓得更死。
        if (r.status === 429) { await sleep(3000 * (t + 1)); continue; }
        if (!r.ok) break;
        const b = Buffer.from(await r.arrayBuffer());
        await writeFile(keyOf(src), b);
        bytes += b.length; done++; ok = true;
      } catch { await sleep(1200); }
    }
    if (!ok) fail++;
    n++;
    await sleep(700);                      // 客氣一點，這是別人的免費資源
    if (n % 10 === 0 || !queue.length) {
      const sec = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${n}/${todo.length}　成功 ${done}　失敗 ${fail}　`
        + `${(bytes / 1048576).toFixed(0)} MB　${Math.round(sec)} 秒　`
        + `剩約 ${Math.round(sec / n * (todo.length - n) / 60)} 分   `);
    }
  }
};
await worker();
console.log(`\n  ${want} 完成：成功 ${done}、失敗 ${fail}、`
  + `${(bytes / 1048576).toFixed(0)} MB、${Math.round((Date.now() - t0) / 1000)} 秒`);
