// /api/track.js — Vercel Serverless Function
// CORS proxy + HMAC signer untuk Biteship & Binderbyte API
// Dipanggil sebagai: /api/track?awb=004612348765&courier=sicepat&provider=biteship

const BITESHIP_BASE = "https://api.biteship.com";
const BITESHIP_SECRET = "ICPHV3CQGPTk7pmiYWnrLAzxcX9n4kC236pjn6OL5UwNf0uC3p";
const BINDERBYTE_KEY = "e09ea1a51887785cd9f4914bded8e095aa965195b31e92df4594a805e8c34ded";

// ── CORS headers ──────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ── HMAC-SHA256 signature untuk Biteship ──────────────────
// Bisa pakai Web Crypto API (available di Vercel runtime)
async function generateBiteshipSignature(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}|${method}|${path}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(BITESHIP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return {
    signature: Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    timestamp,
  };
}

// ── Rotating mobile UA ────────────────────────────────────
const ANDROID_VERSIONS = ["14", "13", "12", "11", "10"];
const CHROME_MAJORS = ["126", "125", "124", "123", "122", "121"];
const DEVICES = [
  "Pixel 8", "Pixel 7", "SM-G998B", "SM-G996B",
  "Xiaomi 14", "Xiaomi 13", "Redmi Note 12",
  "ONEPLUS A6013", "M2007J3SG",
];

function buildMobileUa() {
  const android = ANDROID_VERSIONS[Math.floor(Math.random() * ANDROID_VERSIONS.length)];
  const chrome = CHROME_MAJORS[Math.floor(Math.random() * CHROME_MAJORS.length)];
  const device = DEVICES[Math.floor(Math.random() * DEVICES.length)];
  return `Mozilla/5.0 (Linux; Android ${android}; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;
}

// ── Biteship tracking ─────────────────────────────────────
async function trackBiteship(awb, courier) {
  const path = `/v1/public/trackings/${encodeURIComponent(awb)}/couriers/${encodeURIComponent(courier)}`;
  const url = BITESHIP_BASE + path;
  const { signature, timestamp } = await generateBiteshipSignature("GET", path);

  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": "Public",
    "Origin": "https://biteship.com",
    "Referer": "https://biteship.com/id/cek-resi",
    "x-biteship-public-request-signature": signature,
    "x-biteship-public-request-timestamp": timestamp,
    "User-Agent": buildMobileUa(),
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });

      // 404 = AWB tidak ada
      if (resp.status === 404) {
        return { status: 404, body: null };
      }

      // 429 = rate limited
      if (resp.status === 429) {
        const retryAfter = parseFloat(resp.headers.get("retry-after") || "10");
        await new Promise((r) => setTimeout(r, (retryAfter + Math.random()) * 1000));
        continue;
      }

      // 5xx = retry
      if (resp.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }

      const json = await resp.json();
      return { status: resp.status, body: json };
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
  return { status: 0, body: null };
}

// ── Binderbyte tracking ───────────────────────────────────
async function trackBinderbyte(awb, courier) {
  const url = `https://api.binderbyte.com/v1/track?api_key=${encodeURIComponent(BINDERBYTE_KEY)}&courier=${encodeURIComponent(courier)}&awb=${encodeURIComponent(awb)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

// ── Main handler ──────────────────────────────────────────
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  const { awb, courier = "sicepat", provider = "biteship" } = req.query;

  if (!awb) {
    return res.status(400).json({ error: "Missing 'awb' parameter" });
  }

  try {
    let result;
    if (provider === "binderbyte") {
      result = await trackBinderbyte(awb, courier);
    } else {
      result = await trackBiteship(awb, courier);
    }

    return res.status(result.status || 200).json(result.body);
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Tracking failed",
      success: false,
    });
  }
}
