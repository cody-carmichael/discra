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
//
// Supports two prop styles:
//   1. Legacy:  pinColor="#hex"   → small white-bordered dot (back-compat)
//   2. New:     pinKind="driver"  → WoW-style SVG pin matching the web app
//               label="Alex …"    → optional text rendered next to the pin
//
// pinKind values:
//   - "unassigned"        gold "!" in dark circle, gold border
//   - "assigned"          gold "?" in dark circle, gold border
//   - "picked_up"         purple up-arrow in dark circle
//   - "en_route"          green right-arrow in dark circle
//   - "driver"            dark circle, gold "D" glyph, gold border
//   - "driver_selected"   bright gold border, brighter glyph

function _wowSymbolPinSvg(symbol, symbolColor, glowColor, borderColor) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<defs>' +
    '<filter id="g-' + symbolColor.replace('#','') + '" x="-50%" y="-50%" width="200%" height="200%">' +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur"/>' +
    '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>' +
    '</filter>' +
    '</defs>' +
    '<circle cx="16" cy="16" r="14" fill="#130F1A" stroke="' + borderColor + '" stroke-width="2.5"/>' +
    '<circle cx="16" cy="16" r="14" fill="none" stroke="' + glowColor + '" stroke-width="1" opacity="0.3"/>' +
    '<text x="16" y="22" text-anchor="middle" font-family="Cinzel,Georgia,serif" font-size="20" font-weight="900" fill="' + symbolColor + '" filter="url(#g-' + symbolColor.replace('#','') + ')">' + symbol + '</text>' +
    '</svg>'
  );
}

function _wowArrowPinSvg(arrowPath, fillColor, glowColor) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<defs>' +
    '<filter id="g-arrow" x="-50%" y="-50%" width="200%" height="200%">' +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur"/>' +
    '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>' +
    '</filter>' +
    '</defs>' +
    '<circle cx="16" cy="16" r="14" fill="#130F1A" stroke="' + fillColor + '" stroke-width="2.5"/>' +
    '<circle cx="16" cy="16" r="14" fill="none" stroke="' + glowColor + '" stroke-width="1" opacity="0.25"/>' +
    '<g transform="translate(16,16)" filter="url(#g-arrow)">' + arrowPath + '</g>' +
    '</svg>'
  );
}

const _PIN_BUILDERS = {
  unassigned:      () => _wowSymbolPinSvg("!", "#F0C060", "#F0C060", "#C8973A"),
  assigned:        () => _wowSymbolPinSvg("?", "#F0C060", "#F0C060", "#C8973A"),
  picked_up:       () => _wowArrowPinSvg('<path d="M0,-9 L5,2 L2,2 L2,9 L-2,9 L-2,2 L-5,2 Z" fill="#9D6FC8"/>', "#9D6FC8", "#7B4FA6"),
  en_route:        () => _wowArrowPinSvg('<path d="M-9,0 L2,-5 L2,-2 L9,0 L2,2 L2,5 Z" fill="#6FBD80"/>', "#6FBD80", "#4A9E5C"),
  driver:          () => _wowSymbolPinSvg("D", "#EDE0C4", "#7A5C22", "#7A5C22"),
  driver_selected: () => _wowSymbolPinSvg("D", "#F5D98B", "#F0C060", "#C8973A"),
};

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Inject popup styling once. Mirrors the web app's WoW-flavored dark/gold theme.
let _stylesInjected = false;
function _injectPopupStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  _stylesInjected = true;

  if (!document.getElementById("cinzel-font")) {
    const fontLink = document.createElement("link");
    fontLink.id = "cinzel-font";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap";
    document.head.appendChild(fontLink);
  }

  const style = document.createElement("style");
  style.id = "discra-popup-styles";
  style.textContent = `
    .leaflet-popup.discra-popup-wrapper .leaflet-popup-content-wrapper {
      background: transparent;
      box-shadow: none;
      border-radius: 0;
      padding: 0;
    }
    .leaflet-popup.discra-popup-wrapper .leaflet-popup-content {
      margin: 0;
      width: auto !important;
      min-width: 220px;
    }
    .leaflet-popup.discra-popup-wrapper .leaflet-popup-tip {
      background: #1C1628;
      border: 1px solid #6B4F2A;
      box-shadow: none;
    }
    .leaflet-popup.discra-popup-wrapper .leaflet-popup-close-button {
      color: #968AA8 !important;
      font-size: 18px;
      padding: 6px 8px 0 0;
    }
    .leaflet-popup.discra-popup-wrapper .leaflet-popup-close-button:hover {
      color: #F0C060 !important;
    }
    .discra-popup {
      background: linear-gradient(180deg, #1C1628 0%, #130F1A 100%);
      border: 2px solid #6B4F2A;
      border-radius: 4px;
      box-shadow:
        inset 0 0 0 1px rgba(200,151,58,0.35),
        0 6px 18px rgba(0,0,0,0.75),
        0 0 12px rgba(200,151,58,0.25);
      color: #EDE0C4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    .discra-popup-header {
      background: linear-gradient(90deg, #2A1E10 0%, #1C1628 60%, #1C1628 100%);
      border-bottom: 1px solid #6B4F2A;
      padding: 8px 28px 8px 14px;
    }
    .discra-popup-title {
      color: #F5D98B;
      font-family: "Cinzel", Georgia, serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-shadow: 0 1px 2px rgba(0,0,0,0.6);
    }
    .discra-popup-body {
      padding: 10px 14px 4px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .discra-popup-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 14px;
    }
    .discra-popup-label {
      color: #968AA8;
      font-family: "Cinzel", Georgia, serif;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .discra-popup-value {
      color: #EDE0C4;
      font-size: 12px;
      font-weight: 500;
      text-align: right;
      max-width: 180px;
    }
    .discra-popup-value--accent { color: #F0C060; font-weight: 700; }
    .discra-popup-action {
      display: block;
      width: calc(100% - 20px);
      margin: 8px 10px 10px 10px;
      padding: 8px 10px;
      background: linear-gradient(180deg, #C8973A 0%, #7A5C22 100%);
      color: #0B0910;
      border: 1px solid #F0C060;
      border-radius: 3px;
      font-family: "Cinzel", Georgia, serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      cursor: pointer;
      transition: filter 0.15s, box-shadow 0.15s;
    }
    .discra-popup-action:hover {
      filter: brightness(1.12);
      box-shadow: 0 0 10px rgba(200,151,58,0.6);
    }
    .discra-popup-action:active { transform: translateY(1px); }
  `;
  document.head.appendChild(style);
}

