
// 步頻偵測，從 run-world/lib 攤平而來（去掉 import/export）。
// 校正線與門檻都是實測得到的：2026-08-16 跑步機錄音，低頻 30–200 Hz，
// 信心門檻 0.25（0.35 會讓走路速度掉鎖 28%），km/h = 0.1042 × spm − 8.02。
(function(){
  if (window.__cad) return 'already';
// 步頻偵測 DSP —— sensor-lab 與 run 共用同一份，避免兩邊調參後結果對不起來。

const RATE      = 50;   // 包絡重取樣頻率 (Hz)
const WIN_SEC   = 6;    // 自相關窗長
const SPM_MIN   = 60, SPM_MAX = 250;
const SPM_PRIOR = 170, PRIOR_W = 0.45;
const OCTAVE_TH = 0.72;

// 固定取樣率環形緩衝。
// devicemotion 與音訊輪詢的時間戳都有抖動，而自相關要求等間隔取樣，
// 所以一律用零階保持重取樣到 RATE Hz。
class Envelope {
  constructor(seconds) {
    this.n = Math.ceil(RATE * seconds);
    this.buf = new Float32Array(this.n);
    this.w = 0;              // 已寫入的絕對樣本數
    this.t0 = null;
  }
  push(v, tMs) {
    if (this.t0 === null) { this.t0 = tMs; this.w = 0; }
    const target = Math.floor((tMs - this.t0) / 1000 * RATE);
    if (target < this.w) return;
    if (target - this.w > this.n) this.w = target - this.n;   // 大斷點，跳過
    while (this.w <= target) { this.buf[this.w % this.n] = v; this.w++; }
  }
  latest(count) {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const idx = this.w - count + i;
      out[i] = idx >= 0 ? this.buf[idx % this.n] : 0;
    }
    return out;
  }
  get ready() { return this.w > RATE * 2; }
}

function autocorr(x, lagMin, lagMax) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i] - mean;

  const r = new Float32Array(lagMax + 1);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += y[i] * y[i];
  if (e0 < 1e-9) return r;

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0, ea = 0, eb = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = y[i], b = y[i + lag];
      s += a * b; ea += a * a; eb += b * b;
    }
    const d = Math.sqrt(ea * eb);
    r[lag] = d > 1e-9 ? s / d : 0;
  }
  return r;
}

// 拋物線內插，取得次樣本精度的峰位置
function refine(r, lag) {
  const a = r[lag - 1] ?? 0, b = r[lag], c = r[lag + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-9) return lag;
  const d = 0.5 * (a - c) / denom;
  return lag + Math.max(-0.5, Math.min(0.5, d));
}

function estimateCadence(env) {
  if (!env.ready) return null;
  const x = env.latest(RATE * WIN_SEC);
  const lagMin = Math.floor(60 * RATE / SPM_MAX);
  const lagMax = Math.ceil(60 * RATE / SPM_MIN);
  const r = autocorr(x, lagMin, lagMax);

  let best = -2, bestLag = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const spm = 60 * RATE / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(spm / SPM_PRIOR) / PRIOR_W, 2));
    const score = r[lag] * prior;
    if (score > best) { best = score; bestLag = lag; }
  }
  if (bestLag < 0) return null;

  // 左右腳落地力道通常不對稱，自相關容易鎖到「跨步」（兩步）而非「單步」週期，
  // 步頻就會少算一半 → 若半週期的峰也夠高就折半。
  const half = Math.round(bestLag / 2);
  if (half >= lagMin && r[half] > OCTAVE_TH * r[bestLag]) bestLag = half;

  const lag = refine(r, bestLag);
  return { spm: 60 * RATE / lag, conf: Math.max(0, r[bestLag]), lag, r, lagMin, lagMax };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}


// 感測來源集線器：同時維護四路步頻偵測的包絡，並提供統一的速度輸出。
//
// 之後不管畫面走街景還是影片，都只消費 SensorHub 的 speed/running，
// 這一層抽換掉就能換成藍牙 FTMS 或跑步 pod，畫面端一行都不用改。

const DETECTORS = [
  { id: 'motion', name: '震動',   sub: '加速度計｜不怕音樂' },
  { id: 'low',    name: '低頻',   sub: '30–200 Hz 撞擊' },
  { id: 'high',   name: '高頻',   sub: '1–6 kHz 拍擊' },
  { id: 'flux',   name: '流量',   sub: '頻譜起音偵測' },
];

class SensorHub {
  constructor() {
    this.env = {};
    this.smooth = {};
    this.latest = {};
    for (const d of DETECTORS) {
      this.env[d.id] = new Envelope(WIN_SEC + 2);
      this.smooth[d.id] = [];
      this.latest[d.id] = null;
    }
    this.micOk = false;
    this.motionOk = false;
    this.motionCount = 0;
    this._audio = null;
  }

  async startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 這三個一定要關掉：iOS 的自動增益與降噪會把腳步聲這種脈衝訊號整平
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;   // 預設 0.8 會把脈衝抹平，必須歸零
    ctx.createMediaStreamSource(stream).connect(analyser);

