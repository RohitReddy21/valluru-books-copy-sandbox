/**
 * Points the site's content at the compressed images made by optimize-media.mjs --upload.
 *
 *   node backend/scripts/apply-media-map.mjs --content live.stored.json \
 *     --report media-optimized/report.json --out live-optimized.stored.json
 *
 * Reads a content export (export-site-content.mjs), replaces every original image address with
 * its "newUrl" from the report, and writes the result to --out. Dry run: no database is touched.
 *
 * A new address is used only if it answers with an image right now, so a failed or partial upload
 * never leaves a broken picture on the site. Originals stay in storage, so this is reversible:
 * restore the export you started from.
 *
 * To write the result to the production database, add (MONGODB_URI set in the environment):
 *   --db valluru_books --allow-production valluru_books
 * The --content file must be a *.stored.json export, as for import-booklet-chapters.mjs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

if (process.platform === "win32") {
  require("node:dns").setServers(["1.1.1.1", "8.8.8.8"]);
}

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const contentFile = option("content");
const reportFile = option("report");
const outFile = option("out");
const dbName = option("db");
const PROTECTED_DATABASES = new Set(["valluru_books"]);

if (!contentFile || !reportFile || !outFile) {
  console.error("Usage: node apply-media-map.mjs --content <export>.stored.json --report <report.json> --out <file>.stored.json");
  process.exit(1);
}

if (!outFile.endsWith(".stored.json")) {
  console.error("--out must end in .stored.json, so it can be used with the import and export tools.");
  process.exit(1);
}

if (dbName) {
  if (PROTECTED_DATABASES.has(dbName) && option("allow-production") !== dbName) {
    console.error(`Refusing to write to "${dbName}". Add --allow-production ${dbName} to confirm.`);
    process.exit(1);
  }

  if (!contentFile.endsWith(".stored.json")) {
    console.error("Writing to a database needs --content to be a *.stored.json export, not a public /api/content payload.");
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set, so there is nothing to write to.");
    process.exit(1);
  }
}

const payload = JSON.parse(await readFile(contentFile, "utf8"));
const content = payload.content ?? payload;
const report = JSON.parse(await readFile(reportFile, "utf8"));
const candidates = report.filter((row) => row.url && row.newUrl && row.newUrl !== row.url);

// Confirm each replacement is live before using it.
const usable = new Map();

for (const row of candidates) {
  try {
    const response = await fetch(row.newUrl, { method: "HEAD", signal: AbortSignal.timeout(20000) });
    const type = response.headers.get("content-type") || "";

    if (response.ok && type.startsWith("image/")) {
      usable.set(row.url, row.newUrl);
    } else {
      console.log(`  not live, skipped: ${row.newUrl.split("/").pop()} (HTTP ${response.status}, ${type || "no type"})`);
    }
  } catch {
    console.log(`  unreachable, skipped: ${row.newUrl.split("/").pop()}`);
  }
}

let replaced = 0;

(function walk(node) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (typeof item === "string" && usable.has(item)) {
        node[index] = usable.get(item);
        replaced += 1;
      } else {
        walk(item);
      }
    });
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (typeof node[key] === "string" && usable.has(node[key])) {
        node[key] = usable.get(node[key]);
        replaced += 1;
      } else {
        walk(node[key]);
      }
    }
  }
})(content);

await writeFile(outFile, `${JSON.stringify({ content }, null, 2)}\n`, "utf8");
console.log(`${candidates.length} replacements in the report, ${usable.size} live, ${replaced} addresses swapped in the content.`);
console.log(`Wrote ${outFile}${dbName ? "" : " (dry run: no database touched)"}`);

if (dbName) {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    const result = await client.db(dbName).collection("content").updateOne(
      { key: "site-content" },
      { $set: { content, updatedAt: new Date() } }
    );
    console.log(`Wrote the content to database "${dbName}" (matched ${result.matchedCount}, modified ${result.modifiedCount}).`);
  } finally {
    await client.close();
  }
}
