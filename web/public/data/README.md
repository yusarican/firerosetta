# Country highlights

`country-boundaries.geojson` contains Argentina, Greece, Italy, Portugal, Spain
and Türkiye from Natural Earth's 1:50m Admin 0 Countries dataset. These polygons
draw the visual country highlight. The backend also reads this file to drop recent
Early Warning detections that fall outside the selected country (the live feed is
requested by bounding box), with about 5 km of tolerance for the simplified outline.
Small islands missing at this scale are therefore not covered by the Observed layer.

- Source: https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries-2/
- Download: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
- Retrieved: 2026-11-14
- Source SHA-256: `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb`
- License: public domain, https://www.naturalearthdata.com/about/terms-of-use/

Only the country identifier, display name and geometry are retained. Coordinates
are rounded to five decimal places. Coastlines, islands and polygon holes are
preserved. The app's historical and recent-data coverage remains as documented
in the interface.
