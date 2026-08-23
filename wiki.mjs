// 維基百科的景點來源 —— 全世界通用，不需要金鑰。
//
// 2026-08-23 實測出來的三件事，順序不能換：
//
// 1. **座標一定要用英文維基找。** 同樣半徑 900 公尺，en 給 260 筆、zh 只給 81 筆，
//    而且**羅浮宮本人在 zh 維基沒有座標**（只找得到金字塔和地鐵站）。
// 2. **繁簡轉換只有一種寫法對。** 一般查詢會吐出「卡鲁塞尔凯旋门」；
//    加上 variant=zh-tw & converttitles=1 才會轉，而且轉成台灣用語 ——
//    它給「羅浮宮」並註明「中國大陸譯盧浮宮」。
//    REST API（/api/rest_v1/page/summary）只轉內文不轉標題，而且給「盧浮宮」。
// 3. **熱門度用瀏覽量。** 台北 101 是 23178 次、隔壁 Mozilla 辦公室 2207 次、
//    小學 0 次。字數與語言版本數都沒有這個準。
//
// 覆蓋率（半徑 1 公里、有中文條目且 60 天瀏覽量 > 300）：
//   巴黎 12、紐約 11、伊斯坦堡 7、東京 7、布拉格 3、清邁 3、台北 2、波爾圖 1
// 只有兩成到兩成五的條目有中文版，這是硬限制。

