const apiUrl = "/.netlify/functions/render-map";
const dimensions = {
  landscape: { ratio: "16:9", width: 1280, height: 720 },
  square: { ratio: "1:1", width: 1280, height: 1280 },
  portrait: { ratio: "9:16", width: 720, height: 1280 },
};

const form = document.getElementById("map-form");
const urlInput = document.getElementById("map-url");
const styleSelect = document.getElementById("map-style");
const statusText = document.getElementById("status");
const previewFrame = document.getElementById("preview-frame");
const previewImage = document.getElementById("map-image");
const emptyPreview = document.getElementById("empty-preview");
const outputSize = document.getElementById("output-size");
const previewDimensions = document.getElementById("preview-dimensions");
const renderButton = document.getElementById("render-map");
const downloadButton = document.getElementById("download-map");
const locationSearchInput = document.getElementById("location-search");
const interactiveMapElement = document.getElementById("interactive-map");
const modeInteractiveButton = document.getElementById("mode-interactive");
const modeExportButton = document.getElementById("mode-export");
const MAX_PNG_BYTES = 3.5 * 1024 * 1024; // 3.5 MB limit
const DEFAULT_MAP_LOCATION = { lat: 52.147594, lng: 1.208101, zoom: 6 };
const countryLabelLayer = document.getElementById("country-labels");
const COUNTRY_LABEL_MAX_ZOOM = 7;

// Layers that are selected by default for every map style, when the style offers them.
const DEFAULT_VISIBLE_FEATURES = new Set([
  "landscape.natural",
  "landscape.man_made",
  "water",
  "administrative",
  "administrative.country",
]);

let currentImageUrl = "";
let currentImageDimensions = { width: 1280, height: 720 };
let currentMapLocation = null;
let initialMapLocation = null;
let presetStyles = {};
let featureNames = {};
let layerOverrides = {};
let toggleableFeatureTypes = [];
let labels = [];
let kmlLayers = [];
let googleMap = null;
let placesAutocomplete = null;
let interactiveMarkers = [];
let interactiveKmlOverlays = [];
let googleMapsApiKey = "";
let isUpdatingMapFromCode = false;
let countryLabelsCache = null;
let countryLabelMeasureContext = null;

function setPreviewMode(mode) {
  if (mode === "export" && currentImageUrl) {
    modeExportButton.disabled = false;
    modeExportButton.classList.add("active");
    modeExportButton.setAttribute("aria-selected", "true");
    modeInteractiveButton.classList.remove("active");
    modeInteractiveButton.setAttribute("aria-selected", "false");
    previewImage.hidden = false;
    if (interactiveMapElement) interactiveMapElement.hidden = true;
    emptyPreview.hidden = true;
  } else {
    modeInteractiveButton.classList.add("active");
    modeInteractiveButton.setAttribute("aria-selected", "true");
    modeExportButton.classList.remove("active");
    modeExportButton.setAttribute("aria-selected", "false");
    previewImage.hidden = true;
    if (interactiveMapElement) {
      interactiveMapElement.hidden = false;
      if (googleMap) {
        emptyPreview.hidden = true;
        const center = googleMap.getCenter();
        google.maps.event.trigger(googleMap, "resize");
        if (center) googleMap.setCenter(center);
      }
    }
  }
}

function setStatus(message, state = "") {
  statusText.textContent = message;
  statusText.dataset.state = state;
}

function showPreviewError(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-preview-error";
  paragraph.textContent = message;
  emptyPreview.replaceChildren(paragraph);
  emptyPreview.hidden = false;
}

function selectedRatio() {
  return form.elements.ratio.value;
}

// The Maps Static API renders each export from a fixed logical width (640 for
// landscape/square, 360 for portrait). The on-screen map is larger, so its zoom
// is offset to show the exact same geographic area as the export at the same
// zoom level.
const EXPORT_LOGICAL_WIDTHS = { landscape: 640, square: 640, portrait: 360 };

function mapZoomOffset() {
  const exportWidth = EXPORT_LOGICAL_WIDTHS[selectedRatio()] || 640;
  const previewWidth =
    countryLabelLayer?.clientWidth || previewFrame.clientWidth || exportWidth;
  if (!previewWidth || !exportWidth) return 0;
  return Math.log2(previewWidth / exportWidth);
}

function toMapZoom(exportZoom) {
  return exportZoom + mapZoomOffset();
}

function toExportZoom(mapZoom) {
  const zoom = mapZoom - mapZoomOffset();
  return Math.max(3, Math.min(16, Math.round(zoom)));
}

function updateDimensions() {
  const ratioName = selectedRatio();
  const size = dimensions[ratioName];
  currentImageDimensions = { width: size.width, height: size.height };
  previewFrame.className = `preview-frame ${ratioName}`;
  outputSize.textContent = `${size.width} × ${size.height} px`;
  previewDimensions.textContent = `${size.ratio} · ${size.width} × ${size.height}`;

  if (googleMap && window.google?.maps?.event) {
    const center = googleMap.getCenter();
    google.maps.event.trigger(googleMap, "resize");
    if (center) googleMap.setCenter(center);
    if (currentMapLocation) {
      googleMap.setZoom(toMapZoom(currentMapLocation.zoom));
    }
  }
  requestAnimationFrame(renderCountryLabels);
}

function invalidateOutput() {
  if (!currentImageUrl) {
    return;
  }
  URL.revokeObjectURL(currentImageUrl);
  currentImageUrl = "";
  previewImage.removeAttribute("src");
  previewImage.hidden = true;
  modeExportButton.disabled = true;
  setPreviewMode("interactive");
  downloadButton.disabled = true;
  document.getElementById("download-all").disabled = true;
  setStatus("Settings changed. Generate a fresh map to download.");
}

function niceDistance(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded =
    normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return rounded * magnitude;
}

function updateReferenceOverlays(location) {
  currentMapLocation = location;
  if (window.renderLocator) {
    window.renderLocator(location.lat, location.lng);
  }

  const latitudeRadians = (location.lat * Math.PI) / 180;
  const metersPerPixel =
    (Math.max(0.000001, Math.cos(latitudeRadians)) * 2 * Math.PI * 6378137) /
    (256 * 2 ** location.zoom);
  const targetMeters = metersPerPixel * 130;
  const metricUnitMeters = targetMeters >= 1000 ? 1000 : 1;
  const metricUnit = metricUnitMeters === 1000 ? "km" : "m";
  const metricValue = niceDistance(targetMeters / metricUnitMeters);
  const distanceMeters = metricValue * metricUnitMeters;
  const useMiles = distanceMeters >= 1609.344;
  const imperialUnitMeters = useMiles ? 1609.344 : 0.3048;
  const imperialUnit = useMiles ? "mi" : "ft";
  const imperialValue = Number(
    (distanceMeters / imperialUnitMeters).toFixed(2),
  );
  const barWidth = Math.min(130, distanceMeters / metersPerPixel);

  document.getElementById("scale-metric-label").textContent =
    `${metricValue} ${metricUnit}`;
  document.getElementById("scale-metric-bar").setAttribute("width", barWidth);
  document.getElementById("scale-imperial-label").textContent =
    `${imperialValue} ${imperialUnit}`;
  document.getElementById("scale-imperial-bar").setAttribute("width", barWidth);
}

function parseMapUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a complete Google Maps URL.");
  }

  const host = url.hostname.toLowerCase();
  const isGoogleMapsHost =
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.co.uk" ||
    host.endsWith(".google.co.uk") ||
    host === "maps.app.goo.gl";
  if (!isGoogleMapsHost) {
    throw new Error("Enter a Google Maps URL.");
  }

  let lat;
  let lng;
  let zoom;

  const atMatch = url.href.match(
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/i,
  );
  if (atMatch) {
    lat = Number(atMatch[1]);
    lng = Number(atMatch[2]);
    zoom = Number(atMatch[3]);
  } else {
    const latMatch = url.href.match(/!3d(-?\d+(?:\.\d+)?)/);
    const lngMatch = url.href.match(/!4d(-?\d+(?:\.\d+)?)/);
    const queryCenter = (
      url.searchParams.get("ll") ||
      url.searchParams.get("center") ||
      ""
    ).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (latMatch && lngMatch) {
      lat = Number(latMatch[1]);
      lng = Number(lngMatch[1]);
    } else if (queryCenter) {
      lat = Number(queryCenter[1]);
      lng = Number(queryCenter[2]);
    }
    zoom = Number(
      url.searchParams.get("z") || url.searchParams.get("zoom") || 12,
    );
  }

  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new Error(
      "This URL does not include coordinates. Paste a Google Maps link with a visible map center.",
    );
  }
  if (!Number.isFinite(zoom)) {
    zoom = 12;
  }

  return { lat, lng, zoom: Math.max(3, Math.min(16, Math.round(zoom))) };
}

function loadGoogleMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve(window.google.maps);
      return;
    }
    if (!apiKey) {
      reject(new Error("No Google Maps API key provided."));
      return;
    }
    const callbackName =
      "__initGoogleMapsApi_" + Math.random().toString(36).substring(2, 9);
    window[callbackName] = () => {
      delete window[callbackName];
      resolve(window.google.maps);
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      delete window[callbackName];
      reject(new Error("Could not load Google Maps JavaScript API."));
    };
    document.head.appendChild(script);
  });
}

function isFeatureVisibleByDefault(featureType) {
  return DEFAULT_VISIBLE_FEATURES.has(featureType);
}

function effectiveFeatureVisibility(featureType) {
  return Object.hasOwn(layerOverrides, featureType)
    ? layerOverrides[featureType]
    : isFeatureVisibleByDefault(featureType);
}

function computeEffectiveMapStyles() {
  const preset = presetStyles[styleSelect.value];
  const baseStyles = (preset?.styles || []).map((rule) => {
    const copy = { ...rule };
    if (Array.isArray(rule.stylers)) {
      copy.stylers = rule.stylers.map((styler) => ({ ...styler }));
    }
    delete copy.noToggle;
    return copy;
  });

  const overrideRules = toggleableFeatureTypes.map((featureType) => ({
    featureType,
    stylers: [
      { visibility: effectiveFeatureVisibility(featureType) ? "on" : "off" },
    ],
  }));

  const basemapLabelRules = [
    {
      featureType: "administrative.country",
      elementType: "labels.text",
      stylers: [{ visibility: "off" }],
    },
    {
      featureType: "landscape.natural",
      elementType: "labels.text",
      stylers: [{ visibility: "off" }],
    },
  ];

  // Every preset flattens all basemap label text to a mid grey (#808080, or
  // #dddddd for the hybrid style). Over the pale basemaps that is only about
  // 3.3:1 contrast, so town and city names read as a soft grey blur next to
  // the near-black country labels drawn on top. Darker text with an opaque
  // white halo fixes the interactive preview without touching the exported
  // PNG, which still renders with the preset colours unchanged.
  const legibleLabelRules = [
    {
      featureType: "all",
      elementType: "labels.text.fill",
      stylers: [{ color: "#3a423d" }],
    },
    {
      featureType: "all",
      elementType: "labels.text.stroke",
      stylers: [{ color: "#ffffff" }],
    },
  ];

  return [
    ...baseStyles,
    ...overrideRules,
    ...basemapLabelRules,
    ...legibleLabelRules,
  ];
}

function applyInteractiveMapStyles() {
  if (googleMap) {
    googleMap.setOptions({ styles: computeEffectiveMapStyles() });
  }
}

function projectMercator(lat, lng, zoom) {
  const worldSize = 256 * 2 ** zoom;
  const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = (limitedLat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * worldSize,
    y:
      (0.5 -
        Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) /
          (4 * Math.PI)) *
      worldSize,
  };
}

