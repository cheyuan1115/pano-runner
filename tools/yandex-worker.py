# Yandex 全景資料 worker(俄羅斯+中亞+土耳其等;Google 在俄已撤)。
# 最乾淨的來源:圖已是等距柱狀(不用重投影)、有正規 links 導航圖(direction=羅盤方位)。
# heading 慣例:0=南,90=西,180=北,270=東 → compass = heading + 180。
import sys, json, os, math, time, traceback, threading
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from streetlevel import yandex

CACHE = os.path.join(os.path.dirname(__file__), '..', '.yxcache')
os.makedirs(CACHE, exist_ok=True)
panos = {}
BUILD_LOCKS = {}       # id -> Lock:同一顆切磚只做一次(否則 20 塊磚各觸發一次重複下載)
LOCKS_GUARD = threading.Lock()
def build_lock(pid):
    with LOCKS_GUARD:
        if pid not in BUILD_LOCKS: BUILD_LOCKS[pid] = threading.Lock()
        return BUILD_LOCKS[pid]

def brg(a_lat, a_lng, b_lat, b_lng):
    dx = (b_lng - a_lng) * math.cos(math.radians(a_lat)) * 111320
    dy = (b_lat - a_lat) * 110540
    return math.hypot(dx, dy), (math.degrees(math.atan2(dx, dy)) + 360) % 360

def get_by_id(pid):
    if pid in panos: return panos[pid]
    try:
        p = yandex.find_panorama_by_id(pid)
        if p: panos[pid] = p
        return p
    except Exception: return None

def links_of(p):
    # links 直接帶 direction(羅盤方位,已驗證吻合)。用 find_panorama_by_id 拿距離。
    out = []
    for l in (p.links or []):
        try:
            b = math.degrees(l.direction) % 360
            q = get_by_id(str(l.pano))
            if not q: continue
            d, _ = brg(p.lat, p.lon, q.lat, q.lon)
            if 2 < d < 30:
                out.append({'id': str(q.id), 'lat': q.lat, 'lng': q.lon, 'heading': round(b, 1), 'd': round(d, 1), 'dz': 0})
        except Exception: pass
    # links 太少(1)時,neighbors 補(每 30° 扇區最近)
    if len(out) < 2:
        sec = {}
        for n in (p.neighbors or []):
            if not getattr(n, 'lat', None): continue
            d, b = brg(p.lat, p.lon, n.lat, n.lon)
            if d < 2 or d > 20: continue
            k = round(b / 30) % 12
            if k not in sec or d < sec[k][0]: sec[k] = (d, str(n.id), n.lat, n.lon, b)
        have = {o['id'] for o in out}
        for d, nid, la, lo, b in sec.values():
            if nid not in have: out.append({'id': nid, 'lat': la, 'lng': lo, 'heading': round(b,1), 'd': round(d,1), 'dz': 0})
    return out

def handle(req):
    op = req['op']
    if op == 'find':
        try: p = yandex.find_panorama(req['lat'], req['lng'])
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
        h = math.degrees(p.heading or 0) % 360
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                'yaw': (h + 180) % 360,   # compass heading;中央方位待實地校準(aflip)
                'date': str(p.date.date()) if p.date else None,
                'street': getattr(p, 'street_name', '') or '',
                'links': links_of(p)}
    if op == 'pyramid':
        pid = req['id']
        d = os.path.join(CACHE, pid.replace('/', '_'))
        done = os.path.join(d, 'done.json')
        if os.path.exists(done): return json.load(open(done))
        with build_lock(pid):                        # 同顆只建一次;後到的等它、直接讀 done
            if os.path.exists(done): return json.load(open(done))
            p = get_by_id(pid)
            if not p: return {'error': 'unknown-pano'}
            t0 = time.time()
            raw = d + '.raw.jpg'
            os.makedirs(d, exist_ok=True)
            yandex.download_panorama(p, raw, zoom=1)     # zoom=1 較小較快(俄國線路慢,別抓最大)
            eq = Image.open(raw).convert('RGB'); os.remove(raw)
            out = {'tile': 512, 'zooms': {}}
            for z, w in ((2, 1536), (3, 3072)):
                h = w // 2
                im = eq.resize((w, h), Image.LANCZOS)
                for cx in range(w // 512):
                    for cy in range(h // 512):
                        im.crop((cx*512, cy*512, cx*512+512, cy*512+512)).save(
                            os.path.join(d, f'{z}_{cx}_{cy}.jpg'), quality=84)
                out['zooms'][str(z)] = {'w': w, 'h': h}
            out['secs'] = round(time.time()-t0, 1)
            json.dump(out, open(done, 'w'))
            return out
    return {'error': 'bad-op'}

OUT_LOCK = threading.Lock(); POOL = ThreadPoolExecutor(4)
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
