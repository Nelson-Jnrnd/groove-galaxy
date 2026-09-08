#!/usr/bin/env node
/** Dev helper: dump a snapshot to a flat SVG so a layout tweak can be eyeballed
 *  without starting the dev server. Not part of the build. */
import { readFile, writeFile } from "node:fs/promises";

const src = process.argv[2] || "public/data/snapshot.json";
const out = process.argv[3] || ".cache/preview.svg";
const snap = JSON.parse(await readFile(src, "utf8"));
const { minX, minY, maxX, maxY } = snap.bounds;
const colorOf = (n) =>
  n.cluster < 0 ? "#6d6a62" : snap.clusters[n.cluster].color;

const circles = snap.artists
  .map(
    (n) =>
      `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${colorOf(n)}" fill-opacity="0.55" stroke="${colorOf(n)}" stroke-width="1.5"/>`,
  )
  .join("\n");
const labels = snap.artists
  .filter((n) => n.r > 26)
  .map(
    (n) =>
      `<text x="${n.x}" y="${n.y + n.r + 14}" font-size="12" fill="#ece9e1" text-anchor="middle">${n.name.replace(/[<&]/g, "")}</text>`,
  )
  .join("\n");

await writeFile(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="1400">
<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#141413"/>
${circles}
${labels}
</svg>`,
);
console.log(
  `${out} — ${snap.artists.length} artists, extent ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}`,
);
