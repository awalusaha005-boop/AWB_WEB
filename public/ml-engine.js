// ═══════════════════════════════════════════════════════
// ml-engine.js — Port dari AwbMlEngine.cs + By RB trained model
// Ridge regression (MID prediction) + KDE (AREA ordering)
// v3: Trained weights from By RB V2 + standardization + seed data
// ═══════════════════════════════════════════════════════

// ── Ridge model for MID prediction ──
export class RidgeModel {
  constructor() {
    // Trained params dari By RB V2 (122k samples, R²=0.9667)
    this.weights = [53.59165690364937, 4.855243663753777, 151.70580576053723, 5.812629685473508, 41.67079154200302];
    this.bias = 0.0;
    this.featureCount = 5;
    // Standardization params
    this.xMean = [131.00384615384615, 11.138461538461538, 0.6931781744396154, 0.5826941888713614, 0.03461538461538462];
    this.xStd = [1.8260888783725584, 1.6040997770321255, 0.34725834808347206, 0.24368656184215137, 0.18280360982024998];
    this.yMean = 1134.901007875301;
    this.alpha = 0.5;
    this.trained = true;
  }

  predict(features) {
    if (features.length < this.featureCount) {
      // Fallback to base model (4 features)
      return 42.814244663382595 * features[0] + (-5148.556034482759);
    }
    // Standardized prediction: sum(w_i * (x_i - mu_i) / sigma_i) + y_mean
    let sum = this.yMean;
    for (let i = 0; i < this.featureCount; i++)
      sum += this.weights[i] * (features[i] - this.xMean[i]) / this.xStd[i];
    return sum + this.bias;
  }
}

// ── KDE for AREA distribution per city ──
export class CityAreaKde {
  constructor() {
    this.cityKey = "";
    this.areas = [];
    this.counts = [];
    this.bandwidth = 5.0;
  }

  addArea(area) {
    const idx = this.areas.indexOf(area);
    if (idx >= 0) {
      this.counts[idx]++;
    } else {
      this.areas.push(area);
      this.counts.push(1);
    }
  }

  retrainBandwidth() {
    const total = this.counts.reduce((a, b) => a + b, 0);
    if (total < 5) { this.bandwidth = 10.0; return; }
    // Silverman's rule
    let mean = 0;
    for (let i = 0; i < this.areas.length; i++) mean += this.areas[i] * this.counts[i];
    mean /= total;
    let variance = 0;
    for (let i = 0; i < this.areas.length; i++) variance += Math.pow(this.areas[i] - mean, 2) * this.counts[i];
    variance /= total;
    const std = Math.sqrt(variance);
    this.bandwidth = Math.max(1.0, 1.06 * std * Math.pow(total, -0.2));
  }

  density(area) {
    if (this.areas.length === 0) return 0;
    let totalCounts = 0;
    for (let i = 0; i < this.counts.length; i++) totalCounts += this.counts[i];
    if (totalCounts === 0) return 0;

    let sum = 0;
    const bw2 = this.bandwidth * this.bandwidth;
    const invTotal = 1.0 / totalCounts;
    for (let i = 0; i < this.areas.length; i++) {
      const diff = area - this.areas[i];
      const weight = this.counts[i] * invTotal;
      sum += weight * Math.exp(-(diff * diff) / (2 * bw2));
    }
    return sum;
  }

  rankedAreas(upperBound = 9999) {
    if (this.areas.length === 0) return [];
    upperBound = Math.max(0, Math.min(9999, upperBound));
    const scored = [];
    for (let a = 0; a <= upperBound; a++) scored.push({ area: a, score: this.density(a) });
    scored.sort((x, y) => y.score - x.score);
    return scored.map(s => s.area);
  }

  topAreas(max) {
    return this.rankedAreas(max).slice(0, max);
  }
}

// ── MID variance model (adaptive radius) ──
export class MidVarianceModel {
  constructor() {
    this.dailyRanges = []; // [{date, variance}]
  }

  addSample(date, mid) {
    const existing = this.dailyRanges.find(d => d.date === date);
    if (existing) {
      this.dailyRanges = this.dailyRanges.filter(d => d.date !== date);
      this.dailyRanges.push({ date, variance: Math.max(existing.variance, mid * 0.01) });
    } else {
      this.dailyRanges.push({ date, variance: mid * 0.005 });
    }
  }

