// app.js - dashboard logic
// flow every (farm) minute:  readings -> safety checks -> learning -> auto decision -> pump command

const user = requireLogin();
if (!user) throw new Error('not logged in');

const ZONES = 2;
const TICK_MS = 250;
const SAVE_EVERY_MS = 2000;
const CMD_TIMEOUT_MS = 3000;
const DRY_RUN_MIN = 5;      // after this many minutes of pumping ...
const DRY_RUN_RISE = 2;     // ... moisture must have risen at least this much, else pipe/tank problem
const SPEEDS = [[1, 'Real time'], [60, '1 s = 1 min'], [600, '1 s = 10 min'], [3600, '1 s = 1 hour']];

// Demo only: the virtual farmer's routine. Real people are not exact, so the time moves
// a bit every day and some days are skipped. The system has to learn this from the clicks.
const FARMER_HABITS = [
  [{ at: 6 * 60 + 30, jitter: 12 }, { at: 17 * 60 + 45, jitter: 15 }],  // zone 1: morning + evening
  [{ at: 7 * 60 + 15, jitter: 10 }]                                       // zone 2: once a day
];

const BY_LABEL = { farmer: 'Farmer', auto: 'Auto', safety: 'Safety', device: 'Arduino' };
const WARN_TEXT = {
  NO_PING_PUMP_OFF: 'Arduino switched the pumps off: no signal from the dashboard for 5 s',
  MAX_RUN_PUMP_OFF: 'Arduino switched a pump off: 30 minute hard limit'
};

const A = {
  source: null,          // 'arduino' | 'demo' | null
  link: null, sim: null, timer: null,
  key: null, data: null,
  r: { ldr: null, temp: null, m: [null, null], real: false },
  pump: [false, false], pending: [null, null],
  since: [0, 0], startM: [0, 0], runBy: ['', ''], target: [0, 0], checkedRise: [false, false],
  simFarmer: [false, false],
  lastMin: null, today: null, plan: null, farmer: true,
  tab: 'overview', lastSave: 0, lastRender: 0
};

const Z = i => A.data.zones[i];
const cropOf = i => CROPS[Z(i).crop] || CROPS.tomato;
const nowT = () => A.source === 'demo' ? A.sim.time : Date.now();
const midBand = c => Math.round((c.moist[0] + c.moist[1]) / 2);


/* ================= saved data ================= */

function newZone(i) {
  const d = [{ name: 'Zone 1 - front bed', crop: 'tomato' }, { name: 'Zone 2 - back rows', crop: 'chilli' }][i];
  return {
    name: d.name, crop: d.crop, enabled: true,
    auto: false, topUp: true, maxRun: 20,
    events: [],     // waterings used for learning the schedule
    actions: [],    // every pump on/off
    skips: [],      // learned slots that were skipped (soil already wet)
    history: [],    // { t, m } every 5 min
    scores: [],     // { t, s } hourly health score
    model: NeedModel.empty(),
    rate: Baseline.empty(),
    flags: {}, dryRuns: 0, pausedUntil: 0,
    lowSince: null, badMin: 0, goodMin: 0, hourMark: null, lastHist: 0
  };
}

function newData() { return { v: 2, zones: [newZone(0), newZone(1)], log: [], sim: null }; }

function loadData(src) {
  A.key = `si_data_${user.username}_${src}`;
  const d = store.get(A.key, null);
  A.data = d && d.v === 2 ? d : newData();
  // fill in fields that older saves might not have
  A.data.zones = A.data.zones.map((z, i) => Object.assign(newZone(i), z));
}

function saveData(force) {
  if (!A.data || (!force && Date.now() - A.lastSave < SAVE_EVERY_MS)) return;
  A.lastSave = Date.now();
  store.set(A.key, A.data);
}

function addLog(text, kind = '') {
  A.data.log.push({ t: A.source ? nowT() : Date.now(), text, kind });
  trim(A.data.log, 300);
}

function serialLog(line, dir = '') {
  const el = $('serialLog');
  const lines = (el.textContent + `${new Date().toLocaleTimeString()} ${dir} ${line}\n`).split('\n');
  el.textContent = lines.slice(-200).join('\n');
  el.scrollTop = el.scrollHeight;
}


/* ================= pumps ================= */

// by: 'farmer' | 'auto' | 'safety'     opts: { target, kind }
function setPump(i, on, by, reason, opts = {}) {
  if (!A.source || A.pump[i] === on || A.pending[i]) return;
  if (A.source === 'arduino') {
    A.pending[i] = { on, by, reason, opts, at: Date.now() };
    A.link.send((on ? 'ON' : 'OFF') + (i + 1));
  } else {
    applyPump(i, on, by, reason, opts);
  }
  render(true);
}

// the pump really changed (demo: straight away, Arduino: when it confirms)
function applyPump(i, on, by, reason, opts = {}) {
  if (A.pump[i] === on) return;
  const z = Z(i), t = nowT(), m = A.r.m[i];
  A.pump[i] = on;

  if (on) {
    A.since[i] = t;
    A.startM[i] = m;
    A.runBy[i] = by;
    A.target[i] = opts.target || cropOf(i).moist[1];
    A.checkedRise[i] = false;
    if (by === 'farmer') learnFromFarmer(i, t, m);
    // an automatic run at a learned time that the farmer lets happen confirms the habit
    // (otherwise, once automatic, the farmer never presses the button and everything would be forgotten).
    // Saved at the slot's own time, otherwise starting a few minutes early would slowly drag the schedule earlier.
    if (opts.kind === 'slot') {
      const sm = Math.round(opts.slotMin);
      z.events.push({ t, min: sm, day: dayKey(t), m, dur: null, auto: true });
      trim(z.events, 300);
      for (const dm of [-6, -3, 0, 3, 6]) NeedModel.train(z.model, needFeatures(i, t, sm + dm, m), 1);
    }
  } else {
    const runMin = (t - A.since[i]) / 6e4;
    const ev = z.events.find(e => e.t === A.since[i]);
    if (ev) {
      ev.dur = Math.max(1, Math.round(runMin));
      // farmer stopped an automatic run almost immediately -> not wanted, do not learn from it
      if (ev.auto && by === 'farmer' && runMin < 5) {
        ev.rejected = true;
        addLog(`${z.name}: farmer cancelled the automatic run, learning from that`, 'farmer');
      }
    }
    A.simFarmer[i] = false;
  }

  z.actions.push({ t, on, by, kind: opts.kind || by, reason: reason || '', m });
  trim(z.actions, 400);
  addLog(`${z.name}: pump ${on ? 'ON' : 'OFF'} - ${reason}`, by);
}

