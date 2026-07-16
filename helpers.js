// ═══════════════════════════════════════════════════════
// helpers.js — Port helper logic dari MainWindow.xaml.cs
// Status translation, date matching, destination matching, etc.
// ═══════════════════════════════════════════════════════

// ── Status translation map (EN → ID) ──
const BITESHIP_STATUS_MAP = [
  // 3 STATUS FOCUS (paling spesifik, duluan)
  ["order has been confirmed. locating nearest driver", "Pesanan dikonfirmasi — mencari kurir pickup"],
  ["order has been confirmed", "Pesanan dikonfirmasi"],
  ["locating nearest driver", "Mencari kurir pickup"],
  ["item has been picked and ready to be shipped", "Barang sudah dijemput — siap dikirim"],
  ["item has been picked", "Barang sudah dijemput"],
  ["ready to be shipped", "Siap dikirim"],
  ["paket gagal di pick up", "Paket gagal dijemput"],
  ["failed pick up", "Gagal dijemput"],

  // Delivered / final states
  ["item has been delivered", "Barang sudah diterima"],
  ["package delivered", "Paket diterima"],
  ["shipment delivered", "Paket diterima"],
  ["delivered to", "Diterima oleh"],
  ["received by", "Diterima oleh"],
  ["delivered", "Diterima"],

  // In-transit / active
  ["out for delivery", "Sedang diantar kurir"],
  ["on delivery", "Sedang diantar kurir"],
  ["with delivery courier", "Sedang diantar kurir"],
  ["courier assigned", "Kurir sudah ditugaskan"],
  ["in transit", "Dalam perjalanan"],
  ["on the way", "Dalam perjalanan"],
  ["arrived at destination", "Tiba di kota tujuan"],
  ["arrived at hub", "Tiba di gudang transit"],
  ["arrived at warehouse", "Tiba di gudang"],
  ["arrived at", "Tiba di"],
  ["departed from", "Berangkat dari"],
  ["in warehouse", "Di gudang"],
  ["at warehouse", "Di gudang"],
  ["at sorting center", "Di pusat sortir"],

  // Pickup / origin
  ["picked up by courier", "Paket diambil kurir"],
  ["has been picked up", "Sudah dijemput"],
  ["picked up", "Diambil kurir"],
  ["waiting for pickup", "Menunggu penjemputan"],
  ["waiting pickup", "Menunggu penjemputan"],
  ["ready to pickup", "Siap dijemput"],
  ["pickup requested", "Permintaan penjemputan"],

  // Manifest / confirmation
  ["shipment manifested", "Resi termanifest"],
  ["manifested", "Termanifest"],
  ["shipment created", "Resi dibuat"],
  ["order confirmed", "Pesanan dikonfirmasi"],
  ["order accepted", "Pesanan diterima sistem"],
  ["order created", "Pesanan dibuat"],
  ["order allocated", "Pesanan dialokasikan"],
  ["allocated", "Dialokasikan"],

  // Problem / negative states
  ["return to sender", "Retur ke pengirim"],
  ["returned to sender", "Retur ke pengirim"],
  ["returned", "Diretur"],
  ["failed delivery", "Gagal antar"],
  ["delivery failed", "Gagal antar"],
  ["cancelled", "Dibatalkan"],
  ["canceled", "Dibatalkan"],
  ["on hold", "Ditahan"],
  ["held", "Ditahan"],
  ["lost", "Hilang"],
  ["damaged", "Rusak"],

  // Generic / short
  ["scheduled", "Terjadwal"],
  ["pending", "Menunggu"],
  ["processed", "Diproses"],
  ["processing", "Sedang diproses"],
  ["confirmed", "Dikonfirmasi"],
  ["found", "Ditemukan"],
  ["unknown", "Tidak diketahui"],
];

const ID_MARKERS = ["paket ", "diterima", "diantar", "kurir", "pengirim", "tujuan", "gudang", "manifest", "terima", "diambil", "dikonfirmasi", "dibatalkan", "dijemput", "menunggu"];

export function translateBiteshipStatus(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // Skip if already looks Indonesian
  for (const m of ID_MARKERS)
    if (lower.includes(m)) return trimmed;

  // Phrase match, first match wins
  for (const [en, id] of BITESHIP_STATUS_MAP)
    if (lower.includes(en)) return id;

  return trimmed;
}