    this._audio = {
      ctx, analyser, stream,
      freq: new Float32Array(analyser.frequencyBinCount),
      prevMag: null,
      emaLow: 0, emaHigh: 0, emaFlux: 0,
    };
    this.micOk = true;
    // 記住 timer 與 stream —— 面板上要能隨時關掉，關不掉的話麥克風會一直亮著
    this._timer = setInterval(() => this._pollMic(), 20);   // 50 Hz 包絡
    return ctx.sampleRate;
  }

  _bandEnergy(lo, hi, binHz) {
    const { freq } = this._audio;
    let sum = 0;
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.min(freq.length - 1, Math.ceil(hi / binHz));
    for (let i = a; i <= b; i++) sum += Math.pow(10, freq[i] / 10);   // dB → 線性功率
    return sum;
  }

  _pollMic() {
    const A = this._audio;
    if (!A) return;
    A.analyser.getFloatFrequencyData(A.freq);
    const binHz = A.ctx.sampleRate / A.analyser.fftSize;
    const t = performance.now();

    const low  = Math.sqrt(this._bandEnergy(30, 200, binHz));
    const high = Math.sqrt(this._bandEnergy(1000, 6000, binHz));

    // 頻譜流量：只累加變大的部分，標準的起音偵測函數
    let flux = 0;
    if (A.prevMag) {
      for (let i = 1; i < A.freq.length; i++) {
        const m = Math.pow(10, A.freq[i] / 20);
        const d = m - A.prevMag[i];
        if (d > 0) flux += d;
        A.prevMag[i] = m;
      }
    } else {
      A.prevMag = new Float32Array(A.freq.length);
      for (let i = 0; i < A.freq.length; i++) A.prevMag[i] = Math.pow(10, A.freq[i] / 20);
    }

    A.emaLow  += (low  - A.emaLow)  * 0.35;
    A.emaHigh += (high - A.emaHigh) * 0.35;
    A.emaFlux += (flux - A.emaFlux) * 0.35;

    this.env.low.push(A.emaLow, t);
    this.env.high.push(A.emaHigh, t);
    this.env.flux.push(A.emaFlux, t);
  }

  async startMotion() {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      const p = await DeviceMotionEvent.requestPermission();   // iOS 13+ 需在使用者手勢中呼叫
      if (p !== 'granted') throw new Error('使用者拒絕動作權限');
    }
    let hp = 0, ema = 0;
    window.addEventListener('devicemotion', e => {
      const a = e.acceleration && e.acceleration.x !== null
        ? e.acceleration : e.accelerationIncludingGravity;
      if (!a) return;
      const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      hp += (mag - hp) * 0.02;                 // 高通：扣掉重力與姿勢的慢速成分
      ema += (Math.abs(mag - hp) - ema) * 0.35; // 低通：重取樣前的抗混疊
      this.env.motion.push(ema, performance.now());
      this.motionCount++;
    });
    this.motionOk = true;
  }

  // 更新全部偵測器，回傳 {id: {spm, conf, ...}}
  update() {
    for (const d of DETECTORS) {
      const est = estimateCadence(this.env[d.id]);
      if (!est) { this.latest[d.id] = null; continue; }
      const s = this.smooth[d.id];
      s.push(est.spm);
      if (s.length > 5) s.shift();
      this.latest[d.id] = { ...est, spm: median(s) };
    }
    return this.latest;
  }
}

// 步頻 → 速度的線性校正。預設值來自一般跑者的粗略斜率，
// 一定要用 sensor-lab 錄到的真實資料重新擬合，這只是能動的起點。
const DEFAULT_CAL = { a: 0.333, b: -47 };   // km/h = a * spm + b

function cadenceToSpeed(spm, cal = DEFAULT_CAL) {
  return Math.max(0, cal.a * spm + cal.b);
}

// 由兩個 (步頻, 速度) 校正點解出線性係數
function fitCal(p1, p2) {
  const a = (p2.kmh - p1.kmh) / (p2.spm - p1.spm);
  return { a, b: p1.kmh - a * p1.spm };
}


  const hub = new SensorHub();
  window.__cad = { spm: null, kmh: null, hub };

  hub.startMic().then(() => {
    setInterval(() => {
      // 播報時麥克風收到的是自己的喇叭聲，量測無效 —— 跟 run-world 一樣要跳過
      const speaking = (window.__srAudio && !window.__srAudio.paused)
        || (window.speechSynthesis && speechSynthesis.speaking);
      if (speaking) return;
      const est = hub.update().low;
      if (est && est.conf > 0.25) {
        window.__cad.spm = est.spm;
        window.__cad.kmh = Math.max(0, 0.1042 * est.spm - 8.02);
        window.__cad.at = Date.now();
      }
    }, 500);
  }).catch(e => { window.__cad.error = String(e && e.message || e); });

  return 'started';
})()