function learnFromFarmer(i, t, m) {
  const z = Z(i), min = minuteOfDay(t);
  z.events.push({ t, min, day: dayKey(t), m, dur: null });
  trim(z.events, 300);
  // positive examples for the need model. A few time-shifted copies teach it a time
  // window instead of one exact minute.
  for (const dm of [-6, -3, 0, 3, 6]) NeedModel.train(z.model, needFeatures(i, t, min + dm, m), 1);
  z.pausedUntil = t + 30 * 6e4;   // auto mode stays out of the way for a bit after manual use
}

function lastRunStart(i, before) {
  const a = Z(i).actions;
  for (let k = a.length - 1; k >= 0; k--) if (a[k].on && a[k].t < before) return a[k].t;
  return null;
}

function needFeatures(i, t, min, m) {
  const last = lastRunStart(i, t);
  return NeedModel.features(m, A.r.temp ?? 27, A.r.ldr ?? 500, min, last ? (t - last) / 36e5 : 24);
}

// list of [start, end] pump runs that overlap a time range
function pumpRuns(i, from, to) {
  const runs = [];
  let start = null;
  for (const a of Z(i).actions) {
    if (a.on) start = a.t;
    else if (start != null) { if (a.t > from) runs.push([Math.max(start, from), a.t]); start = null; }
  }
  if (start != null && A.pump[i]) runs.push([Math.max(start, from), to]);
  return runs.filter(r => r[1] > r[0]);
}


/* ================= every farm minute ================= */

function onMinute(t) {
  const min = minuteOfDay(t);
  if (dayKey(t) !== A.today) newDay(t);

  for (let i = 0; i < ZONES; i++) {
    const z = Z(i), m = A.r.m[i];
    if (!z.enabled || m == null) continue;

    sensorCheck(i, t, m);
    safetyCheck(i, t, m);

    if (t - z.lastHist >= 5 * 6e4) {
      z.lastHist = t;
      z.history.push({ t, m });
      trim(z.history, 3 * 288);
    }
    if (!z.hourMark || t - z.hourMark.t >= 36e5) hourly(i, t, m);

    if (!z.flags.sensor && m < cropOf(i).moist[0]) z.lowSince = z.lowSince || t;
    else z.lowSince = null;

    // negative example: the farmer did not water this minute (sampled, otherwise 1439 "no" per day drown the "yes")
    if (!A.pump[i] && !z.flags.sensor && Math.random() < 1 / 30) NeedModel.train(z.model, needFeatures(i, t, min, m), 0);
  }

  if (A.source === 'demo') virtualFarmer(t, min);
  for (let i = 0; i < ZONES; i++) if (Z(i).enabled && A.r.m[i] != null) autoDecide(i, t, min);
}

function newDay(t) {
  A.today = dayKey(t);
  A.plan = FARMER_HABITS.map(hs => hs.map(h => ({
    at: Math.random() < 0.08 ? -1 : h.at + Math.round((Math.random() * 2 - 1) * h.jitter),
    done: false
  })));
}

// a reading of 0-1 % for 20 minutes means the sensor is out of the soil / unplugged
function sensorCheck(i, t, m) {
  const z = Z(i);
  if (m <= 1) {
    z.goodMin = 0;
    if (++z.badMin >= 20 && !z.flags.sensor) {
      z.flags.sensor = t;
      addLog(`${z.name}: moisture sensor looks disconnected (reads ${m}%)`, 'safety');
      toast(`${z.name}: moisture sensor problem - auto watering paused`);
      if (A.pump[i]) setPump(i, false, 'safety', 'sensor fault');
    }
  } else {
    z.badMin = 0;
    if (z.flags.sensor && ++z.goodMin >= 10) {
      delete z.flags.sensor;
      addLog(`${z.name}: moisture sensor reading normal again`);
    }
  }
}

function safetyCheck(i, t, m) {
  if (!A.pump[i]) return;
  const z = Z(i), run = (t - A.since[i]) / 6e4;
  if (m <= 1 && A.startM[i] > 1) return setPump(i, false, 'safety', 'moisture reading dropped to 0%, sensor problem?');
  if (run >= DRY_RUN_MIN && !A.checkedRise[i]) {
    A.checkedRise[i] = true;
    if (m - A.startM[i] < DRY_RUN_RISE) {
      z.flags.dryRun = t;
      z.dryRuns = (z.dryRuns || 0) + 1;
      toast(`${z.name}: pump running but soil not getting wet!`);
      return setPump(i, false, 'safety', `no rise after ${DRY_RUN_MIN} min (${A.startM[i]}% → ${m}%), pipe blocked or tank empty?`);
    }
    z.dryRuns = 0;
  }
  if (run >= z.maxRun) setPump(i, false, 'safety', `max run time ${z.maxRun} min reached`);
}

function hourly(i, t, m) {
  const z = Z(i), prev = z.hourMark;
  z.hourMark = { t, m };
  const plausible = m > 1 && prev && prev.m > 1;   // 0 % = sensor out of the soil, not real drying
  if (plausible && t - prev.t < 90 * 6e4 && !z.flags.sensor && !A.pump[i] && !pumpRuns(i, prev.t, t).length) {
    const rate = (prev.m - m) * 36e5 / (t - prev.t);   // % lost per hour
    const h = new Date(prev.t).getHours();
    if (rate < -3) {
      addLog(`${z.name}: moisture rose ${Math.round(-rate)}% without the pump (rain?)`);
    } else {
      if (Baseline.isUnusual(z.rate, h, rate)) {
        z.flags.fastDry = { t, rate, usual: z.rate.mean[h] };
        addLog(`${z.name}: drying unusually fast (${rate.toFixed(1)} %/h, usual ${z.rate.mean[h].toFixed(1)})`, 'safety');
      }
      Baseline.update(z.rate, h, rate);
    }
  }
  const hl = Health.assess(z, cropOf(i), { m, temp: A.r.temp, ldr: A.r.ldr }, t);
  z.scores.push({ t, s: hl.score });
  trim(z.scores, 72);
}