function _buildPopupHtml({ title, popupRows, actionLabel }) {
  const headerHtml = title
    ? `<div class="discra-popup-header"><span class="discra-popup-title">${_escapeHtml(title)}</span></div>`
    : "";
  const rowsHtml = (popupRows || [])
    .filter((r) => r && (r.value || r.value === 0))
    .map((r) => (
      `<div class="discra-popup-row">` +
        `<span class="discra-popup-label">${_escapeHtml(r.label || "")}</span>` +
        `<span class="discra-popup-value${r.accent ? " discra-popup-value--accent" : ""}">${_escapeHtml(String(r.value))}</span>` +
      `</div>`
    ))
    .join("");
  const bodyHtml = rowsHtml ? `<div class="discra-popup-body">${rowsHtml}</div>` : "";
  const actionHtml = actionLabel
    ? `<button class="discra-popup-action" data-discra-action>${_escapeHtml(actionLabel)}</button>`
    : "";
  return `<div class="discra-popup">${headerHtml}${bodyHtml}${actionHtml}</div>`;
}

function _buildLabelHtml(label) {
  if (!label) return "";
  return (
    '<span style="' +
    'margin-left:6px;padding:2px 8px;' +
    'background:rgba(19,15,26,0.85);color:#EDE0C4;' +
    'border:1px solid #6B4F2A;border-radius:4px;' +
    'font:600 11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'white-space:nowrap;letter-spacing:0.02em;' +
    'box-shadow:0 1px 4px rgba(0,0,0,0.6);' +
    '">' + _escapeHtml(label) + '</span>'
  );
}

function Marker({
  coordinate,
  title,
  description,
  pinColor,
  pinKind,
  label,
  popupRows,
  onAction,
  actionLabel,
}) {
  const { L, map } = React.useContext(MapCtx);
  // Keep latest onAction in a ref so the popup-open listener always calls the
  // current closure (avoids tearing down/re-binding the marker on every render).
  const onActionRef = React.useRef(onAction);
  onActionRef.current = onAction;

  React.useEffect(() => {
    if (!L || !map || !coordinate) return;
    _injectPopupStyles();

    let icon;
    if (pinKind && _PIN_BUILDERS[pinKind]) {
      const svgHtml = _PIN_BUILDERS[pinKind]();
      const labelHtml = _buildLabelHtml(label);
      const PIN_W = 32;
      const labelW = label ? Math.min(220, 16 + label.length * 7) : 0;
      const totalW = PIN_W + labelW;
      icon = L.divIcon({
        className: "",
        html:
          '<div style="display:flex;align-items:center;height:32px;">' +
          svgHtml +
          labelHtml +
          '</div>',
        iconSize: [totalW, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -14],
      });
    } else if (pinColor) {
      icon = L.divIcon({
        className: "",
        html: `<div style="width:13px;height:13px;border-radius:50%;background:${pinColor};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
        iconSize: [13, 13],
        iconAnchor: [6, 6],
        popupAnchor: [0, -8],
      });
    } else {
      icon = new L.Icon.Default();
    }

    const marker = L.marker([coordinate.latitude, coordinate.longitude], { icon }).addTo(map);

    const hasStyledPopup = !!(title || (popupRows && popupRows.length) || actionLabel);
    if (hasStyledPopup) {
      const html = _buildPopupHtml({ title, popupRows, actionLabel });
      marker.bindPopup(html, { className: "discra-popup-wrapper", maxWidth: 320 });

      const handleOpen = () => {
        const popup = marker.getPopup();
        const el = popup && popup.getElement();
        if (!el) return;
        const btn = el.querySelector("[data-discra-action]");
        if (!btn) return;
        const onClick = (ev) => {
          ev.stopPropagation();
          if (onActionRef.current) onActionRef.current();
          marker.closePopup();
        };
        btn.addEventListener("click", onClick, { once: true });
      };
      marker.on("popupopen", handleOpen);
    } else if (description) {
      // Legacy plain popup (kept for back-compat with the old description prop)
      marker.bindPopup(`<strong>${_escapeHtml(title || "")}</strong><br>${_escapeHtml(description)}`);
    }

    return () => { map.removeLayer(marker); };
  }, [
    L, map,
    coordinate && coordinate.latitude, coordinate && coordinate.longitude,
    pinColor, pinKind, label, title, description, actionLabel,
    // popupRows is an array; identity changes break memoization. Stringify for stable dep.
    popupRows ? JSON.stringify(popupRows) : "",
  ]);

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
