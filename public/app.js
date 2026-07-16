// ═══════════════════════════════════════════════════════
// app.js — Main application logic
// Port dari MainWindow.xaml.cs ke browser JS
// ═══════════════════════════════════════════════════════

import { AwbMlEngine, spiralOrder, normalizeKey, extractCityKey } from "./ml-engine.js";
import {
  translateBiteshipStatus, parseBiteshipDate, getHistory, getLatestHistoryEntry,
  getNoteOrDesc, getDateOrUpdated, extractShipmentDate, isValidBiteshipResult,
  isNewPrintStatus, dateMatches, extractMatchingDate, parseTimeRange,
  buildDestination, buildOrigin, matchDestination, getBiteshipDiag,
  createBiteshipRow, createBinderbyteRow, escapeXml, cleanCity,
} from "./helpers.js";

// ── Constants ──
const PREFIX = "0046";
const FIXED_FIELD = "0000";
const COURIER = "sicepat";
const MAX_CONCURRENT = 16;
const SAVE_EVERY = 100;

// ── State ──
let results = [];
let cts = null; // { cancelled: false }
let _paused = false; // true = pause (keep scan UI), false = stop/reset
let nextResolver = null;
let startTime = null;
let ml = null;
let settings = { theme: "Dark", speedMultiplier: 1.0, provider: "biteship", hideAwbColumn: false };
let logQueue = [];
let logRafId = null;
let progress = null; // { phase, checkedMids, checkedAreas, foundMid, ... }
let renderPending = false;
let renderTimer = null;

// ═══════════════════════════════════════════════════════
// SPLASH / LOADING SCREEN
// Port dari LoadingWindow.xaml — 22-seg bar, shimmer, status
// ═══════════════════════════════════════════════════════
const SPLASH_SEG_COUNT = 22;
let _splashShimmerPos = 0;
let _splashLastSegCount = -1;
let _splashShimmerTimer = null;
let _splashSegs = [];

function initSplash() {
  const segbar = document.getElementById("splashSegbar");
  if (!segbar) return;
  for (let i = 0; i < SPLASH_SEG_COUNT; i++) {
    const seg = document.createElement("div");
    seg.className = "splash-seg";
    segbar.appendChild(seg);
    _splashSegs.push(seg);
  }
  // Shimmer timer ~60fps
  _splashShimmerTimer = setInterval(splashShimmerTick, 16);
}

function splashShimmerTick() {
  _splashShimmerPos = (_splashShimmerPos + 1) % SPLASH_SEG_COUNT;
  for (let i = 0; i < SPLASH_SEG_COUNT; i++) {
    if (!_splashSegs[i]) continue;
    if (i < _splashLastSegCount) {
      _splashSegs[i].className = i === _splashShimmerPos ? "splash-seg splash-seg-bright" : "splash-seg splash-seg-active";
    } else {
      _splashSegs[i].className = "splash-seg";
    }
  }
}

function setSplashStatus(msg, progress = 0) {
  const statusEl = document.getElementById("splashStatus");
  const pctEl = document.getElementById("splashPercent");
  if (statusEl) statusEl.textContent = msg.toUpperCase();
  if (pctEl) {
    const pct = Math.min(100, Math.round(progress * 100));
    pctEl.textContent = pct + "%";
  }
  const segCount = Math.min(SPLASH_SEG_COUNT, Math.round(progress * SPLASH_SEG_COUNT));
  _splashLastSegCount = segCount;
}

async function runSplashSequence() {
  initSplash();
  await sleep(500);

  setSplashStatus("Inisialisasi aplikasi...", 0.05);
  await sleep(600);

  setSplashStatus("Memuat mesin ML...", 0.20);
  await sleep(700);

  setSplashStatus("Memeriksa progress tersimpan...", 0.40);
  await sleep(600);

  setSplashStatus("Memuat antarmuka...", 0.65);
  await sleep(600);

  setSplashStatus("Menyiapkan komponen UI...", 0.85);
  await sleep(500);

  setSplashStatus("Selesai", 1.0);
  await sleep(900);

  closeSplash();
}

function closeSplash() {
  if (_splashShimmerTimer) {
    clearInterval(_splashShimmerTimer);
    _splashShimmerTimer = null;
  }
  const splash = document.getElementById("splashScreen");
  if (!splash) return;
  splash.classList.add("splash-hiding");
  setTimeout(() => {
    splash.remove();
  }, 250);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  applyTheme(settings.theme);
  ml = AwbMlEngine.load();
  log("Siap. Kurir: " + COURIER, "info");
  log(`Mesin ML dimuat: ${ml.history.length} data | batas AREA=${ml.getAreaCeiling()}`, "system");
  checkProgressOnStartup();

  // Wire up UI
  document.getElementById("btnTrack").onclick = btnTrackClick;
  document.getElementById("btnTrackSearch").onclick = btnTrackSearchClick;
  document.getElementById("btnPause").onclick = btnPauseClick;
  document.getElementById("btnReset").onclick = btnResetClick;
  document.getElementById("btnStop").onclick = btnStopClick;
  document.getElementById("btnNext").onclick = btnNextClick;
  document.getElementById("btnExport").onclick = btnExportClick;
  document.getElementById("btnSettings").onclick = openSettings;
  document.getElementById("btnSettingsSave").onclick = saveSettingsClick;
  document.getElementById("btnSettingsCancel").onclick = closeSettings;
  document.getElementById("chkHideAwbColumn").onchange = chkHideAwbChange;

  // Restore UI preferences
  document.getElementById("chkHideAwbColumn").checked = settings.hideAwbColumn;

  // Log: flush via requestAnimationFrame (no batching delay)
  logRafId = requestAnimationFrame(flushLogQueue);

  // License countdown (placeholder — no license in web version)
  updateLicenseDisplay();
  setInterval(updateLicenseDisplay, 1000);

  // Run splash sequence after UI is ready
  runSplashSequence();
});