// ── Parse Biteship date ──
export function parseBiteshipDate(raw) {
  if (!raw || raw.trim() === "") return "";
  const fixed = raw.replace(/\./g, ":");
  const dto = new Date(fixed);
  if (!isNaN(dto)) {
    const y = dto.getFullYear();
    const m = String(dto.getMonth() + 1).padStart(2, "0");
    const d = String(dto.getDate()).padStart(2, "0");
    const h = String(dto.getHours()).padStart(2, "0");
    const min = String(dto.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:${min}`;
  }
  return "";
}

// ── Get history from Biteship response ──
export function getHistory(result) {
  return result?.history || result?.data?.tracking_history || [];
}

// ── Get latest history entry (sort by date DESC) ──
export function getLatestHistoryEntry(result) {
  const history = getHistory(result);
  if (!history || history.length === 0) return null;

  const parsed = [];
  for (const h of history) {
    const raw = h.updated_at || h.datetime || h.date || "";
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) parsed.push({ dto, entry: h });
  }
  if (parsed.length === 0) return history[history.length - 1];
  parsed.sort((a, b) => b.dto - a.dto);
  return parsed[0].entry;
}

// ── Get note or desc from history entry ──
export function getNoteOrDesc(entry) {
  return entry?.note ?? entry?.desc ?? entry?.description ?? "";
}

// ── Get date from history entry ──
export function getDateOrUpdated(entry) {
  return entry?.updated_at ?? entry?.date ?? entry?.datetime ?? "";
}

// ── Extract shipment date from result ──
export function extractShipmentDate(result) {
  for (const h of getHistory(result)) {
    const parsed = parseBiteshipDate(getDateOrUpdated(h));
    if (parsed) return parsed;
  }
  return "";
}

// ── Check if result is valid ──
export function isValidBiteshipResult(result) {
  if (!result || result.success !== true) return false;
  const histLen = (result.history?.length || 0) + (result.data?.tracking_history?.length || 0);
  return histLen > 0;
}

// ── Check if status is "baru cetak" (new print) ──
export function isNewPrintStatus(result) {
  const history = getHistory(result);
  if (!history || history.length === 0) return true;

  const entriesWithDto = [];
  for (const h of history) {
    const raw = getDateOrUpdated(h);
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) entriesWithDto.push({ dto, entry: h });
  }
  if (entriesWithDto.length === 0) return true;

  entriesWithDto.sort((a, b) => b.dto - a.dto);
  const lastEntry = entriesWithDto[0].entry;
  const note = (getNoteOrDesc(lastEntry) || "").toLowerCase();
  if (!note) return true;

  // Whitelist
  if (note.includes("order has been confirmed. locating nearest driver")) return true;
  if (note.includes("order has been confirmed")) return true;
  if (note.includes("locating nearest driver")) return true;

  // Blacklist
  const blocked = [
    "item has been picked", "ready to be shipped", "delivered",
    "in transit", "received by", "return to sender",
    "failed pick up", "on_hold", "dropping_off", "picked",
  ];
  for (const kw of blocked)
    if (note.includes(kw)) return false;

  // Status enum fallback
  const statusEnum = (lastEntry.status || "").toLowerCase().trim();
  if (statusEnum) {
    if (statusEnum === "confirmed") return true;
    return false;
  }

  return false;
}

// ── Date matching ──
export function dateMatches(result, targetDate, timeRange) {
  const histories = getHistory(result);
  if (!histories || histories.length === 0)
    return dateMatchesSingle(extractShipmentDate(result), targetDate, timeRange);

  const entriesWithDto = [];
  for (const h of histories) {
    const raw = getDateOrUpdated(h);
    const ts = parseBiteshipDate(raw);
    if (ts) {
      const dto = new Date(raw.replace(/\./g, ":"));
      if (!isNaN(dto)) entriesWithDto.push({ dto, ts });
    }
  }
  if (entriesWithDto.length === 0)
    return dateMatchesSingle(extractShipmentDate(result), targetDate, timeRange);

  entriesWithDto.sort((a, b) => b.dto - a.dto);
  return dateMatchesSingle(entriesWithDto[0].ts, targetDate, timeRange);
}

function dateMatchesSingle(ts, targetDate, timeRange) {
  if (!ts || ts.length < 10) return false;
  if (ts.substring(0, 10) !== targetDate) return false;
  if (!timeRange) return true;
  if (ts.length < 16) return false;
  const minutes = parseInt(ts.substring(11, 13)) * 60 + parseInt(ts.substring(14, 16));
  if (isNaN(minutes)) return false;
  return timeRange.start <= minutes && minutes <= timeRange.end;
}

// ── Extract matching date ──
export function extractMatchingDate(result, targetDate, timeRange) {
  const histories = getHistory(result);
  const sorted = [...histories].sort((a, b) => {
    const tsA = parseBiteshipDate(getDateOrUpdated(a));
    const tsB = parseBiteshipDate(getDateOrUpdated(b));
    return tsB.localeCompare(tsA);
  });
  for (const h of sorted) {
    const ts = parseBiteshipDate(getDateOrUpdated(h));
    if (dateMatchesSingle(ts, targetDate, timeRange)) return ts;
  }
  const latest = getLatestHistoryEntry(result);
  if (latest) return parseBiteshipDate(getDateOrUpdated(latest));
  return "";
}

// ── Time range parsing ──
export function parseTimeRange(input) {
  if (!input || input.trim() === "") return null;
  const parts = input.split("-").map(s => s.trim());
  if (!tryParseMinutes(parts[0])) return null;
  const start = tryParseMinutes(parts[0]);
  const endText = parts.length > 1 ? parts[1] : parts[0];
  if (!tryParseMinutes(endText)) return null;
  const end = tryParseMinutes(endText);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function tryParseMinutes(input) {
  const m = (input || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// ── Build destination string ──
export function buildDestination(result) {
  const loc = result?.destination || result?.data?.destination;
  if (!loc) return "";
  const district = loc.district || loc.district_name || "";
  const city = loc.city || loc.city_name || "";
  if (district && city) return toTitle(district) + ", " + cleanCity(city);
  if (district) return toTitle(district);
  const address = loc.address || "";
  if (address) {
    const stripped = stripContact(address, loc.contact_name || "");
    const parts = stripped.split(",").map(s => s.trim());
    if (parts.length === 2) return toTitle(parts[0]) + ", " + cleanCity(parts[1]);
    return cleanCity(address);
  }
  return cleanCity(city);
}

function stripContact(address, contact) {
  if (contact && address.toLowerCase().startsWith(contact.toLowerCase()))
    return address.substring(contact.length).trim();
  return address.trim();
}

export function cleanCity(value) {
  let c = (value || "").trim();
  for (const prefix of ["KOTA ADMINISTRASI ", "KOTA ", "KAB. ", "KAB ", "KABUPATEN "]) {
    if (c.toUpperCase().startsWith(prefix)) { c = c.substring(prefix.length); break; }
  }
  return toTitle(c);
}

function toTitle(value) {
  return value.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Build origin string ──
export function buildOrigin(result) {
  const loc = result?.origin || result?.data?.origin;
  if (!loc) return "-";
  const city = loc.city || loc.city_name || loc.district || loc.district_name || loc.address || "";
  return city ? city.toUpperCase() : "-";
}

// ── Destination matching (fuzzy) ──
export function matchDestination(entryDestRaw, targetAreaRaw) {
  if (!entryDestRaw || !targetAreaRaw) return false;
  const destTokens = tokenList(entryDestRaw);
  const targetTokens = tokenList(targetAreaRaw);
  if (targetTokens.length === 0) return false;

  const directions = ["selatan", "utara", "timur", "barat", "pusat"];
  const targetDirections = targetTokens.filter(t => directions.includes(t));
  for (const dir of targetDirections)
    if (!destTokens.includes(dir)) return false;
  for (const dir of directions)
    if (destTokens.includes(dir) && !targetDirections.includes(dir)) return false;

  let matches = 0;
  for (const token of targetTokens) {
    if (destTokens.includes(token)) { matches++; continue; }
    const best = destTokens.length === 0 ? 0 : Math.max(...destTokens.map(d => similarity(token, d)));
    if (best >= 0.8) matches++;
  }
  return matches >= targetTokens.length;
}

function tokenList(value) {
  return normalizeAreaForMatch(value).split(" ").filter(s => s.length > 0);
}

function normalizeAreaForMatch(value) {
  const normalized = (value || "").toLowerCase().replace(/[^0-9a-zA-Z\s]+/g, " ");
  const stopWords = ["kota", "kab", "kabupaten", "administrasi"];
  const tokens = normalized.replace(/\s+/g, " ").trim().split(" ").filter(t => !stopWords.includes(t));
  return tokens.join(" ");
}

function similarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const dist = levenshtein(a, b);
  return 1.0 - (dist / Math.max(a.length, b.length));
}

function levenshtein(a, b) {
  const dp = Array(a.length + 1).fill(0).map(() => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ── Extract city key from destination string ──
export function extractCityKey(targetArea) {
  if (!targetArea) return "";
  const parts = targetArea.split(",").map(s => s.trim()).filter(s => s.length > 0);
  let city = parts.length >= 2 ? parts[parts.length - 1] : targetArea;
  for (const prefix of ["KOTA ADMINISTRASI ", "KOTA ", "KAB. ", "KAB ", "KABUPATEN "]) {
    if (city.toUpperCase().startsWith(prefix)) { city = city.substring(prefix.length); break; }
  }
  return normalizeKey(cleanCity(city));
}

export function normalizeKey(value) {
  const normalized = (value || "").toLowerCase().replace(/[^0-9a-zA-Z\s]+/g, " ");
  return normalized.replace(/\s+/g, " ").trim();
}

// ── Diagnostic helper ──
export function getBiteshipDiag(result) {
  const histories = getHistory(result);
  if (!histories || histories.length === 0) return "tanpa-histori";
  const dtos = [];
  for (const h of histories) {
    const raw = getDateOrUpdated(h);
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) dtos.push(dto);
  }
  let earliest = "", latest = "";
  if (dtos.length > 0) {
    const min = new Date(Math.min(...dtos));
    const max = new Date(Math.max(...dtos));
    earliest = formatDateTime(min);
    latest = formatDateTime(max);
  } else {
    const firstRaw = getDateOrUpdated(histories[0]);
    const parsed = parseBiteshipDate(firstRaw);
    earliest = latest = parsed;
  }
  const lastEntry = getLatestHistoryEntry(result);
  const lastNote = getNoteOrDesc(lastEntry) || "";
  return `awal=${earliest} akhir=${latest} catatan=${lastNote}`;
}

function formatDateTime(dto) {
  const y = dto.getFullYear();
  const m = String(dto.getMonth() + 1).padStart(2, "0");
  const d = String(dto.getDate()).padStart(2, "0");
  const h = String(dto.getHours()).padStart(2, "0");
  const min = String(dto.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

// ── Create result row from Biteship response ──
export function createBiteshipRow(awb, result, targetDate, timeRange) {
  const history = getHistory(result);
  const latestEntry = getLatestHistoryEntry(result);
  const displayDate = latestEntry ? parseBiteshipDate(getDateOrUpdated(latestEntry)) : "";
  const destination = buildDestination(result);
  const status = translateBiteshipStatus(
    getNoteOrDesc(latestEntry) || result.status || result.data?.status || "Ditemukan"
  );

  return {
    awb: result.waybill_id || awb,
    status,
    receiver: result.destination?.contact_name || result.data?.receiver_name || "-",
    destination: destination || "-",
    lastUpdate: displayDate + " - " + status,
    jam: displayDate.length >= 16 ? displayDate.substring(11, 16) : "-",
    tanggal: displayDate.length >= 10 ? displayDate.substring(0, 10) : "-",
    courier: result.courier?.company || result.data?.courier?.company || "sicepat",
    history: history.map(h => ({
      date: parseBiteshipDate(getDateOrUpdated(h)),
      description: translateBiteshipStatus(getNoteOrDesc(h)),
      location: h.city_name || ""
    }))
  };
}

// ── Create result row from Binderbyte response ──
export function createBinderbyteRow(awb, result) {
  const summary = result?.data?.summary;
  const detail = result?.data?.detail;
  const allHistory = result?.data?.history || [];

  // Translate all history descriptions
  for (const h of allHistory) h.desc = translateBiteshipStatus(h.desc);

  // Get latest entry
  const validHistory = allHistory.filter(h => h.date);
  validHistory.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latest = validHistory[0];

  let jam = "-", tanggal = "-";
  if (latest?.date) {
    const dt = new Date(latest.date);
    if (!isNaN(dt)) {
      jam = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      tanggal = formatTanggalIndo(dt);
    }
  } else if (summary?.date) {
    const dt = new Date(summary.date);
    if (!isNaN(dt)) {
      jam = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      tanggal = formatTanggalIndo(dt);
    }
  }

  return {
    awb: summary?.awb || awb,
    status: translateBiteshipStatus(latest?.desc || summary?.status || "Tidak diketahui"),
    receiver: detail?.receiver || "-",
    destination: detail?.destination || "-",
    lastUpdate: latest ? (latest.date + " — " + latest.desc) : (summary?.date || "-"),
    jam,
    tanggal,
    courier: summary?.courier || "sicepat",
    history: allHistory.map(h => ({
      date: h.date || "",
      description: translateBiteshipStatus(h.desc || ""),
      location: h.location || ""
    }))
  };
}

function formatTanggalIndo(dt) {
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                 "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return `${hari[dt.getDay()]}, ${dt.getDate()} ${bulan[dt.getMonth()]} ${dt.getFullYear()}`;
}

// ── Escape XML for Excel export ──
export function escapeXml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
