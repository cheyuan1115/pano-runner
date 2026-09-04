# Kakao 街景 worker(韓國;Google 在韓受限、Kakao 覆蓋完整)。
# 最乖的來源:快(近台灣)、heading 標準羅盤(0=北 90=東)、鄰居對稱、圖已是等距柱狀。
import sys, json, os, math, time, traceback, threading
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from streetlevel import kakao

CACHE = os.path.join(os.path.dirname(__file__), '..', '.kkcache')
os.makedirs(CACHE, exist_ok=True)
panos = {}
BUILD_LOCKS = {}; LOCKS_GUARD = threading.Lock()
def build_lock(pid):
    with LOCKS_GUARD:
        BUILD_LOCKS.setdefault(pid, threading.Lock()); return BUILD_LOCKS[pid]

def brg(a_lat, a_lng, b_lat, b_lng):
    dx = (b_lng - a_lng) * math.cos(math.radians(a_lat)) * 111320
    dy = (b_lat - a_lat) * 110540
    return math.hypot(dx, dy), (math.degrees(math.atan2(dx, dy)) + 360) % 360

def get_by_id(pid):
    if pid in panos: return panos[pid]
    try:
        p = kakao.find_panorama_by_id(pid)
        if p: panos[pid] = p
        return p
    except Exception: return None

def links_of(p):
    # 鄰居(by_id 給 8 個,對稱);不足時 find_panoramas 補。每 30° 扇區取最近(~10m 步距)
    cand = {}
    for n in (p.neighbors or []):
        if not getattr(n, 'lat', None): continue
        d, b = brg(p.lat, p.lon, n.lat, n.lon)
        if 2 < d < 25: cand[str(n.id)] = (n.lat, n.lon, d, b)
    if len(cand) < 2:
        try:
            for n in kakao.find_panoramas(p.lat, p.lon, radius=30):
                if str(n.id) == str(p.id) or str(n.id) in cand: continue
                d, b = brg(p.lat, p.lon, n.lat, n.lon)
                if 2 < d < 25: cand[str(n.id)] = (n.lat, n.lon, d, b)
        except Exception: pass
    sec = {}
    for cid, (la, lo, d, b) in cand.items():
        k = round(b / 30) % 12
        if k not in sec or d < sec[k][0]: sec[k] = (d, cid, la, lo, b)
    return [{'id': cid, 'lat': la, 'lng': lo, 'heading': round(b, 1), 'd': round(d, 1), 'dz': 0}
            for d, cid, la, lo, b in sec.values()]

def handle(req):
    op = req['op']
    if op == 'find':
        try: ps = kakao.find_panoramas(req['lat'], req['lng'], radius=max(50, req.get('r', 50)))
        except Exception as e: return {'error': str(e)[:80]}
        if not ps: return {'error': 'no-coverage'}
        best = min(ps, key=lambda p: brg(req['lat'], req['lng'], p.lat, p.lon)[0])
        panos[str(best.id)] = best
        d, _ = brg(req['lat'], req['lng'], best.lat, best.lon)
        if d > req.get('r', 50): return {'error': 'too-far', 'd': round(d)}
        return {'id': str(best.id), 'lat': best.lat, 'lng': best.lon,
                'date': str(best.date.date()) if best.date else None, 'd': round(d, 1)}
    if op == 'meta':
        p = get_by_id(req['id'])
        if not p: return {'error': 'unknown-pano'}
        return {'id': str(p.id), 'lat': p.lat, 'lng': p.lon,
                'yaw': (math.degrees(p.heading or 0)) % 360,   # 標準羅盤;中央方位待校準
                'date': str(p.date.date()) if p.date else None,
                'street': getattr(p, 'street_name', '') or '',
                'links': links_of(p)}
    if op == 'pyramid':
        pid = req['id']
        d = os.path.join(CACHE, pid)
        done = os.path.join(d, 'done.json')
        if os.path.exists(done): return json.load(open(done))
        with build_lock(pid):
            if os.path.exists(done): return json.load(open(done))
            p = get_by_id(pid)
            if not p: return {'error': 'unknown-pano'}
            t0 = time.time()
            raw = d + '.raw.jpg'; os.makedirs(d, exist_ok=True)
            kakao.download_panorama(p, raw, zoom=2)
            eq = Image.open(raw).convert('RGB'); os.remove(raw)
            out = {'tile': 512, 'zooms': {}}
            for z, w in ((2, 2048), (3, 4096)):
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
