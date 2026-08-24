// 把「同一年代的連結鏈」從起點走出來，存成軌道（pano id 順序）。
// 驗證過的櫻花路線用軌道跑 —— 這一帶常有兩條不同年代的採集交錯勾連，
// 跑步時靠方位選路一定會被接到沒花的那條（實測造幣局 2012/4 與 2015/3 互跳）。
//   node tools/make-rail.mjs <起點pano> <名稱>
import { writeFile, readFile } from 'node:fs/promises';
const [pano, name] = process.argv.slice(2);
if (!pano || !name) { console.log('用法：node tools/make-rail.mjs <pano> <名稱>'); process.exit(1); }
const meta = async id => (await (await fetch('http://localhost:8877/api/meta?pano=' + encodeURIComponent(id))).json());
const m0 = await meta(pano);
const era = m0.date.join('/');
console.log(`  起點年代 ${era}`);
// 兩個方向都走到底，接起來
const walk = async (start, firstLink) => {
  const ids = [], seen = new Set([start]);
  let cur = firstLink;
  for (let i = 0; i < 200 && cur; i++) {
    const m = await meta(cur);
    if (m.error || !m.date || m.date.join('/') !== era) break;   // 出年代就停
    ids.push(cur); seen.add(cur);
    const next = m.links.filter(l => !seen.has(l.id));
    cur = next.length ? next[0].id : null;
    await new Promise(r => setTimeout(r, 120));
  }
  return ids;
};
const dirs = m0.links.map(l => l.id);
const a = dirs[0] ? await walk(pano, dirs[0]) : [];
const b = dirs[1] ? await walk(pano, dirs[1]) : [];
// b 反轉 + 起點 + a ＝ 完整走廊
const rail = [...b.reverse(), pano, ...a];
console.log(`  軌道 ${rail.length} 顆（往一邊 ${a.length}、另一邊 ${b.length}）`);
let all = {};
try { all = JSON.parse(await readFile('public/rails.json', 'utf8')); } catch {}
all[name] = { era, ids: rail };
await writeFile('public/rails.json', JSON.stringify(all));
console.log(`  存進 public/rails.json 的「${name}」`);
