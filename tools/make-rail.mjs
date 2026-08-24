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
// 步道採集常有分岔，傻走 links[0] 會走進死巷（伏見稻荷實測只抓到 5 顆）。
// 改成：先把整個「同年代連結圖」爬下來，再取圖上的最長路徑。
const adj = new Map(), seen = new Set([pano]);
let frontier = [pano];
while (frontier.length && seen.size < 500) {
  const next = [];
  for (const id of frontier) {
    const m = await meta(id);
    if (m.error || !m.date || m.date.join('/') !== era) { seen.delete(id); continue; }
    const nbrs = m.links.map(l => l.id);
    adj.set(id, nbrs);
    for (const n of nbrs) if (!seen.has(n)) { seen.add(n); next.push(n); }
    await new Promise(r => setTimeout(r, 120));
  }
  frontier = next;
  process.stdout.write(`\r  爬圖中 ${adj.size} 顆…`);
}
console.log(`\r  同年代連結圖共 ${adj.size} 顆`);
// 圖上最長路徑：從任一點 BFS 找最遠點 A，再從 A BFS 找最遠點 B，取 A→B 路徑
// （樹狀圖是精確解，步道圖幾乎都是樹）
const bfs = (src) => {
  const prev = new Map([[src, null]]);
  let q = [src], last = src;
  while (q.length) {
    const nq = [];
    for (const u of q) for (const v of (adj.get(u) || []))
      if (adj.has(v) && !prev.has(v)) { prev.set(v, u); nq.push(v); last = v; }
    q = nq;
  }
  return { last, prev };
};
const a1 = bfs(pano).last;
const { last: b1, prev } = bfs(a1);
const rail = [];
for (let v = b1; v != null; v = prev.get(v)) rail.push(v);
console.log(`  最長路徑 ${rail.length} 顆（${a1.slice(0,8)}… → ${b1.slice(0,8)}…）`);
let all = {};
try { all = JSON.parse(await readFile('public/rails.json', 'utf8')); } catch {}
all[name] = { era, ids: rail };
await writeFile('public/rails.json', JSON.stringify(all));
console.log(`  存進 public/rails.json 的「${name}」`);
