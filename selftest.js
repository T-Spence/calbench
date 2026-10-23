// Build-time check: proves PrusaSlicer, OpenSCAD, the fonts and Prusa's profiles all work in
// this image by generating and slicing a benchmark tile for both printer types.
// `docker compose build` fails here, with the reason, if any piece is missing.
"use strict";
const s = require("./slicer");
(async () => {
  const v = await s.versions();
  console.log("selftest: PrusaSlicer", v.prusaslicer, "| OpenSCAD", v.openscad, "| Prusa profiles", v.bundle ? "found" : "MISSING");
  if (!v.prusaslicer || !v.openscad || !v.bundle) process.exit(1);
  for (const pr of [{name: "MK3S", model: "MK3S", mmu: false}, {name: "MK3S+ MMU3", model: "MK3SMMU3", mmu: true}]) {
    const r = await s.jobTile(pr, {material: "PETG", values: {temp: 235, bed: 85, em: 1, k: 0.05, retract: 0.8, rspeed: 35, mvs: 8}, name: "SELF TEST", colour: "OK"});
    const model = (r.gcode.match(/^M862\.3 P "([^"]+)"/m) || [])[1];
    const k = (r.gcode.match(/^M900 K([\d.]+) ; calbench/m) || [])[1];
    const st = s.stats(r.gcode);
    console.log(`selftest: ${pr.name}: model check "${model}", K ${k}, ${st.time}, ${st.grams} g`);
    if (model !== pr.model || k !== "0.05" || !(st.maxZ > 9)) { console.error("selftest: unexpected G-code"); process.exit(1); }
  }
  console.log("selftest: ok");
})().catch(e => { console.error("selftest failed:", e.message); process.exit(1); });
