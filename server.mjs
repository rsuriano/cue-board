#!/usr/bin/env node
// Cue Board local server (optional, zero dependencies, Node 18+).
// Serves the app on http://localhost:5173 and relays /api/openrouter/* to OpenRouter,
// so the browser never talks to OpenRouter directly (no CORS issues) and,
// if OPENROUTER_API_KEY is set, the key never reaches the browser.
//
//   OPENROUTER_API_KEY=sk-or-... node server.mjs
//   PORT=8080 node server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const KEY = process.env.OPENROUTER_API_KEY || "";
const UPSTREAM = "https://openrouter.ai/api/v1";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".md": "text/markdown; charset=utf-8",
};

const readBody = (req) => new Promise((ok, ko) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => ok(Buffer.concat(chunks)));
  req.on("error", ko);
});

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ cueboard: true, hasKey: Boolean(KEY) }));
    }

    if (url.pathname.startsWith("/api/openrouter/")) {
      const target = UPSTREAM + url.pathname.slice("/api/openrouter".length) + url.search;
      const headers = {};
      const auth = KEY ? `Bearer ${KEY}` : req.headers.authorization;
      if (auth) headers.authorization = auth;
      if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
      headers["x-title"] = "Cue Board";
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const up = await fetch(target, { method: req.method, headers, body, redirect: "follow" });
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/octet-stream" });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }

    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    const missing = e && e.code === "ENOENT";
    res.writeHead(missing ? 404 : 502, { "content-type": "text/plain; charset=utf-8" });
    res.end(missing ? "Not found" : `Error: ${e.message}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Cue Board → http://localhost:${PORT}` + (KEY ? "  (OpenRouter key loaded from OPENROUTER_API_KEY)" : ""));
});
