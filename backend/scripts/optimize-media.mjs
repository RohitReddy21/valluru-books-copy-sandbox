/**
 * Compresses the site's cover and background images. Dry run only: downloads, writes the
 * smaller files into --out, and prints a before/after table. It uploads nothing and changes
 * no content.
 *
 *   node backend/scripts/optimize-media.mjs --content live-content.json --out media-optimized
 *
 * --content is a saved /api/content payload (or an export from export-site-content.mjs); every
 * image URL in it on an allowed host is fetched. Covers are cut to at most 1600px wide and
 * backgrounds to 1920px, then written as WebP. A file is kept only when it comes out at least
 * 30% smaller; otherwise the original is left alone and reported as skipped.
 *
 * Writes <out>/<file>.webp for each kept image and <out>/report.json listing, per original
 * URL, the sizes and the new file name.
 *
 * Add --upload to also put each smaller file in the SAME Supabase bucket, next to the
 * original with a .webp extension, and record its public address as "newUrl" in report.json.
 * That needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the project the images live in.
 * Originals are never deleted or overwritten, so everything can be rolled back; the site only
 * starts using the new files when apply-media-map.mjs swaps the addresses in the content.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const contentFile = option("content");
const outDir = option("out", "media-optimized");
const CONCURRENCY = Number(option("concurrency", "4"));
const UPLOAD = args.includes("--upload");
const MIN_SAVING = 0.3;
const ALLOWED_HOST = /(^|\.)supabase\.co$|^(www\.)?thevalluru\.org$/;
const IMAGE_URL = /^https?:\/\/.+\.(png|jpe?g|webp)(\?|$)/i;

if (!contentFile) {
  console.error("Usage: node optimize-media.mjs --content <content.json> --out <dir>");
  process.exit(1);
}

const payload = JSON.parse(await readFile(contentFile, "utf8"));
const content = payload.content ?? payload;
const targets = new Map(); // url -> { where, maxWidth }

(function walk(node, trail) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${trail}[${index}]`));
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      walk(node[key], `${trail}.${key}`);
    }
  } else if (typeof node === "string" && IMAGE_URL.test(node)) {
    let host = "";

    try {
      host = new URL(node).hostname;
    } catch {
      return;
    }

    if (!ALLOWED_HOST.test(host)) {
      return;
    }

    const where = trail.replace(/^\./, "").replace(/\[\d+\]/g, "[]");
    const isBackground = /backgroundImage|pageHeroImage|heroImage/i.test(where);
    const existing = targets.get(node);

    targets.set(node, { where: existing ? `${existing.where}, ${where}` : where, maxWidth: isBackground ? 1920 : 1600 });
  }
})(content, "");

await mkdir(outDir, { recursive: true });

let storage = null;
let supabaseOrigin = "";

if (UPLOAD) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("--upload needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
    process.exit(1);
  }

  const { createClient } = require("@supabase/supabase-js");
  storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage;
  supabaseOrigin = new URL(SUPABASE_URL).origin;
}

/** bucket and path from .../storage/v1/object/public/<bucket>/<path>, or null. */
function storageLocation(url) {
  const match = new URL(url).pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  return match ? { bucket: match[1], objectPath: decodeURIComponent(match[2]) } : null;
}

const results = [];
const queue = [...targets.entries()];

async function work() {
  while (queue.length) {
    const [url, info] = queue.shift();
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "image").replace(/\.[a-z]+$/i, "");

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });

      if (!response.ok) {
        results.push({ url, name, status: `HTTP ${response.status}` });
        continue;
      }

      const original = Buffer.from(await response.arrayBuffer());
      const meta = await sharp(original).metadata();
      const compressed = await sharp(original)
        .rotate()
        .resize({ width: info.maxWidth, withoutEnlargement: true })
        .webp({ quality: info.maxWidth > 1600 ? 78 : 82, effort: 5 })
        .toBuffer();
      const saving = 1 - compressed.length / original.length;
      const keep = saving >= MIN_SAVING;

      let newUrl = null;

      if (keep) {
        await writeFile(path.join(outDir, `${name}.webp`), compressed);

        const location = storageLocation(url);

        // Only the project whose key was given can be written to; anything else is left alone.
        if (UPLOAD && location && new URL(url).origin === supabaseOrigin) {
          const newPath = location.objectPath.replace(/\.[a-z0-9]+$/i, ".webp");
          const { error } = await storage.from(location.bucket).upload(newPath, compressed, {
            contentType: "image/webp",
            cacheControl: "31536000",
            upsert: false
          });

          // "already exists" means an earlier run put it there: reuse it.
          if (error && !/exist|duplicate/i.test(error.message)) {
            throw new Error(`upload failed: ${error.message}`);
          }

          newUrl = `${supabaseOrigin}/storage/v1/object/public/${location.bucket}/${newPath.split("/").map(encodeURIComponent).join("/")}`;
        }
      }

      results.push({
        url,
        name: `${name}.webp`,
        where: info.where,
        width: meta.width,
        height: meta.height,
        before: original.length,
        after: keep ? compressed.length : null,
        newUrl,
        status: keep ? (newUrl ? "compressed + uploaded" : "compressed") : "skipped (saves under 30%)"
      });
    } catch (error) {
      results.push({ url, name, status: `failed: ${String(error.message).slice(0, 60)}` });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, work));
results.sort((a, b) => (b.before || 0) - (a.before || 0));
await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");

const kb = (n) => `${(n / 1024).toFixed(0)} KB`.padStart(8);
let before = 0;
let after = 0;

for (const r of results) {
  if (!r.before) {
    console.log(`  ${r.status.padEnd(16)} ${r.name}`);
    continue;
  }

  before += r.before;
  after += r.after ?? r.before;
  console.log(`${kb(r.before)} -> ${r.after ? kb(r.after) : "  (kept)"}  ${r.after ? `-${Math.round((1 - r.after / r.before) * 100)}%`.padStart(5) : "     "}  ${r.width}x${r.height}  ${r.name.slice(0, 46)}`);
}

console.log(
  `\n${results.length} images, ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB ` +
    `(${Math.round((1 - after / before) * 100)}% smaller). ${UPLOAD ? `${results.filter((r) => r.newUrl).length} uploaded; no content changed.` : "Nothing was uploaded or changed."}`
);
