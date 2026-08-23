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

  const WORDS = {
    // 後面那幾個是辨識常見的同音誤判 —— zh-TW 對單音節特別不準，
    // 「右」很容易變成「又／有／佑」，「轉」變成「磚／專／賺」。
    left:  ['左', '左轉', '向左', '往左', '左邊',
            '作轉', '做轉', '坐轉', '左磚', '左專'],
    right: ['右', '右轉', '向右', '往右', '右邊',
            '又轉', '有轉', '佑轉', '右磚', '右專', '又賺', '右賺'],
    back:  ['回頭', '掉頭', '迴轉', '回轉', '往回', '後轉',
            '迴頭', '回投', '會頭', '掉頭髮'],
    // 結束一律用兩個字以上的完整說法。單一個「停」太容易誤觸 ——
    // street-runner 上實測過含「停」的句子讓整趟直接結束。
    // 注意「跑完」要列進來 —— parse 會先剝掉尾綴的「了」，
    // 所以「跑完了」進到比對時已經是「跑完」。
    stop:  ['結束跑步', '結束', '跑完'],
    // 「導覽」兩個字辨識率高、也不容易在一般句子裡單獨出現。
    // 不接受就不用說話 —— 完全避開「是／好」這種單音節在跑步機上的誤判。
    guide: ['導覽', '要導覽', '介紹', '要介紹', '導遊', '倒覽', '道覽'],
  };
  // 指令最長就這麼長。超過表示那是一般說話（或電視、旁人講話），
  // 不但不可能命中，還會把辨識段落一直佔住 —— 直接判定不是指令、當場重來。
  const MAX_LEN = 14;
  // 環境吵的時候可以加啟動詞：「小跑右轉」。安靜時直接說「右轉」就好。
  const WAKE = /^(小跑|跑步|嘿小跑)/;
  const parse = t => {
    let x = (t || '').replace(/[\s。，、！？.,!?]/g, '');
    x = x.replace(WAKE, '');
    x = x.replace(/(吧|喔|囉|了|一下|啦)$/, '');
    for (const [cmd, list] of Object.entries(WORDS)) if (list.includes(x)) return cmd;
    return null;
  };

  const V = window.__voice = { on: false, heard: 0, dropped: 0, last: '', log: [], alive: 0, error: null };
  let rec = null, gen = 0, starting = false, lastCmd = null, lastAt = 0;

  const note = (text, cmd) => {
    V.log.unshift({ t: Date.now(), text, cmd: cmd || null });
    if (V.log.length > 12) V.log.pop();
    V.last = text;
  };

  const fire = (cmd, text) => {
    // 同一個指令兩秒內只算一次 —— interim 會把同一句重送很多遍
    if (cmd === lastCmd && Date.now() - lastAt < 2000) return;
    lastCmd = cmd; lastAt = Date.now();
    V.heard++;
    if (typeof window.__turn === 'function') {
      // 這裡丟例外的話 onresult 會中斷，後面的句子就都收不到了
      try { window.__turn(cmd, text); }
      catch (e) { V.error = 'turn:' + (e && e.message || e); }
    }
  };

  const build = myGen => {
    const r = new SR();
    r.lang = 'zh-TW';
    // 一句一個段落。continuous = true 的話 Chrome 會把一長串話累積成同一段，
    // 永遠不下 final；而比對要求「整句等於指令」，那一段就永遠不會命中也不會結束。
    // 症狀正是「聽了一堆沒用的，一串話就卡住不再聽」。
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 4;
    const live = () => myGen === gen;
    r.onstart = () => { if (live()) { V.on = true; V.alive = Date.now(); } };
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
    };
    r.onresult = e => {
      if (!live()) return;
      V.alive = Date.now();
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
        if (res.isFinal) note(shown, hit);
        if (hit) fire(hit, shown);
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
      setTimeout(() => { starting = false; start(); }, 1200);
      return;
    }
    setTimeout(() => { starting = false; }, 500);
  };

  // 看門狗：只在「我們認為它沒在跑」的時候補一腳。
  // 先前不管 on 是 true 還是 false 都 abort 重來，等於好好的辨識器被打斷。
  setInterval(() => {
    if (V.blocked || starting) return;
    if (!V.on && Date.now() - V.alive > 6000) start();
  }, 3000);

  start();
})();
