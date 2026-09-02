# Gemini Live 浮窗狀態巡邏:印 NONE / LIVE / RESUMED / STUCK
# 「聽取中」會自己變「已暫停」(實測幾分鐘內就發生),跑步中看不到浮窗,
# 對著暫停的 Gemini 講話就是「都聽不到」—— 所以要 OCR 讀狀態、暫停就按回。
# 注意:聽取中時同一顆鈕是「停止聆聽」,沒先確認狀態就按會反過來按停它。
import Quartz, subprocess, sys

def bounds():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
    for w in wl:
        if 'Chrome' in w.get('kCGWindowOwnerName','') and w.get('kCGWindowLayer',0) > 0:
            b = w['kCGWindowBounds']
            if 250 < b['Width'] < 600 and 80 < b['Height'] < 300:
                return b
    return None

def ocr(b):
    p = '/tmp/gem-ocr.png'
    subprocess.run(['screencapture','-x','-R','%d,%d,%d,%d' % (b['X'],b['Y'],b['Width'],b['Height']), p], check=True)
    import Vision
    from Foundation import NSURL
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLanguages_(['zh-Hant','en'])
    h = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(p), None)
    h.performRequests_error_([req], None)
    return ' '.join(str(o.topCandidates_(1)[0].string()) for o in (req.results() or []))

b = bounds()
if not b: print('NONE'); sys.exit()
t = ocr(b)
if '暫停' not in t and 'paused' not in t.lower(): print('LIVE'); sys.exit()
# 已暫停 → 按波形鈕恢復。位置隨晶片列版面變,主位置不行換備用位置
import time
for dx, dy in [(57, 27), (42, 43)]:
    subprocess.run(['cliclick','c:%d,%d' % (int(b['X']+b['Width']-dx), int(b['Y']+b['Height']-dy))])
    time.sleep(1.2)
    b2 = bounds()
    if not b2: print('NONE'); sys.exit()
    t = ocr(b2)
    if '暫停' not in t: print('RESUMED'); sys.exit()
print('STUCK')
