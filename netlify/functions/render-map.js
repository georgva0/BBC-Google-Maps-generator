const presets = require("../../site/config/map-styles.json");

const imageSizes = {
    landscape: "640x360",
    square: "640x640",
    portrait: "360x640",
};

const supportedStylers = new Set([
    "color",
    "gamma",
    "hue",
    "invert_lightness",
    "lightness",
    "saturation",
    "visibility",
    "weight",
]);

function normalizeColor(value) {
    if (typeof value !== "string") {
        return value;
    }

    const shorthand = value.match(/^#([\da-f])([\da-f])([\da-f])$/i);
    if (shorthand) {
        return `0x${shorthand[1]}${shorthand[1]}${shorthand[2]}${shorthand[2]}${shorthand[3]}${shorthand[3]}`;
    }

    const fullColor = value.match(/^#([\da-f]{6})$/i);
    return fullColor ? `0x${fullColor[1]}` : value;
}

function jsonResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        },
        body: JSON.stringify(body),
    };
}

function serializeStyle(rule) {
    const parts = [];
    if (rule.featureType) {
        parts.push(`feature:${rule.featureType}`);
    }
    if (rule.elementType) {
        parts.push(`element:${rule.elementType}`);
    }

    for (const styler of rule.stylers || []) {
        for (const [name, value] of Object.entries(styler)) {
            if (supportedStylers.has(name)) {
                const serializedValue = name === "color" || name === "hue" ? normalizeColor(value) : value;
                parts.push(`${name}:${serializedValue}`);
            }
        }
    }

    return parts.length ? parts.join("|") : "";
}

function normalizeMapType(mapType) {
    return ["terrain", "hybrid", "satellite"].includes(mapType) ? mapType : "roadmap";
}

