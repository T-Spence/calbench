// MK3S Calibration Bench — self-hosted server.
// No npm dependencies: Node 20's built-in http, fs, fetch, FormData and Blob.
//
// Routes
//   GET    /                     the bench page (public/index.html)
//   GET    /healthz              liveness for Docker / Uptime Kuma
//   GET    /api/slicer           PrusaSlicer / OpenSCAD versions available in the image
//   GET    /api/models           uploaded STL models;  POST /api/models?name=x.stl (raw body);  DELETE /api/models/:id
//   POST   /api/slice            {job: temptower|flowtops|tile|model, printer, material, values, …} -> G-code
//   POST   /api/profile-ini      {printer, material, values, name} -> PrusaSlicer filament profile
//   GET    /api/profiles         all filament profiles
//   PUT    /api/profiles/:id     create or replace one profile
//   DELETE /api/profiles/:id     delete one profile
//   GET    /api/export           all profiles as a downloadable JSON file
//   POST   /api/import           merge profiles from an exported JSON file
//   GET    /api/printers         configured printers (never includes API keys)
//   GET    /api/machines         per-printer values that aren't filament-specific (E-steps)
//   PUT    /api/machines/:id     save them
//   GET    /api/octoprint?printer=a        is that OctoPrint reachable, and what is the printer doing
//   POST   /api/octoprint/upload {printer, filename, gcode, print}

"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
// Printers come from numbered env vars: PRINTER_A_URL, PRINTER_A_KEY, PRINTER_A_NAME,
// PRINTER_A_MODEL, PRINTER_A_MMU, PRINTER_A_ENCLOSED (and _B_, _C_ …).
// A single OCTOPRINT_URL / OCTOPRINT_API_KEY pair still works as one printer.
function readPrinters(env) {
  const out = [];
  for (const k of Object.keys(env).sort()) {
    const m = k.match(/^PRINTER_([A-Z0-9]+)_URL$/); if (!m) continue;
    const p = "PRINTER_" + m[1] + "_";
    out.push({
      id: m[1].toLowerCase(),
      name: env[p + "NAME"] || "Printer " + m[1],
      model: env[p + "MODEL"] || "MK3S",
      mmu: env[p + "MMU"] === "true",
      enclosed: env[p + "ENCLOSED"] === "true",
      url: env[k].replace(/\/+$/, ""),
      key: env[p + "KEY"] || ""
    });
  }
  if (!out.length && env.OCTOPRINT_URL) out.push({id: "default", name: env.OCTOPRINT_NAME || "MK3S", model: env.OCTOPRINT_MODEL || "MK3S", mmu: false, enclosed: false, url: env.OCTOPRINT_URL.replace(/\/+$/, ""), key: env.OCTOPRINT_API_KEY || ""});
  return out;
}
const PRINTERS = readPrinters(process.env);
const publicPrinter = p => ({id: p.id, name: p.name, model: p.model, mmu: p.mmu, enclosed: p.enclosed, configured: !!(p.url && p.key)});
function printerFor(id) {
  const p = PRINTERS.find(x => x.id === String(id || "").toLowerCase()) || (PRINTERS.length === 1 && !id ? PRINTERS[0] : null);
  if (!p) throw Object.assign(new Error(`No printer "${id}" is configured on the server`), {status: 404});
  return p;
}
const FOLDER = (process.env.OCTOPRINT_FOLDER || "calibration").replace(/[^A-Za-z0-9._-]/g, "");
const ALLOW_PRINT = process.env.ALLOW_PRINT !== "false";
const MAX_BODY = 32 * 1024 * 1024; // a big temp tower is ~1 MB; leave headroom

const FILE = path.join(DATA_DIR, "profiles.json");
const PAGE = path.join(__dirname, "public", "index.html");
const MODELS = path.join(DATA_DIR, "models");
const slicer = require("./slicer");
const SEED = path.join(__dirname, "seed.json");

