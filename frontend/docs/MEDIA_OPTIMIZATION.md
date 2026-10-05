# Compressing the cover and background images

The covers and backgrounds in storage are 1-3 MB PNGs (about 106 MB for 54 files). The site
already resizes them per visitor, but the originals cost storage and bandwidth. A dry run
shrank them to about 7 MB (93% smaller) as WebP with no visible loss.

Nothing here deletes an original, so every step can be undone.

## 1. See the savings (no uploads, no changes)

```bash
curl -s https://valluru-books-04qq.onrender.com/api/content -o live-content.json
node backend/scripts/optimize-media.mjs --content live-content.json --out media-optimized
```

Downloads each image, writes a smaller WebP into `media-optimized/`, and prints a table.
Covers are cut to 1600px wide, backgrounds to 1920px, and a file is only kept if it saves at
least 30%.

## 2. Upload the smaller files next to the originals

Needs the service key of the Supabase project the images live in (the one in Render's
`SUPABASE_URL`). Keep it in your shell only; never commit it.

```powershell
$env:SUPABASE_URL = "https://<project>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service key>"
node backend/scripts/optimize-media.mjs --content live-content.json --out media-optimized --upload
```

Each file goes in the same bucket and folder as its original, with a `.webp` extension.
`media-optimized/report.json` records the new address of each. The site still uses the
originals at this point.

## 3. Point the content at the new files

```powershell
$env:MONGODB_URI = "<Render's MONGODB_URI>"
node backend/scripts/export-site-content.mjs --db valluru_books --out live.stored.json
node backend/scripts/apply-media-map.mjs --content live.stored.json --report media-optimized/report.json --out live-optimized.stored.json
```

That is a dry run: it checks each new address answers with an image, swaps them in a copy, and
touches no database. When the numbers look right, write it:

```powershell
node backend/scripts/apply-media-map.mjs --content live.stored.json --report media-optimized/report.json --out live-optimized.stored.json --db valluru_books --allow-production valluru_books
```

Keep `live.stored.json`: restoring it puts every address back.

## Notes

- Images on the old Supabase project (`flhdj...`) cannot be downloaded and are skipped.
- A file in storage whose name starts with `._` (a stray macOS file) returns an error and is
  skipped; re-upload that image under a normal name.
- Link-preview images are separate: `/og/<kind>/<slug>` makes a 1200x630 JPEG on demand.
