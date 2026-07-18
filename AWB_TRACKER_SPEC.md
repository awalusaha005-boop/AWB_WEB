# SiCepat Jinxpro — AWB Tracker Web v2.1

> Dokumentasi lengkap untuk porting ke desktop app.
> Target: **SiCepat** (courier), **Biteship API** (primary), **Binderbyte** (fallback).

---

## 1. ARSITEKTUR

```
┌──────────────┐     HMAC-SHA256      ┌─────────────────┐
│   Browser     │ ──── langsung ──────▶│  Biteship API    │
│  (Web Crypto) │                      │  api.biteship.com│
└──────┬───────┘                       └─────────────────┘
       │ fallback (proxy)
       ▼
┌──────────────┐
│  Vercel       │  (/api/track)
│  Serverless   │  ─── HMAC node:crypto ───▶  Biteship
└──────────────┘
```

- **Primary**: browser langsung ke Biteship (Web Crypto HMAC) — 1 hop
- **Fallback**: Vercel proxy `/api/track` — HMAC lewat `node:crypto`
- **Rate limit server**: Upstash Redis (60 req/menit per IP)
- **Progress sync**: localStorage + Upstash Redis backup

---

## 2. STRUKTUR AWB

```
0046 + MID(4 digit) + AREA(4 digit)
```

| Segment | Range | Contoh |
|---------|-------|--------|
| PREFIX | `0046` | `0046` |
| MID | `0000`–`9999` | `1730` |
| AREA | `0000`–`9999` | `0012` |

AWB lengkap: `004617300012`

---

## 3. FULL FEATURE LIST

### 3.1 Mode 1: Batch Tracking
- Input: multiple AWB (1 per baris)
- Parallel: 5 concurrent, rate limit 10 RPS
- Output: status, penerima, tujuan, tanggal, jam, history
- Export Excel (.xls XML format)

### 3.2 Mode 2: Search by Date/Time/City (Opsi 2)
- ML-guided MID scanning (ridge regression + KDE)
- Auto-pause per match (Next / Stop)
- Progress save/resume (localStorage + Redis)
- Real-time stats (Total, Berhasil, Dipindai)
- Kota optional — bisa kosong (global scan)

### 3.3 ML Self-Learning
- **Ridge Regression**: predict MID dari (dayOffset, hour, dow, isWeekend, 0)
- **KDE per kota**: CityAreaKde — density estimation per area
- **Variance Model**: adaptive radius MID
- **Dest Cache**: kota → area (hit ≥ 2 → langsung pakai)
- Auto-retrain setelah scan selesai
- Persist: localStorage + seed JSON

### 3.4 Auth System
- Google Sheets backend (GET `/api/auth?kodeAkses=XXX`)
- Sheet tab: `sicepat`
- Kolom: A=kode, B=username, C=mulai, D=expire, E=hwid, F=status, G=tipe
- Tipe: REGULAR (cek expire), TRIAL (cek expire), LIFETIME (skip)
- Login: 1 field kode akses, glass morphism UI
- Session: 24 jam localStorage

### 3.5 UI/UX
- Dark theme (glass morphism)
- 3-column layout: sidebar | hasil | activity log
- Splash screen animated
- Toggle switches (ON/OFF)
- Copy button dengan persistent "copied" indicator
- Auto-reload via Service Worker (skipWaiting + clients.claim)
- Mobile responsive
- Settings: theme, speed multiplier, API provider

### 3.6 Service Worker
- Cache v4: network-first HTML/JS/CSS, cache-first static assets
- Auto-update: `skipWaiting()` + `clients.claim()` + `client.navigate()`
- `controllerchange` listener untuk reload otomatis

---

## 4. FLOW TRACKING OPSI 2 (LENGKAP)

### 4.1 Input
| Field | Wajib | Format | Contoh |
|-------|-------|--------|--------|
| Jam | Tidak | `HH:mm` atau `HH:mm-HH:mm` | `11:00-13:00` |
| Tanggal | **Ya** | `YYYY-MM-DD` | `2026-07-11` |
| Kota | Tidak | `Kecamatan, Kota` | `Cengkareng, Jakarta Barat` |

