// dev-server.js — Local development server
// Serves static files from /public and API functions from /api
// Usage: node dev-server.js

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// MIME types
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API routes ──
  if (pathname.startsWith("/api/")) {
    try {
      // Dynamic import the API module
      const apiPath = path.join(__dirname, pathname + ".js");
      if (fs.existsSync(apiPath)) {
        const mod = await import(`file://${apiPath}`);
        // Create a mock req/res that matches Vercel's signature
        const mockReq = { method: req.method, query: Object.fromEntries(url.searchParams) };
        const mockRes = {
          _headers: {},
          _status: 200,
          setHeader(k, v) { this._headers[k] = v; },
          status(code) { this._status = code; return this; },
          json(data) {
            Object.entries(this._headers).forEach(([k, v]) => res.setHeader(k, v));
            res.writeHead(this._status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          },
          end() {
            Object.entries(this._headers).forEach(([k, v]) => res.setHeader(k, v));
            res.writeHead(this._status);
            res.end();
          },
        };
        await mod.default(mockReq, mockRes);
        return;
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
      return;
    }
  }

  // ── Static files ──
  let filePath = path.join(__dirname, "public", pathname);
  if (pathname === "/") filePath = path.join(__dirname, "public", "index.html");

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found: " + pathname);
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  AWB Web Dev Server                          │`);
  console.log(`  │  http://localhost:${PORT}                       │`);
  console.log(`  │  Static: /public → /                          │`);
  console.log(`  │  API:    /api/track.js → /api/track           │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
});
