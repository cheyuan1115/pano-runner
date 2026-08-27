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

// UA 帶聯絡方式是 Wikidata 的使用政策 —— 匿名重度使用會被封好幾小時
// (2026-08-25 整夜實測:柏林愛丁堡整批 0 結果,早上自動解封)。
// Wikimedia 要求 UA 帶聯絡方式(匿名重用量會被封,親身踩過)。
// 開源版:請在環境變數填你自己的 email。
const UA = `pano-runner/1.0 (personal virtual-running; contact: ${process.env.PANO_CONTACT || 'set-PANO_CONTACT-env@example.com'})`;
const nap = ms => new Promise(r => setTimeout(r, ms));
// 被限流之後要退多久。批次抓的時候可以調大（tools/warm-wiki.mjs 會設）。
export const tune = { retryMs: 3000, gapMs: 300 };

// **全域節流。** 所有維基呼叫（不管哪一支工具、哪一個端點）共用一個間隔 ——
// 先前每支工具各自控速，同時跑兩支就互相打架，一整晚都在撞限流。
// 撞到就把間隔加倍，順利就慢慢放鬆，讓它自己找到維基能接受的速度。
const T = { gap: 900, min: 700, max: 20000, last: 0, hits: 0, calls: 0 };
export const throttleState = () => ({ ...T });
async function gate() {
  const wait = T.last + T.gap - Date.now();
  if (wait > 0) await nap(wait);
  T.last = Date.now();
  T.calls++;
}
function limited() {
  T.hits++;
  T.gap = Math.min(T.max, Math.round(T.gap * 2));
}
function fine() {
  // 每順利十次放鬆一成，不要一次放太多
  if (T.calls % 10 === 0) T.gap = Math.max(T.min, Math.round(T.gap * 0.9));
}
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
  await gate();
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

// Wikidata 的 SPARQL：**一次查詢**就拿到「附近有座標、有中文條目、而且是地點」
// 的所有項目，連圖片和語言版本數都一起給。
// 先前的做法是 geosearch + Overpass + langlinks + pageviews + P31 過濾，
// 一格要打 12 到 16 次 API —— 35 格一個城市就是四五百次，跑三個城市就撐不住。
// 換成這個之後一格只要一次，實測 3 秒回 25 個景點。
const PLACE_QIDS = [
  'Q41176',   // 建築物
  'Q16970',   // 教堂
  'Q33506',   // 博物館
  'Q23413',   // 城堡
  'Q16560',   // 宮殿
  'Q22698',   // 公園
  'Q174782',  // 廣場
  'Q12280',   // 橋
  'Q4989906', // 紀念碑
  'Q811979',  // 建築結構
  'Q57821',   // 要塞
  'Q1497364', // 建築群
  'Q2977',    // 主教座堂
  'Q44539',   // 神廟
  'Q34627',   // 猶太會堂
  'Q32815',   // 清真寺
  'Q24398318',// 宗教建築
  'Q1802963', // 修道院
  'Q483110',  // 體育場
  'Q11315',   // 購物中心
  'Q207694',  // 美術館
  'Q3947',    // 住宅
  'Q55488',   // 火車站
  'Q1244442', // 學校建築
  'Q39614',   // 墓園
  'Q17715832',// 塔
  'Q2087181', // 歷史建築
  'Q159313',  // 都市計畫區
  'Q3914',    // 學校
  'Q133311',  // 陵墓
  'Q570116',  // 觀光景點
  'Q839954',  // 考古遺址
  // ── 自然與郊區系(皇后鎮實測:整城都是這些,原清單全對不上)──
  'Q35112127',// historic building(跟 Q2087181 是不同編號,NZ 常用這個)
  'Q8502',    // 山
  'Q54050',   // 丘陵
  'Q207326',  // 山峰
  'Q34038',   // 瀑布
  'Q23397',   // 湖
  'Q40080',   // 海灘
  'Q167346',  // 植物園
  'Q43501',   // 動物園
  'Q1107656', // 庭園
  'Q794867',  // 觀景台
  'Q2319498', // 地標
  'Q1576213', // 纜車
  'Q179700',  // 雕像
].map(q => 'wd:' + q).join(' ');