### 4.2 Constants
```
PREFIX       = "0046"
FIXED_FIELD  = "0000"       (dipakai untuk MID scanning)
MAX_CONCURRENT = 16         (bisa naik ke 32 via speed multiplier)
RATE_LIMIT   = 10 RPS       (token bucket: 10 token, refill 1/100ms)
SAVE_EVERY   = 100          (save progress tiap 100 scan)
```

### 4.3 Phase 0: Validasi & Init

1. Validasi tanggal wajib (`YYYY-MM-DD`)
2. Parse time range dari jam (nullable — kalo kosong = semua jam)
3. Kota optional — kalo kosong, log `Tujuan=semua (bebas)`
4. Cek progress tersimpan:
   - Kalo target beda → hapus progress, mulai fresh
   - Kalo sama → resume dari phase terakhir
   - Kalo phase=`area` & foundMid ada → `skipMidPhase=true`

### 4.4 Phase 0.5: Kandidat MID (dari histori ML)

**`buildRbMidOrder(tgl, timeRange)`**:
1. ML ridge regression predict anchor MID
2. `getAdaptiveRadius()` — dari variance model
3. Kalo belum ada data variance untuk tanggal itu → radius aman (max 100)
4. Return **spiral order**: anchor, ±1, ±2, ±3, ... (step-based)

**`buildFallbackMids(tgl, kota, timeRange, seedMid, midOrder, maxCount)`**:
- `maxCount`: **32** kalo kota diisi, **12** kalo kota kosong
- Ambil dari `ml.history`:
  - Filter city: kalo ada kota → `matchDestination()` + cityKey match; kalo kosong → semua lolos
  - Sort: `dateScore` (selisih hari terdekat) → `midDistance` (jarak dari ML anchor)
  - Ambil `maxCount * 3` kandidat
- Tambah: anchor ML + midOrder spiral + delta ±80 (step 5) dari 4 kandidat teratas
- Return max `maxCount` MID

**Uji 5 kandidat pertama**:
- Track `PREFIX + candidateMid + "0000"`
- `isValidBiteshipResult` + `dateMatches` → valid candidate, naikin prioritas AREA
- Kalo ga ada yg cocok → `candidateMids = []`, lanjut MID spiral full

### 4.5 Phase 1: MID Scanning

**Tujuan**: cari MID yang valid (tanggal/jam cocok)

1. Scan `midOrder` (spiral order dari ML)
2. Parallel: `maxConcurrent` request, rate limit 10 RPS
3. Untuk tiap MID:
   - Build AWB: `PREFIX + midStr + "0000"`
   - Skip: `checkedMids.has(midStr)` atau `visitedAwbSuffix.has(midStr + "0000")`
   - Track via Biteship API (HMAC Web Crypto)
   - Valid → `validMidAwb++`, record ke ML
   - `dateMatches` + `newPrintOk` + belum ada MID found → **FOUND MID**
4. Progress: log tiap 200 scan, save tiap `SAVE_EVERY`, ML save tiap 500
5. Dedup: `visitedAwbSuffix` (Set) — cegah scan ulang suffix yg udah pernah

**MID FOUND condition**:
```js
dateOk = dateMatches(result, tgl, timeRange)
newPrintOk = !newPrintOnly || isNewPrintStatus(result)
midLock.found = dateOk && newPrintOk && !midLock.found
```

### 4.6 Phase 2: AREA Scanning

**Kandidat MID AREA**:
- `foundMid` (dari Phase 1) diprioritaskan
- + `fallbackMids` (dari `buildFallbackMids`)
- + `candidateMids` yang lolos uji

**Untuk tiap MID kandidat**:

#### 4.6a. Dest Cache (skip kalo kota kosong)
```
extractCityKey(kota) → ml.tryDestCache()
```
- Kalo hit ≥ 2 → langsung uji AWB cache
- Kalo match → hasil langsung, auto-pause (Next)

#### 4.6b. AREA Scanning

**`buildRbAreaOrder(kota)`**:
- Kalo kota diisi → `ml.getAreaOrder(cityKey)`:
  - Dest cache hit → KDE per-kota (`topAreas` by density) → linear fallback
- Kalo kota kosong → `ml.getAreaOrder("")`:
  - **Global KDE**: gabungin semua `cityKdes`, urutin by total frequency
  - Area paling sering muncul di semua kota di-scan duluan
  - Ceiling: P95 global history × 1.25 (min 255, max 9999)

