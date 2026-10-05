/**
 * Makes vertical (1080x1920) quote reels with ffmpeg: slow camera movement over a booklet's own
 * background art, its lines fading in and out one at a time, a soft ambient drone, and an end
 * card with the logo and link. Costs nothing and needs no account.
 *
 *   node backend/scripts/make-reel-videos.mjs --reels frontend/docs/video/inward-mirror-reels.json \
 *     --media <folder with the .webp images> --out reels/inward-mirror [--only m3]
 *
 * reels.json is a list of { id, label, title, hook, beats[], payoff, background, link }.
 * "background" is a file name inside --media (optimize-media.mjs writes them there).
 *
 * Needs ffmpeg on the PATH and Times New Roman (C:\Windows\Fonts\times.ttf): Georgia and
 * Garamond are missing the dotted letters in names like Kṛṣṇa and Aṣṭāvakra.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const reelsFile = option("reels");
const mediaDir = option("media");
const outDir = option("out", "reels");
const only = option("only");
const fontPath = option("font", "C:/Windows/Fonts/times.ttf");
const italicPath = option("italic", "C:/Windows/Fonts/timesi.ttf");
const logoPath = option("logo", "frontend/public/valluru-logo-sm.png");
// "cover" is the vivid cover art, "background" the dark atmospheric plate; shade is the black overlay.
const source = option("source", "cover");
const shade = option("shade", "0.42");

const W = 1080;
const H = 1920;
const TOTAL = 30;
const GOLD = "0xc4a96b";
const PARCHMENT = "0xe8e0d4";

if (!reelsFile || !mediaDir) {
  console.error("Usage: node make-reel-videos.mjs --reels <reels.json> --media <dir> --out <dir> [--only m3]");
  process.exit(1);
}

/** Wraps a line to a character width, never splitting a word. */
function wrap(text, width) {
  const lines = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.join("\n");
}

/** Bigger type for short lines, smaller for long ones, so every line fits 920px. */
function sizeFor(text) {
  if (text.length <= 48) return 74;
  if (text.length <= 90) return 62;
  return 54;
}

const reels = JSON.parse(await readFile(reelsFile, "utf8")).filter((reel) => !only || reel.id === only);
await mkdir(outDir, { recursive: true });

