// hardware.js - where readings come from: the real Arduino (Web Serial) or the farm simulator

/* ---------- Arduino over USB (Web Serial, Chrome / Edge only) ----------
   Protocol (see arduino/smart_irrigation/smart_irrigation.ino):
     Arduino -> PC : DATA,<ldr>,<moist1>,<moist2>,<temp>,<REAL|SIM>    every second
                     PUMP1:ON / PUMP1:OFF / PUMP2:ON / PUMP2:OFF        on every change
                     WARN:<code>   INFO:<text>
     PC -> Arduino : ON1 OFF1 ON2 OFF2 ALLOFF PING
   The old one-zone sketch (DATA,<ldr>,<moist>,<temp>,<mode>) is still understood. */

class ArduinoLink {
  constructor(handlers) {
    this.h = handlers;
    this.port = this.reader = this.writer = null;
    this.connected = false;
    this.buffer = '';
  }

  get supported() { return 'serial' in navigator; }

  async connect() {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    this.port = port;
    this.buffer = '';
    this.reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    const enc = new TextEncoderStream();
    this.writerClosed = enc.readable.pipeTo(port.writable).catch(() => { });
    this.writer = enc.writable.getWriter();
    this.connected = true;
    this.readLoop();
    // UNO boards reset when the port opens, give it 2 s before we start pinging
    setTimeout(() => {
      if (this.connected) this.keepAlive = setInterval(() => this.send('PING'), 2000);
    }, 2000);
  }

  async readLoop() {
    const reader = this.reader;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += value;
        let idx;
        // a chunk can end in the middle of a line, so only handle complete lines
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (err) {
      if (this.connected) this.h.onLine('Read error: ' + err.message, '!');
    }
    if (this.connected) this.disconnect('Lost connection to the Arduino');
  }

  async disconnect(reason) {
    clearInterval(this.keepAlive);
    if (!this.connected) return;
    this.connected = false;
    try { await this.writer.write('ALLOFF\n'); } catch { }
    try { await this.reader?.cancel(); } catch { }
    try { this.reader?.releaseLock(); } catch { }
    try { await this.writer?.close(); } catch { }
    try { await this.writerClosed; } catch { }
    try { await this.port?.close(); } catch { }
    this.port = this.reader = this.writer = null;
    this.h.onClose(reason);
  }

  async send(cmd) {
    if (!this.writer) return;
    if (cmd !== 'PING') this.h.onLine(cmd, '→');
    try { await this.writer.write(cmd + '\n'); } catch (err) { this.h.onLine('Send failed: ' + err.message, '!'); }
  }

  handleLine(line) {
    if (line.startsWith('DATA,')) {
      const p = line.split(',');
      let r = null;
      if (p.length >= 6) r = { ldr: +p[1], m: [+p[2], +p[3]], temp: +p[4], real: p[5] === 'REAL' };
      else if (p.length === 5) r = { ldr: +p[1], m: [+p[2], null], temp: +p[3], real: p[4] === 'REAL' };
      if (r && [r.ldr, r.m[0], r.temp].every(Number.isFinite)) this.h.onData(r);
      return;
    }
    this.h.onLine(line, '←');
    const m = line.match(/^PUMP(\d?):(ON|OFF)$/);
    if (m) this.h.onPump(m[1] ? +m[1] - 1 : 0, m[2] === 'ON');
    else if (line.startsWith('WARN:')) this.h.onWarn(line.slice(5));
  }
}


/* ---------- Farm simulator (demo mode) ----------
   A simple model of two beds so the learning can be shown in a few minutes
   instead of waiting for real days. Time runs faster (speed x).  */

const FILL_RATE = 1.8;   // % moisture the pump adds per minute

class FarmSimulator {
  constructor(saved = {}) {
    const start = new Date();
    start.setHours(5, 0, 0, 0);
    this.time = saved.time ?? start.getTime();
    this.startTime = saved.startTime ?? this.time;
    this.m = saved.m ?? [56, 50];
    this.speed = saved.speed ?? 600;
    this.heatUntil = saved.heatUntil ?? 0;
    this.crops = ['tomato', 'chilli'];
    this.pump = [false, false];
    this.pipeBlocked = false;     // zone 1 fault
    this.sensorUnplugged = false; // zone 2 fault
    this.temp = 24;
    this.ldr = 100;
    this.acc = 0;
  }

  state() { return { time: this.time, startTime: this.startTime, m: this.m, speed: this.speed, heatUntil: this.heatUntil }; }
  day() { return Math.floor((this.time - this.startTime) / 864e5) + 1; }

  // how many simulated minutes fit into `realMs` of real time
  minutesFor(realMs) {
    this.acc += realMs * this.speed;
    const n = Math.floor(this.acc / 6e4);
    this.acc -= n * 6e4;
    return n;
  }

  step() {
    this.time += 6e4;
    const d = new Date(this.time);
    const h = d.getHours() + d.getMinutes() / 60;
    const sun = Math.max(0, Math.sin((h - 6) / 12 * Math.PI));          // 0 at night, 1 at noon
    const heat = this.time < this.heatUntil ? 10 * Math.max(0.3, sun) : 0;
    this.temp = 27 - 6 * Math.cos((h - 15) / 24 * 2 * Math.PI) + heat + (Math.random() - 0.5) * 0.4;
    this.ldr = Math.round(clamp(40 + 900 * sun * (0.85 + Math.random() * 0.15), 0, 1023));

    for (let i = 0; i < 2; i++) {
      const c = CROPS[this.crops[i]];
      // evaporation is faster in sunlight and heat
      const dry = c.dryRate / 60 * (0.55 + 1.4 * sun) * (1 + (this.temp - 27) * 0.05);
      const water = this.pump[i] && !(this.pipeBlocked && i === 0) ? FILL_RATE : 0;
      this.m[i] = clamp(this.m[i] - dry + water + (Math.random() - 0.5) * 0.05, 3, 98);
    }
  }

  read() {
    return {
      ldr: this.ldr,
      temp: +this.temp.toFixed(1),
      m: this.m.map((v, i) => (this.sensorUnplugged && i === 1) ? 0 : Math.round(v)),
      real: false
    };
  }

  rain() { this.m = this.m.map(v => clamp(v + 28, 3, 96)); }
  heatwave() { this.heatUntil = this.time + 864e5; }
}
