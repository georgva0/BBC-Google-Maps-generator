# Map Studio

A standalone web app for creating styled Google Maps PNGs. Paste a Google Maps URL or enter a location, choose one of the bundled styles, add labels or KML layers, and export a map with the locator and scale.

## Local development

Requirements: Node.js 22 or later and npm.

1. Install dependencies with `npm install`.
2. Create `.env` from `.env.example` and set `GOOGLE_MAPS_API`.
3. In Google Cloud, enable Maps Static API and Geocoding API for the key. Restrict the key to those APIs and configure quotas and billing alerts.
4. Run `npm run dev` and open the local URL printed by Netlify CLI.

The API key is only used by the server-side Netlify Function. Never commit `.env`.

## Deploy to Netlify

Connect this repository to Netlify. The checked-in `netlify.toml` sets the build command and publish directory. Add `GOOGLE_MAPS_API` in the site's environment variables, then deploy.

## Features and limits

- Ten bundled map styles with visibility controls.
- PNG exports at 1280x720, 1280x1280, and 720x1280.
- Address or coordinate-based labels, with editable presentation styles.
- Local KML points, lines, and polygons. Imports are limited to 100 features and 500 coordinates per render.
- Globe locator and metric/imperial scale, each available separately or composited into the map PNG.
- JSON settings import/export for map location, style, labels, KML layers, and export options.
