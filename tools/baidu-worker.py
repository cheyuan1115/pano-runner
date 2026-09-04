# 百度全景資料 worker(中國街景;Google/Apple 在中國大陸零覆蓋)。
# 比 Apple 簡單:圖本身就是等距柱狀(不用重投影)、有現成 neighbors 連結圖 + heading。
# stdin/stdout 走行分隔 JSON,跟 apple-worker 同介面:find / meta / pyramid。
import sys, json, os, math, time, traceback, threading
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from streetlevel import baidu

CACHE = os.path.join(os.path.dirname(__file__), '..', '.bdcache')
os.makedirs(CACHE, exist_ok=True)
panos = {}          # id -> BaiduPanorama

def brg(a_lat, a_lng, b_lat, b_lng):
    dx = (b_lng - a_lng) * math.cos(math.radians(a_lat)) * 111320
    dy = (b_lat - a_lat) * 110540
    return math.hypot(dx, dy), (math.degrees(math.atan2(dx, dy)) + 360) % 360

def get_by_id(pid):
    if pid in panos: return panos[pid]
    try:
        p = baidu.find_panorama_by_id(pid)
        if p: panos[pid] = p
        return p
    except Exception: return None

def dest(lat, lng, brg_deg, d):
    R = 6371000; br = math.radians(brg_deg); la = math.radians(lat); lo = math.radians(lng); dr = d / R
    la2 = math.asin(math.sin(la)*math.cos(dr) + math.cos(la)*math.sin(dr)*math.cos(br))
    lo2 = lo + math.atan2(math.sin(br)*math.sin(dr)*math.cos(la), math.cos(dr)-math.sin(la)*math.sin(la2))
    return math.degrees(la2), math.degrees(lo2)

def links_of(p):
    # 百度的 neighbors 清單常不對稱(只列一個方向)→ 跑到會來回彈跳(實測)。
    # 改成主動探測:8 方向各 ~11m 找最近全景(像 Apple),得到對稱的局部圖。
    def probe(bd):
        la, lo = dest(p.lat, p.lon, bd, 11)
        try:
            q = baidu.find_panorama(la, lo)
            if q and str(q.id) != str(p.id):
                panos[str(q.id)] = q
                d, b = brg(p.lat, p.lon, q.lat, q.lon)
                if 2 < d < 20: return (str(q.id), q.lat, q.lon, round(d, 1), round(b, 1))
        except Exception: pass
        return None
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(probe, range(0, 360, 45)))
    # 也併入 neighbors(近的),多一層保險
    cand = {}
    for r in res:
        if r: cand[r[0]] = r
    for n in (p.neighbors or []):
        if not getattr(n, 'lat', None): continue
        d, b = brg(p.lat, p.lon, n.lat, n.lon)
        if 2 < d < 16 and str(n.id) not in cand:
            cand[str(n.id)] = (str(n.id), n.lat, n.lon, round(d, 1), round(b, 1))
    # 每 30° 扇區挑最接近 10m 的(稀釋步距)
    sec = {}
    for cid, la, lo, d, b in cand.values():
        k = round(b / 30) % 12
        sc = abs(d - 10)
        if k not in sec or sc < sec[k][0]: sec[k] = (sc, cid, la, lo, d, b)
    return [{'id': cid, 'lat': la, 'lng': lo, 'heading': b, 'd': d, 'dz': 0}
            for _, cid, la, lo, d, b in sec.values()]

def handle(req):
    op = req['op']
    if op == 'find':
        try: p = baidu.find_panorama(req['lat'], req['lng'])
        except Exception as e: return {'error': str(e)[:80]}
        if not p: return {'error': 'no-coverage'}
        panos[str(p.id)] = p
        d, _ = brg(req['lat'], req['lng'], p.lat, p.lon)
        if d > req.get('r', 50): return {'error': 'too-far', 'd': round(d)}
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                'date': str(p.date.date()) if p.date else None, 'd': round(d, 1)}
    if op == 'meta':
        p = get_by_id(req['id'])
        if not p: return {'error': 'unknown-pano'}
        for n in (p.neighbors or []):
            if getattr(n, 'lat', None): pass
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                'yaw': (270 - math.degrees(p.heading or 0)) % 360,   # GPano 中央=90-heading;用戶實測反的→+180
                'date': str(p.date.date()) if p.date else None,
                'street': getattr(p, 'street_name', '') or '',
                'links': links_of(p)}
    if op == 'pyramid':
        pid = req['id']
        d = os.path.join(CACHE, pid)
        done = os.path.join(d, 'done.json')
        if os.path.exists(done): return json.load(open(done))
        p = get_by_id(pid)
        if not p: return {'error': 'unknown-pano'}
        t0 = time.time()
        raw = os.path.join(d + '.raw.jpg')
        os.makedirs(d, exist_ok=True)
        baidu.download_panorama(p, raw, zoom=4)      # 等距柱狀,已組好
        eq = Image.open(raw).convert('RGB')
        os.remove(raw)
        out = {'tile': 512, 'zooms': {}}
        for z, w in ((2, 2048), (3, 4096)):          # 都是 512 整數倍
            h = w // 2
            im = eq.resize((w, h), Image.LANCZOS)
            cols, rows = w // 512, h // 512
            for cx in range(cols):
                for cy in range(rows):
                    im.crop((cx*512, cy*512, cx*512+512, cy*512+512)).save(
                        os.path.join(d, f'{z}_{cx}_{cy}.jpg'), quality=84)
            out['zooms'][str(z)] = {'w': w, 'h': h}
        out['secs'] = round(time.time()-t0, 1)
        json.dump(out, open(done, 'w'))
        return out
    return {'error': 'bad-op'}

OUT_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(4)
def run(req):
    try: out = handle(req)
    except Exception as e: out = {'error': str(e)[:200], 'trace': traceback.format_exc()[-300:]}
    out['rid'] = req.get('rid')
    with OUT_LOCK:
        sys.stdout.write(json.dumps(out) + '\n'); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: req = json.loads(line)
    except Exception: continue
    POOL.submit(run, req)
POOL.shutdown(wait=True)