**Scan flow**:
1. Build AWB: `PREFIX + foundMid + areaStr`
2. Skip: `checkedAreas.has(areaStr)` atau `visitedAwbSuffix.has(foundMid + areaStr)`
3. Track via Biteship API
4. Match conditions:
   ```
   destOk = matchDestination(dest, kota)     // kalo kota kosong → always true
   dateOk = dateMatches(result, tgl, timeRange)  // exact date + time range
   newPrintOk = !newPrintOnly || isNewPrintStatus(result)
   matchOk = destOk && dateOk && newPrintOk
   ```

5. **Auto-pause** (Opsi 2):
   - Match pertama → `foundAreaLock.found = true`
   - `results.push()` + render
   - Drain pending tasks (2s timeout)
   - Tampil **Next** button
   - `await waitForNext()` — tunggu user klik Next
   - Klik Next → reset, lanjut scan
   - Klik Stop → `cts.cancelled = true`

### 4.7 Final

1. Update stats: Total Resi, Berhasil, Dipindai
2. `renderResultsNow()`
3. Kalo `foundCounter > 0` → `ml.retrainMidModel()` + `ml.save()`
4. Kalo bukan pause → `deleteProgress()`
5. Set buttons disabled = false

---

## 5. HELPER FUNCTIONS

### 5.1 dateMatches(result, tgl, timeRange)
```
1. Ambil history dari result
2. Sort by date (newest first)
3. Cek: date.substring(0,10) === targetDate (exact match)
4. Kalo timeRange: cek minutes in [start, end]
5. Kalo ga ada timeRange: return true (semua jam)
```

### 5.2 matchDestination(entryDest, targetArea)
```
Kalo targetArea kosong → return true (skip filter)
Kalo entryDest kosong → return false
1. Tokenize kedua string (lowercase, hapus stopwords, hapus tanda baca)
2. Cek arah mata angin (selatan/utara/timur/barat/pusat) — harus match
3. Fuzzy match tiap token target ke token dest (Levenshtein ≥ 0.8)
4. Return true kalo semua token target match
```

### 5.3 isNewPrintStatus(result)
Cek latest history entry punya note/description = "baru cetak" atau sejenisnya.

### 5.4 extractShipmentDate(result)
Ambil tanggal dari history entries (parse `YYYY-MM-DD HH:mm`).

### 5.5 buildDestination(result)
Gabung `district + ", " + city` dari response Biteship.

### 5.6 isValidBiteshipResult(result)
Cek response punya `waybill_id` dan history array tidak kosong.

---

## 6. ML ENGINE (AwbMlEngine)

### 6.1 Ridge Model (MID prediction)
```
Features: [dayOffset, hour, dow, isWeekend, 0]
Weights: trained from By RB V2 (122k samples, R²=0.9667)
Standardization: xMean, xStd per feature
Output: predicted MID (0-9999)
```

### 6.2 CityAreaKde (per kota)
```
- areas[], counts[] — recorded areas with frequency
- bandwidth: Silverman's rule (adaptive)
- density(area): Gaussian KDE
- topAreas(max): ranked by density
```

### 6.3 MidVarianceModel
```
- dailyRanges: [{date, variance}]
- getRadius(): average variance of last 30 days × 20
- Min radius: 50
```

### 6.4 DestCache
```
- key: cityKey (normalized)
- entry: {area, hitCount, lastSeen}
- tryDestCache(): return true if hitCount ≥ 2
```

### 6.5 History
- Max 10,000 records, capped to 5,000
- Each record: {awb, date, destination, mid, area, timestamp}
- `recordValidAwb()`: dedup by AWB, update KDE + variance + dest cache

### 6.6 getAreaOrder(targetCity)
```
1. Dest cache hit (kalo cityKey spesifik)
2. KDE per-kota (topAreas by density) — atau global KDE kalo cityKey kosong
3. Linear fallback: 0 to ceiling
```

**Global KDE** (cityKey kosong):
```
1. Gabungin semua cityKdes → Map<area, totalCount>
2. Filter area ≤ ceiling
3. Sort by totalCount DESC
4. Linear fallback untuk area yg belum ada
```

### 6.7 getAreaCeiling(cityKey)
```
1. Kalo cityKey spesifik + KDE exists → max(areas) × 1.25
2. Kalo history ≥ 20 → P95 × 1.25 (min 255, max 9999)
3. Fallback: 9999
```

