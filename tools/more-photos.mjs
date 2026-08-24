// 幫已經抓下來的景點補照片。
//
// 早期抓的只有維基條目的主圖一張 —— 播報兩三分鐘只看一張太單調。
// prop=images 可以拿到條目裡用到的所有圖片，這支就是回頭把它們補上。
// 新抓的城市已經內建，不需要跑這支。
//
//   node tools/more-photos.mjs          全部補
//   node tools/more-photos.mjs 3        只補照片少於 3 張的
//
// 中途中斷可以直接再跑，補過的會跳過。

import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moreImages, zhTitleOf, tune, throttleState } from '../wiki.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WIKI = join(HERE, '..', '.wikicache');
const PHOTO = join(HERE, '..', '.photocache');
const UA = 'pano-runner/1.0 (personal virtual-running project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
tune.gapMs = 700;
tune.retryMs = 6000;

const want = Number(process.argv[2]) || 3;
const files = (await readdir(WIKI)).filter(f => f.endsWith('.json'));
console.log(`  ${files.length} 格，補照片少於 ${want} 張的景點`);

let added = 0, touched = 0;
for (const [i, f] of files.entries()) {
  const path = join(WIKI, f);
  let o;
  try { o = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
  const need = (o.items || []).filter(x => (x.photos || []).length < want);
  if (!need.length) continue;
  // id 有兩種：新的是 wiki:<中文標題編碼>，早期的是 wiki:<英文標題>
  //（wiki:Great_Palace_of_Constantinople）。拿英文的去問中文維基一定查不到 ——
  // 伊斯坦堡、維也納、巴塞隆納、布拉格全是早期抓的，整批都補不到照片。
  const raw = need.map(x => {
    try { return decodeURIComponent(String(x.id).replace(/^wiki:/, '')); }
    catch { return x.name; }
  });
  const isEn = t => !/[\u4e00-\u9fff]/.test(t);
  const enOnes = [...new Set(raw.filter(isEn).map(t => t.replace(/_/g, ' ')))];
  let en2zh = new Map();
  if (enOnes.length) { try { en2zh = await zhTitleOf(enOnes); } catch {} }
  const titles = raw.map((t, k) =>
    isEn(t) ? (en2zh.get(t.replace(/_/g, ' ')) || need[k].name) : t);
  let got = null;
  for (let t = 0; t < 3 && !got; t++) {
    try { got = await moreImages(titles, 6); }
    catch (e) { await sleep(15000 * (t + 1)); }
  }
  if (!got) { console.log(`\n  ${f} 三次都失敗，跳過`); continue; }
  // 中文條目的圖常常只有一兩張，不夠就去英文版補
  const thinEn = [...new Set(raw.filter((t, k) => isEn(t) && (got.get(titles[k]) || []).length < want)
                                .map(t => t.replace(/_/g, ' ')))];
  if (thinEn.length) {
    try {
      const more = await moreImages(thinEn, 6, 'en.wikipedia.org');
      raw.forEach((t, k) => {
        if (!isEn(t)) return;
        const ex = more.get(t.replace(/_/g, ' ')) || [];
        if (ex.length) got.set(titles[k], (got.get(titles[k]) || []).concat(ex));
      });
    } catch {}
  }
  let dirty = false;
  const base = u => (u || '').split('/').pop().replace(/^\d+px-/, '').split('?')[0];
  for (const [k, x] of need.entries()) {
    const list = got.get(titles[k]) || [];
    const before = (x.photos || []).length;
    for (const u of list) {
      if ((x.photos || []).length >= 6) break;
      if (!x.photos) x.photos = [];
      if (!x.photos.some(p => base(p) === base(u))) { x.photos.push(u); added++; dirty = true; }
    }
    if ((x.photos || []).length > before) touched++;
  }
  if (dirty) await writeFile(path, JSON.stringify(o));
  const t = throttleState();
  process.stdout.write(`\r  ${i + 1}/${files.length}　補了 ${added} 張給 ${touched} 個景點`
    + `　間隔 ${t.gap}ms　限流 ${t.hits} 次   `);
}
console.log();

// 把新增的照片抓回本機
await mkdir(PHOTO, { recursive: true });
const keyOf = u => join(PHOTO, Buffer.from(u).toString('base64url').slice(-120) + '.jpg');
const all = new Set();
for (const f of files) {
  try { for (const x of JSON.parse(await readFile(join(WIKI, f), 'utf8')).items || [])
    (x.photos || []).forEach(u => all.add(u)); } catch {}
}
let dl = 0, had = 0, bad = 0, bytes = 0, n = 0;
for (const u of all) {
  n++;
  try { await access(keyOf(u)); had++; continue; } catch {}
  let ok = false;
  for (let t = 0; t < 3 && !ok; t++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow',
                                 signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(3000 * (t + 1)); continue; }
      if (!r.ok) break;
      const b = Buffer.from(await r.arrayBuffer());
      await writeFile(keyOf(u), b); bytes += b.length; dl++; ok = true;
    } catch { await sleep(1500); }
  }
  if (!ok) bad++;
  await sleep(600);
  if (n % 10 === 0 || n === all.size)
    process.stdout.write(`\r  照片 ${n}/${all.size}　新抓 ${dl}　已有 ${had}　失敗 ${bad}`
      + `　${(bytes / 1048576).toFixed(1)} MB   `);
}
console.log(`\n\n  完成：補了 ${added} 張給 ${touched} 個景點，下載 ${dl} 張、${(bytes / 1048576).toFixed(1)} MB`);