for (const reel of reels) {
  const work = await mkdtemp(path.join(tmpdir(), `reel-${reel.id}-`));
  await copyFile(fontPath, path.join(work, "serif.ttf"));
  await copyFile(italicPath, path.join(work, "serifi.ttf"));
  await copyFile(path.join(mediaDir, reel[source] || reel.background), path.join(work, "bg.webp"));
  await copyFile(logoPath, path.join(work, "logo.png"));

  // Timeline: the hook, then the beats, then the payoff, filling 30 seconds minus the end card.
  const gap = 0.45;
  const endCard = 3.6;
  const hookLength = 4.2;
  const lines = [
    { text: reel.hook, weight: 0, length: hookLength, color: PARCHMENT, font: "serif.ttf" },
    ...reel.beats.map((text) => ({ text, weight: 1, color: PARCHMENT, font: "serif.ttf" })),
    { text: reel.payoff, weight: 1.35, color: GOLD, font: "serifi.ttf" }
  ];
  const flexible = lines.reduce((n, line) => n + line.weight, 0);
  const free = TOTAL - 0.4 - endCard - 0.4 - hookLength - gap * (lines.length - 1);
  let cursor = 0.4;

  lines.forEach((line, index) => {
    line.length = line.length ?? (free * line.weight) / flexible;
    line.start = cursor;
    line.end = cursor + line.length;
    cursor = line.end + gap;
    line.file = `line${index}.txt`;
  });

  const cardStart = TOTAL - endCard;
  const filters = [
    `[0:v]scale=-2:2000,crop=${W}:${H}:x='(iw-${W})*(0.15+0.7*t/${TOTAL})':y='(ih-${H})/2',vignette=PI/4,drawbox=x=0:y=0:w=iw:h=ih:color=black@${shade}:t=fill[bg]`
  ];
  let last = "bg";

  // Booklet label, faint, the whole way through.
  await writeFile(path.join(work, "label.txt"), reel.label);
  filters.push(
    `[${last}]drawtext=fontfile=serif.ttf:textfile=label.txt:fontcolor=${GOLD}:fontsize=34:x=(w-text_w)/2:y=150:shadowcolor=black@0.8:shadowx=2:shadowy=2:alpha='min(1,t/1.2)'[l0]`
  );
  last = "l0";

  for (const [index, line] of lines.entries()) {
    const size = sizeFor(line.text);
    await writeFile(path.join(work, line.file), wrap(line.text, Math.floor(900 / (size * 0.47))));
    const fade = `if(lt(t,${line.start + 0.7}),(t-${line.start})/0.7,if(gt(t,${line.end - 0.7}),(${line.end}-t)/0.7,1))`;
    filters.push(
      `[${last}]drawtext=fontfile=${line.font}:textfile=${line.file}:fontcolor=${line.color}:fontsize=${size}:line_spacing=18:text_align=center:` +
        `x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.7:shadowx=3:shadowy=3:` +
        `enable='between(t,${line.start},${line.end})':alpha='${fade}'[t${index}]`
    );
    last = `t${index}`;
  }

  // End card: logo, then what to do, then the address.
  await writeFile(path.join(work, "cta1.txt"), "READ THE FIRST CHAPTERS FREE");
  await writeFile(path.join(work, "cta2.txt"), reel.link || "thevalluru.org");
  await writeFile(path.join(work, "cta3.txt"), "link in bio");
  const cardFade = `if(lt(t,${cardStart + 0.8}),(t-${cardStart})/0.8,if(gt(t,${TOTAL - 0.6}),(${TOTAL}-t)/0.6,1))`;
  filters.push(
    `[${last}]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill:enable='gte(t,${cardStart})'[c0]`,
    `[1:v]scale=420:-1,format=rgba,fade=t=in:st=${cardStart}:d=0.8:alpha=1,fade=t=out:st=${TOTAL - 0.6}:d=0.6:alpha=1[lg]`,
    `[c0][lg]overlay=(W-w)/2:520:enable='gte(t,${cardStart})'[c1]`,
    `[c1]drawtext=fontfile=serif.ttf:textfile=cta1.txt:fontcolor=${GOLD}:fontsize=42:x=(w-text_w)/2:y=1040:enable='gte(t,${cardStart})':alpha='${cardFade}'[c2]`,
    `[c2]drawtext=fontfile=serif.ttf:textfile=cta2.txt:fontcolor=${PARCHMENT}:fontsize=56:x=(w-text_w)/2:y=1120:enable='gte(t,${cardStart})':alpha='${cardFade}'[c3]`,
    `[c3]drawtext=fontfile=serifi.ttf:textfile=cta3.txt:fontcolor=${PARCHMENT}@0.75:fontsize=38:x=(w-text_w)/2:y=1210:enable='gte(t,${cardStart})':alpha='${cardFade}',format=yuv420p[v]`,
    // A quiet drone: three low sines, slow tremolo, gentle fade in and out. Original, no licence.
    `[2:a][3:a][4:a]amix=inputs=3:weights='1 0.55 0.4':normalize=0,tremolo=f=0.11:d=0.3,lowpass=f=700,afade=t=in:d=2.5,afade=t=out:st=${TOTAL - 3}:d=3,volume=0.55[a]`
  );

  const output = path.resolve(outDir, `inward-mirror-${reel.id}.mp4`);
  const run = spawnSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-t", String(TOTAL), "-i", "bg.webp",
      "-loop", "1", "-framerate", "30", "-t", String(TOTAL), "-i", "logo.png",
      "-f", "lavfi", "-t", String(TOTAL), "-i", "sine=frequency=110",
      "-f", "lavfi", "-t", String(TOTAL), "-i", "sine=frequency=164.81",
      "-f", "lavfi", "-t", String(TOTAL), "-i", "sine=frequency=220",
      "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", String(TOTAL),
      output
    ],
    { cwd: work, encoding: "utf8" }
  );

  if (run.status !== 0) {
    console.error(`${reel.id}: ffmpeg failed\n${(run.stderr || "").slice(-600)}`);
    process.exitCode = 1;
    continue;
  }

  console.log(`${reel.id}: ${path.relative(process.cwd(), output)}`);
}
