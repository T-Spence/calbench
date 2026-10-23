// Slicing support: builds full PrusaSlicer configs from Prusa's own vendor profiles plus
// the values calbench has tested, runs OpenSCAD and PrusaSlicer headless, and
// post-processes the G-code (temperature bands, per-object flow).
"use strict";
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const {execFile} = require("child_process");

const BUNDLE = process.env.PRUSA_BUNDLE || "/usr/share/PrusaSlicer/profiles/PrusaResearch.ini";
const SLICER = process.env.PRUSASLICER_BIN || "prusa-slicer";
const OPENSCAD = process.env.OPENSCAD_BIN || "openscad";
const MODELS_DIR = path.join(__dirname, "models");
const PRINT_PRESET = process.env.PRINT_PRESET || "0.20mm QUALITY @MK3";

// Printer model (from .env) -> Prusa's printer preset. PRINTER_X_PRESET in .env overrides.
const PRINTER_PRESETS = {
  MK3S: "Original Prusa i3 MK3S & MK3S+",
  MK3SMMU3: "Original Prusa i3 MK3S & MK3S+ MMU3 Single",
  MK3SMMU2S: "Original Prusa i3 MK3S & MK3S+ MMU2S Single"
};
// Calbench material -> Prusa filament preset. ASA has no "Generic" preset in Prusa's bundle.
const FILAMENT_PRESETS = {PLA: "Generic PLA", PETG: "Generic PETG", ASA: "Prusament ASA", TPU: "Generic FLEX"};