### 6.8 Persist
```json
{
  "midModel": { weights, bias, featureCount, xMean, xStd, yMean, alpha, trained },
  "varianceModel": { dailyRanges },
  "cityKdes": { "cityKey": { areas, counts, bandwidth } },
  "destCache": { "cityKey": { area, hitCount, lastSeen } },
  "maxAreaEverSeen": 9999,
  "history": [...],
  "_seeded": true
}
```

---

## 7. API ENDPOINTS

### 7.1 `/api/track` (Vercel serverless)
```
GET /api/track?awb=004612348765&courier=sicepat&provider=biteship

- Rate limit: 60 req/menit per IP (Upstash Redis)
- Biteship: HMAC-SHA256 signature (node:crypto)
- Binderbyte: API key di query string
- Retry: 3x (429: retry-after, 5xx: exponential backoff)
- Mobile UA rotation (10 device, 6 Chrome, 5 Android)
```

### 7.2 `/api/auth` (Vercel serverless)
```
POST /api/auth
Body: { "kodeAkses": "XXX" }

- Google Sheets GET (tab "sicepat")
- Response: { ok, username, tipe, message }
```

### 7.3 `/api/redis` (Vercel serverless)
```
POST /api/redis
Body: ["SET", key, value] atau ["GET", key] atau ["DEL", key]

- Upstash Redis REST API
- Progress backup/lookup
```

---

## 8. API TRACKING (Biteship)

### 8.1 Direct (browser)
```
URL: https://api.biteship.com/v1/public/trackings/{awb}/couriers/sicepat
Method: GET
Headers:
  Authorization: Public
  Origin: https://biteship.com
  Referer: https://biteship.com/id/cek-resi
  x-biteship-public-request-signature: <HMAC-SHA256>
  x-biteship-public-request-timestamp: <unix timestamp>

HMAC: timestamp|GET|/v1/public/trackings/{awb}/couriers/sicepat
Secret: ICPHV3CQGPTk7pmiYWnrLAzxcX9n4kC236pjn6OL5UwNf0uC3p
```

### 8.2 Response structure
```json
{
  "waybill_id": "004617300012",
  "status": "delivered",
  "courier": { "company": "sicepat" },
  "origin": { "city_name": "..." },
  "destination": {
    "district": "Cengkareng",
    "city_name": "Jakarta Barat",
    "contact_name": "Budi",
    "address": "..."
  },
  "history": [
    {
      "updated_at": "2026-07-11 14:30:00",
      "note": "Paket telah diterima",
      "city_name": "Jakarta Barat"
    }
  ]
}
```

---

## 9. SARAN UNTUK DESKTOP APP

### 9.1 Perbedaan Fundamental