// ═══════════════════════════════════════════════════════
// API CALL
// ═══════════════════════════════════════════════════════
async function trackAwb(awb, courier = COURIER, provider = null) {
  const prov = provider || settings.provider || "biteship";
  const url = `/api/track?awb=${encodeURIComponent(awb)}&courier=${encodeURIComponent(courier)}&provider=${encodeURIComponent(prov)}`;
  try {
    const resp = await fetch(url);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, message: `HTTP ${resp.status}: ${text}`, error: text };
    }
    return await resp.json();
  } catch (err) {
    return { success: false, message: err.message, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════
// MODE 1: BATCH TRACKING (BtnTrack)
// ═══════════════════════════════════════════════════════
async function btnTrackClick() {
  const raw = document.getElementById("txtAwb").value.trim();
  if (!raw) return;

  const awbList = [...new Set(
    raw.split("\n").map(s => s.trim()).filter(s => s.length > 0)
  )];
  if (awbList.length === 0) return;

  setButtonsDisabled(true);
  cts = { cancelled: false };
  results = [];
  startTime = Date.now();

  log(`Melacak ${awbList.length} nomor resi...`, "system");

  const semaphore = { current: 0, max: 5 };
  let done = 0;

  const tasks = awbList.map(async (awb) => {
    await acquireSemaphore(semaphore);
    try {
      const current = ++done;
      log(`[${current}/${awbList.length}] Melacak ${awb}...`, "info", false);

      const result = await trackAwb(awb);
      const row = settings.provider === "binderbyte"
        ? createBinderbyteRow(awb, result)
        : createBiteshipRow(awb, result);

      results.push(row);
      renderResults();
      log(`✓ ${awb} — ${row.status}`, "success");
    } catch (err) {
      results.push({ awb, status: "Gagal: " + err.message, receiver: "-", destination: "-", lastUpdate: "-", jam: "-", tanggal: "-" });
      renderResults();
      log(`✗ ${awb} — ${err.message}`, "error");
    } finally {
      releaseSemaphore(semaphore);
    }
  });

  await Promise.all(tasks);

  const duration = new Date(Date.now() - startTime);
  updateStats(duration);

  log(`Selesai! ${results.length} hasil.`, "success");
  setButtonsDisabled(false);
  cts = null;
}

// ═══════════════════════════════════════════════════════
// MODE 2: SEARCH BY DATE/TIME/CITY (BtnTrackSearch)
// ═══════════════════════════════════════════════════════
async function btnTrackSearchClick() {
  const jam = document.getElementById("txtJam").value.trim();
  const tgl = document.getElementById("txtTanggal").value.trim();
  const kota = document.getElementById("txtKota").value.trim();

  if (!tgl || !/^\d{4}-\d{2}-\d{2}$/.test(tgl)) {
    log("Tanggal wajib format YYYY-MM-DD. Contoh: 2026-07-11", "warning");
    return;
  }

  const timeRange = parseTimeRange(jam);
  if (jam && !timeRange) {
    log("Format jam harus HH:mm atau HH:mm-HH:mm. Contoh: 11:00-13:00", "warning");
    return;
  }

  if (!kota) {
    log("Kota tujuan wajib format Kecamatan, Kota. Contoh: Cengkareng, Jakarta Barat", "warning");
    return;
  }

  setButtonsDisabled(true);
  document.getElementById("btnStop").classList.remove("hidden");
  cts = { cancelled: false };
  results = [];
  document.getElementById("icResults").innerHTML = "";
  startTime = Date.now();

  const newPrintOnly = document.getElementById("chkNewPrintOnly").checked;

  // Progress init/resume
  let seedMid = "";
  if (progress && progress.phase) {
    const targetChanged = progress.targetDate !== tgl || progress.targetKota !== kota ||
      (progress.newPrintOnly || false) !== newPrintOnly;
    if (targetChanged) {
      log("Progress lama beda target/filter — dihapus agar scan mulai fresh.", "warning");
      deleteProgress();
    }
  }

  let checkedMids = new Set();
  let checkedAreas = new Set();
  let skipMidPhase = false;
  if (progress && progress.phase) {
    checkedMids = new Set(progress.checkedMids || []);
    checkedAreas = new Set(progress.checkedAreas || []);
    if (progress.phase === "area" && progress.foundMid) {
      skipMidPhase = true;
      log(`Lanjut: lewati fase MID, langsung AREA (MID=${progress.foundMid})`, "system", false);
    } else {
      log(`Lanjut MID: lewati ${checkedMids.size} MID sudah dipindai`, "system", false);
    }
  } else {
    progress = { phase: "mid", targetDate: tgl, targetKota: kota, newPrintOnly };
    saveProgress();
  }

  log("=== MODE PENCARIAN: JAM/TANGGAL/KOTA ===", "system");
  log(`Tanggal=${tgl} | Jam=${jam || "semua"} | Tujuan=${kota}`, "info");
  log("Format tujuan ideal: Kecamatan, Kota. Contoh: Cengkareng, Jakarta Barat", "system");

  const maxConcurrent = Math.max(8, Math.min(32, Math.round(16 * Math.max(1.0, settings.speedMultiplier))));
  let midScanned = 0, areaScanned = 0, midFailed = 0, areaFailed = 0;
  let validMidAwb = 0, validAreaAwb = 0, foundCounter = 0;

  try {
    let foundMid = skipMidPhase ? progress.foundMid : null;
    let foundMidResponse = null;
    let foundMidAwb = null;

    // ── Build MID order from ML ──
    const midOrder = buildRbMidOrder(tgl, timeRange);
    log(`ML MID: titik pusat=${midOrder[0]} radius=${ml.getAdaptiveRadius()}`, "system", false);

    // ── Build fallback candidates ──
    let candidateMids = buildFallbackMids(tgl, kota, timeRange, seedMid, midOrder, 32);

    if (candidateMids.length > 0) {
      log(`Cek kandidat MID: ${candidateMids.slice(0, 5).join(", ")}...`, "system", false);
      let validCandidate = false;
      let bestCandidateMid = null;
      for (const cm of candidateMids.slice(0, 5)) {
        if (cts.cancelled) break;
        const probe = await trackAwb(PREFIX + cm + FIXED_FIELD);
        if (isValidBiteshipResult(probe)) {
          log(`UJI KANDIDAT: ${PREFIX + cm + FIXED_FIELD} | info=${getBiteshipDiag(probe)}`, "info", false);
        }
        if (isValidBiteshipResult(probe) && dateMatches(probe, tgl, timeRange)) {
          validCandidate = true;
          bestCandidateMid = cm;
          log(`Kandidat MID ${cm} cocok tanggal target, lewati uji MID.`, "success");
          break;
        }
      }
      if (!validCandidate) {
        log("Kandidat MID dari histori tidak cocok tanggal target — lanjut uji MID spiral.", "system", false);
        candidateMids = [];
      } else if (bestCandidateMid) {
        candidateMids = candidateMids.filter(m => m !== bestCandidateMid);
        candidateMids.unshift(bestCandidateMid);
      }
    } else if (!foundMid) {
      log("Fase 1: mencari MID yang cocok tanggal/jam...", "system", false);
      log(`Titik pusat MID (ML): ${midOrder[0]} | prioritas pindai di sekitar titik pusat`, "system", false);
    }

    // ── Phase 1: MID scanning ──
    const midSemaphore = { current: 0, max: maxConcurrent };
    const midLock = { found: false };
    let midTasks = [];
    const midsToScan = candidateMids.length > 0 ? [] : midOrder;

    for (const midStr of midsToScan) {
      if (cts.cancelled || foundMid) break;
      if (checkedMids.has(midStr)) continue;
      const awb = PREFIX + midStr + FIXED_FIELD;

      const task = (async () => {
        await acquireSemaphore(midSemaphore);
        try {
          if (foundMid) return;
          const result = await trackAwb(awb);
          const current = ++midScanned;
          checkedMids.add(midStr);
          progress.lastMid = midStr;
          if (current % 100 === 0) {
            log(`MID dipindai ${current} | valid=${validMidAwb} | gagal=${midFailed}`, "info", false);
            if (current % SAVE_EVERY === 0) {
              progress.checkedMids = [...checkedMids];
              saveProgress();
            }
            if (current % 500 === 0) ml.save();
          }

          if (!isValidBiteshipResult(result)) return;
          validMidAwb++;
          const date = extractShipmentDate(result);
          const dest = buildDestination(result);
          const dateOk = dateMatches(result, tgl, timeRange);
          const newPrintOk = !newPrintOnly || isNewPrintStatus(result);
          const displayDate = dateOk ? extractMatchingDate(result, tgl, timeRange) : date;
          if (dateOk && newPrintOk)
            log(`MID valid: ${awb} | ${displayDate} | ${dest} | TARGET`, "success", false);

          if (date && dest) {
            ml.recordValidAwb(awb, date, dest, parseInt(midStr), 0);
          }

          if (dateOk && newPrintOk && !midLock.found) {
            midLock.found = true;
            foundMid = midStr;
            foundMidResponse = result;
            foundMidAwb = awb;
          }
        } catch (err) {
          midFailed++;
          log(`MID ${midStr} gagal: ${err.message}`, "error");
        } finally {
          releaseSemaphore(midSemaphore);
        }
      })();

      midTasks.push(task);
      if (midTasks.length >= 100) {
        await Promise.all(midTasks);
        midTasks = [];
      }
    }
    if (midTasks.length > 0) await Promise.all(midTasks);

    // ── Build candidates for AREA phase ──
    let fallbackMids = candidateMids.length > 0 ? candidateMids : buildFallbackMids(tgl, kota, timeRange, seedMid, midOrder, 32);
    if (fallbackMids.length === 0) {
      log("Tidak ada kandidat MID cadangan. Coba perlebar rentang jam.", "error");
      deleteProgress();
      progress = null;
      return;
    }

    let midsToScanArea = [];
    if (foundMid) midsToScanArea.push(foundMid);
    midsToScanArea.push(...fallbackMids.filter(m => m !== foundMid));
    log(`Mode kandidat AREA: pindai ${midsToScanArea.length} kandidat MID${foundMid ? ` (lanjut dari progress MID=${foundMid})` : ""}`, "warning", false);

    let matchedResult = null, matchedAwb = null;

    // ── Phase 2: AREA scanning per MID ──
    for (const midCandidate of midsToScanArea) {
      if (cts.cancelled) break;
      foundMid = midCandidate;
      if (!foundMidAwb) foundMidAwb = PREFIX + foundMid + FIXED_FIELD;
      checkedAreas = new Set();

      progress.phase = "area";
      progress.foundMid = foundMid;
      progress.checkedMids = [...checkedMids];
      progress.checkedAreas = [...checkedAreas];
      saveProgress();

      log(`MID kandidat: ${foundMid} dari ${foundMidAwb}. Pindai AREA tujuan...`, "success");

      // Dest cache check
      const cityKeyForCache = extractCityKey(kota);
      const cacheOut = {};
      if (ml.tryDestCache(cityKeyForCache, cacheOut)) {
        const cacheAwb = PREFIX + foundMid + String(cacheOut.area).padStart(4, "0");
        log(`CACHE TUJUAN COCOK: ${cityKeyForCache} → AREA ${String(cacheOut.area).padStart(4, "0")} | uji ${cacheAwb}`, "system", false);
        const cacheResult = await trackAwb(cacheAwb);
        if (isValidBiteshipResult(cacheResult) && matchDestination(buildDestination(cacheResult), kota) &&
            dateMatches(cacheResult, tgl, timeRange) && (!newPrintOnly || isNewPrintStatus(cacheResult))) {
          ml.recordValidAwb(cacheAwb, extractShipmentDate(cacheResult), buildDestination(cacheResult), parseInt(foundMid), cacheOut.area);
          results.push(createBiteshipRow(cacheAwb, cacheResult, tgl, timeRange));
          renderResults();
          matchedAwb = cacheAwb;
          matchedResult = cacheResult;
          foundCounter++;
          log(`HASIL LANGSUNG DARI CACHE: ${cacheAwb} | tidak perlu pindai AREA`, "success");
          showNextButton();
          await waitForNext();
          hideNextButton();
          if (cts.cancelled) break;
          continue;
        }
        log("Cache tidak cocok, lanjut pindai AREA...", "info", false);
      }

      log(`Fase 2: mencari AREA yang cocok tujuan + tanggal/jam untuk MID ${foundMid}...`, "system", false);

      const areaSemaphore = { current: 0, max: maxConcurrent };
      const foundAreaLock = { found: false };
      let foundArea = null;
      let areaTasks = [];

      const areaOrder = buildRbAreaOrder(kota);
      const ceiling = ml.getAreaCeiling(extractCityKey(kota));
      log(`Pindai AREA: urutan KDE panduan ML (batas ${ceiling}, ${extractCityKey(kota)}) | mid=${foundMid}`, "system");

      for (const areaStr of areaOrder) {
        if (cts.cancelled) break;
        if (foundArea) {
          // Drain pending tasks with 2s timeout
          if (areaTasks.length > 0) {
            await Promise.race([Promise.all(areaTasks), new Promise(r => setTimeout(r, 2000))]);
            areaTasks = [];
          }
          showNextButton();
          log("✓ Match ditemukan! Klik ⏭ Next untuk lanjut cari, ⏹ Stop untuk berhenti.", "success");
          await waitForNext();
          hideNextButton();
          if (cts.cancelled) break;
          foundArea = null;
        }
        if (foundArea) continue; // re-check after drain — skip if foundArea survived
        if (checkedAreas.has(areaStr)) continue;
        const awb = PREFIX + foundMid + areaStr;

        const task = (async () => {
          await acquireSemaphore(areaSemaphore);
          try {
            if (foundArea) return;
            const result = await trackAwb(awb);
            const current = ++areaScanned;
            checkedAreas.add(areaStr);
            progress.lastArea = areaStr;
            if (current % 200 === 0) {
              log(`AREA dipindai ${current} | mid=${foundMid} | valid=${validAreaAwb} | gagal=${areaFailed} | cocok=${foundCounter}`, "info", false);
              if (current % SAVE_EVERY === 0) {
                progress.checkedAreas = [...checkedAreas];
                saveProgress();
              }
            }

            if (!isValidBiteshipResult(result)) return;
            validAreaAwb++;

            const date = extractShipmentDate(result);
            const dest = buildDestination(result);
            const destOk = matchDestination(dest, kota);
            const dateOk = dateMatches(result, tgl, timeRange);
            const newPrintOk = !newPrintOnly || isNewPrintStatus(result);
            const matchOk = destOk && dateOk && newPrintOk;
            const displayDate = dateOk ? extractMatchingDate(result, tgl, timeRange) : date;

            if (date && dest) {
              ml.recordValidAwb(awb, date, dest, parseInt(foundMid), parseInt(areaStr));
            }

            if (!matchOk) return;
            foundCounter++;
            if (!foundAreaLock.found) {
              foundAreaLock.found = true;
              foundArea = areaStr;
              matchedAwb = awb;
              matchedResult = result;
              log(`AREA valid: ${awb} | ${displayDate} | ${dest} | tujuan=OK | tanggal=OK | baru cetak=OK | COCOK | info=${getBiteshipDiag(result)}`, "success", false);
            }

            results.push(createBiteshipRow(awb, result, tgl, timeRange));
            renderResults();
          } catch (err) {
            areaFailed++;
            log(`AREA ${awb} gagal: ${err.message}`, "error");
          } finally {
            releaseSemaphore(areaSemaphore);
          }
        })();

        areaTasks.push(task);
        if (areaTasks.length >= 100) {
          await Promise.all(areaTasks);
          areaTasks = [];
          if (foundArea) continue;
        }
      }
      if (areaTasks.length > 0) await Promise.all(areaTasks);

      if (foundCounter === 0)
        log(`MID ${foundMid} selesai: belum match (scan=${areaScanned} gagal=${areaFailed}), lanjut kandidat berikutnya jika ada.`, "warning");
    }

    // ── Final stats ──
    const duration = new Date(Date.now() - startTime);
    updateStats(duration);
    renderResultsNow();

    log("=== PENCARIAN SELESAI ===", "system");
    log(`MID dipindai: ${midScanned} | MID valid: ${validMidAwb} | AREA dipindai: ${areaScanned} | AREA valid: ${validAreaAwb} | Cocok: ${foundCounter} | Durasi: ${formatDuration(duration)}`,
      foundCounter > 0 ? "success" : "warning");

    // Auto-retrain & save ML model
    if (foundCounter > 0) {
      ml.retrainMidModel();
      ml.save();
      log(`Model ML diperbarui & disimpan. Histori: ${ml.history.length} | Batas AREA baru: ${ml.getAreaCeiling()}`, "success");
    }

    if (!_paused) {
      deleteProgress();
      progress = null;
      log("Progress dihapus (scan selesai).", "system");
    }
  } catch (err) {
    if (cts?.cancelled) {
      if (progress) {
        progress.checkedMids = [...checkedMids];
        progress.checkedAreas = [...checkedAreas];
        saveProgress();
        log("Dihentikan — progres disimpan. Bisa dilanjutkan nanti.", "warning");
      } else {
        log("Pencarian dibatalkan.", "warning");
      }
    } else {
      log("Error: " + err.message, "error");
    }
  } finally {
    cts = null;
    if (!_paused) {
      setButtonsDisabled(false);
      document.getElementById("btnStop").classList.add("hidden");
      document.getElementById("btnNext").classList.add("hidden");
    } else {
      // Paused: change Pause button to Resume
      const btnPause = document.getElementById("btnPause");
      btnPause.querySelector(".text").textContent = "Lanjut"; btnPause.querySelector(".icon").textContent = "▶";
      btnPause.onclick = btnResumeClick;
    }
    _paused = false;
  }
}

// ═══════════════════════════════════════════════════════
// MID/AREA ORDER BUILDERS
// ═══════════════════════════════════════════════════════
function buildRbMidOrder(targetDate, timeRange) {
  const anchor = ml.predictMidTwoLevel(targetDate, timeRange);
  const radius = ml.getAdaptiveRadius();

  const varianceSamples = ml.varianceModel.dailyRanges
    .filter(v => v.date && v.date.length >= 10 && v.date.substring(0, 10) === targetDate.substring(0, 10));
  let adjustedRadius = radius;
  if (varianceSamples.length === 0) {
    adjustedRadius = Math.min(radius, 100);
    log(`Belum ada data variance untuk tanggal ${targetDate}, pakai radius aman=${adjustedRadius}`, "system", false);
  }

  return spiralOrder(anchor, adjustedRadius, 10000).map(i => String(i).padStart(4, "0"));
}

function buildRbAreaOrder(targetArea) {
  try {
    const cityKey = extractCityKey(targetArea);
    const ordered = ml.getAreaOrder(cityKey);
    return ordered.map(a => String(a).padStart(4, "0"));
  } catch (err) {
    const ceiling = ml?.getAreaCeiling(extractCityKey(targetArea)) ?? 9999;
    log(`Urutan AREA ML error: ${err.message} — pakai urutan linear 0-${ceiling}`, "warning");
    return Array.from({ length: ceiling + 1 }, (_, i) => String(i).padStart(4, "0"));
  }
}

function buildFallbackMids(targetDate, targetArea, timeRange, seedMid, midOrder, maxCount) {
  const result = [];
  const seen = new Set();
  const addMid = (mid) => {
    if (mid >= 0 && mid <= 9999) {
      const s = String(mid).padStart(4, "0");
      if (!seen.has(s)) { seen.add(s); result.push(s); }
    }
  };

  if (seedMid && /^\d+$/.test(seedMid)) addMid(parseInt(seedMid));

  const targetCity = extractCityKey(targetArea);
  const targetDt = new Date(targetDate);
  const targetDtOk = !isNaN(targetDt);

  const candidates = ml.history
    .filter(h => h.date && h.destination)
    .map(h => ({
      mid: h.mid,
      destination: h.destination,
      cityOk: matchDestination(h.destination, targetArea) || normalizeKey(extractCityKey(h.destination)) === targetCity,
      dateScore: targetDtOk && !isNaN(new Date(h.date.replace(/\./g, ":"))) ? Math.abs((new Date(h.date.replace(/\./g, ":")) - targetDt) / 86400000) : 9999.0
    }))
    .filter(x => x.cityOk)
    .sort((a, b) => a.dateScore - b.dateScore || Math.abs(a.mid - ml.predictMidTwoLevel(targetDate, timeRange)) - Math.abs(b.mid - ml.predictMidTwoLevel(targetDate, timeRange)))
    .slice(0, maxCount * 3);

  for (const c of candidates) addMid(c.mid);

  for (const c of candidates.slice(0, 4)) {
    for (let delta = 1; delta <= 80; delta += 5) addMid(c.mid + delta);
  }

  const anchor = ml.predictMidTwoLevel(targetDate, timeRange);
  addMid(anchor);
  for (const midStr of midOrder.slice(0, Math.max(0, maxCount * 2)))
    if (/^\d+$/.test(midStr)) addMid(parseInt(midStr));

  return result.slice(0, maxCount);
}

// ═══════════════════════════════════════════════════════
// UI ACTIONS
// ═══════════════════════════════════════════════════════
function btnResetClick() {
  if (nextResolver) nextResolver(false);
  if (cts) {
    cts.cancelled = true;
    log("Scan dibatalkan oleh reset.", "warning");
  }
  deleteProgress();
  progress = null;
  results = [];
  document.getElementById("icResults").innerHTML = "";
  document.getElementById("txtAwb").value = "";
  document.getElementById("txtJam").value = "";
  document.getElementById("txtTanggal").value = "";
  document.getElementById("txtKota").value = "";
  document.getElementById("txtNoResults").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
  document.getElementById("btnStop").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
  document.getElementById("btnPause").classList.add("hidden");
  document.getElementById("btnScanRow").classList.add("hidden");
  document.getElementById("btnTrackSearch").classList.remove("hidden");
  log("Dashboard direset. Progress dihapus. Menunggu input baru...", "system");
  updateStats(new Date(0));
}

function btnStopClick() {
  if (nextResolver) nextResolver(false);
  if (cts) {
    log("Stop — membatalkan scan, progress akan disimpan...", "warning");
    cts.cancelled = true;
  }
}

function btnPauseClick() {
  if (nextResolver) nextResolver(false);
  if (cts) {
    _paused = true;
    log("⏸ Pause — scan dijeda. Progress disimpan.", "warning");
    cts.cancelled = true;
  }
}

function btnResumeClick() {
  // Reset pause button back to Pause
  const btnPause = document.getElementById("btnPause");
  btnPause.querySelector(".text").textContent = "Pause"; btnPause.querySelector(".icon").textContent = "⏸";
  btnPause.onclick = btnPauseClick;
  // Restart scan — will pick up saved progress
  btnTrackSearchClick();
}

function btnNextClick() {
  if (nextResolver) nextResolver(true);
}

function btnExportClick() {
  if (results.length === 0) return;

  let sb = '<?xml version="1.0" encoding="UTF-8"?>\n';
  sb += '<?mso-application progid="Excel.Sheet"?>\n';
  sb += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
  sb += '          xmlns:o="urn:schemas-microsoft-com:office:office"\n';
  sb += '          xmlns:x="urn:schemas-microsoft-com:office:excel"\n';
  sb += '          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  sb += '  <Styles>\n';
  sb += '    <Style ss:ID="Header">\n';
  sb += '      <Font ss:Bold="1"/>\n';
  sb += '      <Interior ss:Color="#00BCD4" ss:Pattern="Solid"/>\n';
  sb += '    </Style>\n';
  sb += '  </Styles>\n';
  sb += '  <Worksheet ss:Name="AWB Export">\n';
  sb += '    <Table>\n';
  sb += '      <Row>\n';
  for (const header of ["AWB", "Status", "Penerima", "Tujuan", "Update Terakhir", "Courier"])
    sb += `        <Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(header)}</Data></Cell>\n`;
  sb += '      </Row>\n';
  for (const r of results) {
    sb += '      <Row>\n';
    for (const val of [r.awb, r.status, r.receiver, r.destination, r.lastUpdate, r.courier])
      sb += `        <Cell><Data ss:Type="String">${escapeXml(val || "")}</Data></Cell>\n`;
    sb += '      </Row>\n';
  }
  sb += '    </Table>\n';
  sb += '  </Worksheet>\n';
  sb += '</Workbook>';

  const blob = new Blob([sb], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `AWB_Export_${new Date().toISOString().replace(/[-:T]/g, "").substring(0, 15)}.xls`;
  a.click();
  URL.revokeObjectURL(url);
  log("Excel diekspor.", "success");
}

function chkHideAwbChange() {
  const hide = document.getElementById("chkHideAwbColumn").checked;
  settings.hideAwbColumn = hide;
  saveSettings();
  renderResultsNow();
}

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════
function loadSettings() {
  try {
    const raw = localStorage.getItem("awb_settings");
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch {}
}

function saveSettings() {
  localStorage.setItem("awb_settings", JSON.stringify(settings));
}

function openSettings() {
  document.getElementById("selTheme").value = settings.theme;
  document.getElementById("txtSpeed").value = settings.speedMultiplier;
  document.getElementById("selProvider").value = settings.provider;
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function saveSettingsClick() {
  settings.theme = document.getElementById("selTheme").value;
  settings.speedMultiplier = parseFloat(document.getElementById("txtSpeed").value) || 1.0;
  settings.provider = document.getElementById("selProvider").value;
  saveSettings();
  applyTheme(settings.theme);
  closeSettings();
  log("Pengaturan disimpan.", "system");
}

function applyTheme(theme) {
  document.body.classList.toggle("theme-light", theme === "Light");
}

// ═══════════════════════════════════════════════════════
// PROGRESS (save/resume/reset)
// ═══════════════════════════════════════════════════════
function saveProgress() {
  if (!progress) return;
  try { localStorage.setItem("awb_progress", JSON.stringify(progress)); } catch {}
}

function deleteProgress() {
  try { localStorage.removeItem("awb_progress"); } catch {}
}

function loadProgress() {
  try {
    const raw = localStorage.getItem("awb_progress");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function checkProgressOnStartup() {
  progress = loadProgress();
  if (!progress || !progress.phase) { progress = null; return; }

  const midCount = progress.checkedMids?.length || 0;
  const areaCount = progress.checkedAreas?.length || 0;
  const resume = confirm(
    `Ditemukan progress scan sebelumnya:\n` +
    `  Phase: ${progress.phase}\n` +
    `  MID checked: ${midCount}\n` +
    `  AREA checked: ${areaCount}\n` +
    `  Found MID: ${progress.foundMid || "-"}\n\n` +
    `Resume scan? (OK=Resume, Cancel=Hapus & mulai baru)`
  );
  if (!resume) {
    deleteProgress();
    progress = null;
    log("Progress dihapus. Mulai dari awal.", "system");
  } else {
    log(`Resume: phase=${progress.phase} | MID=${midCount} | AREA=${areaCount} | foundMid=${progress.foundMid || "-"}`, "system");
  }
}

// ═══════════════════════════════════════════════════════
// UI RENDERING
// ═══════════════════════════════════════════════════════
function renderResults() {
  // Throttle: during active scan, only render every 150ms
  if (renderPending) return;
  renderPending = true;
  renderTimer = setTimeout(() => {
    renderPending = false;
    renderResultsNow();
  }, 150);
}

function renderResultsNow() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  renderPending = false;
  const container = document.getElementById("icResults");
  const noResults = document.getElementById("txtNoResults");
  container.innerHTML = "";

  if (results.length === 0) {
    noResults.classList.remove("hidden");
    return;
  }
  noResults.classList.add("hidden");

  const frag = document.createDocumentFragment();
  const hideAwb = settings.hideAwbColumn;
  for (const item of results) {
    const card = createResultCard(item, hideAwb);
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

function createResultCard(item, hideAwb) {
  const card = document.createElement("div");
  card.className = "result-card";

  const awbDisplay = hideAwb ? "****" : item.awb;

  let html = `
    <div class="result-card-header">
      <div class="result-card-awb-section">
        <div>
          <div class="result-card-awb-label">No. Resi (AWB)</div>
          <div class="result-card-awb">${escapeXml(awbDisplay)}</div>
        </div>
        <button class="btn-copy" title="Salin nomor resi" data-awb="${escapeXml(item.awb)}">📋</button>
      </div>
      <div class="result-card-status">${escapeXml(item.status)}</div>
    </div>
    <div class="result-card-info-label">INFORMASI PENGIRIMAN</div>
    <div class="result-card-grid">
      <div>
        <div class="field-label">TANGGAL</div>
        <div class="result-card-grid-value">${escapeXml(item.tanggal)}</div>
      </div>
      <div>
        <div class="field-label">JAM</div>
        <div class="result-card-grid-value">${escapeXml(item.jam)}</div>
      </div>
      <div>
        <div class="field-label">TUJUAN</div>
        <div class="result-card-grid-value">${escapeXml(item.destination)}</div>
      </div>
      <div>
        <div class="field-label">PENERIMA</div>
        <div class="result-card-grid-value">${escapeXml(item.receiver)}</div>
      </div>
    </div>
    <hr class="result-card-divider">
  `;

  if (item.history && item.history.length > 0) {
    const historyId = "hist-" + Math.random().toString(36).substring(7);
    html += `<span class="history-toggle" onclick="document.getElementById('${historyId}').classList.toggle('hidden')">🕐 RIWAYAT PENGIRIMAN (${item.history.length})</span>`;
    html += `<div class="history-list hidden" id="${historyId}">`;
    for (const h of item.history) {
      html += `
        <div class="history-item">
          <div class="history-dot"></div>
          <div class="history-content">
            <div class="history-date">${escapeXml(h.date)}</div>
            <div class="history-desc">${escapeXml(h.description)}</div>
            <div class="history-location">${escapeXml(h.location)}</div>
          </div>
        </div>
      `;
    }
    html += `</div>`;
  }

  card.innerHTML = html;

  // Wire copy button
  const copyBtn = card.querySelector(".btn-copy");
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(item.awb).then(() => {
        copyBtn.textContent = "✓";
        setTimeout(() => copyBtn.textContent = "📋", 1000);
      });
    };
  }

  return card;
}

function updateStats(duration) {
  document.getElementById("txtTotalResi").textContent = results.length;
  const success = results.filter(r => {
    const s = (r.status || "").toLowerCase();
    return !s.startsWith("gagal") && !s.startsWith("error") && !s.includes("failed");
  }).length;
  const fail = results.length - success;
  document.getElementById("txtBerhasil").textContent = success;
  document.getElementById("txtGagal").textContent = fail;
  const rate = results.length === 0 ? 0 : Math.round(success / results.length * 100);
  document.getElementById("txtSuccessRate").textContent = rate + "%";
  document.getElementById("txtDuration").textContent = formatDuration(duration);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function setButtonsDisabled(disabled) {
  document.getElementById("btnTrack").disabled = disabled;
  if (disabled) {
    document.getElementById("btnTrackSearch").classList.add("hidden");
    const btnPause = document.getElementById("btnPause");
    btnPause.classList.remove("hidden");
    btnPause.querySelector(".text").textContent = "Pause"; btnPause.querySelector(".icon").textContent = "⏸";
    btnPause.onclick = btnPauseClick;
    document.getElementById("btnScanRow").classList.remove("hidden");
    document.getElementById("btnNext").classList.add("hidden");
  } else {
    document.getElementById("btnTrackSearch").classList.remove("hidden");
    document.getElementById("btnPause").classList.add("hidden");
    document.getElementById("btnScanRow").classList.add("hidden");
  }
}

function showNextButton() {
  document.getElementById("btnPause").classList.add("hidden");
  document.getElementById("btnNext").classList.remove("hidden");
}
function hideNextButton() {
  document.getElementById("btnPause").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
}

function waitForNext() {
  return new Promise(resolve => {
    nextResolver = (proceed) => { nextResolver = null; resolve(proceed); };
  });
}

// ═══════════════════════════════════════════════════════
// LOG SYSTEM — text buffer, zero DOM alloc per entry
// ═══════════════════════════════════════════════════════
const LOG_MAX_CHARS = 32000;

function log(msg, type = "info", writeToLog = true) {
  const timestamp = new Date().toTimeString().substring(0, 8);
  logQueue.push(`[${timestamp}] ${msg}\n`);
  if (!logRafId) logRafId = requestAnimationFrame(flushLogQueue);
}

function flushLogQueue() {
  logRafId = null;
  if (logQueue.length === 0) return;
  const body = document.getElementById("logBody");
  if (!body) { logQueue = []; return; }

  const chunk = logQueue.join("");
  logQueue = [];

  body.textContent += chunk;

  // Cap by character count — trim from top
  if (body.textContent.length > LOG_MAX_CHARS) {
    body.textContent = body.textContent.slice(-LOG_MAX_CHARS);
  }

  body.scrollTop = body.scrollHeight;
}

// ═══════════════════════════════════════════════════════
// LICENSE (placeholder — web version has no HWID license)
// ═══════════════════════════════════════════════════════
function updateLicenseDisplay() {
  const el = document.getElementById("licenseBadge");
  // Don't overwrite if user is logged in (email shown by auth module)
  if (el && el.textContent && el.textContent.includes("@")) return;
  if (settings.provider === "binderbyte") {
    el.textContent = "📡 Binderbyte";
    el.style.color = "#06d6e8";
  } else {
    el.textContent = "📡 Biteship Public";
    el.style.color = "#10b981";
  }
}

// ═══════════════════════════════════════════════════════
// CONCURRENCY HELPERS
// ═══════════════════════════════════════════════════════
async function acquireSemaphore(sem) {
  while (sem.current >= sem.max)
    await new Promise(r => setTimeout(r, 10));
  sem.current++;
}

function releaseSemaphore(sem) {
  sem.current--;
}
