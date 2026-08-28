// 語音轉向。從 street-runner 的 overlay.js 搬過來，只留轉向三種指令 ——
// 速度交給麥克風測步頻，不需要「快一點／慢一點」。
//
// 幾個實測踩過的坑（都寫死在下面，不要「簡化」掉）：
//
// 1. **一定要開 interim。** continuous 模式下 Chrome 要判定「這句說完了」才給
//    final，跑步機的環境音會讓它一直不下判斷 —— 實測講完「右轉」三秒後都還
//    只有 interim。等 final 的話路口早就過了。
// 2. **要比對整句，不能比對新增的尾巴。** 一度改成只看 tail 想避免重複觸發，
//    結果「但是你要算說你從左轉開始找」這種句子的 tail 剛好是「左轉」就誤觸。
//    比對整句 + 完全相等，才擋得掉。
// 3. **完全相等，不是包含。** 用包含的話任何含「停」「左」的句子都會中。
// 4. **maxAlternatives 要多要幾個。** 單音節很容易聽錯（實測「停」被聽成「請」）。
// 5. **會自己停。** Chrome 的辨識大約一分鐘後靜默結束，要靠 onend 重啟；
//    另外掛一個看門狗，超過 12 秒沒有任何事件就強制重建。
// 6. zh-TW 暖機要 3–6 秒，第一句常常收不到，這是正常的。