/* ---------- vendor bundle: parse once, flatten presets like PrusaSlicer does ---------- */
let bundle = null;
function loadBundle() {
  if (bundle) return bundle;
  const secs = {}; let cur = null;
  for (const line of fs.readFileSync(BUNDLE, "utf8").split(/\r?\n/)) {
    const h = line.match(/^\[([a-z_]+):(.+)\]\s*$/);
    if (h) { cur = secs[h[1] + ":" + h[2]] = {}; continue; }
    if (/^\[/.test(line)) { cur = null; continue; }
    if (!cur || /^\s*(#|;|$)/.test(line)) continue;
    const i = line.indexOf("="); if (i < 0) continue;
    cur[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return (bundle = secs);
}
// Parents apply left to right, then the preset's own keys. Abstract parents start with "*".
function flatten(type, name, depth = 0) {
  const s = loadBundle()[type + ":" + name];
  if (!s) throw Object.assign(new Error(`Prusa's profiles have no ${type} preset "${name}"`), {status: 500});
  if (depth > 20) throw new Error("Preset inheritance too deep: " + name);
  const out = {};
  if (s.inherits) for (const p of s.inherits.split(";").map(x => x.trim().replace(/^"|"$/g, "")).filter(Boolean)) Object.assign(out, flatten(type, p, depth + 1));
  for (const [k, v] of Object.entries(s)) if (k !== "inherits") out[k] = v;
  return out;
}
const hasPreset = (type, name) => !!loadBundle()[type + ":" + name];
const META = new Set(["inherits", "renamed_from", "alias", "compatible_printers", "compatible_printers_condition",
  "compatible_prints", "compatible_prints_condition", "default_print_profile", "default_filament_profile",
  "default_sla_print_profile", "default_sla_material_profile", "printer_variant"]);

function printerPreset(pr) { return pr.preset || PRINTER_PRESETS[pr.model] || PRINTER_PRESETS.MK3S; }
function filamentPreset(material, mmu) {
  const base = FILAMENT_PRESETS[material] || FILAMENT_PRESETS.PETG;
  return mmu && hasPreset("filament", base + " @MMU") ? base + " @MMU" : base;
}

const num = v => { const n = parseFloat(String(v).split(",")[0]); return isFinite(n) ? n : null; };
const r1 = n => Math.round(n * 10) / 10;

// Filament overrides from calbench's tested values. The first layer keeps Prusa's absolute
// first-layer temperature for the material: it's set for adhesion (PETG deliberately runs it
// cooler, 230 vs 240, so it doesn't fuse to smooth PEI), not by the temperature tower.
function filamentOverrides(base, v) {
  const o = {};
  if (v.temp != null) o.temperature = Math.round(v.temp);
  // The bed temperature is the user's own choice for their sheet (e.g. a cold-bed sheet at
  // 58 °C), so it's used as-is for every layer rather than shifted by Prusa's PEI offset.
  if (v.bed != null) {
    o.bed_temperature = Math.round(v.bed);
    o.first_layer_bed_temperature = Math.round(v.bed);
  }
  if (v.em != null) o.extrusion_multiplier = r1(v.em * 1000) / 1000;
  if (v.retract != null) o.filament_retract_length = v.retract;
  if (v.rspeed != null) o.filament_retract_speed = v.rspeed;
  if (v.mvs != null) o.filament_max_volumetric_speed = v.mvs;
  if (v.fan != null) { o.min_fan_speed = Math.round(v.fan); o.max_fan_speed = Math.max(Math.round(v.fan), num(base.max_fan_speed) || 0); }
  // Overhang fan (PrusaSlicer: Filament Settings -> Cooling -> Dynamic fan speeds). The four
  // values are fan % for lines with 0 / 25 / 50 / 75 % overlap with the layer below: the
  // steepest overhangs get the full value, shading back to the normal max fan.
  if (v.ofan > 0) {
    const top = Math.min(100, Math.round(v.ofan)), norm = num(o.max_fan_speed ?? base.max_fan_speed) || 50;
    Object.assign(o, {enable_dynamic_fan_speeds: 1, overhang_fan_speed_0: top, overhang_fan_speed_1: top,
      overhang_fan_speed_2: Math.round((top + norm) / 2), overhang_fan_speed_3: Math.min(top, norm)});
  } else if (v.ofan === 0) o.enable_dynamic_fan_speeds = 0;
  if (v.bfan > 0) o.bridge_fan_speed = Math.min(100, Math.round(v.bfan));
  if (v.k != null) {
    // Prusa's start code carries two M900 lines (LA 1.5 and LA 1.0 firmware), each wrapped in
    // its own {if}…{endif} logic. Drop every whole line containing M900 when its {if}/{endif}
    // balance (so no template block is left open), then put the tested value first.
    const val = base.start_filament_gcode || '""';
    const quoted = /^".*"$/.test(val), body = quoted ? val.slice(1, -1) : val;
    const opens = t => (t.match(/\{if\b/g) || []).length, closes = t => (t.match(/\{endif\}/g) || []).length;
    const kept = body.split("\\n").filter(line => !(/M900\b/.test(line) && opens(line) === closes(line)));
    const rest = kept.join("\\n").replace(/M900 K[\d.]+/g, ";");  // any unbalanced leftovers: neutralise just the command
    o.start_filament_gcode = `"M900 K${v.k} ; calbench tested value\\n${rest}"`;
  }
  return o;
}

// Full config for one slice: printer + print + filament presets, tested values on top.
function buildConfig(pr, material, values, extra = {}) {
  const fname = filamentPreset(material, pr.mmu);
  const fil = flatten("filament", fname);
  const cfg = {...flatten("printer", printerPreset(pr)), ...flatten("print", PRINT_PRESET), ...fil, ...filamentOverrides(fil, values), ...printOverrides(values), ...extra};
  for (const k of META) delete cfg[k];
  return {cfg, filamentPreset: fname, filamentKeys: Object.keys(fil).filter(k => !META.has(k))};
}
// Print-setting results calbench tests (step 8 pass 2): bridge speed and flow.
function printOverrides(v) {
  const o = {}, b = v.bridge;
  if (b && b.speed > 0) o.bridge_speed = b.speed;
  if (b && b.flow > 0) o.bridge_flow_ratio = b.flow;
  return o;
}
const toIni = cfg => Object.entries(cfg).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n";

// A user filament preset PrusaSlicer can load: full filament keys, inherits Prusa's preset,
// and is only offered for this printer model.
function filamentIni(pr, material, values, presetName) {
  const {cfg, filamentPreset: base, filamentKeys} = buildConfig(pr, material, values);
  const lines = [
    `# PrusaSlicer filament profile generated by MK3S Calibration Bench`,
    `# ${presetName}`, `# Printer: ${pr.name} (${pr.model}). Based on Prusa's "${base}".`,
    `# Save as %APPDATA%\\PrusaSlicer\\filament\\${presetName}.ini, then restart PrusaSlicer.`,
    `inherits = ${base}`,
    `compatible_printers_condition = printer_model=="${pr.model}"`
  ];
  const keys = new Set([...filamentKeys, ...Object.keys(filamentOverrides(flatten("filament", base), values))]);
  for (const k of keys) if (k in cfg) lines.push(`${k} = ${cfg[k]}`);
  return lines.join("\n") + "\n";
}

/* ---------- running the tools ---------- */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {timeout: opts.timeout || 10 * 60000, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd, env: {...process.env, DISPLAY: ""}}, (err, stdout, stderr) => {
      const out = String(stdout) + String(stderr);
      if (err) {
        // Prefer lines that name a problem; otherwise the tool's last words, then how it exited.
        const lines = out.split("\n").map(l => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)*/, "").trim()).filter(l => l && !/^\d+ => /.test(l));
        const flagged = lines.filter(l => /error|fail|cannot|invalid|exception|empty|outside|collid/i.test(l));
        const why = (flagged.length ? flagged : lines).slice(-4).join(" | ");
        const how = err.killed ? "timed out" : err.signal ? `killed by ${err.signal}` : `exit code ${err.code}`;
        console.error(`${new Date().toISOString()} ${path.basename(bin)} ${args.join(" ")}\n${out.slice(-4000)}`);
        return reject(Object.assign(new Error(`${path.basename(bin)} failed (${how}): ${why.slice(0, 500) || "no output"}`), {status: 422}));
      }
      resolve(out);
    });
  });
}
let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; } // one heavy job at a time