  getRadius() {
    if (this.dailyRanges.length === 0) return 150.0;
    const recent = this.dailyRanges.slice(Math.max(0, this.dailyRanges.length - 30));
    const avg = recent.reduce((sum, d) => sum + d.variance, 0) / recent.length;
    return Math.max(50.0, avg * 20);
  }
}

// ── Destination cache entry ──
class DestCacheEntry {
  constructor() {
    this.cityKey = "";
    this.area = 0;
    this.hitCount = 0;
    this.lastSeen = null;
  }
}

// ── Valid AWB record ──
class ValidAwbRecord {
  constructor() {
    this.awb = "";
    this.date = "";
    this.destination = "";
    this.mid = 0;
    this.area = 0;
    this.timestamp = "";
  }
}

// ── Main ML engine ──
export class AwbMlEngine {
  constructor() {
    this.midModel = new RidgeModel();
    this.varianceModel = new MidVarianceModel();
    this.cityKdes = {}; // key -> CityAreaKde
    this.destCache = {}; // key -> DestCacheEntry
    this.maxAreaEverSeen = 0;
    this.history = []; // ValidAwbRecord[]
    this._awbSet = null;
    this._awbSetDirty = true;
    this._seeded = false;
  }

  // ── Seed from By RB model data ──
  seedFromModel(seedData) {
    if (!seedData || this._seeded) return;

    // Seed RidgeModel
    if (seedData.ridge) {
      const r = seedData.ridge;
      this.midModel.weights = r.weights || this.midModel.weights;
      this.midModel.bias = r.bias ?? this.midModel.bias;
      this.midModel.featureCount = r.n_feat || this.midModel.featureCount;
      this.midModel.xMean = r.x_mean || this.midModel.xMean;
      this.midModel.xStd = r.x_std || this.midModel.xStd;
      this.midModel.yMean = r.y_mean ?? this.midModel.yMean;
      this.midModel.alpha = r.alpha ?? this.midModel.alpha;
      this.midModel.trained = true;
    }

    // Seed City KDE
    if (seedData.city_kde) {
      for (const [city, data] of Object.entries(seedData.city_kde)) {
        const kde = new CityAreaKde();
        kde.cityKey = city;
        kde.areas = data.areas || [];
        kde.counts = data.counts || [];
        kde.bandwidth = data.bandwidth || 6.0;
        this.cityKdes[city] = kde;
      }
    }

    // Seed Dest Cache
    if (seedData.dest_cache) {
      for (const [key, data] of Object.entries(seedData.dest_cache)) {
        const entry = new DestCacheEntry();
        entry.cityKey = key;
        entry.area = data.area || 0;
        entry.hitCount = data.hit_count || 1;
        entry.lastSeen = new Date().toISOString();
        this.destCache[key] = entry;
      }
    }

    this._seeded = true;
  }

  // ── Predict MID ──
  predictMidTwoLevel(targetDate, timeRange) {
    const date = new Date(targetDate);
    if (isNaN(date)) return 1730;
    const epoch = new Date(2026, 0, 1);
    const dayOffset = Math.floor((date - epoch) / 86400000);
    const hour = timeRange ? (timeRange.start + timeRange.end) / 2.0 / 60.0 : 12.0;
    const dow = date.getDay(); // 0=Sun 6=Sat
    const sinDow = Math.sin(2 * Math.PI * dow / 7);
    const cosDow = Math.cos(2 * Math.PI * dow / 7);
    const isWeekend = (dow === 0 || dow === 6) ? 1.0 : 0.0;

    if (this.midModel.trained) {
      // 5-feature model with standardization (match By RB)
      const features = [dayOffset, hour, sinDow, cosDow, isWeekend];
      let baseMid = Math.round(this.midModel.predict(features));
      return Math.max(0, Math.min(9999, baseMid));
    }

    // Fallback: base model (4 features, no standardization)
    const features = [dayOffset, hour, dow, isWeekend];
    let baseMid = Math.round(this.midModel.predict(features));
    return Math.max(0, Math.min(9999, baseMid));
  }

  getAdaptiveRadius() {
    return Math.round(this.varianceModel.getRadius());
  }

