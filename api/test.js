export default function handler(request) {
  return new Response(JSON.stringify({ ok: true, time: Date.now(), node: process.version }), {
    headers: { "content-type": "application/json" },
  });
}