async function sparqlSpots(lat, lng, km, limit = 80) {
  const q = `SELECT ?zh ?lat ?lon ?img (COUNT(DISTINCT ?site) AS ?links) WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${km}" .
  }
  ?art schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?zh .
  ?item wdt:P31 ?type . VALUES ?type { ${PLACE_QIDS} }
  OPTIONAL { ?item wdt:P18 ?img }
  ?site schema:about ?item .
  ?item p:P625/psv:P625 ?cv . ?cv wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
} GROUP BY ?zh ?lat ?lon ?img ORDER BY DESC(?links) LIMIT ${limit}`;
  // 429/5xx 要退避重試,不能立刻放棄 —— 一放棄就落到 legacy 那條重 API 鏈,
  // 在被封的時候等於雪上加霜
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q),
      { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(60000) });
    if (r.ok) break;
    if (i < 2) await nap(8000 * (i + 1));
  }
  if (!r.ok) throw new Error('SPARQL HTTP ' + r.status);
  const rows = (await r.json()).results.bindings;
  // 同一個項目可能有多組座標，取第一組
  const seen = new Map();
  for (const b of rows) {
    const zh = b.zh.value;
    if (seen.has(zh)) continue;
    seen.set(zh, {
      zh, lat: +b.lat.value, lng: +b.lon.value,
      links: +b.links.value,
      img: b.img?.value || null,
      dist: haversine(lat, lng, +b.lat.value, +b.lon.value),
    });
  }
  return [...seen.values()];
}

// 條目主圖只有一張，播報一段兩三分鐘只看一張太單調。
// prop=images 可以拿到條目裡用到的**所有**圖片，但裡面混著一堆不能看的：
// 圖示、地圖、旗幟、徽章、SVG、共享資源的通用圖示。要靠檔名與尺寸濾掉。
const BAD_IMG = /icon|logo|flag|coat[ _]of[ _]arms|symbol|blank|spacer|commons|wiki|edit|ambox|question|disambig|stub|portal|crystal|nuvola|emblem|seal|map|locator|plan|diagram|chart|graph|signature|barnstar|\.svg$|\.ogg$|\.webm$|\.pdf$/i;

// 英文條目名 → 中文條目名。早期抓的資料 id 存的是英文標題
// （wiki:Great_Palace_of_Constantinople），拿它去問中文維基一定查不到 ——
// 伊斯坦堡、維也納、巴塞隆納、布拉格全是那個時期抓的，整批都補不到照片。
export async function zhTitleOf(enTitles) {
  const map = new Map();
  for (const part of chunk(enTitles, 50)) {
    const j = await api('en.wikipedia.org', {
      prop: 'langlinks', lllang: 'zh', lllimit: '500', titles: part.join('|'),
    });
    for (const p of j.query?.pages || []) {
      const zh = (p.langlinks || [])[0]?.title;
      if (zh) map.set(p.title, zh);
    }
  }
  return map;
}

// host 可以指定 zh 或 en —— 中文條目的圖常常比英文版少很多
//（實測君士坦丁堡大皇宮中文版只有兩張可用），不夠就去英文版補。
export async function moreImages(titles, want = 5, host = 'zh.wikipedia.org') {
  const byPage = new Map();
  const files = new Set();
  for (const part of chunk(titles, 20)) {
    // imlimit 是**整個查詢**的上限，不是每一頁的 —— 不跟著 continue 拿的話
    // 只有前面一兩個條目會拿到圖片，後面全部被截斷
    //（實測八個景點只有第一個拿到六張，其餘都只有主圖）。
    let cont = null;
    for (let round = 0; round < 6; round++) {
      const j = await api(host, {
        prop: 'images', imlimit: '500', titles: part.join('|'),
        ...(cont ? { imcontinue: cont } : {}),
      });
      for (const p of j.query?.pages || []) {
        const list = (p.images || []).map(i => i.title)
          .filter(t => !BAD_IMG.test(t) && /\.(jpe?g|png)$/i.test(t));
        if (!list.length) continue;
        byPage.set(p.title, (byPage.get(p.title) || []).concat(list));
        list.forEach(f => files.add(f));
      }
      cont = j.continue?.imcontinue;
      await nap(tune.gapMs);
      if (!cont) break;
    }
  }
  if (!files.size) return byPage;
  // 檔名 → 縮圖網址（順便拿尺寸，太小的是裝飾用圖）
  const url = new Map();
  for (const part of chunk([...files], 50)) {
    const j = await api(host, {
      prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: '1200', titles: part.join('|'),
    });
    for (const p of j.query?.pages || []) {
      const ii = (p.imageinfo || [])[0];
      if (!ii) continue;
      if ((ii.width || 0) < 640 || (ii.height || 0) < 400) continue;   // 裝飾用小圖
      url.set(p.title, ii.thumburl || ii.url);
    }
    await nap(tune.gapMs);
  }
  const out = new Map();
  for (const [page, list] of byPage)
    out.set(page, list.map(f => url.get(f)).filter(Boolean).slice(0, want));
  return out;
}