| Aspek | Web | Desktop |
|-------|-----|---------|
| HTTP client | `fetch()` (browser) | `HttpClient` (C#) / `requests` (Python) |
| HMAC | Web Crypto API | `System.Security.Cryptography` / `hmac` |
| Concurrency | Async/await + semaphore | `Task.WhenAll` / `SemaphoreSlim` / `ThreadPool` |
| Storage | localStorage | SQLite / file JSON / registry |
| UI | DOM + CSS | WPF/XAML / WinForms / Qt |
| API calls | Direct dari browser | Semua dari desktop (gapapa, lebih simpel) |

### 9.2 Yang Bisa Disederhanakan di Desktop

1. **Tidak perlu Service Worker** — desktop ga perlu cache/offline SW
2. **Tidak perlu 2 jalur API** — desktop langsung pake HTTP client ke Biteship, ga perlu Web Crypto vs node:crypto
3. **Tidak perlu Redis rate limit** — desktop bisa pake in-memory rate limiter (token bucket)
4. **Tidak perlu CORS / proxy fallback** — desktop ga kena CORS
5. **Progress sync** — cukup file JSON lokal, ga perlu Redis

### 9.3 Yang Wajib Sama

1. **Struktur AWB**: `0046 + MID(4) + AREA(4)` — **EXACT SAME**
2. **HMAC signature**: `timestamp|GET|path` — **EXACT SAME** (cuma beda library)
3. **Flow Opsi 2**: Phase 0 → 0.5 → 1 → 2 — **EXACT SAME**
4. **ML Model**: Ridge regression weights, KDE, variance — **EXACT SAME** (bisa hardcode dari seed JSON)
5. **matchDestination**: tokenize + fuzzy Levenshtein — **EXACT SAME**
6. **dateMatches**: exact date + time range — **EXACT SAME**
7. **Auto-pause**: per match, Next/Stop — **EXACT SAME**

### 9.4 Optimalisasi Khusus Desktop

1. **Concurrency**: Desktop bisa **lebih agresif** — 20-30 concurrent (ga dibatasi browser)
2. **Rate limit**: Tetep 10 RPS (token bucket) — Biteship ratelimit sama
3. **ML persist**: SQLite database (lebih robust dari localStorage)
4. **Seed data**: Embed `awb_model_seed.json` sebagai embedded resource
5. **Progress**: Simpan ke file JSON di `%AppData%` / `~/.awb-tracker/`
6. **Auth**: Bisa tetep pake Google Sheets API atau pindah ke license key lokal
7. **Logging**: Bisa lebih verbose karena ga ada batasan DOM
8. **Export**: Bisa langsung Excel native (EPPlus/ClosedXML) bukan XML hack

### 9.5 Yang Bisa Ditambah di Desktop

1. **Background service**: scan otomatis tiap jam (cron-like)
2. **System tray**: minimize ke tray, notifikasi pas match ketemu
3. **Multi-thread**: MID scanning dan AREA scanning bisa parallel di thread terpisah
4. **Cache agresif**: simpan semua hasil tracking ke SQLite, cek dulu sebelum API call
5. **Batch dari file**: import CSV/Excel langsung
6. **Hitung mundur**: tampilkan estimasi waktu selesai berdasarkan speed

### 9.6 Rekomendasi Arsitektur Desktop

```
┌─────────────────────────────────────────┐
│              Desktop App                 │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │  UI      │  │  Engine   │  │  ML    │ │
│  │ (WPF/Qt) │  │ (Tracker) │  │ Engine │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │            │      │
│  ┌────┴──────────────┴────────────┴────┐ │
│  │         SQLite Database              │ │
│  │  - history (AWB records)             │ │
│  │  - ML model (weights, KDE)           │ │
│  │  - progress (scan state)             │ │
│  │  - settings                          │ │
│  └──────────────────────────────────────┘ │
│                    │                      │
│  ┌─────────────────┴──────────────────┐  │
│  │         HTTP Client                 │  │
│  │  - HMAC-SHA256 signer               │  │
│  │  - Token bucket rate limiter        │  │
│  │  - Retry handler (429, 5xx)         │  │
│  └─────────────────┬──────────────────┘  │
└────────────────────┼─────────────────────┘
                     │
              ┌──────┴──────┐
              │  Biteship   │
              │    API      │
              └─────────────┘
```

---

## 10. FILE STRUCTURE

```
AWB_WEB/
├── api/
│   ├── auth.js          # Google Sheets auth
│   ├── redis.js         # Upstash Redis wrapper
│   ├── track.js         # Biteship/Binderbyte proxy
│   └── test.js          # Test endpoint
├── public/
│   ├── app.js           # Main app logic (1384 lines)
│   ├── auth.js          # Login UI + session
│   ├── helpers.js        # dateMatches, matchDestination, etc.
│   ├── ml-engine.js      # RidgeModel, CityAreaKde, AwbMlEngine
│   ├── service-worker.js # Cache + auto-update
│   ├── index.html        # Main UI
│   ├── style.css         # Dark theme CSS
│   ├── manifest.json     # PWA manifest
│   ├── awb_model_seed.json # ML seed data
│   ├── New-AWB.png       # Logo
│   ├── icon-192x192.png  # PWA icon
│   └── icon-512x512.png  # PWA icon
├── package.json
├── vercel.json
└── dev-server.js         # Local dev server
```

---

## 11. DEPLOYMENT

```bash
# Deploy production
npx vercel deploy --prod --yes

# URL production
https://sicepat-jinxpro.vercel.app
```

---

## 12. VERSION HISTORY

| Version | Changes |
|---------|---------|
| v2.1.0 | Kota optional, global KDE, fallback MID reduction, toggle switches, copied indicator, dedup visitedAwbSuffix, rate limiter 10 RPS |
| v2.0.0 | Direct Biteship call, SW auto-reload, Redis rate limiting, progress backup |
| v1.x | Initial web port from C# WPF desktop |