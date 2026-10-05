/**
 * The brand's public profiles, published in the site's structured data so search engines can
 * tie them to this site. Plain profile addresses only: no share or tracking parameters.
 */
export const SOCIAL_PROFILES = ["https://www.instagram.com/theinwardfire/"];

/** Shown in link previews for any page that has no picture of its own. */
export const DEFAULT_OG_IMAGE = "https://www.thevalluru.org/og/default.jpg";

/** Search results show about 155 characters; anything longer is cut mid-sentence. */
const META_DESCRIPTION_MAX = 158;

/**
 * A description that fits a search snippet. Content descriptions run to 300+ characters
 * because they double as the page's intro, so they are cut for the meta tag: at the last
 * sentence end that fits, else the last word, never mid-word.
 */
export function seoDescription(text: string | undefined, max = META_DESCRIPTION_MAX) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();

  if (clean.length <= max) {
    return clean;
  }

  const head = clean.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));

  if (sentenceEnd >= max * 0.55) {
    return head.slice(0, sentenceEnd + 1);
  }

  const wordEnd = head.lastIndexOf(" ");
  return `${head.slice(0, wordEnd > 0 ? wordEnd : max).replace(/[,;:\-–—\s]+$/, "")}…`;
}

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.thevalluru.org").replace(/\/$/, "");

/** A short stable tag for a string, used to give a changed cover a new preview address. */
function shortHash(value: string) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(36);
}

/**
 * The share and structured-data picture for a booklet or movement: a 1200x630 JPEG of about
 * 100 KB made by /og/[kind]/[slug], not the 2-3 MB cover PNG it is cut from. WhatsApp and
 * others drop previews for heavy images. The tag changes whenever the cover does, so a
 * replaced cover is not stuck behind a year of CDN caching.
 */
export function ogImageUrl(kind: "booklet" | "movement", slug: string, source?: string | null) {
  if (!source) {
    return DEFAULT_OG_IMAGE;
  }

  return `${SITE_URL}/og/${kind}/${encodeURIComponent(slug)}?v=${shortHash(source)}`;
}