  // ── Adaptive ceiling ──
  getAreaCeiling(cityKey = null) {
    // If we have KDE data for this city, use its max area + buffer
    if (cityKey && this.cityKdes[cityKey]) {
      const kde = this.cityKdes[cityKey];
      if (kde.areas.length > 0) {
        const maxArea = Math.max(...kde.areas);
        return Math.min(9999, Math.round(maxArea * 1.25));
      }
    }
    // No city → lower ceiling (match is easier, no need to scan all 10k)
    if (!cityKey) {
      if (this.history && this.history.length >= 20) {
        const areas = this.history.filter(h => h.area > 0).map(h => h.area).sort((a, b) => a - b);
        if (areas.length >= 20) {
          const p95Idx = Math.max(0, Math.min(areas.length - 1, Math.ceil(areas.length * 0.95) - 1));
          return Math.max(255, Math.min(2000, Math.round(areas[p95Idx] * 1.25)));
        }
      }
      return 2000; // default cap for no-city search
    }
    if (!this.history || this.history.length < 20) return 9999;
    const areas = this.history.filter(h => h.area > 0).map(h => h.area).sort((a, b) => a - b);
    if (areas.length < 20) return 9999;

    const p95Idx = Math.max(0, Math.min(areas.length - 1, Math.ceil(areas.length * 0.95) - 1));
    const p95 = areas[p95Idx];
    const ceiling = Math.round(p95 * 1.25);
    return Math.max(255, Math.min(9999, ceiling));
  }

  // ── AREA ordering: KDE + dest cache + fallback ──
  getAreaOrder(targetCity) {
    const cityKey = normalizeKey(targetCity);
    const ceiling = this.getAreaCeiling(cityKey);
    const ordered = [];
    const seen = new Set();

    // 1. Dest cache hit
    if (this.destCache[cityKey]) {
      const entry = this.destCache[cityKey];
      if (!seen.has(entry.area)) { seen.add(entry.area); ordered.push(entry.area); }
    }

    // 2. KDE — per-kota atau global kalo cityKey kosong
    if (cityKey) {
      if (this.cityKdes[cityKey] && this.cityKdes[cityKey].areas.length > 0) {
        const kde = this.cityKdes[cityKey];
        kde.retrainBandwidth();
        for (const a of kde.topAreas(ceiling)) {
          if (!seen.has(a)) { seen.add(a); ordered.push(a); }
        }
      }
    } else {
      // Global: gabungin semua KDE kota, urutin by total frequency
      const globalCounts = new Map();
      for (const kde of Object.values(this.cityKdes)) {
        for (let i = 0; i < kde.areas.length; i++) {
          const a = kde.areas[i];
          globalCounts.set(a, (globalCounts.get(a) || 0) + kde.counts[i]);
        }
      }
      const sorted = [...globalCounts.entries()]
        .filter(([a]) => a <= ceiling)
        .sort((a, b) => b[1] - a[1]);
      for (const [a] of sorted) {
        if (!seen.has(a)) { seen.add(a); ordered.push(a); }
      }
    }

    // 3. Fallback: linear 0 to ceiling
    for (let i = 0; i <= ceiling; i++) {
      if (!seen.has(i)) { seen.add(i); ordered.push(i); }
    }

    return ordered;
  }

  // ── Dest cache check ──
  tryDestCache(cityKey, out) {
    const key = normalizeKey(cityKey);
    const entry = this.destCache[key];
    if (entry && entry.hitCount >= 2) {
      out.area = entry.area;
      return true;
    }
    out.area = -1;
    return false;
  }

  // ── Record valid AWB ──
  recordValidAwb(awb, date, destination, mid, area) {
    const awbSet = this._getAwbSet();
    if (awb && awbSet.has(awb)) return;
    if (awb) awbSet.add(awb);

    this.history.push({
      awb, date, destination, mid, area,
      timestamp: new Date().toISOString()
    });

    if (area > this.maxAreaEverSeen) this.maxAreaEverSeen = area;

    // Update KDE
    const cityKey = normalizeKey(extractCityKey(destination));
    if (!this.cityKdes[cityKey]) this.cityKdes[cityKey] = new CityAreaKde();
    this.cityKdes[cityKey].addArea(area);

    // Update variance model
    this.varianceModel.addSample(date, mid);

    // Update dest cache
    if (!this.destCache[cityKey]) this.destCache[cityKey] = new DestCacheEntry();
    const entry = this.destCache[cityKey];
    if (entry.hitCount === 0) {
      entry.area = area; entry.hitCount = 1;
    } else if (entry.area === area) {
      entry.hitCount++;
    } else {
      entry.hitCount = 0;
    }
    entry.lastSeen = new Date().toISOString();

    // Cap history
    if (this.history.length > 10000) {
      this.history = this.history.slice(-5000);
      this._awbSetDirty = true;
    }
  }