// the automatic controller
function autoDecide(i, t, min) {
  const z = Z(i), c = cropOf(i), m = A.r.m[i];
  if (!z.auto || A.pending[i]) return;

  if (A.pump[i]) {
    if (A.runBy[i] === 'auto' && m >= A.target[i]) setPump(i, false, 'auto', `reached ${m}% (target ${A.target[i]}%)`);
    return;
  }
  if (z.flags.sensor || m <= 1) return;
  // pump ran dry: try again after 3 h (tank may be refilled), after 2 failures wait for the farmer
  if (z.flags.dryRun && (z.dryRuns >= 2 || t - z.flags.dryRun < 3 * 36e5)) return;
  if (t < z.pausedUntil) return;

  const mid = midBand(c);

  // 1. emergency - plant is wilting, schedule does not matter
  if (m < c.critical) return setPump(i, true, 'auto', `soil critically dry (${m}% < ${c.critical}%)`, { target: mid, kind: 'critical' });

  // 2. a learned farmer time
  const slot = ScheduleLearner.due(ScheduleLearner.slots(z.events, t), min, 5, 20);
  if (slot && !slotHandled(i, t, slot)) {
    if (m < mid + 3) {
      return setPump(i, true, 'auto', `learned time ${fmtMin(slot.mean)} (confidence ${Math.round(slot.conf * 100)}%)`, { target: c.moist[1], kind: 'slot', slotMin: slot.mean });
    }
    z.skips.push({ t, m, slot: slot.mean });
    trim(z.skips, 100);
    addLog(`${z.name}: skipped the ${fmtMin(slot.mean)} watering, soil already moist (${m}%)`, 'auto');
    return;
  }

  const last = lastRunStart(i, t + 1);
  if (last && t - last < 2 * 36e5) return;

  // 3. the logistic regression thinks the farmer would water now
  const p = NeedModel.predict(z.model, needFeatures(i, t, min, m));
  if (p >= 0.6 && m < mid && z.model.pos >= 15) {
    return setPump(i, true, 'auto', `model: farmer usually waters now (p = ${p.toFixed(2)})`, { target: c.moist[1], kind: 'model' });
  }

  // 4. top-up: soil below ideal for a while. Not 11-16 h (evaporation) and not at night (fungus)
  const h = Math.floor(min / 60);
  const okHour = (h >= 5 && h < 11) || (h >= 16 && h < 20);
  if (z.topUp && okHour && z.lowSince && t - z.lowSince >= 45 * 6e4) {
    return setPump(i, true, 'auto', `top-up: below ideal ${c.moist[0]}% for ${Math.round((t - z.lowSince) / 6e4)} min`, { target: mid + 5, kind: 'topup' });
  }
}

// a slot counts as handled today if any watering started, or a skip was logged, near its time
function slotHandled(i, t, slot) {
  const z = Z(i), d0 = startOfDay(t);
  const near = x => x >= d0 && Math.abs(minuteOfDay(x) - slot.mean) <= 45;
  return z.actions.some(a => a.on && near(a.t)) || z.skips.some(k => near(k.t));
}

// demo only
function virtualFarmer(t, min) {
  if (!A.farmer || !A.plan) return;
  for (let i = 0; i < ZONES; i++) {
    const z = Z(i), c = cropOf(i), m = A.r.m[i];
    if (!z.enabled || m == null) continue;

    if (A.pump[i] && A.simFarmer[i]) {
      if (m >= c.moist[1] - 2 || (t - A.since[i]) / 6e4 >= 25) setPump(i, false, 'farmer', 'farmer switched it off');
      continue;
    }
    for (const p of A.plan[i] || []) {
      if (p.done || p.at !== min) continue;
      p.done = true;
      if (A.pump[i]) break;
      // once the system has taken over this time, the farmer stops doing it by hand
      if (z.auto && ScheduleLearner.due(ScheduleLearner.slots(z.events, t), min, 40, 40)) break;
      const last = lastRunStart(i, t + 1);
      if (last && t - last < 60 * 6e4) break;
      A.simFarmer[i] = true;
      setPump(i, true, 'farmer', 'farmer switched it on');
    }
  }
}


/* ================= sources: demo / Arduino ================= */

function resetRuntime() {
  A.r = { ldr: null, temp: null, m: [null, null], real: false };
  A.pump = [false, false];
  A.pending = [null, null];
  A.simFarmer = [false, false];
  A.lastMin = A.today = A.plan = null;
}

function startDemo() {
  if (A.source === 'demo') return stopDemo();
  if (A.source) return;
  A.source = 'demo';
  loadData('demo');
  resetRuntime();
  A.sim = new FarmSimulator(A.data.sim || {});
  A.sim.crops = A.data.zones.map(z => z.crop);
  Object.assign(A.r, A.sim.read());   // show something straight away, even at real-time speed
  if (!A.data.sim) addLog('Demo started - virtual farmer will water by habit, watch the Learning page');
  $('speedSel').value = A.sim.speed;
  A.timer = setInterval(demoTick, TICK_MS);
  syncSetup();
  render(true);
}

function stopDemo() {
  clearInterval(A.timer);
  A.data.sim = A.sim.state();
  saveData(true);
  A.source = null;
  resetRuntime();
  loadData('arduino');
  syncSetup();
  render(true);
}

function demoTick() {
  const n = A.sim.minutesFor(TICK_MS);
  for (let k = 0; k < n; k++) {
    A.sim.pump = A.pump.slice();
    A.sim.step();
    Object.assign(A.r, A.sim.read());
    onMinute(A.sim.time);
  }
  if (n) { A.data.sim = A.sim.state(); saveData(); }
  render();
}

async function toggleArduino() {
  if (A.source === 'arduino') return A.link.disconnect('Disconnected');
  if (A.source === 'demo') stopDemo();
  try {
    await A.link.connect();
  } catch (err) {
    if (err.name !== 'NotFoundError') toast('Could not connect: ' + err.message);
    return;
  }
  A.source = 'arduino';
  loadData('arduino');
  resetRuntime();
  addLog('Arduino connected');
  A.timer = setInterval(liveTick, 1000);
  syncSetup();
  render(true);
}

function liveTick() {
  for (let i = 0; i < ZONES; i++) {
    const p = A.pending[i];
    if (p && Date.now() - p.at > CMD_TIMEOUT_MS) {
      A.pending[i] = null;
      toast(`Arduino did not confirm pump ${i + 1} ${p.on ? 'ON' : 'OFF'}`);
    }
  }
  render();
}

A.link = new ArduinoLink({
  onData(r) {
    Object.assign(A.r, r);
    const mk = Math.floor(Date.now() / 6e4);
    if (mk !== A.lastMin) { A.lastMin = mk; onMinute(Date.now()); }
    saveData();
    render();
  },
  onPump(i, on) {
    const p = A.pending[i];
    A.pending[i] = null;
    if (p && p.on === on) applyPump(i, on, p.by, p.reason, p.opts);
    else applyPump(i, on, on ? 'device' : 'safety', on ? 'switched on by the Arduino (offline care)' : 'switched off by the Arduino');
    render(true);
  },
  onWarn(code) {
    const text = WARN_TEXT[code] || code;
    toast(text);
    addLog(text, 'safety');
  },
  onLine: serialLog,
  onClose(reason) {
    clearInterval(A.timer);
    saveData(true);
    A.source = null;
    resetRuntime();
    if (reason) toast(reason);
    serialLog(reason || 'Disconnected');
    render(true);
  }
});


