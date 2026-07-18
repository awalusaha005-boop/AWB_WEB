// apps-script/Code.gs — Google Apps Script
// Deploy sebagai Web App (execute as: me, access: anyone)

const SPREADSHEET_ID = "1ySpL75Ls3lKj2BSmmDTuaHcigWiSdAFay9Db5BC6GTg";
const SHEET_NAME = "Sheet1"; // Ganti sesuai nama tab sheet lo

// GET: ?kodeAkses=XXX&deviceId=YYY
function doGet(e) {
  try {
    const kodeAkses = e.parameter.kodeAkses;
    const deviceId = e.parameter.deviceId || "";
    if (!kodeAkses) {
      return json({ ok: false, message: "Kode akses wajib diisi" });
    }
    return checkAuth(kodeAkses, deviceId);
  } catch (err) {
    return json({ ok: false, message: "Server error: " + err.message });
  }
}

// POST: {"kodeAkses": "XXX", "deviceId": "YYY"}
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { kodeAkses, deviceId } = data;
    if (!kodeAkses) {
      return json({ ok: false, message: "Kode akses wajib diisi" });
    }
    return checkAuth(kodeAkses, deviceId || "");
  } catch (err) {
    return json({ ok: false, message: "Server error: " + err.message });
  }
}

function checkAuth(kodeAkses, deviceId) {
  // Lock untuk mencegah race condition saat dua login bersamaan
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    const rows = sheet.getDataRange().getValues();
    const now = new Date();

    for (let i = 1; i < rows.length; i++) {
      const [kode, username, mulai, expire, deviceIdSheet, status, tipe] = rows[i];

      if (String(kode).trim().toLowerCase() !== String(kodeAkses).trim().toLowerCase()) continue;

      if (String(status).trim().toUpperCase() !== "AKTIF") {
        return json({ ok: false, message: "Kode akses tidak aktif" });
      }

      const tipeStr = String(tipe || "").trim().toUpperCase();
      if (tipeStr === "REGULAR" || tipeStr === "TRIAL") {
        const expireDate = parseDate(expire);
        if (expireDate && now > expireDate) {
          return json({ ok: false, message: "Kode akses sudah expired" });
        }
      }

      // Device binding check
      const deviceIdSheetStr = String(deviceIdSheet || "").trim();
      
      if (!deviceIdSheetStr) {
        // Kolom deviceId kosong → simpan device ID baru
        sheet.getRange(i + 1, 5).setValue(deviceId); // Kolom E
        return json({ ok: true, username: String(username).trim(), tipe: tipeStr });
      }
      
      if (deviceIdSheetStr !== deviceId) {
        // Device ID berbeda → tolak
        return json({ ok: false, message: "Kode akses sudah terdaftar di perangkat lain" });
      }
      
      // Device ID sama → izinkan
      return json({ ok: true, username: String(username).trim(), tipe: tipeStr });
    }

    return json({ ok: false, message: "Kode akses tidak ditemukan" });
  } finally {
    lock.releaseLock();
  }
}

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s || s === "-") return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));

  return new Date(s);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
