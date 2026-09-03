# Apple Look Around 資料 worker:常駐程序,stdin/stdout 走行分隔 JSON。
# Node 端(server.mjs)把它當外部資料層:find(找點)、meta(鄰居)、equirect(取圖)。
# 為什麼用 Python:streetlevel 已解決 protobuf 涵蓋、HEIC 面、重投影(torch),
# 在 Node 重寫這三樣不值得。
import sys, json, io, os, math, time, traceback, threading
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()
from streetlevel import lookaround

CACHE = os.path.join(os.path.dirname(__file__), '..', '.lacache')
os.makedirs(CACHE, exist_ok=True)
auth = lookaround.Authenticator()
tiles = {}          # (tx,ty) -> CoverageTile(記憶體快取)
panos = {}          # id(str) -> pano 物件

def cover(lat, lng):
    # 座標→涵蓋磚(z17),連同周圍一圈都抓,鄰居才不會斷在磚界
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            n = 2 ** 17
            tx = int((lng + 180) / 360 * n)
            lr = math.radians(lat)
            ty = int((1 - math.log(math.tan(lr) + 1/math.cos(lr)) / math.pi) / 2 * n)
            key = (tx+dx, ty+dy)
            if key not in tiles:
                try: tiles[key] = lookaround.get_coverage_tile(*key)
                except Exception: tiles[key] = None
            if tiles[key]:
                out.extend(tiles[key].panos)
    for p in out: panos[str(p.id)] = p
    return out

def dist(a_lat, a_lng, b_lat, b_lng):
    dx = (b_lng-a_lng)*math.cos(math.radians(a_lat))*111320
    dy = (b_lat-a_lat)*110540
    return math.hypot(dx, dy), (math.degrees(math.atan2(dx, dy))+360)%360

def handle(req):
    op = req['op']
    if op == 'find':
        ps = cover(req['lat'], req['lng'])
        if not ps: return {'error': 'no-coverage'}
        r = req.get('r', 50)
        best, bd = None, 1e9
        for p in ps:
            d, _ = dist(req['lat'], req['lng'], p.lat, p.lon)
            if d < bd: best, bd = p, d
        if bd > r: return {'error': 'too-far', 'd': round(bd)}
        return {'id': str(best.id), 'lat': best.lat, 'lng': best.lon,
                'date': str(best.date.date()) if best.date else None, 'd': round(bd, 1)}
    if op == 'meta':
        p = panos.get(req['id'])
        if not p: 
            cover(req['lat'], req['lng'])
            p = panos.get(req['id'])
        if not p: return {'error': 'unknown-pano'}
        ns = []
        for q in cover(p.lat, p.lon):
            if str(q.id) == str(p.id): continue
            d, brg = dist(p.lat, p.lon, q.lat, q.lon)
            if d < 25:
                ns.append({'id': str(q.id), 'lat': q.lat, 'lng': q.lon,
                           'd': round(d, 1), 'heading': round(brg, 1)})
        ns.sort(key=lambda x: x['d'])
        # 上限放大:點距約 4m,只留 24 顆全擠在 10m 內,Node 端稀釋成 13m 步距時
        # 挑不到 13m 的候選(實測步距仍是 4m、跑不順)。留到 60 顆才涵蓋到 ~18m。
        # 重投影後等距柱狀圖的「正中央 = 行進反方向」(streetlevel 文件明載)。
        # 引擎的 meta.yaw 要填「影像中央的世界方位」,所以是 heading+180,不是 heading。
        # 並排 Google/Apple 全景比對確認(之前填 heading 差 180°,看的是正後方)。
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                # 重投影中央的世界方位:實測(用戶+自動邊緣相關一致)= heading - 45。
                # streetlevel 文件說「中央=行進反方向」,但 pano.heading 不是精確的行進向,
                # 用戶實測:heading-45 反而更偏(90°),故是 heading+45。仍可 [ ] 微調。
                'yaw': (math.degrees(getattr(p, 'heading', 0) or 0)+180) % 360,   # Wc=行進反方向=heading+180(每趟一致)
                'date': str(p.date.date()) if p.date else None,
                'links': ns[:60]}
    if op == 'pyramid':
        # 抓六面(並行)→ 重投影 → 縮放成 Google 尺寸的 z2/z3/z4 → 切 512 磚
        # 引擎照 Google 的 geom 幾何運作,磚塔做成一樣的形狀就零改動
        pid = req['id']
        d = os.path.join(CACHE, pid)
        done = os.path.join(d, 'done.json')
        if os.path.exists(done): return json.load(open(done))
        p = panos.get(pid)
        if not p:
            cover(req['lat'], req['lng'])
            p = panos.get(pid)
        if not p: return {'error': 'unknown-pano'}
        t0 = time.time()
        # zoom=3 抓面:重投影 4.5s→1.3s(zoom=2 的重投影是元兇),輸出 4560px
        # 拿來當 z3(3328)顯示綽綽有餘。只切 z2+z3,z4 顯示端對映到 z3。
        with ThreadPoolExecutor(6) as ex:
            raws = list(ex.map(lambda i: lookaround.get_panorama_face(p, i, zoom=3, auth=auth), range(6)))
        faces = [Image.open(io.BytesIO(r)) for r in raws]
        tf = time.time()
        with REPRO_LOCK:   # torch 重投影一次一顆,兩顆並行會把記憶體吃爆
            eq = lookaround.to_equirectangular(faces, p.camera_metadata).convert('RGB')
        tr = time.time()
        os.makedirs(d, exist_ok=True)
        out = {'tile': 512, 'zooms': {}}
        for z, w in ((2, 1664), (3, 3328)):
            h = w // 2
            im = eq.resize((w, h), Image.LANCZOS)
            cols, rows = math.ceil(w / 512), math.ceil(h / 512)
            for cx in range(cols):
                for cy in range(rows):
                    tile = Image.new('RGB', (512, 512))
                    tile.paste(im.crop((cx*512, cy*512, min((cx+1)*512, w), min((cy+1)*512, h))), (0, 0))
                    tile.save(os.path.join(d, f'{z}_{cx}_{cy}.jpg'), quality=84)
            out['zooms'][str(z)] = {'w': w, 'h': h}
        out['secs'] = {'faces': round(tf-t0,1), 'repro': round(tr-tf,1), 'tiles': round(time.time()-tr,1)}
        json.dump(out, open(done, 'w'))
        return out
    return {'error': 'bad-op'}

REPRO_LOCK = threading.Lock()
OUT_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(4)

def run(req):
    try: out = handle(req)
    except Exception as e:
        out = {'error': str(e)[:200], 'trace': traceback.format_exc()[-300:]}
    out['rid'] = req.get('rid')
    with OUT_LOCK:
        sys.stdout.write(json.dumps(out) + '\n')
        sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: req = json.loads(line)
    except Exception: continue
    POOL.submit(run, req)

POOL.shutdown(wait=True)   # stdin 關閉(Node 收攤)後,把在做的先做完再退出
