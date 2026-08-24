// 把一個地區的維基景點（含照片）整批抓到本機。
//
//   node tools/warm-wiki.mjs 伊斯坦堡 41.0082 28.9784 3
//   node tools/warm-wiki.mjs 里斯本   38.7139 -9.1334 2.5
//                            名稱      緯度     經度    半徑(公里)
//
// 為什麼一定要慢慢抓：維基查一格要打六到八次 API，連著查一定被擋 ——
// 而且**被擋時不是回 429，是回 200 配一段純文字**
// 「You are making too many requests to the API.」，直接 JSON.parse 會炸。
// 實測九格連續查有六格失敗；每格之間停三秒之後就穩了。
//
// 抓下來的東西：
//   .wikicache/<格子>.json   景點資料（名稱、座標、繁中導覽稿、照片網址）
//   .photocache/<雜湊>.jpg   照片本身
// 兩份都是跑步時直接讀的，抓完之後那一區完全不需要連外。

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wikiNearby, fetchPhoto, photoState, tune } from '../wiki.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WIKI = join(HERE, '..', '.wikicache');
const PHOTO = join(HERE, '..', '.photocache');
const UA = 'pano-runner/1.0 (personal virtual-running project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 批次抓的時候不趕時間，退避調大一點，成功率換速度
tune.retryMs = 5000;
tune.gapMs = 400;

const [name, latS, lngS, kmS] = process.argv.slice(2);
if (!name || !latS || !lngS) {
  console.log('  用法：node tools/warm-wiki.mjs <名稱> <緯度> <經度> [半徑公里，預設 2]');
  console.log('  例：  node tools/warm-wiki.mjs 伊斯坦堡 41.0082 28.9784 3');
  process.exit(1);
}
const lat0 = +latS, lng0 = +lngS, km = +(kmS || 2);

// 格子跟伺服器用同一套（1/90 度，約 1.1 公里）
const STEP = 1 / 90;
const nLat = Math.ceil(km / 1.11);
const nLng = Math.ceil(km / (1.11 * Math.cos(lat0 * Math.PI / 180)));
const cells = [];
for (let i = -nLat; i <= nLat; i++)
  for (let j = -nLng; j <= nLng; j++)
    cells.push([lat0 + i * STEP, lng0 + j * STEP]);
const key = (la, ln) => `${Math.round(la * 90)}_${Math.round(ln * 90)}`;

console.log(`  ${name}：半徑 ${km} 公里 → ${cells.length} 格`);

await mkdir(WIKI, { recursive: true });
await mkdir(PHOTO, { recursive: true });

const all = new Map();                       // id → 景點
let done = 0, cached = 0, failed = [];
for (const [la, ln] of cells) {
  const k = key(la, ln);
  const f = join(WIKI, k + '.json');
  let items = null;
  try {
    const o = JSON.parse(await readFile(f, 'utf8'));
    if (Date.now() - o.at < 30 * 86400e3) { items = o.items; cached++; }
  } catch {}
  if (!items) {
    try {
      items = await wikiNearby(Math.round(la * 90) / 90, Math.round(ln * 90) / 90,
                               { radius: 1200, limit: 14 });
      await writeFile(f, JSON.stringify({ at: Date.now(), items }));
      done++;
    } catch (e) { failed.push([k, la, ln, String(e.message || e)]); items = []; }
    await sleep(800);   // SPARQL 一格只打一到三次 API，不用停那麼久
  }
  for (const it of items) all.set(it.id, it);
  process.stdout.write(`\r  格子 ${done + cached + failed.length}/${cells.length}　`
    + `新抓 ${done}　已有 ${cached}　失敗 ${failed.length}　景點 ${all.size}   `);
}
console.log();

// 失敗的重來一輪，退更久
if (failed.length) {
  console.log(`  重試 ${failed.length} 格…`);
  const again = failed; failed = [];
  for (const [k, la, ln] of again) {
    await sleep(8000);
    try {
      const items = await wikiNearby(Math.round(la * 90) / 90, Math.round(ln * 90) / 90,
                                     { radius: 1200, limit: 14 });
      await writeFile(join(WIKI, k + '.json'), JSON.stringify({ at: Date.now(), items }));
      for (const it of items) all.set(it.id, it);
      done++;
    } catch (e) { failed.push([k, la, ln, String(e.message || e)]); }
    process.stdout.write(`\r  重試中　成功 ${done}　仍失敗 ${failed.length}　景點 ${all.size}   `);
  }
  console.log();
}

// 照片抓回本機
const keyOf = u => join(PHOTO, Buffer.from(u).toString('base64url').slice(-120) + '.jpg');
const urls = [...new Set([...all.values()].flatMap(x => x.photos || []))];
let got = 0, had = 0, bad = 0, bytes = 0;
for (const u of urls) {
  const f = keyOf(u);
  try { await access(f); had++; continue; } catch {}
  const b = await fetchPhoto(u);
  if (b) { await writeFile(f, b); bytes += b.length; got++; } else bad++;
  const p = photoState();
  process.stdout.write(`\r  照片 ${got + had + bad}/${urls.length}　新抓 ${got}　已有 ${had}`
    + `　失敗 ${bad}　${(bytes / 1048576).toFixed(1)} MB　間隔 ${p.gap}ms   `);
}
console.log(`\n\n  ${name} 完成`);
console.log(`  景點 ${all.size} 個、照片 ${got + had} 張、${(bytes / 1048576).toFixed(1)} MB`);
if (failed.length) console.log(`  ⚠ ${failed.length} 格還是失敗，過一陣子再跑一次就會補上`);
console.log('\n  抓到的景點：');
for (const x of [...all.values()].sort((a, b) => b.views - a.views).slice(0, 20))
  console.log(`    ${String(x.views).padStart(7)} 次　${x.name}`);
