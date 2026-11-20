"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const REPO = process.env.GITHUB_REPOSITORY || "Nasif-Spica-Rollins-Ug/Nasif-Spica-Rollins-Ug.github.io";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://nasif-spica-rollins-ug.github.io";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_BODY = 6 * 1024 * 1024;

const editableFiles = new Set([
  "index.html", "about.html", "projects.html", "interests.html",
  "journey.html", "contact.html", "styles.css", "script.js",
  "sitemap.xml", "robots.txt", "favicon.svg", "README.md"
]);
const knownImages = new Set([
  "Project_background.jpg",
  "Webpage_logo.png",
  "main_webpage_background.png",
  "spi_tech_logo.png"
]);
const sessions = new Map();
const loginAttempts = new Map();

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self' https://nasif-spica-rollins-ug.github.io; base-uri https:; form-action 'self'; frame-ancestors 'none'",
    ...headers
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const item of (req.headers.cookie || "").split(";")) {
    const i = item.indexOf("=");
    if (i > 0) out[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
  let bits = "";
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid authenticator secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function verifyTotp(secret, token) {
  if (!/^\d{6}$/.test(String(token || ""))) return false;
  const key = base32Decode(secret);
  const now = Math.floor(Date.now() / 30000);
  for (let drift = -1; drift <= 1; drift++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(now + drift));
    const digest = crypto.createHmac("sha1", key).update(counter).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    if (safeEqual(String(code).padStart(6, "0"), token)) return true;
  }
  return false;
}

function getSession(req) {
  const id = parseCookies(req).nsr_admin;
  const session = id && sessions.get(id);
  if (!session || session.expires < Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  session.expires = Date.now() + SESSION_TTL;
  return { id, ...session };
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    send(res, 401, { error: "Please sign in again." });
    return null;
  }
  const csrf = req.headers["x-csrf-token"];
  if (req.method !== "GET" && !safeEqual(csrf, session.csrf)) {
    send(res, 403, { error: "Security check failed. Refresh and try again." });
    return null;
  }
  return session;
}

function githubRequest(method, apiPath, payload) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("The publishing connection has not been configured yet.");
  return new Promise((resolve, reject) => {
    const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const req = https.request({
      hostname: "api.github.com",
      path: apiPath,
      method,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NSR-Private-Website-Control-Center",
        ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {})
      }
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => raw += chunk);
      response.on("end", () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = response.statusCode === 401 || response.statusCode === 403
            ? "GitHub rejected the publishing credential. Check its repository access."
            : response.statusCode === 409 || response.statusCode === 422
              ? "GitHub could not apply that change. Reload the file and try again."
              : "GitHub request failed (" + response.statusCode + ").";
          return reject(new Error(message));
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function contentsPath(file) {
  return "/repos/" + REPO + "/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(BRANCH);
}

function isImagePath(file) {
  return knownImages.has(file) || (/^uploads\/[a-z0-9][a-z0-9._-]{0,70}\.(png|jpe?g|webp)$/i.test(file));
}

function isEditablePath(file) {
  return editableFiles.has(file) || isImagePath(file);
}

function mimeFor(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/i.test(file)) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  return "text/plain; charset=utf-8";
}

function serveStatic(res, name) {
  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return send(res, 404, "Not found");
  const ext = path.extname(file);
  const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' https://nasif-spica-rollins-ug.github.io; base-uri https:; form-action 'self'; frame-ancestors 'none'"
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return send(res, 400, { error: "HTTPS is required." });
  }
  if (req.method === "GET" && pathname === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/admin/")) return serveStatic(res, "index.html");
  if (req.method === "GET" && pathname.startsWith("/assets/")) return serveStatic(res, pathname.slice("/assets/".length));

  if (req.method === "POST" && pathname === "/api/login") {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return send(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
    try {
      const input = JSON.parse(await readBody(req, 4096));
      const configured = process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 20 && process.env.ADMIN_TOTP_SECRET && process.env.GITHUB_TOKEN;
      const passOk = configured && safeEqual(input.password, process.env.ADMIN_PASSWORD);
      const otpOk = configured && verifyTotp(process.env.ADMIN_TOTP_SECRET, input.code);
      if (!configured) return send(res, 503, { error: "Setup is incomplete. Add the three required private environment variables in Render, then retry." });
      if (!passOk || !otpOk) {
        attempt.count += 1;
        if (attempt.count >= 6) { attempt.until = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
        loginAttempts.set(ip, attempt);
        return send(res, 401, { error: "Sign-in details were not accepted." });
      }
      loginAttempts.delete(ip);
      const id = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(24).toString("base64url");
      sessions.set(id, { csrf, expires: Date.now() + SESSION_TTL });
      return send(res, 200, { ok: true, csrf }, {
        "Set-Cookie": "nsr_admin=" + encodeURIComponent(id) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800"
      });
    } catch {
      return send(res, 400, { error: "Invalid sign-in request." });
    }
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const session = getSession(req);
    if (session) sessions.delete(session.id);
    return send(res, 200, { ok: true }, {
      "Set-Cookie": "nsr_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    });
  }

  if (pathname.startsWith("/api/")) {
    const session = requireSession(req, res);
    if (!session) return;

    if (req.method === "GET" && pathname === "/api/me") {
      return send(res, 200, { ok: true, csrf: session.csrf, branch: BRANCH });
    }

    if (req.method === "GET" && pathname === "/api/files") {
      return send(res, 200, {
        files: [...editableFiles].map(file => ({ path: file, kind: "code" }))
          .concat([...knownImages].map(file => ({ path: file, kind: "image" })))
      });
    }

    if (req.method === "GET" && pathname === "/api/file") {
      const file = url.searchParams.get("path") || "";
      if (!editableFiles.has(file)) return send(res, 400, { error: "That file is not editable here." });
      try {
        const result = await githubRequest("GET", contentsPath(file));
        const content = Buffer.from(result.content || "", "base64").toString("utf8");
        return send(res, 200, { path: file, content, sha: result.sha, kind: "code" });
      } catch (error) {
        return send(res, 502, { error: error.message });
      }
    }

    if (req.method === "PUT" && pathname === "/api/file") {
      try {
        const input = JSON.parse(await readBody(req));
        const file = String(input.path || "");
        if (!editableFiles.has(file)) return send(res, 400, { error: "That file is not editable here." });
        if (typeof input.content !== "string" || input.content.length > 1500000) return send(res, 413, { error: "File is too large or invalid." });
        if (!/^[a-f0-9]{40}$/i.test(String(input.sha || ""))) return send(res, 400, { error: "Missing file version. Reload before saving." });
        const message = String(input.message || "Update " + file).slice(0, 120);
        const result = await githubRequest("PUT", contentsPath(file), {
          message, branch: BRANCH, sha: input.sha,
          content: Buffer.from(input.content, "utf8").toString("base64")
        });
        return send(res, 200, { ok: true, commit: result.commit?.sha, sha: result.content?.sha });
      } catch (error) {
        return send(res, 502, { error: error.message });
      }
    }

    if (req.method === "POST" && pathname === "/api/upload") {
      try {
        const input = JSON.parse(await readBody(req, 8 * 1024 * 1024));
        const file = String(input.path || "");
        const mime = String(input.mime || "");
        const allowedMime = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
        if (!isImagePath(file) || !allowedMime[mime] || !file.toLowerCase().endsWith(allowedMime[mime]) && !(mime === "image/jpeg" && file.toLowerCase().endsWith(".jpeg"))) {
          return send(res, 400, { error: "Choose a PNG, JPG or WebP image and an approved image path." });
        }
        const encoded = String(input.base64 || "");
        if (!encoded || encoded.length > 5 * 1024 * 1024 * 1.4) return send(res, 413, { error: "Image must be smaller than 5 MB." });
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) return send(res, 413, { error: "Image must be smaller than 5 MB." });
        let sha;
        try {
          const current = await githubRequest("GET", contentsPath(file));
          sha = current.sha;
        } catch (error) {
          if (!/404/.test(error.message)) throw error;
        }
        const result = await githubRequest("PUT", contentsPath(file), {
          message: "Replace website image " + path.basename(file),
          branch: BRANCH, ...(sha ? { sha } : {}),
          content: bytes.toString("base64")
        });
        return send(res, 200, { ok: true, path: file, commit: result.commit?.sha });
      } catch (error) {
        return send(res, 502, { error: error.message });
      }
    }

    return send(res, 404, { error: "Unknown admin API route." });
  }

  return send(res, 404, "Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("NSR private website admin listening on " + PORT);
});