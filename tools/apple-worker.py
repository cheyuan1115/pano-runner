# Apple Look Around 資料 worker:常駐程序,stdin/stdout 走行分隔 JSON。
# Node 端(server.mjs)把它當外部資料層:find(找點)、meta(鄰居)、equirect(取圖)。
# 為什麼用 Python:streetlevel 已解決 protobuf 涵蓋、HEIC 面、重投影(torch),
# 在 Node 重寫這三樣不值得。
import sys, json, io, os, math, time, traceback, threading
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import numpy as np
import pillow_heif
pillow_heif.register_heif_opener()
from streetlevel import lookaround

CACHE = os.path.join(os.path.dirname(__file__), '..', '.lacache')
os.makedirs(CACHE, exist_ok=True)
auth = lookaround.Authenticator()
tiles = {}          # (tx,ty) -> CoverageTile(記憶體快取)
panos = {}          # id(str) -> pano 物件
# 朝向場:pano.heading 亂翻、travelDir 轉彎會反,唯一可靠的是「影像本身」。
# 相鄰全景重疊多、互相關很強(實測峰值 0.5-0.7),用它建立每顆的絕對朝向,
# 從種子傳播、轉彎時正確跟著轉。orient=弧度,strip=地平線灰階條(相關用)。
LA_ORIENT = {}      # id -> 朝向(度,相對種子)
LA_STRIP = {}       # id -> np.array(512) 地平線條
ORI_LOCK = threading.Lock()

def build_strip(p):
    with ThreadPoolExecutor(6) as ex:
        raws = list(ex.map(lambda i: lookaround.get_panorama_face(p, i, zoom=5, auth=auth), range(6)))
    faces = [Image.open(io.BytesIO(r)) for r in raws]
    with REPRO_LOCK:
        eq = lookaround.to_equirectangular(faces, p.camera_metadata).convert('L')
    a = np.asarray(eq.resize((512, 256)), float)
    return a[90:170].mean(0)   # 地平線帶,512 寬

def rel_shift(a, b):
    # b 相對 a 的水平位移(度);環狀正規化互相關
    a = (a - a.mean()) / (a.std() + 1e-6); b = (b - b.mean()) / (b.std() + 1e-6)
    c = [np.sum(a * np.roll(b, s)) for s in range(512)]
    sh = int(np.argmax(c))
    return ((sh if sh < 256 else sh - 512) / 512.0 * 360.0), (max(c) / 512.0)

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

def compute_orient(p):
    # 每顆全景的絕對朝向(度)。相鄰全景互相關很強,從種子傳播、轉彎跟著轉。
    # heading 亂翻、travelDir 轉彎會反 —— 只有影像本身可靠。
    pid = str(p.id)
    with ORI_LOCK:
        if pid in LA_ORIENT: return LA_ORIENT[pid]
        # 收集最近幾顆已定向鄰居(<15m),等一下逐一比對取峰值最高的
        cand = []
        for q in panos.values():
            qid = str(q.id)
            if qid == pid or qid not in LA_ORIENT or qid not in LA_STRIP: continue
            d, _ = dist(p.lat, p.lon, q.lat, q.lon)
            if d < 15: cand.append((d, qid))
        cand.sort(key=lambda x: x[0]); cand = cand[:4]
        refs = [(qid, LA_ORIENT[qid], LA_STRIP[qid]) for _, qid in cand]
    try:
        strip = build_strip(p)
    except Exception:
        strip = None
    ori = None
    if refs and strip is not None:
        # 對每顆鄰居算相對位移,取峰值最高那個
        scored = []
        for qid, qori, qstrip in refs:
            sh, pk = rel_shift(qstrip, strip)
            scored.append((pk, sh, qori))
        # 只看位移合理(<60°)的候選 —— 相鄰 10m 全景真實轉角很小,
        # 大位移必是建築 180° 對稱之類的假峰(會造成整個畫面反過來)。
        ok = [(pk, sh, qori) for pk, sh, qori in scored if abs(sh) < 60 and pk > 0.3]
        if ok:
            ok.sort(reverse=True)
            pk, sh, qori = ok[0]
            ori = (qori + sh) % 360
        else:
            # 沒有合理候選:沿用最近鄰居的朝向(場平滑,寧可不動也不要亂翻)
            ori = scored[0][2] % 360
    with ORI_LOCK:
        if pid in LA_ORIENT: return LA_ORIENT[pid]   # 併發時別人算好了
        if ori is None: ori = 0.0                    # 種子(client 用 travelDir 錨定)
        LA_ORIENT[pid] = ori
        if strip is not None: LA_STRIP[pid] = strip
        if len(LA_ORIENT) > 4000:
            for k in list(LA_ORIENT.keys())[:1000]:
                LA_ORIENT.pop(k, None); LA_STRIP.pop(k, None)
        return ori

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
        # 上限放大:點距約 4m,留 60 顆涵蓋 ~18m,Node 端稀釋步距才挑得到候選。
        # Apple heading 是逆時針(0=北,90=西);轉順時針=(360-h),就是真實行車方向
        # (實測與時間定序算出的行車方向吻合到 0.1°)。重投影中央=行車反方向=+180。
        # → meta.yaw = (360 - h) + 180 = (540 - h) % 360。每顆確定值,轉彎自動對。
        yaw = (540 - math.degrees(p.heading or 0)) % 360
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                'yaw': yaw,
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