// 照片下載也要節流。upload.wikimedia.org 有自己的限流，而且比 API 還兇 ——
// 實測固定間隔 600 毫秒抓，六張裡四張回 429（成功率四成）。
// 跟 API 分開算一組間隔，因為兩邊的額度是分開的。
const PT = { gap: 800, min: 500, max: 30000, last: 0, hits: 0, ok: 0 };
export const photoState = () => ({ ...PT });
export async function fetchPhoto(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const wait = PT.last + PT.gap - Date.now();
    if (wait > 0) await nap(wait);
    PT.last = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow',
                                   signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { PT.hits++; PT.gap = Math.min(PT.max, Math.round(PT.gap * 1.8)); continue; }
      if (!r.ok) return null;
      const b = Buffer.from(await r.arrayBuffer());
      PT.ok++;
      if (PT.ok % 12 === 0) PT.gap = Math.max(PT.min, Math.round(PT.gap * 0.85));
      return b;
    } catch { PT.gap = Math.min(PT.max, Math.round(PT.gap * 1.3)); }
  }
  return null;
}

// 逐句切開當字幕用
const sentences = t => (t.match(/[^。！？!?]+[。！？!?]?/g) || []).map(s => s.trim()).filter(s => s.length > 1);

// 城市級景點:半徑 7 公里、上限 200,一次 SPARQL 拿完 —— 給啟動器
// 標整個城市的橘點用。比逐格轟炸禮貌得多(1 個查詢 vs 81 個)。
// 只回地圖需要的最小欄位;導覽稿與照片等真的跑到那附近時
// 由既有的逐格管線補。
export async function citySpots(lat, lng) {
  // 名字寬容降級:繁中條目名 > 中文標籤 > 英文標籤。
  // 只要求繁中的話,中文圈外整片空白(實測皇后鎮 7km:任何語言 81 個、
  // 繁中只有 3 個)。英文名的景點照樣能標點、能「跑到」,
  // 到了現場交給 AI 導覽(它認得英文名)。
  const q = `SELECT ?zhArt ?zhL ?enL ?lat ?lon (COUNT(DISTINCT ?site) AS ?links) WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "7" .
  }
  ?item wdt:P31 ?type . VALUES ?type { ${PLACE_QIDS} }
  ?site schema:about ?item .
  OPTIONAL { ?art schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?zhArt }
  OPTIONAL { ?item rdfs:label ?zhL . FILTER(LANG(?zhL) = "zh") }
  OPTIONAL { ?item rdfs:label ?enL . FILTER(LANG(?enL) = "en") }
  ?item p:P625/psv:P625 ?cv . ?cv wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
} GROUP BY ?zhArt ?zhL ?enL ?lat ?lon ORDER BY DESC(?links) LIMIT 200`;
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q),
      { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(60000) });
    if (r.ok) break;
    if (i < 2) await nap(8000 * (i + 1));
  }
  if (!r.ok) throw new Error('SPARQL HTTP ' + r.status);
  const seen = new Map();
  for (const b of (await r.json()).results.bindings) {
    const name = b.zhArt?.value || b.zhL?.value || b.enL?.value;
    if (!name || seen.has(name)) continue;
    const links = +b.links.value;
    // 知名度門檻:有繁中條目≥3 語言版;沒有的≥2(≥5 的話中文圈外
    // 整片又空了 —— 紐西蘭的景點大多只有 1~2 個語言版,實測皇后鎮
    // 只剩 2 個)。≥2 = 至少「英文+另一語言」,雜點還能接受
    // 類型白名單本身就是品質濾網(能通過的都是「景點類」),
    // 語言版本數只用來排序,不再當門檻 —— 皇后鎮實測:≥2 剩 7 個,
    // 全放行 = 把 81 個裡型別對的都撈進來,小鎮才有東西看
    if (b.zhArt && links < 3) continue;
    seen.set(name, { id: 'c:' + name, name, lat: +b.lat.value, lng: +b.lon.value,
                     cat: 'see', links });
  }
  return [...seen.values()];
}