  // ── Retrain MID model ──
  retrainMidModel() {
    const rows = this.history.filter(h => !isNaN(new Date(h.date)));
    if (rows.length < 10) return;

    const X = [], y = [];
    const epoch = new Date(2026, 0, 1);
    for (const r of rows) {
      const dt = new Date(r.date);
      if (isNaN(dt)) continue;
      const dayOffset = Math.floor((dt - epoch) / 86400000);
      const hour = dt.getHours(); // actual hour, bukan hardcoded 12
      const dow = dt.getDay(); // 0=Sun 6=Sat
      const sinDow = Math.sin(2 * Math.PI * dow / 7);
      const cosDow = Math.cos(2 * Math.PI * dow / 7);
      const isWeekend = (dow === 0 || dow === 6) ? 1.0 : 0.0;
      // 5 features: match By RB model [dayOffset, hour, sinDow, cosDow, isWeekend]
      X.push([dayOffset, hour, sinDow, cosDow, isWeekend]);
      y.push(r.mid);
    }
    if (X.length < 10) return;

    // Closed-form ridge regression lambda=0.5 (match By RB)
    const k = 5, n = X.length;
    const XtX = Array(k).fill(0).map(() => Array(k).fill(0));
    const Xty = Array(k).fill(0);

    // Standardize features
    const xMean = Array(k).fill(0);
    const xStd = Array(k).fill(0);
    for (let j = 0; j < k; j++) xMean[j] = X.reduce((s, r) => s + r[j], 0) / n;
    for (let j = 0; j < k; j++) {
      const variance = X.reduce((s, r) => s + Math.pow(r[j] - xMean[j], 2), 0) / n;
      xStd[j] = Math.max(Math.sqrt(variance), 1e-8);
    }
    const Xs = X.map(r => r.map((v, j) => (v - xMean[j]) / xStd[j]));

    const yMean = y.reduce((a, b) => a + b, 0) / n;
    const yc = y.map(v => v - yMean);

    for (let i = 0; i < n; i++)
      for (let j = 0; j < k; j++)
        for (let l = 0; l < k; l++)
          XtX[j][l] += Xs[i][j] * Xs[i][l];

    for (let i = 0; i < n; i++)
      for (let j = 0; j < k; j++)
        Xty[j] += Xs[i][j] * yc[i];

    // alpha=0.5 (match By RB)
    for (let j = 0; j < k; j++) XtX[j][j] += 0.5;

    const weights = solveLinear(XtX, Xty, k);
    if (weights) {
      this.midModel.weights = weights;
      this.midModel.featureCount = k;
      this.midModel.xMean = xMean;
      this.midModel.xStd = xStd;
      this.midModel.yMean = yMean;
      this.midModel.alpha = 0.5;
      this.midModel.trained = true;
      this.midModel.bias = 0.0; // bias sudah di-handle oleh standardization
    }
  }

  _getAwbSet() {
    if (this._awbSet && !this._awbSetDirty) return this._awbSet;
    this._awbSet = new Set(this.history.map(h => h.awb));
    this._awbSetDirty = false;
    return this._awbSet;
  }

  // ── Load/Save (localStorage) ──
  save() {
    try {
      const data = {
        midModel: {
          weights: this.midModel.weights,
          bias: this.midModel.bias,
          featureCount: this.midModel.featureCount,
          xMean: this.midModel.xMean,
          xStd: this.midModel.xStd,
          yMean: this.midModel.yMean,
          alpha: this.midModel.alpha,
          trained: this.midModel.trained,
        },
        varianceModel: { dailyRanges: this.varianceModel.dailyRanges },
        cityKdes: Object.fromEntries(
          Object.entries(this.cityKdes).map(([k, v]) => [k, {
            cityKey: v.cityKey, areas: v.areas, counts: v.counts, bandwidth: v.bandwidth
          }])
        ),
        destCache: Object.fromEntries(
          Object.entries(this.destCache).map(([k, v]) => [k, {
            cityKey: v.cityKey, area: v.area, hitCount: v.hitCount, lastSeen: v.lastSeen
          }])
        ),
        maxAreaEverSeen: this.maxAreaEverSeen,
        history: this.history,
        _seeded: this._seeded,
      };
      localStorage.setItem("awb_ml_model", JSON.stringify(data));
    } catch (e) { /* localStorage might be full */ }
  }

