// ── 迷你 FIT 編碼器 ─────────────────────────────────────────
// 只為一件事存在:TCX 標不了「虛擬活動」,FIT 的 sub_sport=58 可以 ——
// Garmin 顯示「虛擬跑步/騎行」,同步 Strava 自動變 VirtualRun/Ride(Zwift 同款)。
// track: [{lat,lng,t,e?,h?,w?,c?}], ride: true=騎車
(function (g) {
  const EPOCH = 631065600;                     // FIT 紀元:1989-12-31 UTC(秒)
  const SC = 2 ** 31 / 180;                    // 度 → semicircles

  function crc16(bytes) {
    const T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
               0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
    let c = 0;
    for (const b of bytes) {
      let t = T[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ T[b & 0xF];
      t = T[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ T[(b >> 4) & 0xF];
    }
    return c;
  }

  function buildFIT(track, ride) {
    const out = [];
    const u8 = v => out.push(v & 0xFF);
    const u16 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
    const u32 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); };
    const s32 = v => u32(v < 0 ? v + 0x100000000 : v);
    const ts = t => Math.round(t / 1000) - EPOCH;

    // 累積距離(公尺):軌跡點帶皮帶里程(m)就以跑步機為準,沒有才用座標推算
    let dist;
    if (track[0].m != null) {
      const m0 = track[0].m;
      dist = track.map(p => Math.max(0, (p.m ?? m0) - m0));
      for (let i = 1; i < dist.length; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
    } else {
      dist = [0];
      for (let i = 1; i < track.length; i++) {
        const a = track[i - 1], b = track[i];
        const dp = (b.lat - a.lat) * Math.PI / 180, dl = (b.lng - a.lng) * Math.PI / 180;
        const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dl / 2) ** 2;
        dist.push(dist[i - 1] + 2 * 6371000 * Math.asin(Math.sqrt(h)));
      }
    }
    const t0 = track[0].t, tN = track[track.length - 1].t;
    const secs = Math.max(1, (tN - t0) / 1000);

    // ── file_id(local 0)──
    u8(0x40); u8(0); u8(0); u16(0); u8(5);
    u8(0); u8(1); u8(0x00);                    // type: enum
    u8(1); u8(2); u8(0x84);                    // manufacturer: u16
    u8(2); u8(2); u8(0x84);                    // product
    u8(3); u8(4); u8(0x8C);                    // serial: u32z
    u8(4); u8(4); u8(0x86);                    // time_created
    u8(0x00); u8(4); u16(255); u16(0); u32(0x2ABCDEF); u32(ts(t0));

    // ── record(local 1)──
    u8(0x41); u8(0); u8(0); u16(20); u8(9);
    u8(253); u8(4); u8(0x86);                  // timestamp
    u8(0); u8(4); u8(0x85);                    // lat s32
    u8(1); u8(4); u8(0x85);                    // lng s32
    u8(5); u8(4); u8(0x86);                    // distance *100
    u8(2); u8(2); u8(0x84);                    // altitude (m+500)*5
    u8(6); u8(2); u8(0x84);                    // speed m/s*1000
    u8(3); u8(1); u8(0x02);                    // heart_rate
    u8(4); u8(1); u8(0x02);                    // cadence
    u8(7); u8(2); u8(0x84);                    // power
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      u8(0x01);
      u32(ts(p.t));
      s32(Math.round(p.lat * SC)); s32(Math.round(p.lng * SC));
      u32(Math.round(dist[i] * 100));
      u16(p.e != null ? Math.round((p.e + 500) * 5) : 0xFFFF);
      const dt = i ? (p.t - track[i - 1].t) / 1000 : 0;
      u16(dt > 0 ? Math.min(65000, Math.round((dist[i] - dist[i - 1]) / dt * 1000)) : 0);
      u8(p.h || 0xFF);
      u8(p.c != null && p.c > 0 ? Math.min(254, p.c) : 0xFF);
      u16(p.w != null ? p.w : 0xFFFF);
    }

    // ── session(local 2)──
    u8(0x42); u8(0); u8(0); u16(18); u8(9);
    u8(253); u8(4); u8(0x86);
    u8(2); u8(4); u8(0x86);                    // start_time
    u8(7); u8(4); u8(0x86);                    // total_elapsed_time *1000
    u8(8); u8(4); u8(0x86);                    // total_timer_time *1000
    u8(9); u8(4); u8(0x86);                    // total_distance *100
    u8(5); u8(1); u8(0x00);                    // sport
    u8(6); u8(1); u8(0x00);                    // sub_sport
    u8(0); u8(1); u8(0x00);                    // event
    u8(1); u8(1); u8(0x00);                    // event_type
    u8(0x02);
    u32(ts(tN)); u32(ts(t0)); u32(Math.round(secs * 1000)); u32(Math.round(secs * 1000));
    u32(Math.round(dist[dist.length - 1] * 100));
    u8(ride ? 2 : 1);                          // sport: cycling/running
    u8(58);                                    // sub_sport 58 = virtual_activity ★重點
    u8(8); u8(1);                              // event=session, event_type=stop

    // ── activity(local 3)──
    u8(0x43); u8(0); u8(0); u16(34); u8(6);
    u8(253); u8(4); u8(0x86);
    u8(0); u8(4); u8(0x86);                    // total_timer_time
    u8(1); u8(2); u8(0x84);                    // num_sessions
    u8(2); u8(1); u8(0x00);                    // type
    u8(3); u8(1); u8(0x00);                    // event
    u8(4); u8(1); u8(0x00);                    // event_type
    u8(0x03);
    u32(ts(tN)); u32(Math.round(secs * 1000)); u16(1); u8(0); u8(26); u8(1);

    // ── 檔頭+CRC ──
    const dataBytes = out.slice();
    const head = [14, 0x20, 0x6B, 0x08,
      dataBytes.length & 0xFF, (dataBytes.length >> 8) & 0xFF,
      (dataBytes.length >> 16) & 0xFF, (dataBytes.length >> 24) & 0xFF,
      0x2E, 0x46, 0x49, 0x54];                 // ".FIT"
    const hcrc = crc16(head);
    head.push(hcrc & 0xFF, (hcrc >> 8) & 0xFF);
    const all = head.concat(dataBytes);
    const fcrc = crc16(all);
    all.push(fcrc & 0xFF, (fcrc >> 8) & 0xFF);
    return new Uint8Array(all);
  }

  if (typeof module !== 'undefined') module.exports = buildFIT;
  else g.buildFIT = buildFIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