function getCountryLabels() {
  if (countryLabelsCache) return countryLabelsCache;
  const topology = window.mapWorldTopology;
  const names = window.WORLD_COUNTRY_NAMES || {};
  if (!topology || !window.d3 || !window.topojson) {
    countryLabelsCache = [];
    return countryLabelsCache;
  }
  const collection = topojson.feature(topology, topology.objects.countries);
  countryLabelsCache = collection.features
    .map((feature) => {
      const name = names[String(feature.id)];
      if (!name) return null;
      const [lng, lat] = d3.geoCentroid(feature);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { name, lat, lng, area: d3.geoArea(feature) };
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area);
  return countryLabelsCache;
}

function countryLabelFontSize(zoom) {
  return zoom <= 3 ? 11 : zoom <= 5 ? 13 : 14;
}

function measureCountryLabel(text, fontSize, fontFamily) {
  if (!countryLabelMeasureContext) {
    countryLabelMeasureContext = document
      .createElement("canvas")
      .getContext("2d");
  }
  countryLabelMeasureContext.font = `700 ${fontSize}px ${fontFamily}`;
  return countryLabelMeasureContext.measureText(text).width;
}

function planCountryLabels(
  location,
  width,
  height,
  projectPoint,
  fontSize,
  measureText,
) {
  if (!effectiveFeatureVisibility("administrative.country")) return [];
  if (location.zoom > COUNTRY_LABEL_MAX_ZOOM) return [];
  const padding = 4;
  const margin = 60;
  const placed = [];
  const result = [];
  for (const country of getCountryLabels()) {
    const point = projectPoint(country.lat, country.lng);
    if (
      point.x < -margin ||
      point.x > width + margin ||
      point.y < -margin ||
      point.y > height + margin
    ) {
      continue;
    }
    const textWidth = measureText(country.name);
    if (textWidth <= 0) continue;
    const rect = {
      left: point.x - textWidth / 2 - padding,
      right: point.x + textWidth / 2 + padding,
      top: point.y - fontSize / 2 - padding,
      bottom: point.y + fontSize / 2 + padding,
    };
    const overlaps = placed.some(
      (other) =>
        rect.left < other.right &&
        rect.right > other.left &&
        rect.top < other.bottom &&
        rect.bottom > other.top,
    );
    if (overlaps) continue;
    placed.push(rect);
    result.push({ name: country.name, x: point.x, y: point.y, fontSize });
  }
  return result;
}

function renderCountryLabels() {
  if (!countryLabelLayer) return;
  if (!currentMapLocation || !googleMap) {
    countryLabelLayer.replaceChildren();
    return;
  }
  const width = countryLabelLayer.clientWidth;
  const height = countryLabelLayer.clientHeight;
  if (!width || !height) {
    countryLabelLayer.replaceChildren();
    return;
  }
  const displayZoom = googleMap.getZoom() || currentMapLocation.zoom;
  const displayLocation = { ...currentMapLocation, zoom: displayZoom };
  const fontSize = countryLabelFontSize(displayZoom);
  const center = projectMercator(
    displayLocation.lat,
    displayLocation.lng,
    displayZoom,
  );
  const worldSize = 256 * 2 ** displayZoom;
  const projectPoint = (lat, lng) => {
    const point = projectMercator(lat, lng, displayZoom);
    let dx = point.x - center.x;
    if (dx > worldSize / 2) dx -= worldSize;
    if (dx < -worldSize / 2) dx += worldSize;
    return {
      x: width / 2 + dx,
      y: height / 2 + point.y - center.y,
    };
  };
  const entries = planCountryLabels(
    displayLocation,
    width,
    height,
    projectPoint,
    fontSize,
    (text) =>
      measureCountryLabel(text, fontSize, '"Aptos", "Segoe UI", sans-serif'),
  );
  countryLabelLayer.replaceChildren(
    ...entries.map((entry) => {
      const span = document.createElement("span");
      span.className = "country-label";
      span.textContent = entry.name;
      span.style.left = `${entry.x}px`;
      span.style.top = `${entry.y}px`;
      span.style.fontSize = `${entry.fontSize}px`;
      return span;
    }),
  );
}

function syncInteractiveMarkers() {
  for (const marker of interactiveMarkers) {
    marker.setMap(null);
  }
  interactiveMarkers = [];

  if (!googleMap || !window.google || !google.maps) return;

  labels.forEach((label) => {
    if (label.visible === false) return;
    const marker = new google.maps.Marker({
      position: { lat: label.lat, lng: label.lng },
      map: googleMap,
      title: label.title,
    });
    interactiveMarkers.push(marker);
  });
}

function syncInteractiveKmlOverlays() {
  for (const overlay of interactiveKmlOverlays) {
    overlay.setMap(null);
  }
  interactiveKmlOverlays = [];

  if (!googleMap || !window.google || !google.maps) return;

  for (const layer of kmlLayers) {
    if (!layer.visible) continue;
    for (const overlay of layer.overlays || []) {
      if (overlay.type === "line" && Array.isArray(overlay.points)) {
        const polyline = new google.maps.Polyline({
          path: overlay.points,
          geodesic: true,
          strokeColor: overlay.color || "#174b39",
          strokeOpacity: 1.0,
          strokeWeight: 3,
          map: googleMap,
        });
        interactiveKmlOverlays.push(polyline);
      } else if (overlay.type === "polygon" && Array.isArray(overlay.points)) {
        const polygon = new google.maps.Polygon({
          paths: overlay.points,
          strokeColor: overlay.color || "#174b39",
          strokeOpacity: 0.8,
          strokeWeight: 2,
          fillColor: overlay.color || "#174b39",
          fillOpacity: 0.25,
          map: googleMap,
        });
        interactiveKmlOverlays.push(polygon);
      } else if (overlay.type === "point") {
        const marker = new google.maps.Marker({
          position: { lat: overlay.lat, lng: overlay.lng },
          map: googleMap,
        });
        interactiveKmlOverlays.push(marker);
      }
    }
  }
}

let isInitializingMap = true;

function resetToInitialState() {
  const initial = initialMapLocation || { ...DEFAULT_MAP_LOCATION };
  const { lat, lng, zoom } = initial;

  labels = [];
  renderLabels();

  if (locationSearchInput) {
    locationSearchInput.value = "";
  }

  currentMapLocation = { lat, lng, zoom };
  urlInput.value = `https://www.google.com/maps/@${lat},${lng},${zoom}z`;
  updateReferenceOverlays(currentMapLocation);

  if (googleMap) {
    isUpdatingMapFromCode = true;
    googleMap.setCenter({ lat, lng });
    googleMap.setZoom(toMapZoom(zoom));
    isUpdatingMapFromCode = false;
  }
  renderCountryLabels();

  invalidateOutput();
  setStatus("Map reset to its initial view. All labels removed.");
}

async function initGoogleMaps(apiKey) {
  if (!apiKey) {
    showPreviewError(
      "Interactive map unavailable: no browser map key was provided. Set GOOGLE_MAPS_API_CLIENT_KEY in your hosting environment variables and redeploy.",
    );
    return;
  }
  googleMapsApiKey = apiKey;

  try {
    await loadGoogleMapsScript(apiKey);

    let initialLoc = { ...DEFAULT_MAP_LOCATION };
    if (urlInput.value.trim()) {
      try {
        initialLoc = parseMapUrl(urlInput.value);
      } catch {
        // Ignore parse errors on initial load
      }
    }
    currentMapLocation = initialLoc;
    initialMapLocation = { ...initialLoc };

    googleMap = new google.maps.Map(interactiveMapElement, {
      center: { lat: initialLoc.lat, lng: initialLoc.lng },
      zoom: toMapZoom(initialLoc.zoom),
      isFractionalZoomEnabled: true,
      mapTypeId: "roadmap",
      disableDefaultUI: false,
      zoomControl: true,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      styles: computeEffectiveMapStyles(),
    });

    googleMap.addListener("idle", () => {
      if (isUpdatingMapFromCode) return;
      const center = googleMap.getCenter();
      if (!center) return;
      const lat = Number(center.lat().toFixed(6));
      const lng = Number(center.lng().toFixed(6));
      const displayZoom = googleMap.getZoom() || 12;
      const zoom = toExportZoom(displayZoom);
      currentMapLocation = { lat, lng, zoom };
      urlInput.value = `https://www.google.com/maps/@${lat},${lng},${zoom}z`;
      updateReferenceOverlays(currentMapLocation);
      renderCountryLabels();
      if (!isInitializingMap) {
        invalidateOutput();
      }
      if (Math.abs(displayZoom - toMapZoom(zoom)) > 0.02) {
        isUpdatingMapFromCode = true;
        googleMap.setZoom(toMapZoom(zoom));
        isUpdatingMapFromCode = false;
      }
    });

    googleMap.addListener("rightclick", (event) => {
      if (!event.latLng) return;
      if (labels.length >= 100) {
        setStatus("You can add up to 100 labels.", "error");
        return;
      }
      const lat = Number(event.latLng.lat().toFixed(5));
      const lng = Number(event.latLng.lng().toFixed(5));
      const label = {
        title: `${lat}, ${lng}`,
        lat,
        lng,
        visible: true,
        direction: "left",
        pointerStyle: "whiteBlackPointer",
        backgroundColor: "#ffffff",
        textStyle: "regular",
        textColor: "#222222",
      };
      labels.push(label);
      renderLabels();
      invalidateOutput();
      setStatus(`Added label at ${lat}, ${lng}`);
    });

    if (locationSearchInput) {
      locationSearchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      });

      placesAutocomplete = new google.maps.places.Autocomplete(
        locationSearchInput,
        {
          fields: ["geometry", "name", "formatted_address"],
        },
      );

      placesAutocomplete.addListener("place_changed", () => {
        const place = placesAutocomplete.getPlace();
        if (!place || !place.geometry || !place.geometry.location) {
          return;
        }
        isUpdatingMapFromCode = true;
        if (place.geometry.viewport) {
          googleMap.fitBounds(place.geometry.viewport);
        } else {
          googleMap.setCenter(place.geometry.location);
          googleMap.setZoom(toMapZoom(13));
        }
        const center = googleMap.getCenter();
        const lat = Number(center.lat().toFixed(6));
        const lng = Number(center.lng().toFixed(6));
        const zoom = toExportZoom(googleMap.getZoom() || 12);
        currentMapLocation = { lat, lng, zoom };
        urlInput.value = `https://www.google.com/maps/@${lat},${lng},${zoom}z`;
        updateReferenceOverlays(currentMapLocation);
        renderCountryLabels();
        invalidateOutput();
        setStatus(
          `Location set: ${place.name || place.formatted_address || `${lat}, ${lng}`}`,
        );
        isUpdatingMapFromCode = false;
      });
    }

    updateReferenceOverlays(currentMapLocation);
    emptyPreview.hidden = true;
    syncInteractiveMarkers();
    syncInteractiveKmlOverlays();
    renderCountryLabels();
    setPreviewMode("interactive");
    setTimeout(() => {
      isInitializingMap = false;
    }, 600);
  } catch (err) {
    console.error("Failed to initialize Google Maps:", err);
    showPreviewError(`Failed to load interactive map: ${err.message}`);
  }
}

