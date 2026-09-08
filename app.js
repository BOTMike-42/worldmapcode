/*
 * Research Institutions Map
 * ---------------------------------------------------
 * 1. Fetches MAP_DATA.csv (semicolon-delimited, UTF-8).
 * 2. Parses it with PapaParse.
 * 3. Builds a GeoJSON FeatureCollection, one point per institution
 *    that has valid latitude/longitude.
 * 4. Renders it on a MapLibre GL map using a free OpenStreetMap
 *    raster style (no API key required).
 * 5. Node radius is scaled by sqrt(papers) so a few very large
 *    institutions don't drown out everything else.
 * 6. Clicking a node shows a popup with institution / country / papers.
 */

const CSV_PATH = "MAP_DATA.csv";
const CSV_DELIMITER = ";";

// Radius range (in pixels) that circles will be scaled between.
const MIN_RADIUS = 4;
const MAX_RADIUS = 28;

const statusBox = document.getElementById("status");

function showStatus(message, isError = false) {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? "#000" : "#000";
}

function hideStatus() {
  statusBox.hidden = true;
}

/**
 * Free, no-API-key base map style: Esri's classic "Light Gray Canvas" raster
 * tile service (services.arcgisonline.com). This is a legacy, long-standing
 * public REST tile service — distinct from Esri's newer key-gated basemap
 * APIs — and has historically not required any account, token, or key for
 * this kind of usage. It renders a minimal light-gray map showing only
 * country/region borders, water, and streets — no building outlines,
 * land-use coloring, or text labels.
 *
 * A CSS grayscale filter (see style.css) is applied on top as a safety net
 * to guarantee a fully black-and-white look regardless of subtle tinting.
 *
 * Note: this is a third-party free service governed by Esri's terms of use.
 * If it's ever unavailable or terms change, the OSM raw tile fallback used
 * earlier can be swapped back in (see the commented block below).
 */
const OSM_STYLE = {
  version: 8,
  sources: {
    "esri-light-gray": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS community",
    },
  },
  layers: [
    {
      id: "base-tiles",
      type: "raster",
      source: "esri-light-gray",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

/* --- Fallback option (raw OpenStreetMap raster tiles), kept for reference:
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};
--- */

const map = new maplibregl.Map({
  container: "map",
  style: OSM_STYLE,
  center: [10, 30],
  zoom: 1.5,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right"
);

/**
 * Turns a raw "papers" count into a circle radius (in px) using a
 * square-root scale. Square-root (rather than linear) keeps a single
 * huge outlier institution from making every other node invisible,
 * because circle *area* then scales roughly linearly with paper count.
 */
function papersToRadius(papers, minPapers, maxPapers) {
  if (maxPapers === minPapers) return (MIN_RADIUS + MAX_RADIUS) / 2;

  const sqrtVal = Math.sqrt(papers);
  const sqrtMin = Math.sqrt(minPapers);
  const sqrtMax = Math.sqrt(maxPapers);

  const t = (sqrtVal - sqrtMin) / (sqrtMax - sqrtMin); // 0..1
  return MIN_RADIUS + t * (MAX_RADIUS - MIN_RADIUS);
}

function buildGeoJSON(rows) {
  const skipped = [];
  const validRows = [];

  for (const row of rows) {
    const lat = parseFloat(row.latitude);
    const lon = parseFloat(row.longitude);
    const papers = parseInt(row.papers, 10);

    const hasValidCoords =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;

    if (!hasValidCoords || !Number.isFinite(papers)) {
      skipped.push(row.institution || "(unnamed row)");
      continue;
    }

    validRows.push({ ...row, lat, lon, papers });
  }

  if (skipped.length > 0) {
    console.warn(
      `Skipped ${skipped.length} institution(s) with missing/invalid coordinates:`,
      skipped
    );
  }

  const paperCounts = validRows.map((r) => r.papers);
  const minPapers = Math.min(...paperCounts);
  const maxPapers = Math.max(...paperCounts);

  const features = validRows.map((row) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [row.lon, row.lat], // GeoJSON is [lng, lat]
    },
    properties: {
      institution: row.institution,
      country: row.country,
      papers: row.papers,
      radius: papersToRadius(row.papers, minPapers, maxPapers),
    },
  }));

  return {
    geojson: { type: "FeatureCollection", features },
    skippedCount: skipped.length,
    totalCount: rows.length,
  };
}

function addInstitutionsLayer(geojson) {
  map.addSource("institutions", {
    type: "geojson",
    data: geojson,
  });

  map.addLayer({
    id: "institutions-circles",
    type: "circle",
    source: "institutions",
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#000000",
      "circle-opacity": 0.55,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#000000",
      "circle-stroke-opacity": 0.9,
    },
  });

  // Pointer cursor on hover
  map.on("mouseenter", "institutions-circles", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "institutions-circles", () => {
    map.getCanvas().style.cursor = "";
  });

  // Popup on click
  map.on("click", "institutions-circles", (e) => {
    const feature = e.features[0];
    const { institution, country, papers } = feature.properties;
    const coords = feature.geometry.coordinates.slice();

    // If the map is zoomed/panned such that the point is duplicated
    // across the antimeridian, adjust the popup to the correct copy.
    while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
      coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
    }

    const html = `
      <div class="popup-institution">${escapeHtml(institution)}</div>
      <div class="popup-row"><span class="label">Country:</span> ${escapeHtml(
        country
      )}</div>
      <div class="popup-row"><span class="label">Papers:</span> ${papers}</div>
    `;

    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);
  });
}

// Minimal HTML-escaping so institution/country names can't break the popup markup.
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadData() {
  showStatus("Loading institution data…");

  fetch(CSV_PATH)
    .then((response) => {
      if (!response.ok) {
        throw new Error(
          `Could not fetch ${CSV_PATH} (HTTP ${response.status}). ` +
            `Make sure the file sits next to index.html and you're viewing this ` +
            `over http/https (not double-clicking the file), e.g. via a local server ` +
            `or GitHub Pages.`
        );
      }
      return response.text();
    })
    .then((csvText) => {
      const parsed = Papa.parse(csvText, {
        header: true,
        delimiter: CSV_DELIMITER,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });

      if (parsed.errors && parsed.errors.length > 0) {
        console.warn("CSV parse warnings:", parsed.errors);
      }

      const { geojson, skippedCount, totalCount } = buildGeoJSON(parsed.data);

      if (geojson.features.length === 0) {
        showStatus(
          "No institutions with valid coordinates were found in the CSV.",
          true
        );
        return;
      }

      const addLayerOnce = () => addInstitutionsLayer(geojson);
      if (map.isStyleLoaded()) {
        addLayerOnce();
      } else {
        map.once("load", addLayerOnce);
      }

      if (skippedCount > 0) {
        showStatus(
          `Showing ${totalCount - skippedCount} of ${totalCount} institutions ` +
            `(${skippedCount} skipped — missing latitude/longitude). See browser console for the list.`
        );
      } else {
        hideStatus();
      }
    })
    .catch((err) => {
      console.error(err);
      showStatus(err.message, true);
    });
}

loadData();
