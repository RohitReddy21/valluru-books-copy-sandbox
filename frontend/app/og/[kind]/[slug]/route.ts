import { NextResponse } from "next/server";
import sharp from "sharp";
import { getSiteContent } from "@/lib/content-store";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";
import { bookletMatchesSlug, isPublished, movementSlug } from "@/lib/site-content";

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 630;
const FETCH_TIMEOUT_MS = 15000;

/** The same hosts next.config allows for images: a slug can only ever lead to one of these. */
const ALLOWED_HOST = /(^|\.)supabase\.co$|^(www\.)?thevalluru\.org$/;

type Params = { kind: string; slug: string };

/** The cover this booklet or movement is already published with, looked up by slug. */
async function sourceFor(kind: string, slug: string) {
  const content = await getSiteContent();

  if (kind === "booklet") {
    const booklets = [...content.series.booklets, ...content.inwardMirror.booklets];

    return booklets.find((item) => bookletMatchesSlug(item, slug) && isPublished(item.status))
      ?.coverImage;
  }

  if (kind === "movement") {
    return content.home.seriesOverview.movements.find(
      (item, index) => movementSlug(item, index) === slug && isPublished(item.status)
    )?.coverImage;
  }

  return undefined;
}

function fallback() {
  // Short-lived: a missing cover should not be remembered for a year.
  const response = NextResponse.redirect(DEFAULT_OG_IMAGE, 302);
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
}

/**
 * A 1200x630 JPEG of a booklet's or movement's cover, small enough for link previews.
 *
 * The source covers are 2-3 MB PNGs. Previews on WhatsApp and some other apps are dropped
 * above roughly 300 KB, so a shared booklet link showed no picture at all.
 */
export async function GET(_request: Request, { params }: { params: Promise<Params> }) {
  const { kind, slug } = await params;
  const source = await sourceFor(kind, slug);

  if (!source) {
    return fallback();
  }

  try {
    if (!ALLOWED_HOST.test(new URL(source).hostname)) {
      return fallback();
    }

    // Never cached by Next's data cache, which refuses anything over 2 MB: the finished
    // JPEG is what the CDN keeps.
    const response = await fetch(source, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      return fallback();
    }

    const image = await sharp(Buffer.from(await response.arrayBuffer()))
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 78, mozjpeg: true, progressive: true })
      .toBuffer();

    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/jpeg",
        // The address carries a tag that changes with the cover, so a long cache is safe.
        "Cache-Control": "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800"
      }
    });
  } catch {
    return fallback();
  }
}