const UA = 'pano-runner/1.0 (personal virtual-running project)';
const nap = ms => new Promise(r => setTimeout(r, ms));
// 被限流之後要退多久。批次抓的時候可以調大（tools/warm-wiki.mjs 會設）。
export const tune = { retryMs: 3000, gapMs: 300 };
const api = async (host, params) => {
  const u = `https://${host}/w/api.php?` + new URLSearchParams(
    // formatversion 2：pages 是陣列（1 是以 pageid 為鍵的物件），
    // 而且 langlinks 的欄位是 title 不是 '*'
    { action: 'query', format: 'json', formatversion: '2', ...params }).toString();
  // 維基會限流。撞到就退一步再來 —— 一趟查詢要打三到四次 API，
  // 連著打很容易 429（實測第三個城市就中）。
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { await nap(2500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${host}`);
    return r.json();
  }
  throw new Error('429 ' + host);
};
// api() 只給 action=query 用；這個可以指定任意 action
const api2 = async (host, params) => {
  const u = `https://${host}/w/api.php?` + new URLSearchParams(
    { format: 'json', formatversion: '2', ...params }).toString();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const b = await r.text();
  if (!r.ok || /^\s*You are making too many requests/i.test(b)) throw new Error('限流');
  return JSON.parse(b);
};

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const views = o => Object.values(o || {}).reduce((a, b) => a + (b || 0), 0);
const haversine = (a1, o1, a2, o2) => {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dp = r(a2 - a1), dl = r(o2 - o1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// 百科體開頭要清掉才念得下去。原文長這樣：
//   「羅浮宮（法語：Palais du Louvre，發音：[palɛ dy luvʁ]，中國大陸譯盧浮宮）是一座位於…」
// 那一串括號念出來完全是噪音。
function clean(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/（[^（）]{0,120}?(語|文|發音|音標|縮寫|舊譯|又譯|大陸譯|IPA)[^（）]{0,120}?）/g, '');
  t = t.replace(/\([^()]{0,120}?(IPA|pronounced|lit\.)[^()]{0,120}?\)/gi, '');
  t = t.replace(/\[[^\]]{0,40}\]/g, '');          // [palɛ dy luvʁ]、註腳
  t = t.replace(/（\s*）|\(\s*\)/g, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/ ，/g, '，');
  return t.trim();
}
// 摘要的第一個詞就是繁體名稱（「羅浮宮是一座位於…」）。
// zh 維基回傳的 title 仍然是簡體 —— converttitles 只轉**輸入**不轉輸出。
// 要切在「是／為／位於」之前，不然會抓成整句
//（實測拿到「羅浮宮博物館是位於法國巴黎的國立藝術博物」）。
// 名字裡出現數字、度數符號、拉丁或希臘字母，或超過 14 個字，就是沒切乾淨。
// 實測失手的例子：「41.029°N 28.」（那篇摘要開頭是座標）、
// 「伊斯坦堡大學土耳其伊斯坦」、「蒙古聖瑪利亞教堂或 Πα」。
export const looksBad = n => !n || n.length > 14 || /[0-9°A-Za-z\u0370-\u03ff]/.test(n);

// 從摘要切不出來時的正解：問維基要「顯示標題」。
// action=parse 才有繁體（action=query 的 displaytitle 不吃 variant，實測過），
// 但一次只能問一頁 —— 所以只在切壞的時候才用，一格通常一到三次。
export async function displayTitle(title) {
  try {
    const j = await api2('zh.wikipedia.org',
      { action: 'parse', prop: 'displaytitle', variant: 'zh-tw', page: title });
    const html = j.parse?.displaytitle || '';
    const t = html.replace(/<[^>]+>/g, '').trim();
    return t || title;
  } catch { return title; }
}

export function nameFrom(extract, fallback) {
  const t = (extract || '').trim();
  // 切在第一個「結構詞」之前。順序有意義：又名/又稱要先切，
  // 不然「少女塔又名勒安得耳塔」會整串被當成名字（實測伊斯坦堡就是這樣）。
  // 「或」「以往」也要切 —— 實測跑出「新清真寺或蘇丹皇太后清真寺」
  // 與「艾米諾努以往」（原文是「艾米諾努（土耳其語…）以往是…」，
  // 括號被清掉之後就黏在一起了）。
  const m = /^(.{2,16}?)(?=又名|又稱|亦稱|舊稱|通稱|簡稱|或稱|或|以往|過去|曾是|曾經|現為|是一|是位|是個|是[^，。]{0,10}的|是|為一|為位|為|係|位於|坐落|建於|，|。|、|（|\()/.exec(t);
  let n = m && m[1].trim();
  // 完全切不出來（沒有任何結構詞）就取前 12 個字，總比整段當標題好
  if (!n || n.length < 2) n = t.slice(0, 12).replace(/[，。].*$/, '');
  return n.length >= 2 ? n : fallback;
}

// 只留「地點」。瀏覽量擋不掉非地點的條目 —— 實測羅浮宮旁邊排第一的是
// 「法蘭西第一帝國」（91816 次），銀座旁邊有「文部科學省」「日本電視放送網」。
// 靠 Wikidata 的 P31（instance of）過濾，用英文標籤比對關鍵字。
const PLACE = new RegExp([
  'building', 'museum', 'church', 'cathedral', 'basilica', 'chapel', 'abbey', 'monastery',
  'temple', 'shrine', 'mosque', 'synagogue', 'palace', 'castle', 'fort', 'citadel',
  'park', 'garden', 'square', 'plaza', 'bridge', 'tower', 'monument', 'memorial',
  'statue', 'fountain', 'obelisk', 'arch', 'gate', 'wall', 'theatre', 'theater',
  'opera', 'stadium', 'arena', 'library', 'market', 'hall', 'pavilion', 'gallery',
  'observatory', 'lighthouse', 'pier', 'harbou?r', 'port', 'beach', 'island',
  'mountain', 'hill', 'lake', 'river', 'canal', 'cemetery', 'tomb', 'mausoleum',
  'ruins', 'archaeological', 'attraction', 'zoo', 'aquarium', 'skyscraper',
  // 'house' 不能單獨放 —— 路易威登的 P31 是 fashion house，會被誤中
  'department store', 'shopping mall', 'shopping cent', 'mall', 'hotel', 'villa', 'mansion',
  'street', 'avenue', 'boulevard', 'district', 'quarter', 'neighborhood', 'campus',
  'university', 'cafe', 'restaurant', 'station', 'structure', 'landmark', 'site',
].join('|'), 'i');

// 一次問 50 個條目的 Wikidata 編號與 P31，再一次問那些 P31 的英文標籤
async function placeFilter(titles) {
  const keep = new Set();
  for (const part of chunk(titles, 50)) {
    const pp = await api('en.wikipedia.org', { prop: 'pageprops', ppprop: 'wikibase_item',
                                               titles: part.join('|') });
    const qidOf = new Map();
    for (const p of pp.query?.pages || []) {
      const q = p.pageprops?.wikibase_item;
      if (q) qidOf.set(p.title, q);
    }
    if (!qidOf.size) continue;
    await nap(tune.gapMs);
    const ent = await fetch('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json'
      + '&props=claims&ids=' + [...qidOf.values()].join('|'),
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
    const cls = new Map();                        // 條目 → 它的 P31 清單
    const all = new Set();
    for (const [title, q] of qidOf) {
      const c = (ent.entities?.[q]?.claims?.P31 || [])
        .map(x => x.mainsnak?.datavalue?.value?.id).filter(Boolean);
      cls.set(title, c); c.forEach(x => all.add(x));
    }
    if (!all.size) continue;
    await nap(tune.gapMs);
    const labels = {};
    for (const qs of chunk([...all], 50)) {
      const lb = await fetch('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json'
        + '&props=labels&languages=en&ids=' + qs.join('|'),
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
      for (const [q, e] of Object.entries(lb.entities || {}))
        labels[q] = e.labels?.en?.value || '';
      await nap(tune.gapMs);
    }
    for (const [title, c] of cls)
      if (c.some(q => PLACE.test(labels[q] || ''))) keep.add(title);
  }
  return keep;
}
// OpenStreetMap 的實體地標。維基的 geosearch 會漏 —— 漏的原因是條目本身
// 沒有掛座標（羅浮宮就是這樣，只找得到金字塔和地鐵站），而 OSM 是照著
// 地面上真的有的東西畫的，不會漏。
// 實測伊斯坦堡 1.2 公里：OSM 找到 344 個物件、134 個帶 Wikidata 編號，
// 其中 36 個有中文維基條目 —— geosearch 同一格只找到 11 個。
async function osmSpots(lat, lng, radius) {
  const qy = `[out:json][timeout:40];(
    nwr(around:${radius},${lat},${lng})[tourism~"^(attraction|museum|artwork|viewpoint|gallery)$"];
    nwr(around:${radius},${lat},${lng})[historic];
    nwr(around:${radius},${lat},${lng})[amenity~"^(place_of_worship|theatre|fountain)$"];
  );out center tags 400;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
    body: qy, signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
  const els = (await r.json()).elements || [];
  const out = [];
  for (const e of els) {
    const q = e.tags?.wikidata;
    if (!q || !/^Q\d+$/.test(q)) continue;
    const la = e.lat ?? e.center?.lat, ln = e.lon ?? e.center?.lon;
    if (la == null || ln == null) continue;
    out.push({ qid: q, lat: la, lng: ln });
  }
  // 同一個 Wikidata 編號可能有好幾個物件（建築外框＋出入口）
  const seen = new Map();
  for (const o of out) if (!seen.has(o.qid)) seen.set(o.qid, o);
  return [...seen.values()];
}

// Wikidata 編號 → 中英文條目名稱
async function qidTitles(qids) {
  const map = new Map();
  for (const part of chunk(qids, 50)) {
    const r = await fetch('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json'
      + '&props=sitelinks&sitefilter=zhwiki|enwiki&ids=' + part.join('|'),
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    for (const [q, e] of Object.entries(j.entities || {})) {
      const zh = e.sitelinks?.zhwiki?.title, en = e.sitelinks?.enwiki?.title;
      if (zh && en) map.set(q, { zh, en });
    }
    await nap(tune.gapMs);
  }
  return map;
}

// 逐句切開當字幕用
const sentences = t => (t.match(/[^。！？!?]+[。！？!?]?/g) || []).map(s => s.trim()).filter(s => s.length > 1);

export async function wikiNearby(lat, lng, {
  radius = 1200, minViews = 250, limit = 12, minChars = 60,
} = {}) {
  // 1. 英文維基找座標
  const g = await api('en.wikipedia.org', {
    list: 'geosearch', gscoord: `${lat}|${lng}`, gsradius: String(Math.min(10000, radius)),
    gslimit: '300',
  });
  const spots = (g.query?.geosearch || []);
  const byTitle = new Map(spots.map(s => [s.title, s]));

  // 1b. OSM 補上 geosearch 漏掉的。失敗就算了 —— Overpass 有時候很慢或滿載，
  //     不能因為它掛掉就整個沒有景點。
  try {
    await nap(tune.gapMs);
    const os = await osmSpots(lat, lng, Math.min(2000, radius));
    if (os.length) {
      const t = await qidTitles(os.map(o => o.qid));
      for (const o of os) {
        const n = t.get(o.qid);
        if (!n || byTitle.has(n.en)) continue;
        byTitle.set(n.en, { title: n.en, lat: o.lat, lon: o.lng,
                            dist: haversine(lat, lng, o.lat, o.lng) });
      }
    }
  } catch (e) { /* Overpass 掛了就只用 geosearch */ }

  const allSpots = [...byTitle.values()];
  if (!allSpots.length) return [];

  // 2. 中文條目名稱＋熱門度（一次 50 個）
  const cand = [];
  for (const part of chunk(allSpots.slice(0, 200), 50)) {
    await nap(tune.gapMs);
    const j = await api('en.wikipedia.org', {
      prop: 'langlinks|pageviews', lllang: 'zh', lllimit: '500',
      pvipdays: '60', titles: part.map(s => s.title).join('|'),
    });
    for (const p of j.query?.pages || []) {
      const zh = (p.langlinks || [])[0]?.title;
      const pv = views(p.pageviews);
      const s = byTitle.get(p.title);
      if (!zh || !s) continue;
      if (pv < minViews) continue;
      cand.push({ zh, en: p.title, pv, lat: s.lat, lng: s.lon, dist: s.dist });
    }
  }
  if (!cand.length) return [];
  cand.sort((a, b) => b.pv - a.pv);
  await nap(tune.gapMs);
  // 先砍掉非地點，再取前幾名
  const ok = await placeFilter(cand.slice(0, limit * 2).map(c => c.en));
  const top = cand.filter(c => ok.has(c.en)).slice(0, limit * 2);
  if (!top.length) return [];

  // 3. 繁中摘要與照片
  const out = [];
  for (const part of chunk(top, 20)) {
    const j = await api('zh.wikipedia.org', {
      variant: 'zh-tw', converttitles: '1',
      prop: 'extracts|pageimages', exintro: '1', explaintext: '1',
      piprop: 'thumbnail|original', pithumbsize: '1200',
      titles: part.map(c => c.zh).join('|'),
    });
    await nap(tune.gapMs);
    const meta = new Map((j.query?.pages || []).map(p => [p.title, p]));
    for (const c of part) {
      // 回傳的 title 可能被正規化過，找不到就用順序對
      const p = meta.get(c.zh) || (j.query?.pages || []).find(x => x.pageid && !x.__used);
      if (!p) continue;
      p.__used = true;
      const body = clean(p.extract);
      if (body.length < minChars) continue;
      let name = nameFrom(body, c.zh);
      if (looksBad(name)) { await nap(tune.gapMs); name = await displayTitle(c.zh); }
      // P31 擋不掉的兩類：有座標的「事件」（實測布拉格跑出「2023年12月21日」，
      // 那是校園槍擊案）與行政區劃（「大巴黎都會區」）。用名稱擋掉。
      if (/^\d|事件|槍擊|襲擊|攻擊|爆炸|暴動|戰役|地震|空難|大火|疫情/.test(name)) continue;
      if (/都會區|都市圈|自治市|行政區$|地區$|縣$|州$|省$|大區$/.test(name)) continue;
      const photos = [];
      if (p.thumbnail?.source) photos.push(p.thumbnail.source);
      out.push({
        id: 'wiki:' + c.en.replace(/\s+/g, '_'),
        name, city: '', cat: 'wiki', src: 'wiki',
        lat: c.lat, lng: c.lng, dist: c.dist, views: c.pv,
        len: body.length,
        script: body,
        lines: sentences(body),
        marks: [],                      // 沒有音檔，時間軸由畫面端用語音合成產生
        photos,
      });
    }
  }
  return out.slice(0, limit);
}