async function loadStyles() {
  const [response, presetsResponse, namesResponse] = await Promise.all([
    fetch(apiUrl, { headers: { Accept: "application/json" } }),
    fetch("config/map-styles.json"),
    fetch("config/feature-names.json"),
  ]);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.styles)) {
    throw new Error(data.error || "Could not load map styles.");
  }
  if (!presetsResponse.ok || !namesResponse.ok) {
    throw new Error("Could not load map style settings.");
  }
  presetStyles = await presetsResponse.json();
  featureNames = (await namesResponse.json()).featureTypes;

  styleSelect.replaceChildren(
    ...data.styles.map((style) => {
      const option = document.createElement("option");
      option.value = style.id;
      option.textContent = style.title;
      return option;
    }),
  );
  styleSelect.value = "streetLevel";
  renderLayerControls();

  if (data.apiKey) {
    initGoogleMaps(data.apiKey);
  } else {
    // The server only ever exposes the browser-restricted key. If this is
    // empty, GOOGLE_MAPS_API_CLIENT_KEY is not set in the hosting
    // environment (a redeploy is required after adding it).
    showPreviewError(
      "Interactive map unavailable: the server did not return a browser map key. Set GOOGLE_MAPS_API_CLIENT_KEY in your hosting environment variables and redeploy.",
    );
    setStatus(
      "Styled map export still works, but the interactive map is unavailable.",
    );
  }
}

function renderLayerControls() {
  const container = document.getElementById("advanced-layers");
  const preset = presetStyles[styleSelect.value];
  const uniqueFeatures = new Set();
  for (const rule of preset?.styles || []) {
    if (!rule.featureType || rule.noToggle === true) {
      continue;
    }
    uniqueFeatures.add(rule.featureType);
  }
  toggleableFeatureTypes = [...uniqueFeatures];

  container.replaceChildren();
  for (const featureType of toggleableFeatureTypes) {
    const label = document.createElement("label");
    label.className = "layer-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = effectiveFeatureVisibility(featureType);
    checkbox.addEventListener("change", () => {
      layerOverrides[featureType] = checkbox.checked;
      applyInteractiveMapStyles();
      renderCountryLabels();
      invalidateOutput();
    });
    const text = document.createElement("span");
    text.textContent = featureNames[featureType] || featureType;
    label.append(checkbox, text);
    container.append(label);
  }
}

async function generateMap(event) {
  event.preventDefault();
  renderButton.disabled = true;
  downloadButton.disabled = true;
  document.getElementById("download-all").disabled = true;
  setStatus("Generating the map…");

  try {
    if (googleMap) {
      const center = googleMap.getCenter();
      if (center) {
        const lat = Number(center.lat().toFixed(6));
        const lng = Number(center.lng().toFixed(6));
        const zoom = toExportZoom(googleMap.getZoom() || 12);
        currentMapLocation = { lat, lng, zoom };
        urlInput.value = `https://www.google.com/maps/@${lat},${lng},${zoom}z`;
      }
    } else if (!urlInput.value.trim() && currentMapLocation) {
      urlInput.value = `https://www.google.com/maps/@${currentMapLocation.lat},${currentMapLocation.lng},${currentMapLocation.zoom}z`;
    }
    const location = parseMapUrl(urlInput.value);
    updateReferenceOverlays(location);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "image/png, application/json",
      },
      body: JSON.stringify({
        ...location,
        style: styleSelect.value,
        ratio: selectedRatio(),
        visibilityOverrides: toggleableFeatureTypes.map((featureType) => ({
          featureType,
          visible: effectiveFeatureVisibility(featureType),
        })),
        overlays: kmlLayers
          .filter((layer) => layer.visible)
          .flatMap((layer) => layer.overlays),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.error || "Map generation failed. Check the URL and try again.",
      );
    }

    const mapBlob = await response.blob();
    if (!mapBlob.type.startsWith("image/")) {
      throw new Error("The map service did not return an image.");
    }
    const {
      blob: imageBlob,
      width: exportedWidth,
      height: exportedHeight,
    } = await composeMapImage(mapBlob, location);

    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
    }
    currentImageUrl = URL.createObjectURL(imageBlob);
    currentImageDimensions = { width: exportedWidth, height: exportedHeight };
    previewImage.src = currentImageUrl;
    setPreviewMode("export");
    downloadButton.disabled = false;
    document.getElementById("download-all").disabled = false;
    const sizeFormatted =
      imageBlob.size >= 1024 * 1024
        ? `${(imageBlob.size / (1024 * 1024)).toFixed(2)} MB`
        : `${Math.round(imageBlob.size / 1024)} KB`;
    outputSize.textContent = `${exportedWidth} × ${exportedHeight} px (${sizeFormatted})`;
    setStatus(`Map ready to download (${sizeFormatted}).`);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    renderButton.disabled = false;
  }
}