// Text that ends up inside OpenSCAD -D 'name="…"': keep it to printable, quote-free characters.
const scadText = s => String(s || "").toUpperCase().replace(/[^A-Z0-9 +\-_.#/&()°]/g, "").replace(/\s+/g, " ").trim().slice(0, 28);
async function openscad(file, defines, outStl) {
  const args = ["-o", outStl];
  for (const [k, v] of Object.entries(defines)) args.push("-D", `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`);
  args.push(path.join(MODELS_DIR, file));
  await run(OPENSCAD, args, {timeout: 5 * 60000});
  return outStl;
}
async function slice(stls, cfg, {merge = false, keepPositions = false} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-"));
  try {
    const ini = path.join(dir, "config.ini"), out = path.join(dir, "out.gcode");
    await fsp.writeFile(ini, toIni(cfg));
    const log = await run(SLICER, ["--load", ini, ...(merge ? ["--merge"] : []), ...(keepPositions ? ["--dont-arrange"] : []), "--export-gcode", "--output", out, ...stls]);
    const gcode = await fsp.readFile(out, "utf8");
    // PrusaSlicer prints "Detected print stability issues:", a blank line, the object name,
    // then the actual issues. Fold that into one readable warning.
    const ls = log.split("\n").map(l => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)*/, "").trim());
    const warnings = [];
    ls.forEach((l, i) => {
      if (!/warning/i.test(l)) return;
      if (/stability issues/i.test(l)) {
        const detail = ls.slice(i + 1, i + 6).find(x => x && !/\.(stl|3mf|obj)$/i.test(x) && !/=>/.test(x));
        warnings.push("PrusaSlicer stability check: " + (detail || "see the preview"));
      } else warnings.push(l.replace(/^print warning:\s*/i, ""));
    });
    warnings.splice(5);
    return {gcode, warnings};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}
function stats(gcode) {
  const tail = gcode.slice(-60000), head = gcode.slice(0, 4000) + tail;
  const t = head.match(/; estimated printing time \(normal mode\) = (.+)/);
  const g = head.match(/; filament used \[g\] = ([\d.]+)/);
  let maxZ = 0; for (const m of gcode.matchAll(/^;Z:([\d.]+)/gm)) maxZ = Math.max(maxZ, +m[1]);
  return {time: t ? t[1].trim() : null, grams: g ? +g[1] : null, maxZ, lines: gcode.split("\n").length};
}

/* ---------- post-processing ---------- */
// Temperature tower. `boundaries` = [{z, temp}] sorted by z: the first layer whose top (;Z:)
// reaches z switches to temp. Layers below the first boundary (the base plate) keep the
// profile's own temperatures, as Prusa's tower does. One M104 per block, on its own line.
function temperatureBands(gcode, boundaries) {
  const lines = gcode.split("\n"), out = []; let cur = -1, maxZ = 0;
  for (const line of lines) {
    out.push(line);
    const m = line.match(/^;Z:([\d.]+)/);
    if (!m) continue;
    const z = +m[1]; maxZ = Math.max(maxZ, z);
    let b = -1; for (let i = 0; i < boundaries.length; i++) if (z >= boundaries[i].z - 1e-6) b = i;
    if (b > cur) { cur = b; out.push(`M104 S${boundaries[b].temp} ; calbench: block ${b + 1}`, `M117 Block ${b + 1}: ${boundaries[b].temp}C`); }
  }
  const used = boundaries.filter(x => x.z <= maxZ + 1e-6);
  const bands = used.map((x, i) => ({n: i + 1, z0: x.z, z1: i + 1 < used.length ? used[i + 1].z : maxZ, value: x.temp}));
  return {gcode: out.join("\n"), bands, unused: boundaries.slice(used.length).map(x => x.temp)};
}
const towerBoundaries = (base, block, temps) => temps.map((t, i) => ({z: +(base + i * block).toFixed(3), temp: t}));

/* ---------- 3MF import ---------- */
// Minimal ZIP reader (3MF is a ZIP): central directory -> entry -> inflate. No dependencies.
function zipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Object.assign(new Error("Not a valid 3MF (ZIP) file"), {status: 400});
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    if (name === wanted) {
      const data = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.slice(data, data + csize);
      return method === 0 ? raw : method === 8 ? require("zlib").inflateRawSync(raw) : null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}
// Reads a temperature tower's block heights and temperatures out of a PrusaSlicer 3MF.
// Prusa's towers use conditionals in before_layer_gcode: {if layer_z>=11.05} M104 S225 …{endif}.
// Per-height custom G-code (the layer-slider markers) is read too, for towers made that way.
function parse3mf(buf) {
  const cfgBuf = zipEntry(buf, "Metadata/Slic3r_PE.config");
  const cfg = {};
  if (cfgBuf) for (const line of cfgBuf.toString("utf8").split("\n")) { const m = line.match(/^; (\w+) = (.*)$/); if (m) cfg[m[1]] = m[2]; }
  let boundaries = [];
  const blg = (cfg.before_layer_gcode || "") + "\n" + (cfg.layer_gcode || "");
  for (const m of blg.matchAll(/layer_z\s*>=?\s*([\d.]+)\s*\}\s*M10[49]\s+S(\d+)/g)) boundaries.push({z: +m[1], temp: +m[2]});
  const perZ = zipEntry(buf, "Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml");
  if (perZ) for (const m of perZ.toString("utf8").matchAll(/print_z="([\d.]+)"[^>]*?gcode="[^"]*?M10[49]\s+S(\d+)/g)) boundaries.push({z: +m[1], temp: +m[2]});
  const seen = new Set();
  boundaries = boundaries.sort((a, b) => a.z - b.z).filter(x => !seen.has(x.z) && seen.add(x.z));
  return {boundaries, presets: {printer: cfg.printer_settings_id, print: cfg.print_settings_id, filament: (cfg.filament_settings_id || "").replace(/^"|"$/g, "")}};
}
// The mesh goes through PrusaSlicer's own 3MF reader and comes out as an STL, so slicing
// works the same as for any uploaded model and none of the 3MF's settings ride along.
async function threeMfToStl(buf, outStl) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-3mf-"));
  try {
    const src = path.join(dir, "in.3mf");
    await fsp.writeFile(src, buf);
    await run(SLICER, ["--export-stl", "--output", outStl, src], {timeout: 5 * 60000});
    return outStl;
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}

