# Garmin token 上傳:取代瀏覽器自動化(它的 cookie 每天過期,不算自動)。
# garth 的 OAuth1 權杖約一年有效,OAuth2 短效但用 OAuth1 自動續 → 登入一次撐很久。
#
#   login   讀 ~/.keys/garmin-login(第1行 email、第2行 password),登入→存權杖到
#           ~/.keys/garmin-tokens/。有兩步驗證會在終端機問你收到的碼(互動執行)。
#   upload <file>   載入權杖上傳 .fit/.tcx/.gpx;印 OK / 需要重新登入 / 錯誤
import sys, os, warnings
warnings.filterwarnings('ignore')
TOK = os.path.expanduser('~/.keys/garmin-tokens')

def do_login():
    import garth
    from garminconnect import Garmin
    p = os.path.expanduser('~/.keys/garmin-login')
    if not os.path.exists(p):
        print('NOFILE'); return
    lines = [l.strip() for l in open(p) if l.strip()]
    email, pw = lines[0], lines[1]
    try:
        g = Garmin(email=email, password=pw, return_on_mfa=True)
        res = g.login()
        # 兩步驗證:res 會是 ('needs_mfa', ctx)
        if isinstance(res, tuple) and res[0] == 'needs_mfa':
            # 一次性代碼改「等檔案」:Garmin 傳碼到手機後,把碼寫進 ~/.keys/garmin-mfa,
            # 這裡輪詢讀到就送出(背景執行也能收碼,不必卡在 stdin)。
            import time
            mfp = os.path.expanduser('~/.keys/garmin-mfa')
            if os.path.exists(mfp): os.remove(mfp)
            print('NEEDMFA 已寄出代碼,等待輸入…', flush=True)
            code = None
            for _ in range(180):   # 最多等 3 分鐘
                if os.path.exists(mfp):
                    code = open(mfp).read().strip()
                    if code: break
                time.sleep(1)
            if not code: print('MFA_TIMEOUT'); return
            try: os.remove(mfp)
            except: pass
            g.resume_login(res[1], code)
        os.makedirs(TOK, exist_ok=True)
        g.garth.dump(TOK) if hasattr(g, 'garth') else g.client.dump(TOK)
        print('OK 已登入並存權杖')
    except Exception as e:
        print('ERR', str(e)[:200])

def do_upload(path):
    from garminconnect import Garmin
    if not os.path.isdir(TOK):
        print('NOTOKEN'); return
    try:
        g = Garmin()
        g.login(tokenstore=TOK)      # 從權杖目錄續用;OAuth2 過期會用 OAuth1 自動續
        r = g.upload_activity(path)
        print('OK', getattr(r, 'status_code', r))
    except Exception as e:
        msg = str(e)
        if '409' in msg or 'duplicate' in msg.lower():
            print('DUP 這筆已上傳過')
        elif '401' in msg or '403' in msg or 'auth' in msg.lower():
            print('NEEDLOGIN 權杖失效,要重新 login')
        else:
            print('ERR', msg[:200])

if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'login': do_login()
    elif len(sys.argv) >= 3 and sys.argv[1] == 'upload': do_upload(sys.argv[2])
    else: print('usage: garmin-token.py login | upload <file>')