function projectToMap(location, dimensions, mapLocation) {
  const worldSize = 256 * 2 ** mapLocation.zoom;
  const mercatorY = (latitude) => {
    const limitedLatitude = Math.max(
      -85.05112878,
      Math.min(85.05112878, latitude),
    );
    const radians = (limitedLatitude * Math.PI) / 180;
    return (
      (0.5 -
        Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) /
          (4 * Math.PI)) *
      worldSize
    );
  };
  const worldX = (longitude) => ((longitude + 180) / 360) * worldSize;
  let deltaX = worldX(location.lng) - worldX(mapLocation.lng);
  if (deltaX > worldSize / 2) deltaX -= worldSize;
  if (deltaX < -worldSize / 2) deltaX += worldSize;
  const outputScale = 2;
  return {
    x: dimensions.width / 2 + deltaX * outputScale,
    y:
      dimensions.height / 2 +
      (mercatorY(location.lat) - mercatorY(mapLocation.lat)) * outputScale,
  };
}

function drawMapLabel(context, label, point, scale) {
  if (
    !label.visible ||
    point.x < 0 ||
    point.x > context.canvas.width ||
    point.y < 0 ||
    point.y > context.canvas.height
  ) {
    return;
  }

  const textStyle = label.textStyle || "regular";
  const fontSize =
    (textStyle === "country" || textStyle === "bold-country"
      ? 26
      : textStyle === "regular"
        ? 18
        : 24) * scale;
  const weight =
    textStyle === "bold-region" || textStyle === "bold-country" ? "700" : "400";
  const title =
    textStyle === "regular" ? label.title : label.title.toUpperCase();
  const paddingX = 12 * scale;
  const paddingY = 8 * scale;
  const maxTextWidth = Math.min(340 * scale, context.canvas.width * 0.38);

  context.save();
  context.font = `${weight} ${fontSize}px Arial, sans-serif`;
  const words = title.split(/\s+/);
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    const proposedLine = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && context.measureText(proposedLine).width > maxTextWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = proposedLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = fontSize * 1.2;
  const boxWidth =
    Math.min(
      maxTextWidth,
      Math.max(...lines.map((line) => context.measureText(line).width)),
    ) +
    paddingX * 2;
  const boxHeight = lines.length * lineHeight + paddingY * 2;
  const direction = label.direction || "left";
  let boxX =
    direction === "right"
      ? point.x + 9 * scale
      : direction === "left"
        ? point.x - boxWidth - 9 * scale
        : point.x - boxWidth / 2;
  let boxY =
    direction === "up"
      ? point.y - boxHeight - 12 * scale
      : direction === "down"
        ? point.y + 12 * scale
        : point.y - boxHeight / 2;
  boxX = Math.max(0, Math.min(context.canvas.width - boxWidth, boxX));
  boxY = Math.max(0, Math.min(context.canvas.height - boxHeight, boxY));

  if (label.pointerStyle !== "noPointer") {
    context.beginPath();
    context.arc(point.x, point.y, 5 * scale, 0, Math.PI * 2);
    context.fillStyle = label.pointerStyle?.includes("white")
      ? "#fff"
      : label.pointerStyle?.includes("kingfisher")
        ? "#00a6a6"
        : "#222";
    context.fill();
    context.lineWidth = 1.5 * scale;
    context.strokeStyle =
      label.pointerStyle?.includes("Stroke") ||
      label.pointerStyle === "whiteBlackPointer"
        ? "#222"
        : "#fff";
    context.stroke();
  }

  if (label.backgroundColor !== "transparent") {
    context.fillStyle = label.backgroundColor || "rgba(255,255,255,.92)";
    context.fillRect(boxX, boxY, boxWidth, boxHeight);
  }
  context.fillStyle = label.textColor || "#222";
  context.textBaseline = "top";
  lines.forEach((line, index) =>
    context.fillText(
      line,
      boxX + paddingX,
      boxY + paddingY + index * lineHeight,
    ),
  );
  context.restore();
}

function serializeSvg(svg) {
  const clone = svg.cloneNode(true);
  const viewBox = svg.viewBox.baseVal;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(viewBox.width));
  clone.setAttribute("height", String(viewBox.height));
  const sourceElements = [svg, ...svg.querySelectorAll("*")];
  const clonedElements = [clone, ...clone.querySelectorAll("*")];
  sourceElements.forEach((source, index) => {
    const computed = getComputedStyle(source);
    const target = clonedElements[index];
    for (const property of [
      "fill",
      "stroke",
      "stroke-width",
      "font-family",
      "font-size",
      "font-weight",
      "text-anchor",
    ]) {
      const value = computed.getPropertyValue(property);
      if (value) target.setAttribute(property, value);
    }
  });
  return new XMLSerializer().serializeToString(clone);
}

