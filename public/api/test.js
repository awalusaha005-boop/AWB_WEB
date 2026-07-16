// /api/test.js — minimal test to verify Vercel serverless works
export default async function handler(req, res) {
  return res.status(200).json({ ok: true, time: Date.now(), node: process.version });
}