  static load() {
    try {
      const raw = localStorage.getItem("awb_ml_model");
      if (!raw) return new AwbMlEngine();
      const data = JSON.parse(raw);
      const engine = new AwbMlEngine();
      if (data.midModel) {
        engine.midModel.weights = data.midModel.weights || engine.midModel.weights;
        engine.midModel.bias = data.midModel.bias ?? engine.midModel.bias;
        engine.midModel.featureCount = data.midModel.featureCount || engine.midModel.featureCount;
        engine.midModel.xMean = data.midModel.xMean || engine.midModel.xMean;
        engine.midModel.xStd = data.midModel.xStd || engine.midModel.xStd;
        engine.midModel.yMean = data.midModel.yMean ?? engine.midModel.yMean;
        engine.midModel.alpha = data.midModel.alpha ?? engine.midModel.alpha;
        engine.midModel.trained = data.midModel.trained ?? false;
      }
      if (data.varianceModel) engine.varianceModel.dailyRanges = data.varianceModel.dailyRanges || [];
      if (data.cityKdes) {
        for (const [k, v] of Object.entries(data.cityKdes)) {
          const kde = new CityAreaKde();
          Object.assign(kde, v);
          engine.cityKdes[k] = kde;
        }
      }
      if (data.destCache) {
        for (const [k, v] of Object.entries(data.destCache)) {
          const entry = new DestCacheEntry();
          Object.assign(entry, v);
          engine.destCache[k] = entry;
        }
      }
      if (data.maxAreaEverSeen != null) engine.maxAreaEverSeen = data.maxAreaEverSeen;
      if (data.history) engine.history = data.history;
      engine._seeded = data._seeded || false;
      return engine;
    } catch (e) {
      return new AwbMlEngine();
    }
  }

  // ── Async: load seed data from JSON ──
  static async loadWithSeed(seedUrl = "awb_model_seed.json") {
    let engine = AwbMlEngine.load();
    if (engine._seeded) return engine;

    try {
      const resp = await fetch(seedUrl);
      if (resp.ok) {
        const seedData = await resp.json();
        engine.seedFromModel(seedData);
        engine.save();
      }
    } catch (e) {
      // Seed not available, use base model
    }
    return engine;
  }

  // ── Seed from JSONL (array of {awb, date, destination, mid, area}) ──
  seedFromRecords(records) {
    for (const r of records) {
      if (!r.awb || !r.date) continue;
      this.recordValidAwb(r.awb, r.date, r.destination || "", r.mid || 0, r.area || 0);
    }
  }
}

// ═══ Helpers ═══

function normalizeKey(value) {
  const normalized = (value || "").toLowerCase().replace(/[^0-9a-zA-Z\s]+/g, " ");
  return normalized.replace(/\s+/g, " ").trim();
}

function extractCityKey(destination) {
  if (!destination) return "";
  const parts = destination.split(",").map(s => s.trim()).filter(s => s.length > 0);
  let city = parts.length >= 2 ? parts[parts.length - 1] : (parts.length > 0 ? parts[0] : destination);
  for (const prefix of ["KOTA ADMINISTRASI ", "KOTA ", "KAB. ", "KAB ", "KABUPATEN "]) {
    if (city.toUpperCase().startsWith(prefix)) { city = city.substring(prefix.length); break; }
  }
  return city;
}

// Gaussian elimination with partial pivoting
function solveLinear(A, b, n) {
  const aug = Array(n).fill(0).map(() => Array(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i][j] = A[i][j];
    aug[i][n] = b[i];
  }
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++)
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    if (Math.abs(aug[maxRow][i]) < 1e-10) return null;

    for (let j = 0; j <= n; j++) [aug[i][j], aug[maxRow][j]] = [aug[maxRow][j], aug[i][j]];

    for (let k = i + 1; k < n; k++) {
      const factor = aug[k][i] / aug[i][i];
      for (let j = i; j <= n; j++) aug[k][j] -= factor * aug[i][j];
    }
  }
  const result = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    result[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) result[i] -= aug[i][j] * result[j];
    result[i] /= aug[i][i];
  }
  return result;
}

// ── Spiral order for MID scanning ──
export function spiralOrder(anchor, radius, max) {
  const seen = new Set();
  const result = [];
  for (let step = 0; step <= radius; step++) {
    const candidates = step === 0 ? [anchor] : [anchor + step, anchor - step];
    for (const c of candidates) {
      if (c >= 0 && c < max && !seen.has(c)) {
        seen.add(c);
        result.push(c);
      }
    }
  }
  // Fill remaining linearly
  for (let i = 0; i < max; i++)
    if (!seen.has(i)) result.push(i);
  return result;
}

export { normalizeKey, extractCityKey };