async function svgToImage(svg) {
  const blob = new Blob([serializeSvg(svg)], {
    type: "image/svg+xml;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function composeMapImage(mapBlob, location) {
  const activeLabels = labels.filter((label) => label.visible);
  const locatorSvg = document.getElementById("include-locator").checked
    ? document.getElementById("locator-svg")
    : null;
  const scaleSvg = document.getElementById("include-scale").checked
    ? document.getElementById("scale-svg")
    : null;

  const objectUrl = URL.createObjectURL(mapBlob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });

    const locatorImage = locatorSvg ? await svgToImage(locatorSvg) : null;
    const scaleImage = scaleSvg ? await svgToImage(scaleSvg) : null;

    const renderComposite = async (targetWidth, targetHeight) => {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, targetWidth, targetHeight);

      const mapDimensions = dimensions[selectedRatio()];
      const scale = canvas.width / mapDimensions.width;

      for (const label of activeLabels) {
        drawMapLabel(
          context,
          label,
          projectToMap(label, mapDimensions, location),
          scale,
        );
      }

      const inset = 20 * scale;
      if (locatorImage) {
        const locatorSize = 150 * scale;
        context.drawImage(locatorImage, inset, inset, locatorSize, locatorSize);
      }
      if (scaleImage) {
        const scaleWidth = 275 * scale;
        const scaleHeight = 80 * scale;
        const x = canvas.width - scaleWidth - inset;
        context.fillStyle = "rgba(255,255,255,0.88)";
        context.fillRect(
          x - 10 * scale,
          inset - 8 * scale,
          scaleWidth + 20 * scale,
          scaleHeight + 16 * scale,
        );
        context.drawImage(scaleImage, x, inset, scaleWidth, scaleHeight);
      }

      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      return { blob, width: targetWidth, height: targetHeight };
    };

    let result = await renderComposite(image.naturalWidth, image.naturalHeight);

    // In the rare event that the rendered image exceeds 3.5MB, gently adjust canvas resolution
    // and re-render directly from vectors rather than downsampling a blurry flat bitmap
    let currentWidth = image.naturalWidth;
    let currentHeight = image.naturalHeight;
    while (
      result.blob &&
      result.blob.size > MAX_PNG_BYTES &&
      currentWidth > 640 &&
      currentHeight > 360
    ) {
      const ratio = Math.max(
        0.88,
        Math.min(0.97, Math.sqrt((MAX_PNG_BYTES * 0.98) / result.blob.size)),
      );
      const nextWidth = Math.round(currentWidth * ratio);
      const nextHeight = Math.round(currentHeight * ratio);
      if (nextWidth >= currentWidth || nextHeight >= currentHeight) {
        break;
      }
      currentWidth = nextWidth;
      currentHeight = nextHeight;
      result = await renderComposite(currentWidth, currentHeight);
    }

    return result;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function addMapLabel() {
  const searchInput = document.getElementById("label-search");
  const captionInput = document.getElementById("label-caption");
  const query = searchInput.value.trim();
  if (!query) {
    setStatus("Enter a place or address for the label.", "error");
    return;
  }

  const button = document.getElementById("add-label");
  button.disabled = true;
  const coordinates = query.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/,
  );
  setStatus(
    coordinates ? "Placing label…" : "Searching for the label location…",
  );
  try {
    let result;
    if (coordinates) {
      const lat = Number(coordinates[1]);
      const lng = Number(coordinates[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new Error(
          "Coordinates must be within latitude ±90 and longitude ±180.",
        );
      }
      result = { label: `${lat}, ${lng}`, lat, lng };
    } else {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ action: "geocode", address: query }),
      });
      result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not find that place.");
      }
    }

    const label = {
      title: captionInput.value.trim() || result.label,
      lat: result.lat,
      lng: result.lng,
      visible: true,
      direction: "left",
      pointerStyle: "whiteBlackPointer",
      backgroundColor: "#ffffff",
      textStyle: "regular",
      textColor: "#222222",
    };
    labels.push(label);
    renderLabels();
    if (labels.length === 1) {
      const zoom = currentMapLocation?.zoom || 12;
      urlInput.value = `https://www.google.com/maps/@${label.lat},${label.lng},${zoom}z`;
      updateReferenceOverlays(parseMapUrl(urlInput.value));
      if (googleMap) {
        isUpdatingMapFromCode = true;
        googleMap.setCenter({ lat: label.lat, lng: label.lng });
        isUpdatingMapFromCode = false;
      }
    }
    searchInput.value = "";
    captionInput.value = "";
    invalidateOutput();
    setStatus(`Added label: ${label.title}`);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderLabels() {
  const container = document.getElementById("label-list");
  container.replaceChildren();
  labels.forEach((label, index) => {
    const item = document.createElement("article");
    item.className = "label-item";
    const row = document.createElement("div");
    row.className = "label-item-row";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = label.visible;
    visible.setAttribute("aria-label", `Show ${label.title}`);
    visible.addEventListener("change", () => {
      label.visible = visible.checked;
      syncInteractiveMarkers();
      invalidateOutput();
    });
    const title = document.createElement("input");
    title.type = "text";
    title.value = label.title;
    title.setAttribute("aria-label", "Label text");
    title.addEventListener("input", () => {
      label.title = title.value;
      syncInteractiveMarkers();
      invalidateOutput();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-label";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      labels.splice(index, 1);
      if (index === 0 && labels.length > 0) {
        const zoom = currentMapLocation?.zoom || 12;
        urlInput.value = `https://www.google.com/maps/@${labels[0].lat},${labels[0].lng},${zoom}z`;
        updateReferenceOverlays(parseMapUrl(urlInput.value));
        if (googleMap) {
          isUpdatingMapFromCode = true;
          googleMap.setCenter({ lat: labels[0].lat, lng: labels[0].lng });
          isUpdatingMapFromCode = false;
        }
      }
      renderLabels();
      invalidateOutput();
    });
    row.append(visible, title, remove);

    const options = document.createElement("div");
    options.className = "label-options";
    for (const [field, values] of Object.entries({
      direction: [
        ["left", "Left"],
        ["right", "Right"],
        ["up", "Above"],
        ["down", "Below"],
      ],
      pointerStyle: [
        ["whiteBlackPointer", "White pointer"],
        ["blackPointer", "Black pointer"],
        ["whiteDotBlackStroke", "White dot"],
        ["blackDot", "Black dot"],
        ["noPointer", "No pointer"],
      ],
      textStyle: [
        ["regular", "Regular"],
        ["country", "Country"],
        ["region", "Region"],
        ["bold-region", "Bold region"],
        ["bold-country", "Bold country"],
      ],
      backgroundColor: [
        ["#ffffff", "White background"],
        ["#106078", "Blue background"],
        ["transparent", "No background"],
      ],
      textColor: [
        ["#222222", "Black text"],
        ["#ffffff", "White text"],
      ],
    })) {
      const select = document.createElement("select");
      select.setAttribute(
        "aria-label",
        field.replace(/[A-Z]/g, (character) => ` ${character.toLowerCase()}`),
      );
      values.forEach(([value, text]) => select.add(new Option(text, value)));
      select.value = label[field];
      select.addEventListener("change", () => {
        label[field] = select.value;
        invalidateOutput();
      });
      options.append(select);
    }
    item.append(row, options);
    if (labels.length > 1) {
      const applyAll = document.createElement("button");
      applyAll.type = "button";
      applyAll.className = "text-button apply-label-style";
      applyAll.textContent = "Apply style to all labels";
      applyAll.addEventListener("click", () => {
        const style = {
          direction: label.direction,
          pointerStyle: label.pointerStyle,
          backgroundColor: label.backgroundColor,
          textStyle: label.textStyle,
          textColor: label.textColor,
        };
        labels.forEach((target) => Object.assign(target, style));
        renderLabels();
        invalidateOutput();
      });
      item.append(applyAll);
    }
    container.append(item);
  });
  syncInteractiveMarkers();
}