(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { window.__voiceError = '這個瀏覽器沒有語音辨識'; return; }
  if (window.__voice) return;
  // 英文模式:辨識引擎切 en-US、改用英文指令詞表(跟介面同一套判斷)
  const Q9 = new URLSearchParams(location.search);
  let EN_V;
  try {
    const p = Q9.get('lang') || localStorage.getItem('pano-lang');
    EN_V = p ? p === 'en'
         : !(navigator.languages || [navigator.language]).some(l => /^zh/i.test(l || ''));
  } catch { EN_V = false; }

  const WORDS = {
    // 後面那幾個是辨識常見的同音誤判 —— zh-TW 對單音節特別不準，
    // 「右」很容易變成「又／有／佑」，「轉」變成「磚／專／賺」。
    // 「往左」和「左邊」原本都有，但合起來的「往左邊」沒有 —— 而那是最自然的說法。
    // 比對是完全相等，差一個字就整個不中。
    left:  ['左', '左轉', '向左', '往左', '左邊', '往左邊', '向左邊', '左手邊',
            '作轉', '做轉', '坐轉', '左磚', '左專'],
    right: ['右', '右轉', '向右', '往右', '右邊', '往右邊', '向右邊', '右手邊',
            '又轉', '有轉', '佑轉', '右磚', '右專', '又賺', '右賺'],
    back:  ['回頭', '掉頭', '迴轉', '回轉', '往回', '後轉', '往回跑', '回去',
            '迴頭', '回投', '會頭', '掉頭髮'],
    // 結束一律用兩個字以上的完整說法。單一個「停」太容易誤觸 ——
    // street-runner 上實測過含「停」的句子讓整趟直接結束。
    // 注意「跑完」要列進來 —— parse 會先剝掉尾綴的「了」，
    // 所以「跑完了」進到比對時已經是「跑完」。
    stop:  ['結束跑步', '結束', '跑完'],
    // 「導覽」兩個字辨識率高、也不容易在一般句子裡單獨出現。
    // 不接受就不用說話 —— 完全避開「是／好」這種單音節在跑步機上的誤判。
    guide: ['導覽', '要導覽', '導遊', '倒覽', '道覽',
            '導覽吧', '過去看看', '去看看'],
    // 「介紹」獨立成 AI 導覽:就算附近有內建景點的詢問框,
    // 說「介紹」也是問 AI 講眼前的東西,不會跑去景點導覽。
    // 只聽一模一樣的「介紹」兩個字(使用者指定)—— Gemini Live 共存後,
    // 任何前綴/變體比對都會被聊天內容誤觸
    aiguide: ['介紹'],
    // 叫出 Chrome 內建 Gemini(伺服器模擬 ^G)。辨識對英文字通常
    // 直接給拉丁拼寫,大小寫都收
    // 呼叫 Chrome 內建 Gemini。詞是「呼叫AI」(使用者指定);
    // AI 兩字母辨識會出大小寫變體,同一句話全收
    gemini: ['呼叫AI', '呼叫ai', '呼叫Ai', '呼叫A I', '呼叫a i'],
  };
  // 指令最長就這麼長。超過表示那是一般說話（或電視、旁人講話），
  // 不但不可能命中，還會把辨識段落一直佔住 —— 直接判定不是指令、當場重來。
  const MAX_LEN = EN_V ? 30 : 14;   // 英文片語比較長(turn around 就 11 字)
  // 英文指令詞表:比對前先小寫、去標點、空白壓成單一空格
  const WORDS_EN = {
    left:  ['left', 'turn left', 'go left'],
    right: ['right', 'turn right', 'go right'],
    back:  ['turn around', 'u turn', 'u-turn', 'go back', 'turn back'],
    stop:  ['stop running', 'finish run', 'end run', 'im done', "i'm done"],
    guide: ['guide', 'tour', 'guide me', 'take the tour'],
    gemini: ['gemini', 'hey gemini', 'ask gemini'],
    aiguide: ['describe', 'describe this', 'what is this', 'whats this',
              "what's this", 'tell me about this', 'introduce'],
  };
  // 環境吵的時候可以加啟動詞：「小跑右轉」。安靜時直接說「右轉」就好。
  const WAKE = /^(小跑|跑步|嘿小跑)/;
  const parse = t => {
    if (EN_V) {
      const x2 = (t || '').toLowerCase().replace(/[。，、！？.,!?]/g, '')
        .replace(/\s+/g, ' ').trim();
      for (const [cmd, list] of Object.entries(WORDS_EN)) if (list.includes(x2)) return cmd;
      if (/^(run to|go to|take me to) .{2,40}$/.test(x2)) return 'goto';
      if (/^(describe|tell me about|what is) .{2,40}$/.test(x2)) return 'aiabout';
      return null;
    }
    let x = (t || '').replace(/[\s。，、！？.,!?]/g, '');
    x = x.replace(WAKE, '');
    x = x.replace(/(吧|喔|囉|了|一下|啦)$/, '');
    for (const [cmd, list] of Object.entries(WORDS)) if (list.includes(x)) return cmd;
    // 「跑到凱旋門」「前往鐵塔」—— 名字部分在 view.js 的 gotoLm 再解一次。
    // 名字限 2~8 字:單字太容易誤觸,超長的是一般聊天。
    if (/^(跑到|跑去|前往).{2,20}$/.test(x)) return 'goto';
    // 中文的「介紹○○」指名比對已停用(使用者指定只聽單獨的「介紹」)——
    // Gemini Live 共存後,跟它聊天的句子常以「介紹」開頭,前綴比對必誤觸。
    // 指名介紹仍可用英文 describe ○○ 觸發。
    return null;
  };

  const V = window.__voice = { on: false, heard: 0, dropped: 0, selfHeard: 0,
                               last: '', log: [], alive: 0, error: null };
  // 給測試與除錯用：直接餵一句話進來，走跟真的辨識完全相同的比對與觸發路徑。
  // 沒有這個就只能對著麥克風念，改一次詞表要重跑一次跑步機。
  V.feed = t => { const c = parse(t); note(t, c); if (c) fire(c, t); else cancelIfLonger(t); return c; };
  let rec = null, gen = 0, starting = false, lastCmd = null, lastAt = 0;

  // 把事件送回伺服器。辨識這一段在開發機上重現不了（沒辦法對麥克風講話），
  // 出問題時只有這份紀錄能分辨是哪一段壞掉。失敗就算了，絕不能影響辨識。
  const vlog = (ev, extra) => {
    try {
      fetch('/api/vlog', { method: 'POST', keepalive: true,
        body: JSON.stringify({ ev, on: V.on, err: V.error, heard: V.heard,
          drop: V.dropped, self: V.selfHeard, paused: !!V.paused,
          spk: !!window.__speaking, ...extra }) }).catch(() => {});
    } catch {}
  };
  V.vlog = vlog;

  const note = (text, cmd) => {
    V.log.unshift({ t: Date.now(), text, cmd: cmd || null });
    if (V.log.length > 12) V.log.pop();
    V.last = text;
  };

  // 「介紹」vs「介紹○○」的搶跑問題:辨識是分段吐的,「介紹皇后鎮星巴克」
  // 會先送出「介紹」(中途結果)→ 立刻觸發看畫面版;完整句到齊時指名版
  // 已被 busy 擋掉(實際反饋)。解法:單獨「介紹」憋 900ms 再執行,
  // 期間出現「介紹+名字」就取消原版、改跑指名版。
  // 累積型指令(介紹/介紹○○/跑到○○)的搶跑問題:辨識逐字吐,
  // 「介紹巴黎聖母院」會先送「介紹」→「介紹巴黎」→ 完整句 ——
  // 前段都會命中並開槍,真正想要的最後版反被 busy 擋掉
  // (日誌實錘:aiabout「介紹巴黎」先開,人在巴黎聽起來就像在介紹原地)。
  // 解法:這三種指令每次更新就重置 1 秒計時,辨識穩定才執行最後版本。
  // 轉向等單發指令維持即時(慢 1 秒會錯過路口)。
  let pendT = null, pendCmd = null, pendText = null, doneKey = '', doneAt = 0;
  // 排隊取消器:「介紹」先到排了隊,接著聽到「介紹xxx」(現在不匹配任何
  // 指令)—— 那代表使用者說的是長句(可能在跟 Gemini 講話),
  // 待命中的那發要收回(實際反饋:說介紹xxx 還是觸發了介紹)
  const PEND_PREFIX = { aiguide: ['介紹'], goto: ['跑到', '跑去', '前往'] };
  const cancelIfLonger = t => {
    if (!pendCmd) return;
    const x = (t || '').replace(/[\s。，、！？.,!?]/g, '');
    const pre = PEND_PREFIX[pendCmd] || [];
    for (const p2 of pre)
      if (x.startsWith(p2) && x.length > p2.length) {
        clearTimeout(pendT); pendCmd = null;
        return;
      }
  };
  const fire = (cmd, text) => {
    // 播報導覽的時候，麥克風收到的是自己的喇叭聲。旁白裡出現「介紹」「右」
    // 這種字很常見，照收的話會被自己的旁白指揮。
    if (window.__speaking) { V.selfHeard = (V.selfHeard || 0) + 1; return; }
    const settle = cmd === 'aiguide' || cmd === 'aiabout' || cmd === 'goto';
    if (!settle) {
      // 同一個指令兩秒內只算一次 —— interim 會把同一句重送很多遍
      if (cmd === lastCmd && Date.now() - lastAt < 2000) return;
      lastCmd = cmd; lastAt = Date.now();
      V.heard++;
      vlog('指令', { cmd, text: (text || '').slice(0, 40) });
      if (typeof window.__turn === 'function') {
        // 這裡丟例外的話 onresult 會中斷，後面的句子就都收不到了
        try { window.__turn(cmd, text); }
        catch (e) { V.error = 'turn:' + (e && e.message || e); }
      }
      return;
    }
    pendCmd = cmd; pendText = text || '';
    clearTimeout(pendT);
    pendT = setTimeout(() => {
      const key = pendCmd + '|' + pendText;
      // final 常整句重送 —— 剛執行過一模一樣的就不要再來一次
      if (key === doneKey && Date.now() - doneAt < 3000) { pendCmd = null; return; }
      doneKey = key; doneAt = Date.now();
      V.heard++;
      vlog('指令', { cmd: pendCmd, text: pendText.slice(0, 40) });
      if (typeof window.__turn === 'function') {
        try { window.__turn(pendCmd, pendText); }
        catch (e) { V.error = 'turn:' + (e && e.message || e); }
      }
      pendCmd = null;
    }, 1000);
  };

  const build = myGen => {
    const r = new SR();
    r.lang = EN_V ? 'en-US' : 'zh-TW';
    // 一句一個段落。continuous = true 的話 Chrome 會把一長串話累積成同一段，
    // 永遠不下 final；而比對要求「整句等於指令」，那一段就永遠不會命中也不會結束。
    // 症狀正是「聽了一堆沒用的，一串話就卡住不再聽」。
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 4;
    const live = () => myGen === gen;
    r.onstart = () => { if (live()) { V.on = true; V.alive = Date.now(); vlog('起來了'); } };
    r.onaudiostart = () => { if (live()) V.alive = Date.now(); };
    r.onsoundstart = () => { if (live()) V.alive = Date.now(); };
    r.onspeechstart = () => { if (live()) V.alive = Date.now(); };
    r.onerror = e => {
      if (!live()) return;
      V.error = e.error; V.alive = Date.now();
      // 權限被拒就不要一直重試 —— 每次重試 Chrome 都會再閃一次提示，很吵。
      // 使用者在網址列改成允許之後，會由畫面上的橫幅再呼叫一次 start()。
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') V.blocked = true;
      // no-speech / aborted / no-match 在一句一段落的模式下是常態，不要當成故障
      if (e.error === 'no-speech' || e.error === 'aborted' || e.error === 'no-match') V.error = null;
      vlog('錯誤', { code: e.error });
    };
    r.onresult = e => {
      if (!live()) return;
      V.alive = Date.now();
      // 播報中收到的都是自己的旁白，直接忽略。
      // 這裡**不要** abort 重啟 —— 一段旁白會連續丟出幾十個 interim，
      // 每個都重啟一次等於把辨識器打死。整段的暫停交給下面的監看器做，
      // 一段只 abort 一次。
      if (window.__speaking) { V.selfHeard = (V.selfHeard || 0) + 1; return; }
      // 講太長就當場中止，不要等他講完 —— 段落被佔住的時候後面的指令全部收不到
      const cur = e.results[e.results.length - 1];
      if (cur && !parse(cur[0].transcript)
          && cur[0].transcript.replace(/\s/g, '').length > MAX_LEN) {
        V.dropped = (V.dropped || 0) + 1;
        note(cur[0].transcript.slice(0, 20) + '…', null);
        try { rec.onend = null; rec.abort(); } catch {}
        setTimeout(start, 150);
        return;
      }
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        let hit = null, shown = res[0] && res[0].transcript;
        // 多個候選只要有一個對得上就算 —— 單音節指令很容易被聽成別的字
        for (let a = 0; a < res.length; a++) {
          const t = res[a].transcript;
          const cmd = parse(t);          // 比對整句，不是比對新增的尾巴
          if (cmd) { hit = cmd; shown = t; break; }
        }
        // 只記 final，interim 會把同一句重送十幾次，記了看不出東西
        if (res.isFinal) { note(shown, hit); vlog('聽到', { text: shown, cmd: hit }); }
        if (hit) fire(hit, shown);
        else cancelIfLonger(res[0].transcript);
      }
    };
    r.onend = () => {
      if (!live()) return;
      V.on = false;
      if (!V.blocked) setTimeout(start, 250);
    };
    return r;
  };

  // 單一實例。先前 abort() 會觸發 onend 再排一次 start()，於是同時存在兩個
  // 辨識器互相打架 —— 症狀就是「第一句聽得懂，之後都沒反應」。
  // 換代號碼讓舊實例的事件全部失效，是唯一可靠的做法。
  const start = V.start = () => {
    if (starting) return;
    starting = true;
    V.blocked = false;
    gen++;
    const myGen = gen;
    try { if (rec) { rec.onend = null; rec.onerror = null; rec.abort(); } } catch {}
    try {
      rec = build(myGen);
      rec.start();
      V.alive = Date.now();
    } catch (e) {
      V.error = String(e && e.message || e);
      vlog('start 丟例外', { msg: V.error });
      setTimeout(() => { starting = false; start(); }, 1200);
      return;
    }
    setTimeout(() => { starting = false; }, 500);
  };

  // 播報期間把辨識器整個停掉，播完再起一次。
  // 只在狀態**改變**的那一刻動作，所以一段導覽最多一次 abort、一次 start。
  let wasSpeaking = false, pausedAt = 0;
  setInterval(() => {
    const sp = !!window.__speaking;
    // 保險：一段導覽最長也就兩三分鐘。暫停超過五分鐘一定是旗標漏放了，
    // 硬是恢復 —— 寧可多聽到一點旁白，也不要語音整個死掉而畫面上看不出來。
    if (sp && pausedAt && Date.now() - pausedAt > 300000) {
      window.__speaking = false; vlog('暫停太久，強制恢復');
      wasSpeaking = false; pausedAt = 0; V.paused = false; start();
      return;
    }
    if (sp === wasSpeaking) return;
    wasSpeaking = sp;
    if (sp) {
      V.paused = true;
      try { if (rec) { rec.onend = null; rec.onerror = null; rec.abort(); } } catch {}
      V.on = false;
      pausedAt = Date.now();
      vlog('播報中，暫停');
    } else {
      V.paused = false;
      pausedAt = 0;
      V.alive = Date.now();
      vlog('播報結束，恢復');
      start();
    }
  }, 300);

  // 看門狗：只在「我們認為它沒在跑」的時候補一腳。
  // 先前不管 on 是 true 還是 false 都 abort 重來，等於好好的辨識器被打斷。
  setInterval(() => {
    if (V.blocked || starting || V.paused) return;
    if (!V.on && Date.now() - V.alive > 6000) start();
  }, 3000);

  vlog('voice.js 載入');
  start();
  // 每十五秒回報一次狀態，就算完全沒聲音也看得出辨識器活著沒
  setInterval(() => vlog('心跳', { last: V.last ? V.last.slice(0, 24) : '' }), 15000);
})();
