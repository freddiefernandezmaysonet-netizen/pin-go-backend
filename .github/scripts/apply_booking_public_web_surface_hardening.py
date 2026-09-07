from pathlib import Path

path = Path('src/booking-search.staging.server.ts')
text = path.read_text()
anchor = 'app.get("/health", (_q, r) => r.json({ ok: true, service: "pin-go-booking-search-staging", revision: STAGING_REVISION }));\n'
insert = '''app.get("/robots.txt", (_q, res) => {\n  res.type("text/plain").send("User-agent: *\\nAllow: /\\nDisallow: /api/\\nSitemap: https://book.pin-ngo.com/sitemap.xml\\n");\n});\napp.get("/sitemap.xml", (_q, res) => {\n  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://book.pin-ngo.com/</loc></url></urlset>');\n});\napp.get(["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"], (_q, res) => {\n  res.redirect(302, "https://pin-ngo.com/favicon.ico");\n});\n\n'''
if text.count(anchor) != 1:
    raise SystemExit(f'Expected exactly one health anchor, found {text.count(anchor)}')
path.write_text(text.replace(anchor, insert + anchor, 1))