function kmlColorToCss(value) {
  const color = value?.trim().replace(/^#/, "");
  if (!color || !/^[\da-f]{8}$/i.test(color)) {
    return "#174b39";
  }
  return `#${color.slice(6, 8)}${color.slice(4, 6)}${color.slice(2, 4)}`;
}

function parseKmlCoordinates(element) {
  const coordinateNode = element.querySelector("coordinates");
  if (!coordinateNode) return [];
  return coordinateNode.textContent
    .trim()
    .split(/\s+/)
    .map((value) => {
      const [lng, lat] = value.split(",").map(Number);
      return { lat, lng };
    })
    .filter(
      (point) =>
        Number.isFinite(point.lat) &&
        Math.abs(point.lat) <= 90 &&
        Number.isFinite(point.lng) &&
        Math.abs(point.lng) <= 180,
    );
}

function parseKmlContent(contents, filename) {
  const xml = new DOMParser().parseFromString(contents, "application/xml");
  if (xml.querySelector("parsererror")) {
    throw new Error("This KML file could not be parsed.");
  }

  const styleColors = new Map();
  xml.querySelectorAll("Style[id]").forEach((style) => {
    const id = style.getAttribute("id");
    styleColors.set(id, {
      line: kmlColorToCss(style.querySelector("LineStyle color")?.textContent),
      polygon: kmlColorToCss(
        style.querySelector("PolyStyle color")?.textContent,
      ),
    });
  });

  const overlays = [];
  xml.querySelectorAll("Placemark").forEach((placemark) => {
    const styleId = placemark
      .querySelector("styleUrl")
      ?.textContent.trim()
      .replace(/^#/, "");
    const style = styleColors.get(styleId) || {};
    placemark.querySelectorAll("Point").forEach((point) => {
      const coordinates = parseKmlCoordinates(point)[0];
      if (coordinates)
        overlays.push({
          type: "point",
          ...coordinates,
          color: style.line || "#174b39",
        });
    });
    placemark.querySelectorAll("LineString").forEach((line) => {
      const points = parseKmlCoordinates(line);
      if (points.length >= 2)
        overlays.push({ type: "line", points, color: style.line || "#174b39" });
    });
    placemark.querySelectorAll("Polygon").forEach((polygon) => {
      const boundary =
        polygon.querySelector("outerBoundaryIs coordinates") ||
        polygon.querySelector("LinearRing coordinates");
      const points = boundary
        ? parseKmlCoordinates(boundary.parentElement || polygon)
        : [];
      if (points.length >= 3)
        overlays.push({
          type: "polygon",
          points,
          color: style.polygon || "#174b39",
        });
    });
  });

  if (!overlays.length) {
    throw new Error(
      "No supported points, lines, or polygons were found in this KML.",
    );
  }
  if (
    overlays.length > 100 ||
    overlays.reduce(
      (total, overlay) => total + (overlay.points?.length || 1),
      0,
    ) > 500
  ) {
    throw new Error(
      "This KML is too detailed. Reduce it to 100 features and 500 coordinates or fewer.",
    );
  }
  return {
    name: filename.replace(/\.(kml|xml)$/i, ""),
    visible: true,
    overlays,
  };
}

function renderKmlLayers() {
  const list = document.getElementById("kml-list");
  list.replaceChildren();
  kmlLayers.forEach((layer, index) => {
    const item = document.createElement("div");
    item.className = "kml-layer";
    const visibility = document.createElement("input");
    visibility.type = "checkbox";
    visibility.checked = layer.visible;
    visibility.setAttribute("aria-label", `Show ${layer.name}`);
    visibility.addEventListener("change", () => {
      layer.visible = visibility.checked;
      syncInteractiveKmlOverlays();
      invalidateOutput();
    });
    const name = document.createElement("span");
    name.textContent = layer.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-label";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      kmlLayers.splice(index, 1);
      renderKmlLayers();
      invalidateOutput();
    });
    item.append(visibility, name, remove);
    list.append(item);
  });
  syncInteractiveKmlOverlays();
}