/* ================= drawing helpers (plain SVG) ================= */

function moistureChart(i, t) {
  const z = Z(i), c = cropOf(i);
  const W = 640, H = 200, L = 32, R = 8, T = 8, B = 22, span = 24 * 36e5, from = t - span;
  const x = tt => L + (tt - from) / span * (W - L - R);
  const y = v => T + (100 - clamp(v, 0, 100)) / 100 * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Soil moisture, last 24 hours">`;

  for (const r of pumpRuns(i, from, t)) {
    s += `<rect x="${x(r[0]).toFixed(1)}" y="${T}" width="${Math.max(2, x(r[1]) - x(r[0])).toFixed(1)}" height="${H - T - B}" fill="#2c74b8" opacity=".14"/>`;
  }
  s += `<rect x="${L}" y="${y(c.moist[1])}" width="${W - L - R}" height="${y(c.moist[0]) - y(c.moist[1])}" fill="#2f7d4f" opacity=".1"/>`;
  for (const v of [0, 25, 50, 75, 100]) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8e3"/>`;
    s += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`;
  }
  s += `<line x1="${L}" x2="${W - R}" y1="${y(c.critical)}" y2="${y(c.critical)}" stroke="#c9473f" stroke-dasharray="5 5"/>`;

  // hour labels every 6 h
  const off = new Date().getTimezoneOffset() * 6e4;   // so labels land on local 00/06/12/18
  for (let ht = Math.ceil((from - off) / (6 * 36e5)) * 6 * 36e5 + off; ht <= t; ht += 6 * 36e5) {
    s += `<text x="${x(ht)}" y="${H - 6}" text-anchor="middle" class="ax">${fmtTime(ht)}</text>`;
  }

  // line, broken where data is missing
  let seg = [], last = null;
  const flush = () => { if (seg.length > 1) s += `<polyline points="${seg.join(' ')}" fill="none" stroke="#22603b" stroke-width="2" stroke-linejoin="round"/>`; seg = []; };
  for (const p of z.history) {
    if (p.t < from) continue;
    if (last && p.t - last > 20 * 6e4) flush();
    seg.push(`${x(p.t).toFixed(1)},${y(p.m).toFixed(1)}`);
    last = p.t;
  }
  flush();
  if (!z.history.some(p => p.t >= from)) s += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="ax">No readings yet</text>`;
  return s + '</svg>';
}

function timelineChart(i, t, slots) {
  const z = Z(i), days = 10, W = 640, rowH = 22, L = 64, R = 8, T = 20, H = T + days * rowH + 4;
  const x = min => L + min / 1440 * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Watering times, last 10 days">`;

  for (const sl of slots.filter(sl => sl.learned)) {
    const a = x(Math.max(0, sl.mean - Math.max(10, sl.std))), b = x(Math.min(1440, sl.mean + Math.max(10, sl.std)));
    s += `<rect x="${a}" y="${T - 4}" width="${b - a}" height="${days * rowH + 4}" fill="#2c74b8" opacity=".12" rx="3"/>`;
  }
  for (let hr = 0; hr <= 24; hr += 3) {
    s += `<line x1="${x(hr * 60)}" x2="${x(hr * 60)}" y1="${T - 4}" y2="${H}" stroke="#e8ece8"/>`;
    s += `<text x="${x(hr * 60)}" y="12" text-anchor="middle" class="ax">${pad(hr % 24)}:00</text>`;
  }

  const today = startOfDay(t);
  for (let d = 0; d < days; d++) {
    const d0 = today - (days - 1 - d) * 864e5, d1 = d0 + 864e5, cy = T + d * rowH + rowH / 2;
    s += `<text x="4" y="${cy + 4}" class="ax">${fmtDate(d0).slice(0, 6)}</text>`;
    s += `<line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" stroke="#f0f2f0"/>`;
    for (const a of z.actions) {
      if (!a.on || a.t < d0 || a.t >= d1) continue;
      const col = a.by === 'farmer' ? '#2f7d4f' : a.kind === 'slot' ? '#2c74b8' : '#d08a10';
      s += `<circle cx="${x(minuteOfDay(a.t))}" cy="${cy}" r="5.5" fill="${col}"><title>${fmtTime(a.t)} ${esc(a.reason)}</title></circle>`;
    }
    for (const k of z.skips) {
      if (k.t < d0 || k.t >= d1) continue;
      s += `<circle cx="${x(minuteOfDay(k.t))}" cy="${cy}" r="5" fill="#fff" stroke="#8a978e" stroke-width="1.5"><title>skipped, soil ${k.m}%</title></circle>`;
    }
  }
  return s + '</svg>';
}

// typical day shape, only used for the "chance by hour" bars
const typicalLdr = h => Math.round(40 + 900 * Math.max(0, Math.sin((h - 6) / 12 * Math.PI)));
const typicalTemp = h => 27 - 6 * Math.cos((h - 15) / 24 * 2 * Math.PI);

