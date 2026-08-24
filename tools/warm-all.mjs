// 照著 tools/cities.txt 一個接一個抓。整夜跑用的。
//
//   node tools/warm-all.mjs            全部
//   node tools/warm-all.mjs 10         只跑前十個
//
// 每個城市之間停一分鐘讓維基的額度回來。中途中斷可以直接再跑一次 ——
// 已經抓過的格子會跳過，只補沒抓到的。
// 結果記到 tools/warm-all.log，隨時可以看進度。

import { spawn } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOG = join(HERE, 'warm-all.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

const lines = (await readFile(join(HERE, 'cities.txt'), 'utf8')).split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const limit = Number(process.argv[2]) || lines.length;
const jobs = lines.slice(0, limit).map(l => l.split(/\s+/));

// 數這個城市範圍內的快取
async function countCells(lat, lng, km) {
  const STEP = 1 / 90, la0 = +lat, ln0 = +lng, r = +km;
  const nLat = Math.ceil(r / 1.11);
  const nLng = Math.ceil(r / (1.11 * Math.cos(la0 * Math.PI / 180)));
  const ids = new Set(); let cells = 0, empty = 0;
  for (let i = -nLat; i <= nLat; i++) for (let j = -nLng; j <= nLng; j++) {
    const k = `${Math.round((la0 + i * STEP) * 90)}_${Math.round((ln0 + j * STEP) * 90)}`;
    try {
      const o = JSON.parse(await readFile(join(HERE, '..', '.wikicache', k + '.json'), 'utf8'));
      cells++; if (!(o.items || []).length) empty++;
      for (const it of o.items || []) ids.add(it.id);
    } catch {}
  }
  return { spots: ids.size, cells, empty };
}

const note = async t => { console.log(t); await appendFile(LOG, t + '\n').catch(() => {}); };
await note(`\n===== ${new Date().toLocaleString('zh-TW')} 開始，共 ${jobs.length} 個城市 =====`);

for (const [i, [name, lat, lng, km]] of jobs.entries()) {
  const t0 = Date.now();
  await note(`\n[${i + 1}/${jobs.length}] ${stamp()} ${name} 開始`);
  const out = await new Promise(res => {
    const p = spawn('node', [join(HERE, 'warm-wiki.mjs'), name, lat, lng, km || '2'],
                    { cwd: join(HERE, '..') });
    let buf = '';
    p.stdout.on('data', d => { buf += d.toString(); });
    p.stderr.on('data', d => { buf += d.toString(); });
    p.on('close', () => res(buf));
    // 單一城市最多四十分鐘，卡住就跳過
    setTimeout(() => { try { p.kill(); } catch {} }, 40 * 60e3);
  });
  // 直接從快取數，不要去解析子程序的輸出 —— 先前用正規表示式對輸出，
  // 對不上就一律報 0，害整夜看起來全部失敗，其實快取裡是有東西的。
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const n = await countCells(lat, lng, km || '2');
  await note(`  ${stamp()} ${name}：景點 ${n.spots} 個（${n.cells} 格，空的 ${n.empty} 格）、${mins} 分`);
  if (i < jobs.length - 1) await sleep(60000);
}
await note(`\n===== ${new Date().toLocaleString('zh-TW')} 全部結束 =====`);