async function importKmlFile(file) {
  try {
    if (file.size > 2 * 1024 * 1024) {
      throw new Error("KML files must be 2 MB or smaller.");
    }
    kmlLayers.push(parseKmlContent(await file.text(), file.name));
    renderKmlLayers();
    invalidateOutput();
    setStatus(`Imported KML layer: ${file.name}`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function exportMapState() {
  const currentLocation = currentMapLocation || parseMapUrl(urlInput.value);
  const state = {
    version: 1,
    location: currentLocation,
    style: styleSelect.value,
    ratio: selectedRatio(),
    includeLocator: document.getElementById("include-locator").checked,
    includeScale: document.getElementById("include-scale").checked,
    visibilityOverrides: layerOverrides,
    labels,
    kmlLayers,
  };
  downloadBlob(
    new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
    "map-studio.json",
  );
}

function normalizeImportedLabel(label) {
  const normalized = {
    title: String(label.title || "Untitled label").slice(0, 120),
    lat: Number(label.lat),
    lng: Number(label.lng),
    visible: label.visible !== false,
    direction: label.direction || "left",
    pointerStyle: label.pointerStyle || "whiteBlackPointer",
    backgroundColor: label.backgroundColor || "#ffffff",
    textStyle: label.textStyle || "regular",
    textColor: label.textColor || "#222222",
  };
  if (
    !Number.isFinite(normalized.lat) ||
    Math.abs(normalized.lat) > 90 ||
    !Number.isFinite(normalized.lng) ||
    Math.abs(normalized.lng) > 180
  ) {
    throw new Error("Imported settings include an invalid label position.");
  }
  return normalized;
}

async function importMapState(file) {
  try {
    if (file.size > 2 * 1024 * 1024)
      throw new Error("Settings files must be 2 MB or smaller.");
    const state = JSON.parse(await file.text());
    if (
      !state.location ||
      !Number.isFinite(Number(state.location.lat)) ||
      !Number.isFinite(Number(state.location.lng))
    ) {
      throw new Error("Settings file does not contain a valid map location.");
    }
    const zoom = Math.max(
      3,
      Math.min(16, Math.round(Number(state.location.zoom) || 12)),
    );
    urlInput.value = `https://www.google.com/maps/@${Number(state.location.lat)},${Number(state.location.lng)},${zoom}z`;
    if (
      typeof state.style === "string" &&
      Object.hasOwn(presetStyles, state.style)
    ) {
      styleSelect.value = state.style;
    }
    if (
      typeof state.ratio === "string" &&
      Object.hasOwn(dimensions, state.ratio)
    ) {
      form.elements.ratio.value = state.ratio;
      updateDimensions();
    }
    if (typeof state.includeLocator === "boolean") {
      document.getElementById("include-locator").checked = state.includeLocator;
    }
    if (typeof state.includeScale === "boolean") {
      document.getElementById("include-scale").checked = state.includeScale;
    }
    layerOverrides =
      state.visibilityOverrides && !Array.isArray(state.visibilityOverrides)
        ? state.visibilityOverrides
        : {};
    labels = Array.isArray(state.labels)
      ? state.labels.slice(0, 100).map(normalizeImportedLabel)
      : [];
    if (labels.length > 0) {
      let zoom = 12;
      try {
        zoom = parseMapUrl(urlInput.value).zoom;
      } catch {
        zoom = currentMapLocation?.zoom || 12;
      }
      urlInput.value = `https://www.google.com/maps/@${labels[0].lat},${labels[0].lng},${zoom}z`;
    }
    kmlLayers = Array.isArray(state.kmlLayers)
      ? state.kmlLayers.slice(0, 20)
      : [];
    renderLayerControls();
    renderLabels();
    renderKmlLayers();
    updateReferenceOverlays(parseMapUrl(urlInput.value));
    if (googleMap) {
      isUpdatingMapFromCode = true;
      const parsedLoc = parseMapUrl(urlInput.value);
      googleMap.setCenter({ lat: parsedLoc.lat, lng: parsedLoc.lng });
      googleMap.setZoom(toMapZoom(parsedLoc.zoom));
      applyInteractiveMapStyles();
      isUpdatingMapFromCode = false;
    }
    invalidateOutput();
    setStatus("Map settings imported. Generate the map to preview the result.");
  } catch (error) {
    setStatus(error.message || "Could not import this settings file.", "error");
  }
}

function downloadMap() {
  if (!currentImageUrl) {
    return;
  }
  const width =
    currentImageDimensions.width || dimensions[selectedRatio()].width;
  const height =
    currentImageDimensions.height || dimensions[selectedRatio()].height;
  const link = document.createElement("a");
  link.href = currentImageUrl;
  link.download = `map_${width}x${height}.png`;
  link.click();
}

function downloadAll() {
  if (!currentImageUrl) {
    setStatus("Generate a map before downloading all files.", "error");
    return;
  }
  downloadMap();
  setTimeout(
    () =>
      downloadOverlay(
        document.querySelector('[data-export="locator"][data-format="png"]'),
      ),
    250,
  );
  setTimeout(
    () =>
      downloadOverlay(
        document.querySelector('[data-export="scale"][data-format="png"]'),
      ),
    500,
  );
}

function downloadSvgAsPng(svg, filename) {
  const markup = serializeSvg(svg);
  const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.onload = () => {
    const size = svg.viewBox.baseVal;
    const canvas = document.createElement("canvas");
    canvas.width = size.width * 2;
    canvas.height = size.height * 2;
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(objectUrl);
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, filename);
      }
    }, "image/png");
  };
  image.onerror = () => URL.revokeObjectURL(objectUrl);
  image.src = objectUrl;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function downloadOverlay(button) {
  const overlayName = button.dataset.export;
  const format = button.dataset.format;
  const svg = document.getElementById(
    overlayName === "locator" ? "locator-svg" : "scale-svg",
  );
  if (!svg) {
    setStatus("Read a map URL before exporting the locator or scale.", "error");
    return;
  }

  const filename = `${overlayName}.${format}`;
  if (format === "svg") {
    downloadBlob(
      new Blob([serializeSvg(svg)], { type: "image/svg+xml;charset=utf-8" }),
      filename,
    );
  } else {
    downloadSvgAsPng(svg, filename);
  }
}

form.addEventListener("submit", generateMap);
document
  .getElementById("reset-map")
  .addEventListener("click", resetToInitialState);
downloadButton.addEventListener("click", downloadMap);
document.getElementById("download-all").addEventListener("click", downloadAll);
document
  .getElementById("include-locator")
  .addEventListener("change", invalidateOutput);
document
  .getElementById("include-scale")
  .addEventListener("change", invalidateOutput);
urlInput.addEventListener("input", invalidateOutput);
styleSelect.addEventListener("change", invalidateOutput);
styleSelect.addEventListener("change", () => {
  layerOverrides = {};
  renderLayerControls();
  applyInteractiveMapStyles();
  renderCountryLabels();
});
window.addEventListener("resize", () => {
  if (googleMap && currentMapLocation) {
    isUpdatingMapFromCode = true;
    googleMap.setZoom(toMapZoom(currentMapLocation.zoom));
    isUpdatingMapFromCode = false;
  }
  requestAnimationFrame(renderCountryLabels);
});
modeInteractiveButton.addEventListener("click", () =>
  setPreviewMode("interactive"),
);
modeExportButton.addEventListener("click", () => {
  if (currentImageUrl) setPreviewMode("export");
});
document.querySelectorAll('input[name="ratio"]').forEach((input) =>
  input.addEventListener("change", () => {
    updateDimensions();
    invalidateOutput();
  }),
);
document.getElementById("read-url").addEventListener("click", () => {
  try {
    const location = parseMapUrl(urlInput.value);
    updateReferenceOverlays(location);
    if (googleMap) {
      isUpdatingMapFromCode = true;
      googleMap.setCenter({ lat: location.lat, lng: location.lng });
      googleMap.setZoom(toMapZoom(location.zoom));
      isUpdatingMapFromCode = false;
    }
    setStatus("Map location found. Choose a style and generate the image.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

updateDimensions();
loadStyles()
  .then(() => {
    setStatus("Interactive map ready. Search a location or pan around.");
  })
  .catch((error) => {
    styleSelect.replaceChildren(new Option("Styles unavailable", ""));
    setStatus(error.message, "error");
  });
document.querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => downloadOverlay(button));
});
document.getElementById("toggle-layers").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  document.getElementById("advanced-layers").hidden = expanded;
});
document.getElementById("add-label").addEventListener("click", addMapLabel);
document.getElementById("label-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addMapLabel();
  }
});
document
  .getElementById("import-kml")
  .addEventListener("click", () => document.getElementById("kml-file").click());
document.getElementById("kml-file").addEventListener("change", (event) => {
  for (const file of event.target.files || []) importKmlFile(file);
  event.target.value = "";
});
document.getElementById("export-state").addEventListener("click", () => {
  try {
    exportMapState();
  } catch (error) {
    setStatus(error.message, "error");
  }
});
document
  .getElementById("import-state")
  .addEventListener("click", () =>
    document.getElementById("state-file").click(),
  );
document.getElementById("state-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importMapState(file);
  event.target.value = "";
});
