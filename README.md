# Map Studio

A standalone web app for creating styled Google Maps PNGs. Search for a location or paste a Google Maps URL, choose a bundled map style, adjust which layers are visible, add labels and KML overlays, then export a PNG with an optional globe locator and scale bar.

## Local development

Requirements: Node.js 22 or later and npm.

1. Install dependencies with `npm install`.
2. Create `.env` from `.env.example` and set `GOOGLE_MAPS_API`. This is the server-side key used for Maps Static API and Geocoding API requests.
3. Optionally set `GOOGLE_MAPS_API_CLIENT_KEY` for the interactive map. If it is not set, the function falls back to `GOOGLE_MAPS_API`.
4. In Google Cloud, enable the APIs used by the app:
   - Maps Static API and Geocoding API for the server key.
   - Maps JavaScript API and Places API for the browser key.
     Restrict each key to the APIs and origins it needs, and configure quotas and billing alerts.
5. Run `npm run dev` and open the local URL printed by Netlify CLI.

The function exposes the browser key to the client by design so the interactive map can load. Never use an unrestricted key.

## Deploy to Netlify

Connect this repository to Netlify. The checked-in `netlify.toml` sets the build command and publish directory. Add `GOOGLE_MAPS_API` (and optionally `GOOGLE_MAPS_API_CLIENT_KEY`) in the site's environment variables, then deploy.

## Usage

- **Location** — search for a place, paste a Google Maps URL, or pan and zoom the interactive map. The refresh button next to the search field returns the map to its initial view and clears all labels.
- **Map style** — choose one of the ten bundled styles and expand "Adjust visible layers" to toggle individual features. Land - natural, Land - man made, Water, and Borders - countries are selected by default when a style provides them.
- **Labels** — add labels through the search fields, or right-click anywhere on the interactive map. Labels appear in the Labels list where they can be renamed, restyled (direction, pointer, background, text style/color), hidden, or removed.
- **KML layers** — import KML files (up to 2 MB) containing points, lines, and polygons; each imported layer can be toggled or removed.
- **Settings** — export the current map location, style, labels, KML layers, and options to JSON, or import a previously saved settings file (up to 2 MB).
- **PNG export** — generate a 1280x720, 1280x1280, or 720x1280 PNG, download it on its own, or download the map, locator, and scale together.

The interactive preview is sized to show exactly the area the exported PNG will cover at the displayed zoom level. Country names are drawn in a readable font in the preview; the exported PNG contains no automatic country names, so localized labels can be added manually.

## Limits

- Up to 100 right-click labels.
- Imported settings are capped at 100 labels and 20 KML layers.
- KML renders are capped at 100 features and 500 coordinates.
- Static map requests require an integer zoom between 3 and 16 and valid coordinates, and reject unsupported styles or oversized request bodies.