function hourBars(i) {
  const z = Z(i), ev = z.events.filter(e => !e.auto).slice(-20);
  const m = ev.length ? Math.round(avg(ev.map(e => e.m))) : cropOf(i).moist[0];   // moisture the farmer usually waters at
  const W = 640, H = 120, L = 30, R = 8, T = 8, B = 20, bw = (W - L - R) / 24;
  const y = p => T + (1 - p) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Predicted chance of watering by hour">`;
  for (const p of [0, 0.5, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="#e8ece8"/><text x="${L - 5}" y="${y(p) + 4}" text-anchor="end" class="ax">${p * 100}%</text>`;
  for (let h = 0; h < 24; h++) {
    const p = NeedModel.predict(z.model, NeedModel.features(m, typicalTemp(h), typicalLdr(h), h * 60 + 30, 8));
    s += `<rect x="${(L + h * bw + 2).toFixed(1)}" y="${y(p).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${(y(0) - y(p)).toFixed(1)}" fill="${p >= 0.5 ? '#2c74b8' : '#9fc2e3'}" rx="2"><title>${pad(h)}:00 - ${Math.round(p * 100)}%</title></rect>`;
    if (h % 3 === 0) s += `<text x="${L + h * bw + bw / 2}" y="${H - 5}" text-anchor="middle" class="ax">${pad(h)}</text>`;
  }
  return s + '</svg>';
}

function ring(score, level) {
  const r = 34, C = 2 * Math.PI * r, v = score ?? 0;
  const col = { good: '#2f7d4f', warn: '#c98a12', bad: '#c9473f' }[level] || '#b5beb8';
  return `<svg viewBox="0 0 84 84" width="84" height="84" role="img" aria-label="Health score ${score ?? 'unknown'}">
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="#e8ece8" stroke-width="8"/>
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${(C * v / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 42 42)"/>
    <text x="42" y="48" text-anchor="middle" font-size="20" font-weight="700" fill="#1e2b22">${score ?? '--'}</text></svg>`;
}

function sparkline(points) {
  const W = 300, H = 50;
  if (points.length < 2) return '<p class="muted small">Builds up hour by hour.</p>';
  const x = k => k / (points.length - 1) * W, y = v => H - 4 - v / 100 * (H - 8);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart spark"><line x1="0" x2="${W}" y1="${y(80)}" y2="${y(80)}" stroke="#d9e8de" stroke-dasharray="4 4"/>
    <polyline fill="none" stroke="#2f7d4f" stroke-width="2" points="${points.map((p, k) => `${x(k).toFixed(1)},${y(p.s).toFixed(1)}`).join(' ')}"/></svg>`;
}

// only touch the DOM when something changed (keeps buttons clickable while re-rendering)
function setHTML(id, html) { const el = $(id); if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
function setText(id, text) { const el = $(id); if (el && el.textContent !== String(text)) el.textContent = text; }


/* ================= build the per-zone parts of the page once ================= */

function buildUI() {
  const cropOptions = Object.entries(CROPS).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('');
  const zones = [...Array(ZONES).keys()];

  $('ovZones').innerHTML = zones.map(i => `
    <div class="card zone-card">
      <div class="zc-head"><div><h3 id="ovName${i}"></h3><span class="muted small" id="ovCrop${i}"></span></div><span class="pill" id="ovPump${i}">Stopped</span></div>
      <div class="zc-body">
        <div><div class="big"><span id="ovM${i}">--</span><span class="unit">%</span></div><div class="muted small">soil moisture</div></div>
        <div class="zc-score"><span id="ovScore${i}">--</span><small id="ovStatus${i}" class="muted"></small></div>
      </div>
      <div class="band-meter"><div class="crit" id="ovCrit${i}"></div><div class="band" id="ovBand${i}"></div><div class="mark" id="ovMark${i}"></div></div>
      <div class="band-labels"><span>dry</span><span id="ovIdeal${i}"></span><span>wet</span></div>
      <div class="zc-foot"><span id="ovMode${i}"></span><span id="ovNext${i}"></span></div>
    </div>`).join('');

  $('ovCharts').innerHTML = zones.map(i => `
    <div class="card"><div class="card-head"><h3 id="chTitle${i}"></h3><span class="muted small">last 24 h</span></div>
      <div id="chart${i}"></div>
      <div class="legend"><span><i class="lg band"></i>ideal range</span><span><i class="lg crit"></i>wilting point</span><span><i class="lg pump"></i>pump running</span></div>
    </div>`).join('');

  $('pumpZones').innerHTML = zones.map(i => `
    <div class="card">
      <div class="card-head"><h3 id="pcName${i}"></h3><span class="muted small" id="pcCrop${i}"></span></div>
      <div class="pump-row"><span class="dot" id="pcDot${i}"></span><span class="pump-state" id="pcState${i}">Stopped</span></div>
      <div class="muted small" id="pcInfo${i}">&nbsp;</div>
      <div class="btn-row">
        <button class="btn blue" id="pcOn${i}">Pump ON</button>
        <button class="btn red" id="pcOff${i}">Pump OFF</button>
      </div>
      <div class="settings">
        <label class="set-row"><span><b>Automatic mode</b><small>Water at the learned times and when the plant needs it</small></span><input type="checkbox" id="pcAuto${i}"></label>
        <label class="set-row"><span><b>Smart top-up</b><small>Extra watering if soil stays below ideal (never 11:00-16:00 or at night)</small></span><input type="checkbox" id="pcTop${i}"></label>
        <label class="set-row"><span><b>Max run time</b><small>Safety stop for one run</small></span>
          <select id="pcMax${i}"><option value="10">10 min</option><option value="15">15 min</option><option value="20">20 min</option><option value="30">30 min</option></select></label>
      </div>
    </div>`).join('');

  $('learnZones').innerHTML = zones.map(i => `
    <div class="card">
      <div class="card-head"><h3 id="lnName${i}"></h3><span class="muted small">watering times, last 10 days</span></div>
      <div id="lnTimeline${i}"></div>
      <div class="legend"><span><i class="dotl" style="background:#2f7d4f"></i>farmer (manual)</span><span><i class="dotl" style="background:#2c74b8"></i>automatic, learned time</span><span><i class="dotl" style="background:#d08a10"></i>automatic, plant need</span><span><i class="dotl hollow"></i>skipped (soil wet)</span><span><i class="lg slot"></i>learned slot</span></div>
      <div class="learn-grid">
        <div><h4>Learned time slots</h4><div id="lnSlots${i}"></div></div>
        <div><h4>Need model <span class="muted small">(logistic regression)</span></h4><div id="lnModel${i}"></div></div>
      </div>
      <div class="learn-grid">
        <div><h4>Chance the farmer waters, by hour</h4><div id="lnBars${i}"></div><p class="muted small">Model output for a typical day, at the soil moisture the farmer usually waters at.</p></div>
        <div><h4>Crop check <span class="muted small">(k-nearest neighbours, k = 3)</span></h4><div id="lnKnn${i}"></div></div>
      </div>
    </div>`).join('');

  $('healthZones').innerHTML = zones.map(i => `
    <div class="card">
      <div class="health-top"><div id="hlRing${i}"></div><div><h3 id="hlName${i}"></h3><div id="hlStatus${i}" class="status"></div><span class="muted small" id="hlCrop${i}"></span></div></div>
      <table class="tbl compact" id="hlTable${i}"></table>
      <h4>What the caretaker noticed</h4>
      <ul class="issues" id="hlIssues${i}"></ul>
      <p class="tip" id="hlTip${i}"></p>
      <h4>Health score, last 48 h</h4>
      <div id="hlTrend${i}"></div>
      <button class="btn xs ghost" id="hlClear${i}">Problem fixed - clear alerts</button>
    </div>`).join('');

  $('setupZones').innerHTML = zones.map(i => `
    <div class="card">
      <h3>Zone ${i + 1}</h3>
      <div class="field"><label for="suName${i}">Name</label><input type="text" id="suName${i}" maxlength="40"></div>
      <div class="field"><label for="suCrop${i}">Crop</label><select id="suCrop${i}">${cropOptions}</select></div>
      <label class="chk"><input type="checkbox" id="suEn${i}"> Zone in use (sensor + pump connected)</label>
      <div class="crop-info" id="suInfo${i}"></div>
      <button class="btn xs ghost danger" id="suReset${i}">Forget learned timings</button>
    </div>`).join('');

  zones.forEach(i => {
    $('pcOn' + i).onclick = () => setPump(i, true, 'farmer', 'manual switch');
    $('pcOff' + i).onclick = () => setPump(i, false, 'farmer', 'manual switch');
    $('pcAuto' + i).onchange = e => {
      Z(i).auto = e.target.checked;
      addLog(`${Z(i).name}: automatic mode ${e.target.checked ? 'ON' : 'OFF'}`);
      saveData(true); render(true);
    };
    $('pcTop' + i).onchange = e => { Z(i).topUp = e.target.checked; saveData(true); };
    $('pcMax' + i).onchange = e => { Z(i).maxRun = +e.target.value; saveData(true); };
    $('hlClear' + i).onclick = () => {
      const z = Z(i);
      delete z.flags.dryRun; delete z.flags.fastDry;
      z.dryRuns = 0;
      addLog(`${z.name}: alerts cleared by ${user.name}`);
      saveData(true); render(true);
    };
    $('suName' + i).oninput = e => { Z(i).name = e.target.value.trim() || `Zone ${i + 1}`; saveData(); render(true); };
    $('suCrop' + i).onchange = e => setCrop(i, e.target.value);
    $('suEn' + i).onchange = e => {
      Z(i).enabled = e.target.checked;
      if (!e.target.checked && A.pump[i]) setPump(i, false, 'farmer', 'zone switched off');
      saveData(true); render(true);
    };
    $('suReset' + i).onclick = () => {
      if (!confirm(`Forget everything learned for ${Z(i).name}?`)) return;
      Object.assign(Z(i), { events: [], skips: [], model: NeedModel.empty(), rate: Baseline.empty() });
      addLog(`${Z(i).name}: learning reset`);
      saveData(true); render(true);
    };
  });

  // "use this crop" button inside the KNN box is re-rendered, so listen on the parent
  $('learnZones').addEventListener('click', e => {
    const b = e.target.closest('[data-usecrop]');
    if (b) setCrop(+b.dataset.zone, b.dataset.usecrop);
  });
}

function setCrop(i, crop) {
  Z(i).crop = crop;
  if (A.sim) A.sim.crops[i] = crop;
  addLog(`${Z(i).name}: crop set to ${CROPS[crop].name}`);
  saveData(true);
  syncSetup();
  render(true);
}

// copy saved settings into the form controls
function syncSetup() {
  for (let i = 0; i < ZONES; i++) {
    const z = Z(i);
    $('pcAuto' + i).checked = z.auto;
    $('pcTop' + i).checked = z.topUp;
    $('pcMax' + i).value = z.maxRun;
    if (document.activeElement !== $('suName' + i)) $('suName' + i).value = z.name;
    $('suCrop' + i).value = z.crop;
    $('suEn' + i).checked = z.enabled;
  }
}


/* ================= rendering ================= */

function nextWatering(i, t, slots) {
  const z = Z(i), min = minuteOfDay(t), learned = slots.filter(s => s.learned).sort((a, b) => a.mean - b.mean);
  if (!learned.length) {
    const seen = slots.length ? Math.max(...slots.map(s => s.days)) : 0;
    return `Learning: ${seen}/${ScheduleLearner.MIN_DAYS} days of routine seen`;
  }
  const next = learned.find(s => s.mean + 20 >= min && !slotHandled(i, t, s)) || learned[0];
  return z.auto ? `Next auto watering ${fmtMin(next.mean)}` : `${learned.length} time(s) learned - turn on auto`;
}

function render(force) {
  if (!force && Date.now() - A.lastRender < 200) return;
  A.lastRender = Date.now();
  const t = A.source ? nowT() : Date.now();
  const live = !!A.source;

  // top bar
  setText('clock', A.source === 'demo' ? `Farm time (simulated): ${fmtDate(t)}, ${fmtTime(t)} · day ${A.sim.day()}` : `${fmtDate(t)}, ${fmtTime(t)}`);
  const cp = $('connPill');
  cp.className = 'pill ' + (A.source === 'arduino' ? 'on' : A.source === 'demo' ? 'sim' : '');
  cp.textContent = A.source === 'arduino' ? 'Arduino connected' : A.source === 'demo' ? 'Demo mode' : 'Not connected';
  const sp = $('sensorPill');
  sp.hidden = !live;
  sp.className = 'pill ' + (A.r.real ? 'on' : 'sim');
  sp.textContent = A.r.real ? 'Real sensors' : 'Simulated readings';
  $('connBtn').textContent = A.source === 'arduino' ? 'Disconnect' : 'Connect Arduino';
  $('connBtn').disabled = A.source === 'demo' || !A.link.supported;
  $('demoBtn').textContent = A.source === 'demo' ? 'Stop demo' : 'Demo mode';
  $('demoBtn').disabled = A.source === 'arduino';
  $('demoBar').hidden = A.source !== 'demo';
  $('noSource').hidden = live;
  if (A.sim) {
    $('fPipe').textContent = A.sim.pipeBlocked ? 'Unblock zone 1 pipe' : 'Block zone 1 pipe';
    $('fSensor').textContent = A.sim.sensorUnplugged ? 'Plug zone 2 sensor back' : 'Unplug zone 2 sensor';
  }

  const slots = A.data.zones.map(z => ScheduleLearner.slots(z.events, t));
  const health = A.data.zones.map((z, i) => Health.assess(z, cropOf(i), { m: A.r.m[i], temp: A.r.temp, ldr: A.r.ldr }, t));
  const views = { overview: renderOverview, pumps: renderPumps, learning: renderLearning, health: renderHealth, history: renderHistory, setup: renderSetup };
  views[A.tab]?.(t, slots, health);
}

function renderOverview(t, slots, health) {
  const r = A.r;
  setText('ovTemp', r.temp == null ? '--' : r.temp.toFixed(1));
  setText('ovLdr', r.ldr ?? '--');
  setText('ovLdrNote', r.ldr == null ? 'LDR, 0-1023' : r.ldr < 150 ? 'Dark / night' : r.ldr < 400 ? 'Dim / cloudy' : r.ldr < 750 ? 'Bright' : 'Full sun');
  const autoZones = A.data.zones.filter(z => z.enabled && z.auto).length;
  const learned = slots.reduce((n, s) => n + s.filter(x => x.learned).length, 0);
  setText('ovAuto', `${autoZones} / ${A.data.zones.filter(z => z.enabled).length}`);
  setText('ovAutoNote', `${learned} watering time(s) learned`);
  const alerts = health.reduce((n, h) => n + h.issues.filter(x => x.level !== 'info').length, 0);
  setText('ovAlerts', alerts);
  $('ovAlertsCard').classList.toggle('alert', alerts > 0);

  for (let i = 0; i < ZONES; i++) {
    const z = Z(i), c = cropOf(i), m = r.m[i], h = health[i];
    setText('ovName' + i, z.name);
    setText('ovCrop' + i, z.enabled ? c.name : 'not in use');
    setText('ovM' + i, m ?? '--');
    const pill = $('ovPump' + i);
    pill.className = 'pill ' + (A.pump[i] ? 'blue' : '');
    pill.textContent = A.pending[i] ? 'Switching…' : A.pump[i] ? 'Pump running' : 'Pump off';
    setText('ovScore' + i, h.score ?? '--');
    $('ovScore' + i).className = 'score ' + h.level;
    setText('ovStatus' + i, h.status);
    $('ovCrit' + i).style.width = c.critical + '%';
    $('ovBand' + i).style.left = c.moist[0] + '%';
    $('ovBand' + i).style.width = (c.moist[1] - c.moist[0]) + '%';
    $('ovMark' + i).style.left = clamp(m ?? 0, 0, 100) + '%';
    $('ovMark' + i).hidden = m == null;
    setText('ovIdeal' + i, `ideal ${c.moist[0]}-${c.moist[1]}%`);
    setText('ovMode' + i, z.auto ? 'Automatic' : 'Manual');
    setText('ovNext' + i, nextWatering(i, t, slots[i]));
    setText('chTitle' + i, `${z.name} - soil moisture`);
    setHTML('chart' + i, moistureChart(i, t));
  }

  const log = A.data.log.slice(-7).reverse();
  setHTML('ovActivity', log.length ? log.map(l => `<li><span class="when">${fmtTime(l.t)}</span><span class="tag ${l.kind}">${BY_LABEL[l.kind] || 'Info'}</span>${esc(l.text)}</li>`).join('') : '<li class="muted">Nothing yet.</li>');
}

function renderPumps(t) {
  for (let i = 0; i < ZONES; i++) {
    const z = Z(i), on = A.pump[i], busy = !!A.pending[i], ok = !!A.source && z.enabled;
    setText('pcName' + i, z.name);
    setText('pcCrop' + i, cropOf(i).name);
    $('pcDot' + i).classList.toggle('on', on);
    setText('pcState' + i, busy ? 'Switching…' : on ? 'Running' : 'Stopped');
    let info = !A.source ? 'Connect the Arduino or start the demo.' : !z.enabled ? 'Zone not in use (see Setup).' : A.r.m[i] == null ? 'No moisture reading for this zone.' : `Soil moisture ${A.r.m[i]}%`;
    if (on) {
      info = `Running ${Math.round((t - A.since[i]) / 6e4)} min · started by ${BY_LABEL[A.runBy[i]] || A.runBy[i]} · ` +
        (A.runBy[i] === 'auto' ? `stops at ${A.target[i]}%` : `safety stop after ${z.maxRun} min`);
    }
    else if (ok && z.auto && t < z.pausedUntil) info += ` · auto waits till ${fmtTime(z.pausedUntil)} after manual use`;
    setText('pcInfo' + i, info);
    $('pcOn' + i).disabled = !ok || on || busy;
    $('pcOff' + i).disabled = !ok || !on || busy;
  }
  $('stopAll').disabled = !A.pump.some(Boolean);
}

function renderLearning(t, slots) {
  for (let i = 0; i < ZONES; i++) {
    const z = Z(i);
    setText('lnName' + i, `${z.name} (${cropOf(i).name})`);
    setHTML('lnTimeline' + i, timelineChart(i, t, slots[i]));

    setHTML('lnSlots' + i, slots[i].length ? `<table class="tbl compact"><tr><th>Time</th><th>Days</th><th>Usual run</th><th>Confidence</th><th></th></tr>` +
      slots[i].sort((a, b) => a.mean - b.mean).map(s => `<tr>
        <td><b>${fmtMin(s.mean)}</b> <span class="muted">± ${Math.round(s.std)} min</span></td>
        <td>${s.days}</td>
        <td>${s.dur ? Math.round(s.dur) + ' min' : '-'}</td>
        <td><div class="meter"><div style="width:${Math.round(s.conf * 100)}%"></div></div></td>
        <td>${s.learned ? (z.auto ? '<span class="tag auto">Automated</span>' : '<span class="tag farmer">Learned</span>') : '<span class="muted small">learning</span>'}</td></tr>`).join('') + '</table>'
      : `<p class="muted small">No manual waterings yet. Use the pump normally for a few days (Pump control page) and the system will pick up the routine. A time needs to repeat on ${ScheduleLearner.MIN_DAYS} days to be trusted.</p>`);

    const md = z.model, acc = NeedModel.accuracy(md);
    const m = A.r.m[i];
    const pNow = m == null ? null : NeedModel.predict(md, needFeatures(i, t, minuteOfDay(t), m));
    setHTML('lnModel' + i, `
      <div class="kv"><span>Chance farmer would water now</span><b>${pNow == null ? '--' : Math.round(pNow * 100) + '%'}</b></div>
      <div class="kv"><span>Training samples</span><b>${md.n} <span class="muted small">(${md.pos} "watered")</span></b></div>
      <div class="kv"><span>Balanced accuracy (test-then-train)</span><b>${acc == null ? '--' : Math.round(acc * 100) + '%'}</b></div>
      <details><summary class="small">Show weights</summary><table class="tbl compact">${NeedModel.NAMES.map((n, k) => `<tr><td>${n}</td><td class="num">${md.w[k].toFixed(3)}</td></tr>`).join('')}</table></details>`);

    setHTML('lnBars' + i, hourBars(i));

    const f = zoneFeatures(i, t);
    if (!f) {
      setHTML('lnKnn' + i, `<p class="muted small">Needs about 2 days of readings with a normal watering routine. It looks at how fast the soil dries and how much water the bed takes, and compares that with the reference crops.</p>`);
    } else {
      const g = CropKNN.guess(f), same = g.crop === z.crop;
      setHTML('lnKnn' + i, `
        <div class="kv"><span>${CropKNN.FEATURES[0]}</span><b>${f[0].toFixed(2)}</b></div>
        <div class="kv"><span>${CropKNN.FEATURES[1]}</span><b>${Math.round(f[1])}</b></div>
        <div class="kv"><span>${CropKNN.FEATURES[2]}</span><b>${Math.round(f[2])}</b></div>
        <p>Behaves most like <b>${CROPS[g.crop].name}</b> <span class="muted small">(${g.votes} of 3 neighbours)</span>.
        ${same ? '<span class="tag farmer">matches setup</span>' : `Setup says ${cropOf(i).name}. <button class="btn xs ghost" data-usecrop="${g.crop}" data-zone="${i}">Use ${CROPS[g.crop].name}</button>`}</p>`);
    }
  }
}

// features for the crop guess: [drying rate, average moisture, pump minutes per day]
function zoneFeatures(i, t) {
  const z = Z(i);
  const dry = Baseline.overall(z.rate);
  const hist = z.history.filter(p => p.t > t - 3 * 864e5);
  if (dry == null || z.rate.n.filter(n => n > 0).length < 18 || hist.length < 2) return null;
  const spanDays = (t - hist[0].t) / 864e5;
  if (spanDays < 1.5) return null;
  const runMin = pumpRuns(i, hist[0].t, t).reduce((s, r) => s + (r[1] - r[0]) / 6e4, 0);
  return [dry, avg(hist.map(p => p.m)), runMin / spanDays];
}

function renderHealth(t, slots, health) {
  for (let i = 0; i < ZONES; i++) {
    const z = Z(i), c = cropOf(i), h = health[i], r = A.r;
    setHTML('hlRing' + i, ring(h.score, h.level));
    setText('hlName' + i, z.name);
    setText('hlStatus' + i, h.status);
    $('hlStatus' + i).className = 'status ' + h.level;
    setText('hlCrop' + i, c.name);
    const row = (name, now, ideal, ok) => `<tr><td>${name}</td><td class="${ok === false ? 'bad-txt' : ''}">${now}</td><td class="muted">${ideal}</td></tr>`;
    setHTML('hlTable' + i, `<tr><th></th><th>Now</th><th>Ideal for ${esc(c.name)}</th></tr>` +
      row('Soil moisture', r.m[i] == null ? '--' : r.m[i] + '%', `${c.moist[0]}-${c.moist[1]}%`, r.m[i] == null ? null : r.m[i] >= c.moist[0] && r.m[i] <= c.moist[1] + 8) +
      row('Temperature', r.temp == null ? '--' : r.temp.toFixed(1) + ' °C', `${c.temp[0]}-${c.temp[1]} °C`, r.temp == null ? null : r.temp >= c.temp[0] - 2 && r.temp <= c.temp[1] + 2) +
      row('Usual drying', Baseline.overall(z.rate) == null ? 'learning…' : Baseline.overall(z.rate).toFixed(1) + ' %/h', `~${c.dryRate} %/h`));
    setHTML('hlIssues' + i, h.issues.length ? h.issues.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('')
      : h.score == null ? '<li class="muted">No readings yet.</li>' : '<li class="good">Everything looks fine.</li>');
    setText('hlTip' + i, c.tip);
    setHTML('hlTrend' + i, sparkline(z.scores.filter(s => s.s != null && s.t > t - 48 * 36e5)));
    $('hlClear' + i).hidden = !(z.flags.dryRun || z.flags.fastDry);
  }
}

function renderHistory() {
  const rows = A.data.log.slice(-80).reverse();
  setHTML('logTable', rows.length ? rows.map(l => `<tr><td class="nowrap">${fmtDate(l.t)} ${fmtTime(l.t)}</td><td><span class="tag ${l.kind}">${BY_LABEL[l.kind] || 'Info'}</span></td><td>${esc(l.text)}</td></tr>`).join('')
    : '<tr><td class="muted">No events yet.</td></tr>');
}

function renderSetup() {
  for (let i = 0; i < ZONES; i++) {
    const c = cropOf(i);
    setHTML('suInfo' + i, `Ideal moisture <b>${c.moist[0]}-${c.moist[1]}%</b>, wilting below <b>${c.critical}%</b>, comfortable <b>${c.temp[0]}-${c.temp[1]} °C</b>.`);
  }
  setText('storeInfo', `Data for "${A.source || 'arduino'}" mode, user ${user.username}: ${Math.round((JSON.stringify(A.data).length) / 1024)} KB in browser storage.`);
}


/* ================= page wiring ================= */

function showTab(name) {
  if (!document.getElementById('tab-' + name)) name = 'overview';
  A.tab = name;
  document.querySelectorAll('.tab-pane').forEach(p => p.hidden = p.id !== 'tab-' + name);
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  setText('pageTitle', document.querySelector(`#nav a[data-tab="${name}"]`).textContent);
  render(true);
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

$('userName').textContent = user.name;
$('logoutBtn').onclick = async () => {
  if (A.source === 'arduino') await A.link.disconnect();
  if (A.source === 'demo') stopDemo();
  logout();
};
$('connBtn').onclick = toggleArduino;
$('demoBtn').onclick = startDemo;
$('stopAll').onclick = () => { for (let i = 0; i < ZONES; i++) setPump(i, false, 'farmer', 'stop all'); };

$('speedSel').innerHTML = SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
$('speedSel').onchange = e => { A.sim.speed = +e.target.value; };
$('farmerChk').onchange = e => { A.farmer = e.target.checked; };
$('fRain').onclick = () => { A.sim.rain(); addLog('Demo: rain shower'); };
$('fHeat').onclick = () => { A.sim.heatwave(); addLog('Demo: heatwave for one day'); };
$('fPipe').onclick = () => { A.sim.pipeBlocked = !A.sim.pipeBlocked; addLog(`Demo: zone 1 pipe ${A.sim.pipeBlocked ? 'blocked' : 'cleared'}`); render(true); };
$('fSensor').onclick = () => { A.sim.sensorUnplugged = !A.sim.sensorUnplugged; addLog(`Demo: zone 2 sensor ${A.sim.sensorUnplugged ? 'unplugged' : 'plugged back'}`); render(true); };
$('demoReset').onclick = () => {
  if (!confirm('Reset the demo farm and everything it learned?')) return;
  clearInterval(A.timer);
  store.del(`si_data_${user.username}_demo`);
  A.source = null;
  startDemo();
};

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(A.data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `irrigation-${A.source || 'arduino'}-${dayKey(Date.now())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('importFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.v !== 2 || !Array.isArray(d.zones)) throw new Error('not a backup from this app');
    A.data = d;
    A.data.zones = d.zones.map((z, i) => Object.assign(newZone(i), z));
    saveData(true); syncSetup(); render(true);
    toast('Backup loaded');
  } catch (err) { toast('Could not load file: ' + err.message); }
  e.target.value = '';
};
$('clearAll').onclick = () => {
  if (!confirm('Delete all saved data (learning, history, log) for this mode?')) return;
  A.data = newData();
  saveData(true); syncSetup(); render(true);
};

if (!('serial' in navigator)) $('serialNote').hidden = false;

loadData('arduino');
buildUI();
syncSetup();
showTab(location.hash.slice(1) || 'overview');
setInterval(() => { if (!A.source) render(); }, 1000);