// Per-object flow: M221 at the start of each labelled object, relative to the baseline the
// start G-code set (Prusa's MMU profiles start at M221 S95), restored when the object ends.
function perObjectFlow(gcode, pctByObject) {
  const lines = gcode.split("\n"), out = [];
  let baseline = 100;
  const first = gcode.match(/^M221 S(\d+)/m); if (first) baseline = +first[1];
  for (const l of lines) {
    out.push(l);
    let m = l.match(/^; printing object (\S+)/);
    if (m && pctByObject[m[1]] != null) { out.push(`M221 S${Math.round(baseline * pctByObject[m[1]] / 100)} ; calbench: ${m[1]} at ${pctByObject[m[1]]}%`); continue; }
    m = l.match(/^; stop printing object (\S+)/);
    if (m && pctByObject[m[1]] != null) out.push(`M221 S${baseline}`);
  }
  return {gcode: out.join("\n"), baseline};
}

/* ---------- writing 3MF (per-object settings) ---------- */
// PrusaSlicer keeps right-click object settings in Metadata/Slic3r_PE_model.config inside a
// 3MF. Writing that file lets one print hold several swatches, each sliced with its own
// settings (fuzzy skin changes geometry, so it can't be varied with a G-code command).
function stlMesh(buf) {
  const verts = [], tris = [], key = new Map();
  const add = (x, y, z) => { const k = x + "," + y + "," + z; let i = key.get(k); if (i === undefined) { i = verts.length; key.set(k, i); verts.push([x, y, z]); } return i; };
  if (/^\s*solid/.test(buf.slice(0, 256).toString("latin1")) && buf.includes("facet")) {
    const v = [...buf.toString("latin1").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map(m => [+m[1], +m[2], +m[3]]);
    for (let i = 0; i + 2 < v.length; i += 3) tris.push([add(...v[i]), add(...v[i + 1]), add(...v[i + 2])]);
  } else {
    const n = buf.readUInt32LE(80);
    for (let t = 0; t < n; t++) { const o = 84 + t * 50 + 12, p = []; for (let j = 0; j < 3; j++) p.push(add(buf.readFloatLE(o + j * 12), buf.readFloatLE(o + j * 12 + 4), buf.readFloatLE(o + j * 12 + 8))); tris.push(p); }
  }
  return {verts, tris};
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) { // ZIP with stored (uncompressed) entries: all a 3MF reader needs
  const parts = [], cen = []; let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); cen.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cs = cen.reduce((a, b) => a + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cs, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, ...cen, end]);
}
const xa = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// objects: [{name, mesh, settings}] or [{name, settings, volumes: [{name, mesh, type, settings}]}]
// where type is "ModelPart" or "ParameterModifier". PrusaSlicer stores all of an object's
// volumes in one mesh and tells them apart by triangle ranges (firstid..lastid).
function build3mf(objects) {
  let res = "", items = "", cfg = "";
  objects.forEach((o, i) => {
    const id = i + 1, vols = o.volumes || [{name: o.name, mesh: o.mesh, type: "ModelPart"}];
    let vxml = "", txml = "", vcfg = "", vbase = 0, tbase = 0;
    for (const v of vols) {
      vxml += v.mesh.verts.map(p => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join("");
      txml += v.mesh.tris.map(t => `<triangle v1="${t[0] + vbase}" v2="${t[1] + vbase}" v3="${t[2] + vbase}"/>`).join("");
      vcfg += `  <volume firstid="${tbase}" lastid="${tbase + v.mesh.tris.length - 1}">\n   <metadata type="volume" key="name" value="${xa(v.name)}"/>\n   <metadata type="volume" key="volume_type" value="${v.type || "ModelPart"}"/>\n` +
        Object.entries(v.settings || {}).map(([k, val]) => `   <metadata type="volume" key="${xa(k)}" value="${xa(val)}"/>\n`).join("") + `  </volume>\n`;
      vbase += v.mesh.verts.length; tbase += v.mesh.tris.length;
    }
    res += `<object id="${id}" type="model"><mesh><vertices>${vxml}</vertices><triangles>${txml}</triangles></mesh></object>\n`;
    items += `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n`;
    cfg += ` <object id="${id}" instances_count="1">\n  <metadata type="object" key="name" value="${xa(o.name)}"/>\n` +
      Object.entries(o.settings || {}).map(([k, v]) => `  <metadata type="object" key="${xa(k)}" value="${xa(v)}"/>\n`).join("") + vcfg + ` </object>\n`;
  });
  return zipStore([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`],
    ["3D/3dmodel.model", `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n<metadata name="slic3rpe:Version3mf">1</metadata>\n<resources>\n${res}</resources>\n<build>\n${items}</build>\n</model>\n`],
    ["Metadata/Slic3r_PE_model.config", `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfg}</config>\n`]
  ]);
}

/* ---------- jobs ---------- */
// meta.boundaries comes from an imported 3MF (heights and temperatures fixed by the labels
// moulded into the model); otherwise base/block/temps from the page.
async function jobTempTower(pr, req, modelPath, meta = {}) {
  let boundaries;
  if (meta.boundaries && meta.boundaries.length) boundaries = meta.boundaries;
  else {
    const temps = (req.temps || []).map(Number).filter(t => t >= 150 && t <= 320);
    if (!temps.length) throw Object.assign(new Error("No temperatures to print"), {status: 400});
    const base = +req.base, block = +req.block;
    if (!(block > 0) || !(base >= 0)) throw Object.assign(new Error("Base and block heights must be positive"), {status: 400});
    boundaries = towerBoundaries(base, block, temps);
  }
  // Base plate at the filament's own temperature; blocks switch from there.
  const {cfg} = buildConfig(pr, req.material, req.values);
  const r = await slice([modelPath], cfg);
  const t = temperatureBands(r.gcode, boundaries);
  return {gcode: t.gcode, bands: t.bands, unused: t.unused, warnings: r.warnings};
}
async function jobFlowTops(pr, req) {
  const n = Math.min(9, Math.max(3, Math.round(req.count || 5))), step = +req.step || 2;
  const pcts = Array.from({length: n}, (_, i) => +(100 + (i - (n - 1) / 2) * step).toFixed(1));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-flow-"));
  try {
    // Squares are placed by OpenSCAD in bed coordinates (rows of up to 5, 33 mm apart, centred
    // on the MK3S bed) and PrusaSlicer is told not to rearrange them, so the layout doesn't
    // depend on the slicer's auto-arrange, whose command-line behaviour varies by version.
    const SIZE = 25, PITCH = 33, cols = Math.min(n, 5), rows = Math.ceil(n / cols);
    const x0 = 125 - ((cols - 1) * PITCH + SIZE) / 2, y0 = 105 + ((rows - 1) * PITCH - SIZE) / 2;
    const stls = [], map = {};
    for (let i = 0; i < n; i++) {
      const name = `flow_${i + 1}.stl`;
      const ox = +(x0 + (i % cols) * PITCH).toFixed(2), oy = +(y0 - Math.floor(i / cols) * PITCH).toFixed(2);
      stls.push(await openscad("flow_square.scad", {idx: i + 1, ox, oy}, path.join(dir, name)));
      map[name] = pcts[i];
    }
    const {cfg} = buildConfig(pr, req.material, req.values, {gcode_label_objects: "octoprint"});
    const r = await slice(stls, cfg, {merge: true, keepPositions: true});
    const f = perObjectFlow(r.gcode, map);
    return {gcode: f.gcode, bands: pcts.map((p, i) => ({n: i + 1, notches: i + 1, value: p})), baseline: f.baseline, warnings: r.warnings};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}
// Optional finishes. Each swatch is its own object with its own ironing or fuzzy-skin
// settings; values vary along one axis (flow or speed; thickness or point distance).
const FINISHES = {
  ironing: {
    size: 20, h: 1.6, // solid top layers over a thin base: only the top surface matters
    modes: {flow: {key: "ironing_flowrate", unit: "%"}, speed: {key: "ironing_speed", unit: "mm/s"}},
    settings: (q, mode, v) => ({ironing: 1, ironing_type: "top", ironing_flowrate: (mode === "flow" ? v : q.flow) + "%",
      ironing_speed: mode === "speed" ? v : q.speed, ironing_spacing: q.spacing})
  },
  fuzzy: {
    size: 20, h: 8, notch: {nw: 1.6, nd: 2}, // the texture moves walls by up to ±thickness
    modes: {thickness: {key: "fuzzy_skin_thickness", unit: "mm"}, dist: {key: "fuzzy_skin_point_dist", unit: "mm"}},
    settings: (q, mode, v) => ({fuzzy_skin: "external", fuzzy_skin_thickness: mode === "thickness" ? v : q.thickness,
      fuzzy_skin_point_dist: mode === "dist" ? v : q.dist})
  }
};
async function jobSwatches(pr, req) {
  const F = FINISHES[req.kind];
  if (!F || !F.modes[req.mode]) throw Object.assign(new Error("Unknown finish test"), {status: 400});
  const values = (req.list || []).map(Number).filter(v => v > 0).slice(0, 6); // 6 notches fit a 20 mm face
  if (values.length < 2) throw Object.assign(new Error("Need at least two values to compare"), {status: 400});
  const n = values.length, SIZE = F.size, PITCH = SIZE + 8, cols = Math.min(n, 5), rows = Math.ceil(n / cols);
  const x0 = 125 - ((cols - 1) * PITCH + SIZE) / 2, y0 = 105 + ((rows - 1) * PITCH - SIZE) / 2;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-sw-"));
  try {
    const objects = [];
    for (let i = 0; i < n; i++) {
      const ox = +(x0 + (i % cols) * PITCH).toFixed(2), oy = +(y0 - Math.floor(i / cols) * PITCH).toFixed(2);
      const stl = await openscad("flow_square.scad", {idx: i + 1, ox, oy, size: SIZE, h: F.h, ...(F.notch || {})}, path.join(dir, `s${i + 1}.stl`));
      objects.push({name: `swatch_${i + 1}.stl`, mesh: stlMesh(await fsp.readFile(stl)), settings: F.settings(req, req.mode, values[i])});
    }
    const file = path.join(dir, "swatches.3mf");
    await fsp.writeFile(file, build3mf(objects));
    const {cfg} = buildConfig(pr, req.material, req.values, {gcode_label_objects: "octoprint"});
    const r = await slice([file], cfg, {keepPositions: true});
    return {gcode: r.gcode, bands: values.map((v, i) => ({n: i + 1, notches: i + 1, value: v})), warnings: r.warnings};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}
// A user print preset PrusaSlicer can load: Prusa's print preset plus the finish settings.
function printIni(pr, kind, q, presetName) {
  const base = flatten("print", PRINT_PRESET);
  let extra, what;
  if (kind === "bridge") { extra = printOverrides({bridge: q}); what = "your tested bridge speed and flow"; }
  else {
    const F = FINISHES[kind]; if (!F) throw Object.assign(new Error("Unknown print profile kind"), {status: 400});
    extra = kind === "ironing" ? F.settings(q, "flow", q.flow) : F.settings(q, "thickness", q.thickness);
    what = kind === "ironing" ? "ironing turned on" : "fuzzy skin turned on";
  }
  const lines = [`# PrusaSlicer print profile generated by MK3S Calibration Bench`, `# ${presetName}`,
    `# Based on Prusa's "${PRINT_PRESET}" with ${what}.`,
    `# Save as %APPDATA%\\PrusaSlicer\\print\\${presetName}.ini, then restart PrusaSlicer.`,
    `inherits = ${PRINT_PRESET}`, `compatible_printers_condition = printer_model=="${pr.model}"`];
  for (const [k, v] of Object.entries({...base, ...extra})) if (!META.has(k)) lines.push(`${k} = ${v}`);
  return lines.join("\n") + "\n";
}

/* ---------- step 8: overhang/bridge fan tower and bridge swatches ---------- */
// Fan tower: sliced once with dynamic fan speeds on and every overhang/bridge fan at a
// reference of 100 %, then each block's boosted fan commands are rescaled to that block's
// value. Fan settings are filament settings, which PrusaSlicer can't vary per object, so the
// variation has to happen in the G-code. The reference uses the same shape calbench exports
// (0 % and 25 % overlap = full value, 50 % = halfway, 75 % = normal fan), and the rescale is
// linear, so each block prints exactly what that value would give in a real print.
const FAN_TOWER = {base: 1, bh: 8};
function fanBands(gcode, {targets, normal}) {
  const {base, bh} = FAN_TOWER, out = [];
  let z = 0, block = -1, maxZ = 0, changed = 0;
  for (const line of gcode.split("\n")) {
    const zm = line.match(/^;Z:([\d.]+)/);
    if (zm) {
      z = +zm[1]; maxZ = Math.max(maxZ, z);
      const b = z <= base + 1e-6 ? -1 : Math.min(targets.length - 1, Math.floor((z - base - 1e-6) / bh));
      if (b !== block) { block = b; if (b >= 0) out.push(line, `M117 Block ${b + 1}: fan ${targets[b]}%`); else out.push(line); continue; }
    }
    const fm = block >= 0 && line.match(/^M106 S(\d+(?:\.\d+)?)(.*)$/);
    if (fm) {
      const pct = +fm[1] / 2.55;
      if (pct > normal + 0.5) {
        const t = targets[block], v = normal + (pct - normal) * (t - normal) / (100 - normal);
        out.push(`M106 S${Math.round(v * 2.55)}${fm[2]} ; calbench: block ${block + 1} at ${t}%`); changed++; continue;
      }
    }
    out.push(line);
  }
  const n = Math.min(targets.length, Math.ceil((maxZ - base) / bh));
  return {gcode: out.join("\n"), changed,
    bands: targets.slice(0, n).map((t, i) => ({n: i + 1, z0: base + i * bh, z1: Math.min(maxZ, base + (i + 1) * bh), value: t}))};
}
async function jobFanTower(pr, req) {
  const targets = (req.list || []).map(Number).filter(v => v >= 0 && v <= 100).slice(0, 6);
  if (targets.length < 2) throw Object.assign(new Error("Need at least two fan values"), {status: 400});
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-fan-"));
  try {
    const stl = await openscad("fan_tower.scad", {blocks: targets.length, bh: FAN_TOWER.bh, base: FAN_TOWER.base}, path.join(dir, "tower.stl"));
    const values = {...req.values}; delete values.ofan; delete values.bfan;
    const normal = num(buildConfig(pr, req.material, values).cfg.max_fan_speed) || 50;
    if (targets.some(t => t < normal)) throw Object.assign(new Error(`Fan values can't be below the normal fan (${normal} %)`), {status: 400});
    const {cfg} = buildConfig(pr, req.material, values, {enable_dynamic_fan_speeds: 1, overhang_fan_speed_0: 100, overhang_fan_speed_1: 100,
      overhang_fan_speed_2: Math.round((100 + normal) / 2), overhang_fan_speed_3: normal, bridge_fan_speed: 100});
    const r = await slice([stl], cfg);
    const f = fanBands(r.gcode, {targets, normal});
    return {gcode: f.gcode, bands: f.bands, warnings: r.warnings, normal, changed: f.changed};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}
// Bridge swatches: bridge speed and flow ratio are print settings, so each swatch is its own
// object with its own value, in one 3MF.
async function jobBridges(pr, req) {
  const mode = req.mode === "flow" ? "flow" : "speed";
  const values = (req.list || []).map(Number).filter(v => v > 0).slice(0, 6);
  if (values.length < 2) throw Object.assign(new Error("Need at least two values to compare"), {status: 400});
  const n = values.length, W = 45, D = 12, cols = Math.min(n, 4), rows = Math.ceil(n / cols);
  const x0 = 125 - ((cols - 1) * (W + 8) + W) / 2, y0 = 105 + ((rows - 1) * (D + 12) - D) / 2;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-br-"));
  try {
    const objects = [];
    for (let i = 0; i < n; i++) {
      const ox = +(x0 + (i % cols) * (W + 8)).toFixed(2), oy = +(y0 - Math.floor(i / cols) * (D + 12)).toFixed(2);
      const stl = await openscad("bridge_swatch.scad", {idx: i + 1, ox, oy}, path.join(dir, `b${i + 1}.stl`));
      const settings = mode === "speed" ? {bridge_speed: values[i], bridge_flow_ratio: req.flow || 0.95} : {bridge_flow_ratio: values[i], bridge_speed: req.speed || 25};
      objects.push({name: `bridge_${i + 1}.stl`, mesh: stlMesh(await fsp.readFile(stl)), settings});
    }
    const file = path.join(dir, "bridges.3mf");
    await fsp.writeFile(file, build3mf(objects));
    const vals = {...req.values}; delete vals.bridge;
    const {cfg} = buildConfig(pr, req.material, vals, {gcode_label_objects: "octoprint"});
    const r = await slice([file], cfg, {keepPositions: true});
    return {gcode: r.gcode, bands: values.map((v, i) => ({n: i + 1, notches: i + 1, value: v})), warnings: r.warnings};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}

// A box as a mesh, rotated about Z by `deg`: used as a modifier volume.
function boxMesh(x0, x1, y0, y1, z0, z1, deg) {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
    .map(([x, y, z]) => [+(x * c - y * s).toFixed(4), +(x * s + y * c).toFixed(4), z]);
  return {verts: P, tris: [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]};
}
async function jobTile(pr, req) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "calbench-tile-"));
  try {
    const stl = await openscad("hex_tile.scad", {
      name: scadText(req.name) || "FILAMENT", modifier: scadText(req.modifier), colour: scadText(req.colour), compact: !!req.compact,
      info1: scadText(`${pr.name.split(" ")[0]}  ${Math.round(req.values.temp)}C`), info2: scadText(req.date || new Date().toISOString().slice(0, 10))
    }, path.join(dir, "tile.stl"));
    // Ironing: a whole-object print setting, so it simply goes into the config.
    const extra = {};
    const ir = req.ironing;
    if (ir && ir.flow > 0) Object.assign(extra, {ironing: 1, ironing_type: "top", ironing_flowrate: ir.flow + "%", ironing_speed: ir.speed || 15, ironing_spacing: ir.spacing || 0.1});
    const {cfg} = buildConfig(pr, req.material, req.values, extra);
    let input = stl;
    // Fuzzy skin: only on the 210° face (the one plain face: no undercut, no tunnel), via a
    // modifier volume around that face, the way you'd add one in PrusaSlicer.
    const fz = req.fuzzy;
    if (fz && fz.thickness > 0) {
      const F = 50, R = F / Math.sqrt(3);
      input = path.join(dir, "tile.3mf");
      await fsp.writeFile(input, build3mf([{name: "tile.stl", volumes: [
        {name: "tile.stl", type: "ModelPart", mesh: stlMesh(await fsp.readFile(stl))},
        {name: "fuzzy face", type: "ParameterModifier", mesh: boxMesh(F / 2 - 1.5, F / 2 + 1, -R / 2, R / 2, -0.1, 8.1, 210),
          settings: {fuzzy_skin: "external", fuzzy_skin_thickness: fz.thickness, fuzzy_skin_point_dist: fz.dist || 0.8}}
      ]}]));
    }
    const r = await slice([input], cfg);
    return {gcode: r.gcode, bands: [], warnings: r.warnings};
  } finally { fsp.rm(dir, {recursive: true, force: true}).catch(() => {}); }
}
async function jobModel(pr, req, modelPath) {
  const {cfg} = buildConfig(pr, req.material, req.values);
  const r = await slice([modelPath], cfg);
  return {gcode: r.gcode, bands: [], warnings: r.warnings};
}

