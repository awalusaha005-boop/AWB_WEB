// ═══════════════════════════════════════════════════════
// ml-engine.js — Port dari AwbMlEngine.cs
// Ridge regression (MID prediction) + KDE (AREA ordering)
// ═══════════════════════════════════════════════════════

// ── Ridge model for MID prediction ──
export class RidgeModel {
  constructor() {
    // Trained params dari reference model (122k samples)
    this.weights = [42.814244663382595, 0, 0, 0];
    this.bias = -5148.556034482759;
    this.featureCount = 4;
  }

  predict(features) {
    if (features.length < this.featureCount) return 0;
    let sum = this.bias;
    for (let i = 0; i < this.featureCount; i++)
      sum += this.weights[i] * features[i];
    return sum;
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
    this.dataPath = null;
  }

  // ── Predict MID ──
  predictMidTwoLevel(targetDate, timeRange) {
    const date = new Date(targetDate);
    if (isNaN(date)) return 1730;
    const epoch = new Date(2026, 0, 1);
    const dayOffset = Math.floor((date - epoch) / 86400000);
    const hour = timeRange ? (timeRange.start + timeRange.end) / 2.0 / 60.0 : 12.0;
    const dow = date.getDay();
    const isWeekend = (dow === 0 || dow === 6) ? 1.0 : 0.0;

    const features = [dayOffset, hour, dow, isWeekend];
    let baseMid = Math.round(this.midModel.predict(features));

    if (timeRange) {
      const midFraction = (timeRange.start + timeRange.end) / 2.0 / 1440.0;
      baseMid += Math.round(midFraction * 75.0);
    }

    return Math.max(0, Math.min(9999, baseMid));
  }

  getAdaptiveRadius() {
    return Math.round(this.varianceModel.getRadius());
  }

  // ── Adaptive ceiling ──
  getAreaCeiling(cityKey = null) {
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

    // 2. KDE per-kota
    if (this.cityKdes[cityKey] && this.cityKdes[cityKey].areas.length > 0) {
      const kde = this.cityKdes[cityKey];
      kde.retrainBandwidth();
      for (const a of kde.topAreas(ceiling)) {
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
      X.push([dayOffset, 12, dt.getDay(), (dt.getDay() === 0 || dt.getDay() === 6) ? 1 : 0]);
      y.push(r.mid);
    }
    if (X.length < 10) return;

    // Closed-form ridge regression lambda=1.0
    const k = 4, n = X.length;
    const XtX = Array(k).fill(0).map(() => Array(k).fill(0));
    const Xty = Array(k).fill(0);

    for (let i = 0; i < n; i++)
      for (let j = 0; j < k; j++)
        for (let l = 0; l < k; l++)
          XtX[j][l] += X[i][j] * X[i][l];

    for (let i = 0; i < n; i++)
      for (let j = 0; j < k; j++)
        Xty[j] += X[i][j] * y[i];

    for (let j = 0; j < k; j++) XtX[j][j] += 1.0;

    const weights = solveLinear(XtX, Xty, k);
    if (weights) {
      this.midModel.weights = weights;
      const xMean = Array(k).fill(0);
      for (let j = 0; j < k; j++) xMean[j] = X.reduce((s, r) => s + r[j], 0) / n;
      this.midModel.bias = y.reduce((a, b) => a + b, 0) / n - weights.reduce((s, w, j) => s + w * xMean[j], 0);
      this.midModel.featureCount = k;
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
        midModel: this.midModel,
        varianceModel: { dailyRanges: this.varianceModel.dailyRanges },
        cityKdes: Object.fromEntries(
          Object.entries(this.cityKdes).map(([k, v]) => [k, {
            cityKey: v.cityKey, areas: v.areas, counts: v.counts, bandwidth: v.bandwidth
          }])
        ),
        destCache: this.destCache,
        maxAreaEverSeen: this.maxAreaEverSeen,
        history: this.history,
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
      if (data.midModel) Object.assign(engine.midModel, data.midModel);
      if (data.varianceModel) engine.varianceModel.dailyRanges = data.varianceModel.dailyRanges || [];
      if (data.cityKdes) {
        for (const [k, v] of Object.entries(data.cityKdes)) {
          const kde = new CityAreaKde();
          Object.assign(kde, v);
          engine.cityKdes[k] = kde;
        }
      }
      if (data.destCache) engine.destCache = data.destCache;
      if (data.maxAreaEverSeen != null) engine.maxAreaEverSeen = data.maxAreaEverSeen;
      if (data.history) engine.history = data.history;
      return engine;
    } catch (e) {
      return new AwbMlEngine();
    }
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
