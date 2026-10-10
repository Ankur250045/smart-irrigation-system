// ml.js - the learning part of the project
//
//  1. ScheduleLearner : finds the farmer's daily watering times by clustering the start
//                       times of manual waterings (unsupervised).
//  2. NeedModel       : online logistic regression, P(farmer would water now | readings, time).
//                       Trained with SGD every minute, so it keeps adapting.
//  3. Baseline        : per-hour-of-day "normal" drying rate of each zone, used to spot
//                       unusual behaviour (anomaly detection with a z-score style check).
//  4. CropKNN         : k-nearest-neighbours guess of the crop from how the soil dries and
//                       how much water it takes.
//  5. Health          : plant health score + plain-language advice.
//
// All state is plain objects/arrays so it can be saved to localStorage as JSON.

const ScheduleLearner = {
  GAP: 45,          // start times closer than this (minutes) are the same slot
  WINDOW_DAYS: 14,  // only look at the last two weeks, so the schedule follows season changes
  MIN_DAYS: 3,      // a slot must be seen on 3 different days before we trust it
  MAX_STD: 35,      // ... and the farmer must be regular (std dev in minutes)

  // events: [{ t, min, day, m, dur, auto?, rejected? }]
  slots(events, t) {
    const from = t - this.WINDOW_DAYS * 864e5;
    const ev = events.filter(e => e.t >= from && e.t <= t && !e.rejected).sort((a, b) => a.min - b.min);

    // 1-D clustering: walk the sorted start times and cut wherever the gap is big
    const groups = [];
    for (const e of ev) {
      const g = groups[groups.length - 1];
      if (g && e.min - g[g.length - 1].min <= this.GAP) g.push(e);
      else groups.push([e]);
    }

    return groups.map(g => {
      const mins = g.map(e => e.min);
      const mean = avg(mins);
      const std = Math.sqrt(avg(mins.map(v => (v - mean) ** 2)));
      const days = new Set(g.map(e => e.day)).size;
      const conf = clamp(days / 5, 0, 1) * clamp(1 - std / 60, 0, 1);
      return {
        id: Math.round(mean / 30),
        mean, std, days, conf,
        count: g.length,
        dur: median(g.map(e => e.dur).filter(Boolean)),
        startM: Math.round(avg(g.map(e => e.m))),
        learned: days >= this.MIN_DAYS && std <= this.MAX_STD
      };
    });
  },

  // learned slot whose time window contains `min` (window opens 10 min early)
  due(slots, min, before = 10, after = 20) {
    return slots.find(s => s.learned && min >= s.mean - before && min <= s.mean + after) || null;
  }
};


const NeedModel = {
  NAMES: ['bias', 'moisture', 'temperature', 'light', 'sin(t)', 'cos(t)', 'sin(2t)', 'cos(2t)', 'hours since watering', 'moisture²'],
  LR: 0.05,
  L2: 1e-4,
  MAX_CLASS_WEIGHT: 15,

  empty() { return { w: new Array(10).fill(0), n: 0, pos: 0, tp: 0, fn: 0, tn: 0, fp: 0 }; },

  // time of day goes in as sin/cos so 23:59 and 00:00 are close together.
  // The 2t terms let it learn two peaks a day (morning + evening watering).
  features(m, temp, ldr, min, hrsSince) {
    const a = 2 * Math.PI * min / 1440;
    return [1, m / 100, temp / 50, ldr / 1023,
      Math.sin(a), Math.cos(a), Math.sin(2 * a), Math.cos(2 * a),
      Math.min(hrsSince, 48) / 24, (m / 100) ** 2];
  },

  predict(model, x) {
    let z = 0;
    for (let i = 0; i < x.length; i++) z += model.w[i] * x[i];
    return 1 / (1 + Math.exp(-z));
  },

  // test-then-train: score the sample first (that is our running accuracy), then learn from it.
  // "watered" samples are rare, so they get a bigger weight (class weighting), otherwise
  // the model just learns to always say no.
  train(model, x, y) {
    const p = this.predict(model, x);
    if (y) p >= 0.5 ? model.tp++ : model.fn++;
    else p < 0.5 ? model.tn++ : model.fp++;
    const cw = y ? clamp((model.n - model.pos) / Math.max(1, model.pos), 1, this.MAX_CLASS_WEIGHT) : 1;
    for (let i = 0; i < x.length; i++) model.w[i] += this.LR * (cw * (y - p) * x[i] - this.L2 * model.w[i]);
    model.n++;
    if (y) model.pos++;
  },

  // balanced accuracy, because "never water" would already be 97% accurate on raw minutes
  accuracy(model) {
    const P = model.tp + model.fn, N = model.tn + model.fp;
    if (!P || !N) return null;
    return (model.tp / P + model.tn / N) / 2;
  }
};


const Baseline = {
  empty() { return { mean: new Array(24).fill(0), var: new Array(24).fill(0), n: new Array(24).fill(0) }; },

  // exponentially weighted mean/variance, so old weather slowly fades out
  update(b, h, x) {
    b.n[h]++;
    const a = Math.max(0.15, 1 / b.n[h]);
    const d = x - b.mean[h];
    b.mean[h] += a * d;
    b.var[h] = (1 - a) * (b.var[h] + a * d * d);
  },

  // the sensor only gives whole %, so one hour can easily read 1 % off - hence the minimum margin
  isUnusual(b, h, x) {
    if (b.n[h] < 4) return false;
    const sd = Math.sqrt(b.var[h]);
    return x > b.mean[h] + Math.max(2.5 * sd, 1.2) && x > 1.6 * b.mean[h];
  },

  overall(b) {
    const hrs = b.mean.filter((_, h) => b.n[h] > 0);
    return hrs.length ? avg(hrs) : null;
  }
};