/* ---------- profile store: one JSON file, atomic writes, serialized ---------- */
async function load() {
  try {
    return JSON.parse(await fsp.readFile(FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    let seed = {profiles: {}};
    try { seed = JSON.parse(await fsp.readFile(SEED, "utf8")); } catch {}
    await save(seed);
    return seed;
  }
}
async function save(obj) {
  await fsp.mkdir(DATA_DIR, {recursive: true});
  const tmp = FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, FILE); // rename is atomic: a crash never leaves half a file
}
let queue = Promise.resolve();
function mutate(fn) { // one writer at a time so two devices can't interleave read-modify-write
  const run = queue.then(async () => { const d = await load(); d.profiles = d.profiles || {}; const r = fn(d); await save(d); return r; });
  queue = run.catch(() => {});
  return run;
}

/* ---------- helpers ---------- */
const validId = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
function send(res, code, body, type = "application/json", extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, {"Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", ...extra});
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("Body is not valid JSON"), {status: 400})); } });
    req.on("error", reject);
  });
}
function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("File too large"), {status: 413})); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Binary STL: 80-byte header, triangle count, 50 bytes per triangle. ASCII STL: "solid … facet".
function looksLikeStl(buf) {
  if (buf.length >= 84 && buf.length === 84 + buf.readUInt32LE(80) * 50) return true;
  const head = buf.slice(0, 1024).toString("latin1");
  return /^\s*solid/.test(head) && buf.includes("facet");
}
let slicerInfo = null;
function cleanProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw Object.assign(new Error("Profile must be an object"), {status: 400});
  if (typeof p.name !== "string" || !p.name.trim()) throw Object.assign(new Error("Profile needs a name"), {status: 400});
  const out = JSON.parse(JSON.stringify(p)); delete out.id; out.updatedAt = Date.now();
  return out;
}
async function octo(pr, pathname, opts = {}) {
  if (!pr.url || !pr.key) throw Object.assign(new Error(`${pr.name} has no URL or API key in .env`), {status: 503});
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 8000);
  try {
    return await fetch(pr.url + pathname, {...opts, headers: {"X-Api-Key": pr.key, ...(opts.headers || {})}, signal: ctl.signal});
  } catch (e) {
    throw Object.assign(new Error(`Can't reach ${pr.name}'s OctoPrint at ${pr.url} (${e.name === "AbortError" ? "timed out" : e.cause?.code || e.message})`), {status: 502});
  } finally { clearTimeout(t); }
}
async function printerState(pr) {
  const r = await octo(pr, "/api/printer?exclude=sd,temperature");
  if (r.status === 409) return {connected: false, text: "Printer not connected in OctoPrint", printing: false};
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("OctoPrint rejected the API key"), {status: 502});
  if (!r.ok) throw Object.assign(new Error(`OctoPrint answered ${r.status}`), {status: 502});
  const j = await r.json(); const fl = j.state?.flags || {};
  return {connected: true, text: j.state?.text || "Unknown", printing: !!(fl.printing || fl.paused || fl.pausing || fl.cancelling), ready: !!fl.ready};
}

