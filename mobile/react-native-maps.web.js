// react-native-maps.web.js — Leaflet-backed drop-in for Expo web / React Native Web
"use strict";

const React = require("react");
const { View } = require("react-native");

// ─── CDN loader ───────────────────────────────────────────────────────────────

let _leafletLoad = null;

function loadLeaflet() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.L) return Promise.resolve(window.L);
  if (_leafletLoad) return _leafletLoad;

  _leafletLoad = new Promise((resolve) => {
    if (!document.getElementById("lf-css")) {
      const link = document.createElement("link");
      link.id = "lf-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => { _leafletLoad = null; resolve(null); };
    document.head.appendChild(script);
  });

  return _leafletLoad;
}

function latDeltaToZoom(delta) {
  return Math.max(1, Math.min(18, Math.round(Math.log2(180 / Math.max(delta, 0.001)))));
}

// ─── Context (passes live L + map instance down to Marker / Polyline) ─────────

const MapCtx = React.createContext({ L: null, map: null });

// ─── MapView ──────────────────────────────────────────────────────────────────

function MapView({ style, region, children }) {
  const divRef = React.useRef(null);
  const [L, setL] = React.useState(null);
  const [map, setMap] = React.useState(null);

  // Load Leaflet once on mount
  React.useEffect(() => {
    loadLeaflet().then((lib) => { if (lib) setL(lib); });
  }, []);

  // Initialise the Leaflet map once L is ready
  React.useEffect(() => {
    if (!L || !divRef.current || map) return;
    const center = region ? [region.latitude, region.longitude] : [39.8, -98.5];
    const zoom   = region ? latDeltaToZoom(region.latitudeDelta) : 4;
    const m = L.map(divRef.current).setView(center, zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(m);
    setMap(m);
    return () => { m.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L]);

  // Pan/zoom when the region prop changes from the parent
  React.useEffect(() => {
    if (!map || !region) return;
    map.setView(
      [region.latitude, region.longitude],
      latDeltaToZoom(region.latitudeDelta),
      { animate: true }
    );
  }, [map, region && region.latitude, region && region.longitude]);

  const ctx = React.useMemo(() => ({ L, map }), [L, map]);

  // Children (Marker, Polyline) render outside the View so they emit no DOM
  // nodes, but they're inside the Provider so they can read the context.
  return React.createElement(
    MapCtx.Provider,
    { value: ctx },
    React.createElement(
      View,
      { style },
      React.createElement("div", {
        ref: divRef,
        style: { width: "100%", height: "100%", position: "relative" },
      })
    ),
    children
  );
}

// ─── Marker ───────────────────────────────────────────────────────────────────

function Marker({ coordinate, title, description, pinColor }) {
  const { L, map } = React.useContext(MapCtx);

  React.useEffect(() => {
    if (!L || !map || !coordinate) return;

    const icon = pinColor
      ? L.divIcon({
          className: "",
          html: `<div style="width:13px;height:13px;border-radius:50%;background:${pinColor};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
          iconSize: [13, 13],
          iconAnchor: [6, 6],
          popupAnchor: [0, -8],
        })
      : new L.Icon.Default();

    const marker = L.marker([coordinate.latitude, coordinate.longitude], { icon }).addTo(map);
    if (title) {
      marker.bindPopup(
        `<strong>${title}</strong>${description ? "<br>" + description : ""}`
      );
    }
    return () => { map.removeLayer(marker); };
  }, [L, map, coordinate && coordinate.latitude, coordinate && coordinate.longitude, pinColor, title, description]);

  return null;
}

// ─── Polyline ─────────────────────────────────────────────────────────────────

function Polyline({ coordinates, strokeColor, strokeWidth }) {
  const { L, map } = React.useContext(MapCtx);

  React.useEffect(() => {
    if (!L || !map || !coordinates || !coordinates.length) return;
    const line = L.polyline(
      coordinates.map((c) => [c.latitude, c.longitude]),
      { color: strokeColor || "#1c8f69", weight: strokeWidth || 3 }
    ).addTo(map);
    return () => { map.removeLayer(line); };
  }, [L, map, coordinates, strokeColor, strokeWidth]);

  return null;
}

// ─── No-op stubs for unused components ───────────────────────────────────────

const Stub = () => React.createElement(View, null);
Stub.displayName = "MapStub";

module.exports = {
  __esModule: true,
  default: MapView,
  MapView,
  Marker,
  Polyline,
  Callout: Stub,
  Circle: Stub,
  Polygon: Stub,
  Overlay: Stub,
  UrlTile: Stub,
  AnimatedRegion: class AnimatedRegion {},
};
