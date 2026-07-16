// /api/auth.js — Vercel Serverless Function
// Proxy autentikasi ke Google Apps Script (via GET)
// GET ?kodeAkses=XXX → forward ke Apps Script → return json

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwU88nOoHlpJji2mfU5Nwf1lF-15B9BU1Zrw_867w8e-DEzUDHKhNamnZJvjnS9nxJTFg/exec";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Support both GET (query) and POST (body)
  let kodeAkses;
  if (req.method === "POST") {
    kodeAkses = (req.body || {}).kodeAkses;
  } else {
    kodeAkses = req.query?.kodeAkses;
  }

  if (!kodeAkses) {
    return res.status(400).json({ ok: false, message: "Kode akses wajib diisi" });
  }

  try {
    const url = `${APPS_SCRIPT_URL}?kodeAkses=${encodeURIComponent(kodeAkses)}`;
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