/* ---------- routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, m = req.method;

  if (m === "GET" && (p === "/" || p === "/index.html")) {
    return send(res, 200, await fsp.readFile(PAGE), "text/html; charset=utf-8");
  }
  if (m === "GET" && p === "/healthz") return send(res, 200, {ok: true});

  if (p === "/api/profiles" && m === "GET") {
    const d = await load();
    return send(res, 200, Object.entries(d.profiles || {}).map(([id, v]) => ({...v, id})));
  }
  const pm = p.match(/^\/api\/profiles\/([^/]+)$/);
  if (pm) {
    const id = decodeURIComponent(pm[1]);
    if (!validId(id)) return send(res, 400, {error: "Profile id must be lowercase letters, digits and dashes"});
    if (m === "PUT") {
      const body = cleanProfile(await readBody(req));
      await mutate(d => { d.profiles[id] = body; });
      return send(res, 200, {...body, id});
    }
    if (m === "DELETE") {
      const existed = await mutate(d => { const had = id in d.profiles; delete d.profiles[id]; return had; });
      return send(res, existed ? 200 : 404, existed ? {ok: true} : {error: "No such profile"});
    }
  }
  if (p === "/api/export" && m === "GET") {
    const d = await load(); const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, JSON.stringify({exportedAt: new Date().toISOString(), ...d}, null, 2), "application/json",
      {"Content-Disposition": `attachment; filename="calbench-profiles-${stamp}.json"`});
  }
  if (p === "/api/import" && m === "POST") {
    const body = await readBody(req);
    const incoming = body.profiles && typeof body.profiles === "object" ? body.profiles : null;
    if (!incoming) return send(res, 400, {error: "That file has no profiles in it"});
    const ids = Object.keys(incoming).filter(validId);
    const clean = {}; for (const id of ids) clean[id] = cleanProfile(incoming[id]);
    await mutate(d => { Object.assign(d.profiles, clean); });
    return send(res, 200, {imported: ids.length});
  }

  if (p === "/api/printers" && m === "GET") return send(res, 200, PRINTERS.map(publicPrinter));

  if (p === "/api/slicer" && m === "GET") {
    if (!slicerInfo) slicerInfo = await slicer.versions();
    return send(res, 200, {...slicerInfo, printPreset: slicer.PRINT_PRESET,
      presets: PRINTERS.map(x => ({id: x.id, printer: slicer.printerPreset(x)}))});
  }

  if (p === "/api/models" && m === "GET") { const d = await load(); return send(res, 200, Object.entries(d.models || {}).map(([id, v]) => ({...v, id}))); }
  if (p === "/api/models" && m === "POST") {
    const buf = await readRaw(req);
    const is3mf = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50; // ZIP signature "PK\3\4"
    if (!is3mf && !looksLikeStl(buf)) return send(res, 400, {error: "That isn't an STL or 3MF file"});
    const name = String(url.searchParams.get("name") || "model.stl").replace(/[^\w .()+-]/g, "_").slice(0, 80);
    const id = name.toLowerCase().replace(/\.(stl|3mf)$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
    await fsp.mkdir(MODELS, {recursive: true});
    const meta = {name, size: buf.length, uploadedAt: Date.now(), kind: is3mf ? "3mf" : "stl"};
    if (is3mf) {
      const info = slicer.parse3mf(buf);
      await slicer.serial(() => slicer.threeMfToStl(buf, path.join(MODELS, id + ".stl")));
      meta.boundaries = info.boundaries; meta.presets = info.presets;
    } else await fsp.writeFile(path.join(MODELS, id + ".stl"), buf);
    await mutate(d => { d.models = d.models || {}; d.models[id] = meta; });
    return send(res, 200, {...meta, id});
  }
  const md = p.match(/^\/api\/models\/([a-z0-9-]+)$/);
  if (md && m === "DELETE") {
    await mutate(d => { if (d.models) delete d.models[md[1]]; });
    await fsp.rm(path.join(MODELS, md[1] + ".stl"), {force: true});
    return send(res, 200, {ok: true});
  }

  if (p === "/api/slice" && m === "POST") {
    const body = await readBody(req);
    const pr = printerFor(body.printer);
    const values = body.values || {};
    const modelPath = async () => {
      if (!/^[a-z0-9-]+$/.test(String(body.model || ""))) throw Object.assign(new Error("Pick an uploaded model first"), {status: 400});
      const f = path.join(MODELS, body.model + ".stl");
      try { await fsp.access(f); } catch { throw Object.assign(new Error("That model file is missing; upload it again"), {status: 404}); }
      return f;
    };
    const started = Date.now();
    const result = await slicer.serial(async () => {
      if (body.job === "temptower") { const d = await load(); return slicer.jobTempTower(pr, body, await modelPath(), (d.models || {})[body.model]); }
      if (body.job === "flowtops") return slicer.jobFlowTops(pr, body);
      if (body.job === "tile") return slicer.jobTile(pr, body);
      if (body.job === "swatches") return slicer.jobSwatches(pr, body);
      if (body.job === "fantower") return slicer.jobFanTower(pr, body);
      if (body.job === "bridges") return slicer.jobBridges(pr, body);
      if (body.job === "model") return slicer.jobModel(pr, body, await modelPath());
      throw Object.assign(new Error("Unknown job"), {status: 400});
    });
    return send(res, 200, {...result, stats: slicer.stats(result.gcode), seconds: Math.round((Date.now() - started) / 100) / 10});
  }

  if (p === "/api/print-ini" && m === "POST") {
    const body = await readBody(req);
    const pr = printerFor(body.printer);
    const name = String(body.name || "Finish").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    return send(res, 200, {filename: name + ".ini", ini: slicer.printIni(pr, body.kind, body.settings || {}, name)});
  }

  if (p === "/api/profile-ini" && m === "POST") {
    const body = await readBody(req);
    const pr = printerFor(body.printer);
    const name = String(body.name || "Calibrated filament").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    return send(res, 200, {filename: name + ".ini", ini: slicer.filamentIni(pr, body.material, body.values || {}, name)});
  }

  if (p === "/api/machines" && m === "GET") { const d = await load(); return send(res, 200, d.machines || {}); }
  const mm = p.match(/^\/api\/machines\/([^/]+)$/);
  if (mm && m === "PUT") {
    const id = decodeURIComponent(mm[1]);
    if (!validId(id)) return send(res, 400, {error: "Bad printer id"});
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, {error: "Body must be an object"});
    body.updatedAt = Date.now();
    await mutate(d => { d.machines = d.machines || {}; d.machines[id] = {...(d.machines[id] || {}), ...body}; });
    return send(res, 200, body);
  }

  if (p === "/api/octoprint" && m === "GET") {
    if (!PRINTERS.length) return send(res, 200, {configured: false, allowPrint: ALLOW_PRINT});
    let pr; try { pr = printerFor(url.searchParams.get("printer")); } catch (e) { return send(res, 200, {configured: false, allowPrint: ALLOW_PRINT, error: e.message}); }
    if (!pr.url || !pr.key) return send(res, 200, {configured: false, allowPrint: ALLOW_PRINT});
    try { return send(res, 200, {configured: true, allowPrint: ALLOW_PRINT, folder: FOLDER, ...(await printerState(pr))}); }
    catch (e) { return send(res, 200, {configured: true, allowPrint: ALLOW_PRINT, error: e.message}); }
  }
  if (p === "/api/octoprint/upload" && m === "POST") {
    const {printer, filename, gcode, print} = await readBody(req);
    const pr = printerFor(printer);
    if (typeof gcode !== "string" || !gcode.trim()) return send(res, 400, {error: "No G-code in the request"});
    const name = String(filename || "calibration.gcode").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.gcode$/i, "") + ".gcode";
    if (print) {
      if (!ALLOW_PRINT) return send(res, 403, {error: "Starting prints is turned off (ALLOW_PRINT=false). The file can still be uploaded."});
      const st = await printerState(pr);
      if (!st.connected) return send(res, 409, {error: "OctoPrint isn't connected to the printer"});
      if (st.printing) return send(res, 409, {error: `Printer is busy: ${st.text}`});
    }
    // Make sure the target folder exists (409 = already there, which is fine).
    if (FOLDER) {
      const fd0 = new FormData(); fd0.append("foldername", FOLDER); fd0.append("path", "");
      const r0 = await octo(pr, "/api/files/local", {method: "POST", body: fd0});
      if (!r0.ok && r0.status !== 409) return send(res, 502, {error: `Couldn't create folder "${FOLDER}" in OctoPrint (${r0.status})`});
    }
    const fd = new FormData();
    fd.append("file", new Blob([gcode], {type: "application/octet-stream"}), name);
    if (FOLDER) fd.append("path", FOLDER);
    if (print) { fd.append("select", "true"); fd.append("print", "true"); }
    const r = await octo(pr, "/api/files/local", {method: "POST", body: fd, timeout: 60000});
    if (!r.ok) { const t = await r.text().catch(() => ""); return send(res, 502, {error: `OctoPrint refused the upload (${r.status}) ${t.slice(0, 200)}`}); }
    return send(res, 200, {ok: true, printer: pr.name, path: (FOLDER ? FOLDER + "/" : "") + name, printing: !!print});
  }

  return send(res, 404, {error: "Not found"});
}

http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (e.status !== 400 && e.status !== 413) console.error(new Date().toISOString(), req.method, req.url, e.message);
    if (!res.headersSent) send(res, e.status || 500, {error: e.message || "Server error"});
  });
}).listen(PORT, () => {
  // Ask PrusaSlicer and OpenSCAD for their versions now, so the first page load doesn't wait.
  slicer.versions().then(v => { slicerInfo = v; console.log(`slicer: PrusaSlicer ${v.prusaslicer}, OpenSCAD ${v.openscad}, Prusa profiles ${v.bundle ? "found" : "MISSING"}`); });
  console.log(`calbench listening on :${PORT}, data in ${FILE}`);
  if (!PRINTERS.length) console.log("No printers configured: set PRINTER_A_URL / PRINTER_A_KEY in .env");
  for (const p of PRINTERS) console.log(`printer ${p.id}: ${p.name} (${p.model}${p.mmu ? " + MMU" : ""}${p.enclosed ? ", enclosed" : ""}) -> ${p.url || "NO URL"}${p.key ? "" : "  [NO API KEY]"}`);
  console.log(`uploads go to OctoPrint folder "${FOLDER}", starting prints ${ALLOW_PRINT ? "allowed" : "disabled"}`);
});