exports.handler = async function(event) {
    if (event.httpMethod === "GET") {
        const clientKey = process.env.GOOGLE_MAPS_API_CLIENT_KEY
            || process.env.GOOGLE_MAPS_CLIENT_KEY
            || process.env.GOOGLE_MAPS_API
            || "";
        return jsonResponse(200, {
            styles: Object.entries(presets).map(([id, preset]) => ({ id, title: preset.title })),
            apiKey: clientKey,
        });
    }
    if (event.httpMethod !== "POST") {
        return jsonResponse(405, { error: "Method not allowed." });
    }

    const apiKey = process.env.GOOGLE_MAPS_API || process.env.GOOGLE_MAPS_API_CLIENT_KEY;
    if (!apiKey) {
        return jsonResponse(503, { error: "Map service is not configured." });
    }

    let input;
    try {
        if (!event.body || event.body.length > 50000) {
            return jsonResponse(413, { error: "Request is too large." });
        }
        input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
    } catch {
        return jsonResponse(400, { error: "Invalid request." });
    }

    if (input.action === "geocode") {
        const address = typeof input.address === "string" ? input.address.trim() : "";
        if (!address || address.length > 200) {
            return jsonResponse(400, { error: "Enter a place or address up to 200 characters." });
        }
        try {
            const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
            geocodeUrl.searchParams.set("address", address);
            geocodeUrl.searchParams.set("key", apiKey);
            const response = await fetch(geocodeUrl);
            const result = await response.json();
            if (!response.ok || result.status !== "OK" || !result.results?.length) {
                return jsonResponse(404, { error: "No matching place was found." });
            }
            const match = result.results[0];
            return jsonResponse(200, {
                label: match.address_components?.[0]?.short_name || match.formatted_address || address,
                lat: match.geometry.location.lat,
                lng: match.geometry.location.lng,
            });
        } catch {
            return jsonResponse(502, { error: "Place search is temporarily unavailable." });
        }
    }

    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const zoom = Number(input.zoom);
    const preset = presets[input.style];
    const size = imageSizes[input.ratio];

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return jsonResponse(400, { error: "Map coordinates are invalid." });
    }
    if (!Number.isInteger(zoom) || zoom < 3 || zoom > 16) {
        return jsonResponse(400, { error: "Map zoom is invalid." });
    }
    if (!preset || !size) {
        return jsonResponse(400, { error: "Choose a supported map style and image shape." });
    }

    const overlays = [];
    let coordinateCount = 0;
    if (input.overlays !== undefined && !Array.isArray(input.overlays)) {
        return jsonResponse(400, { error: "KML overlays are invalid." });
    }
    for (const overlay of (input.overlays || []).slice(0, 100)) {
        if (!overlay || !["point", "line", "polygon"].includes(overlay.type)) {
            return jsonResponse(400, { error: "KML contains an unsupported geometry." });
        }
        if (overlay.type === "point") {
            const lat = Number(overlay.lat);
            const lng = Number(overlay.lng);
            if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
                return jsonResponse(400, { error: "KML contains invalid coordinates." });
            }
            overlays.push({ type: "point", lat, lng, color: overlay.color });
            coordinateCount += 1;
            continue;
        }

        if (!Array.isArray(overlay.points) || overlay.points.length < (overlay.type === "polygon" ? 3 : 2)) {
            return jsonResponse(400, { error: "KML contains an incomplete path." });
        }
        const points = overlay.points.map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }));
        if (points.some(point => !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lng) || Math.abs(point.lng) > 180)) {
            return jsonResponse(400, { error: "KML contains invalid coordinates." });
        }
        coordinateCount += points.length;
        overlays.push({ type: overlay.type, points, color: overlay.color });
        if (coordinateCount > 500) {
            return jsonResponse(413, { error: "This KML layer is too detailed. Simplify it to 500 or fewer coordinates." });
        }
    }

    const visibilityOverrides = new Map();
    if (Array.isArray(input.visibilityOverrides) && input.visibilityOverrides.length <= 100) {
        const allowedFeatures = new Set((preset.styles || [])
            .filter(rule => rule.noToggle !== true)
            .map(rule => rule.featureType)
            .filter(Boolean));
        for (const override of input.visibilityOverrides) {
            if (override && allowedFeatures.has(override.featureType) && typeof override.visible === "boolean") {
                visibilityOverrides.set(override.featureType, override.visible ? "on" : "off");
            }
        }
    }

    const requestUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
    requestUrl.searchParams.set("center", `${lat},${lng}`);
    requestUrl.searchParams.set("zoom", String(zoom));
    requestUrl.searchParams.set("size", size);
    requestUrl.searchParams.set("scale", "2");
    requestUrl.searchParams.set("format", "png");
    requestUrl.searchParams.set("maptype", normalizeMapType(preset.mapType));
    requestUrl.searchParams.set("key", apiKey);

    for (const rule of preset.styles || []) {
        const visibility = visibilityOverrides.get(rule.featureType);
        const adjustedRule = visibility
            ? {
                ...rule,
                stylers: [
                    ...(rule.stylers || []).filter(styler => !Object.prototype.hasOwnProperty.call(styler, "visibility")),
                    { visibility },
                ],
            }
            : rule;
        const style = serializeStyle(adjustedRule);
        if (style) {
            requestUrl.searchParams.append("style", style);
        }
    }

    for (const overlay of overlays) {
        const color = /^#[\da-f]{6}$/i.test(overlay.color || "")
            ? `0x${overlay.color.slice(1)}`
            : "0x174B39";
        if (overlay.type === "point") {
            requestUrl.searchParams.append("markers", `size:small|color:${color}|${overlay.lat},${overlay.lng}`);
        } else {
            const points = overlay.points.map(point => `${point.lat},${point.lng}`).join("|");
            const pathStyle = overlay.type === "polygon"
                ? `color:${color}|weight:1|fillcolor:${color}40|${points}`
                : `color:${color}|weight:3|${points}`;
            requestUrl.searchParams.append("path", pathStyle);
        }
    }

    if (requestUrl.href.length > 15000) {
        return jsonResponse(413, { error: "The combined map style and KML are too large for one map request. Simplify the KML layer." });
    }

    try {
        const mapResponse = await fetch(requestUrl);
        const contentType = mapResponse.headers.get("content-type") || "";
        if (!mapResponse.ok || !contentType.startsWith("image/")) {
            return jsonResponse(502, { error: "Google Maps could not render this map. Check that Static Maps API is enabled for the server key." });
        }

        const image = Buffer.from(await mapResponse.arrayBuffer()).toString("base64");
        return {
            statusCode: 200,
            isBase64Encoded: true,
            headers: {
                "Cache-Control": "no-store",
                "Content-Type": "image/png",
                "X-Content-Type-Options": "nosniff",
            },
            body: image,
        };
    } catch {
        return jsonResponse(502, { error: "Map service is temporarily unavailable." });
    }
};