const CropKNN = {
  K: 3,
  FEATURES: ['drying rate (%/h)', 'average moisture (%)', 'pump time (min/day)'],

  guess(f) {
    // min-max scale every feature so % and minutes are comparable
    const ranges = [0, 1, 2].map(j => {
      const v = CROP_SAMPLES.map(s => s[j]);
      return [Math.min(...v), Math.max(...v)];
    });
    const norm = (v, j) => (v - ranges[j][0]) / (ranges[j][1] - ranges[j][0]);

    const nb = CROP_SAMPLES
      .map(s => ({ crop: s[3], d: Math.hypot(...[0, 1, 2].map(j => norm(f[j], j) - norm(s[j], j))) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.K);

    const votes = {};
    nb.forEach(n => votes[n.crop] = (votes[n.crop] || 0) + 1);
    // most votes wins; on a tie the nearest neighbour decides (nb is sorted by distance)
    let crop = nb[0].crop;
    for (const n of nb) if (votes[n.crop] > votes[crop]) crop = n.crop;
    return { crop, votes: votes[crop], neighbours: nb };
  }
};


const Health = {
  // z = zone data, c = crop profile, r = { m, temp, ldr }, t = time
  assess(z, c, r, t) {
    const m = r.m;
    if (m == null) return { score: null, status: 'No data', level: '', issues: [] };
    const issues = [];
    let score = 100;
    const add = (level, text, penalty) => { issues.push({ level, text }); score -= penalty; };

    if (z.flags.sensor) {
      add('bad', `Moisture sensor stuck at ${m}%, probably loose or unplugged. Automatic watering is paused for this zone.`, 30);
    } else if (m < c.critical) {
      add('bad', `Soil is very dry (${m}%). ${c.name} starts wilting below about ${c.critical}%.`, 40);
    } else if (m < c.moist[0]) {
      add('warn', `Soil is drier than ideal (${m}%, ideal ${c.moist[0]}-${c.moist[1]}%).`, Math.min(25, (c.moist[0] - m) * 1.5));
    } else if (m > c.moist[1] + 8) {
      add('warn', `Soil is waterlogged (${m}%). Roots need air too, long waterlogging can cause root rot.`, Math.min(30, (m - c.moist[1]) * 1.2));
    }

    if (r.temp != null) {
      if (r.temp > c.temp[1] + 2) {
        add(r.temp > c.temp[1] + 6 ? 'bad' : 'warn',
          `Heat stress: ${r.temp.toFixed(1)} °C (comfortable up to ${c.temp[1]} °C). Water early morning or evening, mulching keeps roots cooler.`,
          Math.min(25, (r.temp - c.temp[1]) * 3));
      } else if (r.temp < c.temp[0] - 2) {
        add('warn', `Cold: ${r.temp.toFixed(1)} °C (below ${c.temp[0]} °C). Growth slows down, avoid watering late in the evening.`,
          Math.min(20, (c.temp[0] - r.temp) * 2));
      }
    }

    const h = new Date(t).getHours();
    if (r.ldr != null && h >= 10 && h < 15 && r.ldr < 250) {
      add('info', `Low light for midday (LDR ${r.ldr}). Cloudy day, or the bed is shaded.`, 5);
    }

    const dryRun = z.flags.dryRun && (z.dryRuns >= 2 || t - z.flags.dryRun < 24 * 36e5);
    if (dryRun) {
      add('bad', 'Pump ran but soil moisture did not rise. Check the pipe, valve and water tank.' +
        (z.dryRuns >= 2 ? ' Automatic watering is waiting until you press "Problem fixed".' : ''), 20);
    }
    if (z.flags.fastDry && t - z.flags.fastDry.t < 6 * 36e5) {
      add('warn', `Soil dried ${z.flags.fastDry.rate.toFixed(1)} %/h, usual for that hour is ${z.flags.fastDry.usual.toFixed(1)} %/h. Hot wind, heat, or a leak near the sensor?`, 10);
    }

    // hours below the ideal band in the last 24 h (history has one sample per 5 min)
    const lowHrs = z.history.filter(p => p.t > t - 864e5 && p.m < c.moist[0]).length * 5 / 60;
    if (!z.flags.sensor && !dryRun && lowHrs >= 4) {
      add('info', `Moisture stayed below ideal for about ${Math.round(lowHrs)} h in the last day. ` +
        (z.auto && z.topUp ? 'Smart top-up will add an extra watering.' : 'One more watering a day (or turning on smart top-up) would help.'),
        Math.min(15, lowHrs));
    }

    score = Math.max(0, Math.round(score));
    const level = score >= 80 ? 'good' : score >= 55 ? 'warn' : 'bad';
    const status = { good: 'Healthy', warn: 'Needs attention', bad: 'Stressed' }[level];
    return { score, status, level, issues };
  }
};