// Prusa's first-layer nozzle temperature per calbench material, for the page's summary.
function firstLayerTemps() {
  const out = {};
  for (const [mat, name] of Object.entries(FILAMENT_PRESETS)) { try { out[mat] = num(flatten("filament", name).first_layer_temperature); } catch {} }
  return out;
}
async function versions() {
  const out = {};
  try { out.prusaslicer = ((await run(SLICER, ["--help"], {timeout: 30000})).match(/PrusaSlicer-([\d.]+\S*)/) || [])[1] || "unknown"; } catch { out.prusaslicer = null; }
  try { out.openscad = ((await run(OPENSCAD, ["--version"], {timeout: 30000})).match(/version ([\d.]+)/) || [])[1] || "unknown"; } catch { out.openscad = null; }
  try {
    loadBundle(); out.bundle = true; out.firstLayer = firstLayerTemps();
    out.maxFan = {}; // each material's normal maximum fan: the floor for the overhang fan tower
    out.bridgeFan = {}; // Prusa's bridge fan per material, shown when you haven't tested one
    for (const [mat, name] of Object.entries(FILAMENT_PRESETS)) { try { const f = flatten("filament", name); out.maxFan[mat] = num(f.max_fan_speed); out.bridgeFan[mat] = num(f.bridge_fan_speed); } catch {} }
    const pp = flatten("print", PRINT_PRESET); out.bridge = {speed: num(pp.bridge_speed), flow: num(pp.bridge_flow_ratio)};
  } catch { out.bundle = false; }
  return out;
}

module.exports = {
  jobSwatches, printIni, build3mf, stlMesh, jobFanTower, jobBridges, fanBands,
  serial, stats, versions, filamentIni, buildConfig, printerPreset, filamentPreset,
  jobTempTower, jobFlowTops, jobTile, jobModel, temperatureBands, parse3mf, threeMfToStl, perObjectFlow, scadText, PRINT_PRESET
};
