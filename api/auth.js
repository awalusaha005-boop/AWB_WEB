// /api/auth.js — Vercel Serverless Function
// Proxy autentikasi ke Google Apps Script (via GET)
// GET ?kodeAkses=XXX&deviceId=YYY → forward ke Apps Script → return json

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxEdAtDpOnyoUbprHyipa1GSErGR50sPImt9Pkjr6c3xQ-Ene7LFCzkgOJqPwMbe-l_6w/exec";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Support both GET (query) and POST (body)
  let kodeAkses;
  let deviceId;
  if (req.method === "POST") {
    kodeAkses = (req.body || {}).kodeAkses;
    deviceId = (req.body || {}).deviceId || "";
  } else {
    kodeAkses = req.query?.kodeAkses;
    deviceId = req.query?.deviceId || "";
  }

  if (!kodeAkses) {
    return res.status(400).json({ ok: false, message: "Kode akses wajib diisi" });
  }

  try {
    const url = `${APPS_SCRIPT_URL}?kodeAkses=${encodeURIComponent(kodeAkses)}&deviceId=${encodeURIComponent(deviceId)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await resp.text();

    try {
      const json = JSON.parse(text);
      return res.status(200).json(json);
    } catch {
      return res.status(502).json({ ok: false, message: "Server auth error", raw: text.substring(0, 200) });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Gagal terhubung: " + err.message });
  }
}
