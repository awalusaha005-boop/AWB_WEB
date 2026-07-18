## 🐛 Bug 1 — PAUSE GATE benar trigger, tapi Next lanjut scan sisa 10k area (MAIN BUG)

**Masalahnya:** Waktu match ketemu di area 4 (batch 0–16), PAUSE GATE memang trigger dan nunggu user klik Next. Tapi waktu Next diklik, kode hanya reset `foundArea = null` lalu... **while loop lanjut dari `areaIdx = 16` sampai `areaOrder.length` (10k)**. Gak ada `break`!

```js
// PAUSE GATE sekarang — ini yang salah
if (foundArea) {
  await waitForNext();
  if (cts.cancelled) break;  // cuma break kalau Stop diklik
  foundArea = null;
  foundAreaLock.found = false;
  // ❌ while loop lanjut terus ke areaIdx 16 → 32 → ... → 10k
}
```

**Fix:** Tambah `break` setelah Next diklik supaya loncat ke midCandidate berikutnya, bukan nyerobot sisa area:

```js
// ✅ PAUSE GATE fix
if (foundArea) {
  log(`DEBUG: PAUSE GATE triggered! foundArea=${foundArea}, areaIdx=${areaIdx}`, "success");
  showNextButton();
  log("🎉 Match ditemukan! Klik ⏭ Next untuk lanjut MID berikutnya, ⏹ Stop untuk berhenti.", "success");
  await waitForNext();
  hideNextButton();
  break; // ← SELALU break, baik Next maupun Stop
         // cts.cancelled dicek di outer for loop (midsToScanArea)
}
```

---

## 🐛 Bug 2 — `if (foundArea) return;` di dalam task gak efektif

**Masalahnya:** Batch size = `maxConcurrent`, dan `areaSemaphore.max` juga = `maxConcurrent`. Jadi semua 16 task langsung dapat semaphore slot **secara bersamaan** sebelum `foundArea` bisa di-set oleh siapapun. Early exit check itu jadi gak berguna untuk batch pertama.

```js
// Semua 16 task masuk serentak:
await acquireSemaphore(areaSemaphore); // ← semua 16 langsung dapat slot
if (foundArea) return;                 // ← fondArea masih null untuk semua
await rateAcquire();
const result = await trackAwb(awb);   // ← semua 16 langsung hit API
// Task 4 set foundArea... tapi task 5-16 udah in-flight
```

**Fix:** Pakai `AbortController` biar fetch yang masih in-flight bisa dibatalkan:

```js
// Di luar while loop, per-midCandidate:
let batchAbort = new AbortController();

// Waktu match ketemu di dalam task:
if (!foundAreaLock.found) {
  foundAreaLock.found = true;
  foundArea = areaStr;
  batchAbort.abort();           // ← cancel semua fetch yang masih jalan
  matchedAwb = awb;
  // ... rest of match handling
}

// Di awal tiap batch iteration:
batchAbort = new AbortController(); // fresh controller per batch
const batchSignal = batchAbort.signal;

// Pass signal ke trackAwb → trackBiteshipDirect:
async function trackBiteshipDirect(awb, courier, signal) {
  // ...
  const resp = await fetch(url, {
    // ...
    signal: signal ?? AbortSignal.timeout(30000),
  });
  // ...
}
```

---

## 🐛 Bug 3 — MID phase batch 500 task sekaligus

**Masalahnya:** For loop MID berjalan synchronous, buat 500 task sebelum yield ke event loop. Jadi `if (cts.cancelled || foundMid) break` di for loop gak pernah kebaca waktu async task lagi running.

```js
for (const midStr of midsToScan) {
  if (foundMid) break;     // ← ini dicek synchronously — foundMid belum bisa
                           //   di-set karena async task belum dapat giliran run
  const task = (async () => { ... })(); // ← langsung invoke
  midTasks.push(task);
  if (midTasks.length >= 500) {
    await Promise.all(midTasks); // ← baru yield di sini → baru async bisa run
    midTasks = [];
  }
}
```

**Fix:** Kurangi batch size MID ke `maxConcurrent` (sama kayak AREA), atau pakai queue pattern yang lebih proper:

```js
// Ganti batch 500 → pakai maxConcurrent slots
let midTasks = [];
for (const midStr of midsToScan) {
  if (cts.cancelled || foundMid) break;
  if (checkedMids.has(midStr) || visitedAwbSuffix.has(midStr + FIXED_FIELD)) continue;

  midTasks.push(trackSingleMid(midStr)); // fungsi async yang wrap logic per-MID

  if (midTasks.length >= maxConcurrent) {
    await Promise.race(midTasks); // ← yield begitu ADA 1 yang selesai
    // Buang yang sudah resolved
    midTasks = midTasks.filter(t => isPending(t));
  }
}
if (midTasks.length > 0) await Promise.all(midTasks);
```

---

## Priority Fix

Kalau mau fix cepet, **Bug 1 paling kritikal** dan paling simpel — cukup ubah 4 baris di PAUSE GATE:

```js
// Ganti ini (line 626-635):
if (foundArea) {
  log(`DEBUG: PAUSE GATE triggered! foundArea=${foundArea}, areaIdx=${areaIdx}`, "success");
  showNextButton();
  log("🎉 Match ditemukan! Klik ⏭ Next untuk lanjut cari, ⏹ Stop untuk berhenti.", "success");
  await waitForNext();
  hideNextButton();
  if (cts.cancelled) break;
  foundArea = null;
  foundAreaLock.found = false;
}

// ↓ Jadi ini:
if (foundArea) {
  log(`PAUSE GATE triggered! foundArea=${foundArea}, areaIdx=${areaIdx}`, "success");
  showNextButton();
  log("🎉 Match ditemukan! Klik ⏭ Next untuk cari MID berikutnya.", "success");
  await waitForNext();
  hideNextButton();
  break; // ← ini aja yang beda — selalu break, cts.cancelled ditangani outer loop
}
```

Dengan ini: match di lemari 4 → pause → Next → loncat ke midCandidate berikutnya (bukan nyrobot 10k lemari sisanya). Stop → `cts.cancelled = true` → outer for loop juga break.