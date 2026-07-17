// /api/redis.js — Vercel Serverless Function
// Proxy ke Upstash Redis REST API
// Dipanggil sebagai: POST /api/redis dengan body JSON array Redis commands

const UPSTASH_URL = "https://normal-louse-172843.upstash.io";
const UPSTASH_TOKEN = "gQAAAAAAAqMrAAIgcDE1OWU5Mjc3YmJlZmI0MGZkOTY2YWMxZDUzNGYzZDYyNw";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ── Execute Redis command via Upstash REST ──
async function redisExec(command) {
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  return await resp.json();
}

// ── Main handler ──
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const command = req.body;
    if (!Array.isArray(command) || command.length === 0) {
      return res.status(400).json({ error: "Body must be a Redis command array, e.g. [\"GET\", \"key\"]" });
    }

    const result = await redisExec(command);
    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}