export async function wikiNearby(lat, lng, {
  radius = 1200, minLinks = 3, limit = 12, minChars = 60,
} = {}) {
  let cand = [];
  try {
    cand = await sparqlSpots(lat, lng, Math.max(0.5, radius / 1000));
  } catch (e) {
    // SPARQL 掛了就退回舊的做法（慢很多，但至少有東西）
    return legacyNearby(lat, lng, { radius, limit, minChars });
  }
  // 語言版本數當熱門度。先前用 60 天瀏覽量比較準，但那要另外打好幾次 API ——
  // SPARQL 順手就給語言版本數，省下的呼叫次數比準度值錢。
  cand = cand.filter(c => c.links >= minLinks && c.dist <= radius)
             .sort((a, b) => b.links - a.links)
             .slice(0, limit * 2);
  if (!cand.length) return [];

  const out = [];
  // 先一次把所有條目的圖片問出來
  let extra = new Map();
  try { extra = await moreImages(cand.map(c => c.zh)); } catch {}
  for (const part of chunk(cand, 20)) {
    const j = await api('zh.wikipedia.org', {
      variant: 'zh-tw', converttitles: '1',
      prop: 'extracts|pageimages', exintro: '1', explaintext: '1',
      piprop: 'thumbnail|original', pithumbsize: '1200',
      titles: part.map(c => c.zh).join('|'),
    });
    await nap(tune.gapMs);
    const pages = j.query?.pages || [];
    const meta = new Map(pages.map(p => [p.title, p]));
    for (const c of part) {
      const p = meta.get(c.zh) || pages.find(x => x.pageid && !x.__used);
      if (!p) continue;
      p.__used = true;
      const body = clean(p.extract);
      if (body.length < minChars) continue;
      let name = nameFrom(body, c.zh);
      if (looksBad(name)) { await nap(tune.gapMs); name = await displayTitle(c.zh); }
      if (/^\d|事件|槍擊|襲擊|攻擊|爆炸|暴動|戰役|地震|空難|大火|疫情/.test(name)) continue;
      if (/都會區|都市圈|自治市|行政區$|地區$|縣$|州$|省$|大區$/.test(name)) continue;
      // 世界遺產名錄本身也掛著座標（實測阿姆斯特丹排第一名的就是它）
      if (/世界遺產|文化遺產|名錄|列表$/.test(name)) continue;
      // 主圖排第一，條目內的其他圖片接在後面（去掉重複的）
      const photos = [];
      if (p.thumbnail?.source) photos.push(p.thumbnail.source);
      else if (c.img) photos.push(c.img);
      const base = u => (u || '').split('/').pop().replace(/^\d+px-/, '');
      for (const u of extra.get(c.zh) || []) {
        if (photos.length >= 6) break;
        if (!photos.some(x => base(x) === base(u))) photos.push(u);
      }
      out.push({
        id: 'wiki:' + encodeURIComponent(c.zh),
        name, city: '', cat: 'wiki', src: 'wiki',
        lat: c.lat, lng: c.lng, dist: c.dist, views: c.links,
        len: body.length, script: body, lines: sentences(body), marks: [], photos,
      });
    }
  }
  return out.slice(0, limit);
}

// 舊的做法留著當備援 —— SPARQL 服務偶爾會 502（實測阿姆斯特丹那次）
async function legacyNearby(lat, lng, {
  radius = 1200, minViews = 250, limit = 12, minChars = 60,
} = {}) {  // 1. 英文維基找座標
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
      // 世界遺產名錄本身也掛著座標（實測阿姆斯特丹排第一名的就是它）
      if (/世界遺產|文化遺產|名錄|列表$/.test(name)) continue;
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