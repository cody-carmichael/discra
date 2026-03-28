(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_driver_auth";
  const apiBase = C.deriveApiBase("/ui/driver");
  const driverAllowedRoles = ["Driver", "Admin", "Dispatcher"];
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";
  const defaultMapStyle = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

  const el = {
    loginScreen: document.getElementById("login-screen"),
    loginScreenBtn: document.getElementById("login-screen-btn"),
    loginScreenMessage: document.getElementById("login-screen-message"),
    appShell: document.getElementById("app-shell"),
    authState: document.getElementById("driver-auth-state"),
    token: document.getElementById("driver-jwt-token"),
    saveToken: document.getElementById("driver-save-token"),
    clearToken: document.getElementById("driver-clear-token"),
    claims: document.getElementById("driver-claims-view"),
    authMessage: document.getElementById("driver-auth-message"),
    refreshInbox: document.getElementById("refresh-inbox"),
    orders: document.getElementById("driver-orders"),
    ordersMessage: document.getElementById("driver-orders-message"),
    stopCount: document.getElementById("stop-count"),
    directionsList: document.getElementById("directions-list"),
    tabStops: document.getElementById("tab-stops"),
    tabDirections: document.getElementById("tab-directions"),
    locationBar: document.getElementById("location-bar"),
    locationStatus: document.getElementById("location-status"),
    cognitoDomain: document.getElementById("driver-cognito-domain"),
    cognitoClientId: document.getElementById("driver-cognito-client-id"),
    loginHostedUi: document.getElementById("driver-login-hosted-ui"),
    logoutHostedUi: document.getElementById("driver-logout-hosted-ui"),
    authDebug: document.getElementById("driver-auth-debug"),
    devAuthPanel: document.getElementById("driver-dev-auth-panel"),
    devAuthActions: document.getElementById("driver-dev-auth-actions"),
    mapContainer: document.getElementById("driver-map"),
    routePrompt: document.getElementById("route-prompt"),
    routePromptText: document.getElementById("route-prompt-text"),
    routeGo: document.getElementById("route-go"),
    routeCancel: document.getElementById("route-cancel"),
    routeStats: document.getElementById("route-stats"),
    routeStatsText: document.getElementById("route-stats-text"),
    detailPanel: document.getElementById("driver-detail-panel"),
    detailCustomerName: document.getElementById("detail-customer-name"),
    detailBody: document.getElementById("detail-body"),
    detailClose: document.getElementById("detail-close"),
    bottomSheet: document.getElementById("bottom-sheet"),
    sheetHandle: document.getElementById("sheet-handle"),
    profileBtn: document.getElementById("profile-btn"),
    profileAvatar: document.getElementById("profile-avatar"),
    profileModal: document.getElementById("profile-modal"),
    profileClose: document.getElementById("profile-close"),
    profileForm: document.getElementById("profile-form"),
    profilePhone: document.getElementById("profile-phone"),
    profileEmail: document.getElementById("profile-email"),
    profilePhotoUrl: document.getElementById("profile-photo-url"),
    profilePhotoFile: document.getElementById("profile-photo-file"),
    profilePhotoPreview: document.getElementById("profile-photo-preview"),
    profileTsa: document.getElementById("profile-tsa"),
    profileMessage: document.getElementById("profile-message"),
  };

  let token = "";
  let locationTimer = null;
  let isAuthorizedRole = false;
  let devAuthEnabled = false;
  let devAuthProfiles = [];
  let devSessionClaims = null;
  let webSessionClaims = null;
  const autoDevBootstrapKey = storageKey + "_auto_dev_bootstrapped";

  // Map state
  let map = null;
  let stopMarkers = [];
  let driverMarker = null;
  let driverLocation = null;
  let currentOrders = [];
  let selectedOrderId = null;
  let pendingNavigation = null;
  let activeNavigationOrderId = null; // tracks which order we're actively navigating to
  let currentRouteSteps = [];
  const geocodeCache = {};
  const orderCoords = {};
  const activeRouteSourceId = "driver-active-route";
  const activeRouteLayerId = "driver-active-route-layer";

  // ── Auth ─────────────────────────────────────────────────────────

  function claimsRoles(claims) {
    if (!claims) return [];
    var groups = claims["cognito:groups"] || claims.groups || [];
    if (Array.isArray(groups)) return groups;
    if (!groups) return [];
    return [String(groups)];
  }

  function hasAllowedRole(claims) {
    return claimsRoles(claims).some(function (r) { return driverAllowedRoles.indexOf(r) >= 0; });
  }

  function _claimsFromDevUser(user) {
    if (!user || typeof user !== "object") return null;
    var groups = Array.isArray(user.groups) ? user.groups : [];
    return { sub: user.sub || user.username || "", username: user.username || user.sub || "", email: user.email || null, org_id: user.org_id || "", "custom:org_id": user.org_id || "", groups: groups, "cognito:groups": groups, _dev_session: true };
  }

  function _claimsFromWebSessionUser(user) {
    if (!user || typeof user !== "object") return null;
    var groups = Array.isArray(user.groups) ? user.groups : [];
    return { sub: user.sub || user.username || "", username: user.username || user.sub || "", email: user.email || null, org_id: user.org_id || "", "custom:org_id": user.org_id || "", groups: groups, "cognito:groups": groups, _web_session: true };
  }

  function _activeClaims() { return devSessionClaims || webSessionClaims || C.decodeJwt(token); }

  function setInteractiveState(enabled) {
    if (el.refreshInbox) el.refreshInbox.disabled = !enabled;
  }

  function showLoginScreen(show) {
    if (el.loginScreen) el.loginScreen.classList.toggle("hidden", !show);
    if (el.appShell) el.appShell.style.display = show ? "none" : "flex";
  }

  function evaluateAuthorization(claims) {
    if (!claims) {
      isAuthorizedRole = false;
      showLoginScreen(true);
      setInteractiveState(false);
      return;
    }
    isAuthorizedRole = hasAllowedRole(claims);
    if (isAuthorizedRole) {
      showLoginScreen(false);
    } else {
      showLoginScreen(true);
    }
    setInteractiveState(isAuthorizedRole);
    if (!isAuthorizedRole && el.loginScreenMessage) {
      el.loginScreenMessage.textContent = "Driver, Admin, or Dispatcher role required.";
      el.loginScreenMessage.className = "drv-msg error";
    }
  }

  function requireAuthorized(msgEl) {
    if (!token && !devSessionClaims && !webSessionClaims) { if (msgEl) C.showMessage(msgEl, "Sign in to continue.", "error"); return false; }
    if (!isAuthorizedRole) { if (msgEl) C.showMessage(msgEl, "Driver role required.", "error"); return false; }
    return true;
  }

  function setToken(nextToken) {
    token = C.setStoredToken(storageKey + "_debug", nextToken);
    if (token) { devSessionClaims = null; webSessionClaims = null; }
    if (el.token) el.token.value = token;
    renderClaims();
  }

  function renderClaims() {
    var claims = _activeClaims();
    if (!claims) {
      el.authState.textContent = "Offline";
      el.authState.className = "drv-status-pill drv-status-off";
      if (el.claims) el.claims.textContent = "No active web session.";
      evaluateAuthorization(null);
      return;
    }
    var roles = C.tokenRoleSummary(claims);
    var usingDev = !!claims._dev_session;
    var usingWeb = !!claims._web_session;
    el.authState.textContent = usingDev ? "DEV" : "Online";
    el.authState.className = "drv-status-pill drv-status-on";
    if (el.claims) el.claims.textContent = JSON.stringify(claims, null, 2);
    evaluateAuthorization(claims);
  }

  async function loadUiConfig() {
    try {
      var config = await C.requestJson(apiBase, "/ui/config");
      if (config && config.cognito_domain && el.cognitoDomain) el.cognitoDomain.value = config.cognito_domain;
      if (config && config.cognito_client_id && el.cognitoClientId) el.cognitoClientId.value = config.cognito_client_id;
      devAuthEnabled = !!(config && config.dev_auth_enabled);
      devAuthProfiles = Array.isArray(config && config.dev_auth_profiles) ? config.dev_auth_profiles : [];
      renderDevAuthActions();
    } catch (e) { devAuthEnabled = false; devAuthProfiles = []; renderDevAuthActions(); }
  }

  function renderDevAuthActions() {
    if (!el.devAuthPanel || !el.devAuthActions) return;
    if (!devAuthEnabled) { el.devAuthPanel.hidden = true; el.devAuthActions.innerHTML = ""; return; }
    var driverProfiles = devAuthProfiles.map(function (p, i) { return { profile: p, index: i }; }).filter(function (e) { return e.profile && driverAllowedRoles.indexOf(e.profile.role) >= 0; });
    if (!driverProfiles.length) { el.devAuthPanel.hidden = true; el.devAuthActions.innerHTML = ""; return; }
    var btns = driverProfiles.map(function (e) { return '<button class="drv-btn drv-btn-accent drv-btn-sm" type="button" data-dev-auth-index="' + e.index + '">' + C.escapeHtml(e.profile.label || e.profile.role + " " + e.profile.user_id) + "</button>"; }).join("");
    el.devAuthPanel.hidden = false;
    el.devAuthActions.innerHTML = btns + '<button class="drv-btn drv-btn-ghost drv-btn-sm" type="button" data-dev-auth-logout="1">Exit Dev</button>';
  }

  function _preferredAutoDevProfileIndex() {
    if (!Array.isArray(devAuthProfiles) || !devAuthProfiles.length) return -1;
    return devAuthProfiles.findIndex(function (p) { return p && driverAllowedRoles.indexOf(p.role) >= 0; });
  }

  async function maybeAutoBootstrapDevSession() {
    if (!devAuthEnabled || token || devSessionClaims || webSessionClaims) return false;
    if (window.sessionStorage && window.sessionStorage.getItem(autoDevBootstrapKey) === "1") return false;
    var idx = _preferredAutoDevProfileIndex();
    if (idx < 0) return false;
    await loginDevAuthProfile(idx);
    if (window.sessionStorage) window.sessionStorage.setItem(autoDevBootstrapKey, "1");
    return true;
  }

  async function restoreDevAuthSession() {
    if (!devAuthEnabled) { devSessionClaims = null; return; }
    try {
      var session = await C.getDevAuthSession(apiBase);
      if (session && session.active && session.user) {
        devSessionClaims = _claimsFromDevUser(session.user);
        token = C.setStoredToken(storageKey + "_debug", "");
        if (el.token) el.token.value = token;
        renderClaims();
      }
    } catch (e) { /* normal */ }
  }

  async function restoreWebAuthSession() {
    try {
      var session = await C.getAuthSession(apiBase);
      if (session && session.active && session.user) webSessionClaims = _claimsFromWebSessionUser(session.user);
      else webSessionClaims = null;
    } catch (e) { webSessionClaims = null; }
    renderClaims();
    return !!webSessionClaims;
  }

  async function loginDevAuthProfile(index) {
    var profile = devAuthProfiles[index];
    if (!profile) return;
    var result = await C.loginDevAuthSession(apiBase, { role: profile.role, user_id: profile.user_id, org_id: profile.org_id, email: profile.email || null });
    devSessionClaims = _claimsFromDevUser((result && result.user) || profile);
    webSessionClaims = null;
    token = C.setStoredToken(storageKey + "_debug", "");
    if (el.token) el.token.value = token;
    renderClaims();
  }

  async function logoutDevAuthSession(silent) {
    if (devAuthEnabled) { try { await C.logoutDevAuthSession(apiBase); } catch (e) { /* ok */ } }
    devSessionClaims = null;
    renderClaims();
    if (!silent && el.authMessage) C.showMessage(el.authMessage, "Session cleared.", "success");
  }

  async function onDevAuthActionClick(event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("data-dev-auth-logout") === "1") { await logoutDevAuthSession(); return; }
    var rawIndex = target.getAttribute("data-dev-auth-index");
    if (rawIndex === null) return;
    var index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || index < 0) return;
    await loginDevAuthProfile(index);
  }

  function hostedFlowConfig() {
    return {
      domain: el.cognitoDomain ? el.cognitoDomain.value.trim() : "",
      clientId: el.cognitoClientId ? el.cognitoClientId.value.trim() : "",
      redirectUri: window.location.origin + window.location.pathname,
      storageKey: storageKey,
    };
  }

  async function launchHostedLogin() {
    var loginUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!loginUrl) {
      var msgEl = el.loginScreenMessage || el.authMessage;
      if (msgEl) C.showMessage(msgEl, "Sign-in is not configured. Contact support.", "error");
      return;
    }
    window.location.assign(loginUrl);
  }

  // ── Map ─────────────────────────────────────────────────────────

  function ensureMap() {
    if (!window.maplibregl || !el.mapContainer) return null;
    if (map) return map;
    map = new window.maplibregl.Map({
      container: el.mapContainer,
      style: defaultMapStyle,
      center: [-97.7431, 30.2672],
      zoom: 4,
    });
    return map;
  }

  function clearRouteLayer() {
    if (!map) return;
    if (map.getLayer(activeRouteLayerId)) map.removeLayer(activeRouteLayerId);
    if (map.getSource(activeRouteSourceId)) map.removeSource(activeRouteSourceId);
    if (el.routeStats) el.routeStats.style.display = "none";
  }

  function drawRoutePolyline(coords) {
    if (!map || !coords || coords.length < 2) return;
    clearRouteLayer();
    map.addSource(activeRouteSourceId, {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } },
    });
    map.addLayer({
      id: activeRouteLayerId,
      type: "line",
      source: activeRouteSourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#1ca2d4", "line-width": 5, "line-opacity": 0.9 },
    });
  }

  function updateDriverMarker(lat, lng) {
    if (!map) return;
    driverLocation = { lat: lat, lng: lng };
    if (driverMarker) {
      driverMarker.setLngLat([lng, lat]);
      return;
    }
    var markerEl = document.createElement("div");
    markerEl.style.cssText = "width:16px;height:16px;background:#1ca2d4;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    driverMarker = new maplibregl.Marker({ element: markerEl }).setLngLat([lng, lat]).addTo(map);
  }

  function clearStopMarkers() {
    stopMarkers.forEach(function (m) { m.remove(); });
    stopMarkers = [];
  }

  function placeStopPin(order, lat, lng) {
    if (!map) return;
    orderCoords[order.id] = { lat: lat, lng: lng };
    var pinEl = document.createElement("div");
    var isDelivery = String(order.status || "").match(/PickedUp|EnRoute/i);
    var color = isDelivery ? "#34d399" : "#f59e0b";
    pinEl.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="' + color + '" stroke="#0a1019" stroke-width="2"/><text x="14" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="#0a1019">&#x25BC;</text></svg>';
    pinEl.style.cursor = "pointer";
    pinEl.addEventListener("click", function () { selectOrder(order.id); });
    var marker = new maplibregl.Marker({ element: pinEl, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);
    stopMarkers.push(marker);
  }

  // ── Geocoding & Pins ───────────────────────────────────────────

  function _geocodeAndPin(order) {
    var status = String(order.status || "").toLowerCase();
    var isDelivery = status === "pickedup" || status === "enroute";
    var address;
    if (isDelivery) {
      address = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ");
    } else {
      address = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ");
    }
    if (!address) return;
    if (geocodeCache[address]) {
      placeStopPin(order, geocodeCache[address][1], geocodeCache[address][0]);
      return;
    }
    fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(address) + "&limit=1")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.features || !data.features.length) return;
        var coords = data.features[0].geometry.coordinates;
        geocodeCache[address] = coords;
        placeStopPin(order, coords[1], coords[0]);
      })
      .catch(function () { /* skip */ });
  }

  // ── Order Sorting ──────────────────────────────────────────────

  function sortOrdersByDistance(orders) {
    if (!driverLocation || !orders.length) return orders;
    var withDist = orders.map(function (order) {
      var coord = orderCoords[order.id];
      var dist = coord ? _haversine(driverLocation.lat, driverLocation.lng, coord.lat, coord.lng) : Infinity;
      return { order: order, dist: dist };
    });
    withDist.sort(function (a, b) { return a.dist - b.dist; });
    return withDist.map(function (w) { return w.order; });
  }

  function _haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    var dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Order Card Rendering ───────────────────────────────────────

  function _badgeClass(status) {
    var s = String(status || "").toLowerCase();
    if (s === "assigned") return "drv-badge-assigned";
    if (s === "pickedup") return "drv-badge-pickedup";
    if (s === "enroute") return "drv-badge-enroute";
    if (s === "delivered") return "drv-badge-delivered";
    if (s === "failed") return "drv-badge-failed";
    return "drv-badge-created";
  }

  function renderStopCard(order, index) {
    var badge = _badgeClass(order.status);
    var delivery = [order.delivery_street, order.delivery_city].filter(Boolean).join(", ") || "-";
    var isSelected = order.id === selectedOrderId;
    return (
      '<div class="drv-order-card' + (isSelected ? ' selected' : '') + '" data-order-id="' + C.escapeHtml(order.id) + '">' +
      '<div class="drv-order-seq">' + (index + 1) + '</div>' +
      '<div class="drv-order-info">' +
      '<div class="drv-order-name">' + C.escapeHtml(order.customer_name) + '</div>' +
      '<div class="drv-order-addr">' + C.escapeHtml(delivery) + '</div>' +
      '</div>' +
      '<span class="drv-order-badge ' + badge + '">' + C.escapeHtml(order.status) + '</span>' +
      '</div>'
    );
  }

  function renderOrders(orders) {
    currentOrders = orders || [];
    if (el.stopCount) el.stopCount.textContent = currentOrders.length;
    if (!currentOrders.length) {
      el.orders.innerHTML = '<div class="drv-empty"><div class="drv-empty-icon">&#x1F4E6;</div><div class="drv-empty-text">No assigned orders</div></div>';
      return;
    }
    var sorted = sortOrdersByDistance(currentOrders);
    el.orders.innerHTML = sorted.map(renderStopCard).join("");
  }

  // ── Order Selection & Detail Panel ─────────────────────────────

  function selectOrder(orderId) {
    selectedOrderId = orderId;
    var order = currentOrders.find(function (o) { return o.id === orderId; });
    if (!order) return;

    // Highlight card
    document.querySelectorAll(".drv-order-card").forEach(function (c) {
      c.classList.toggle("selected", c.getAttribute("data-order-id") === orderId);
    });

    // Fly to pin
    var coord = orderCoords[orderId];
    if (coord && map) {
      map.flyTo({ center: [coord.lng, coord.lat], zoom: 14, duration: 800 });
    }

    showDetailPanel(order);
    showRoutePrompt(order);
  }

  function showDetailPanel(order) {
    el.detailCustomerName.textContent = order.customer_name || "Order";
    var pickup = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ") || "-";
    var delivery = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-";
    var badge = _badgeClass(order.status);

    el.detailBody.innerHTML =
      '<div class="drv-detail-section">' +
        '<span class="drv-order-badge ' + badge + '">' + C.escapeHtml(order.status) + '</span>' +
        '<span style="margin-left:8px;font-size:.75rem;color:var(--drv-text-muted)">Ref ' + C.escapeHtml(order.reference_id || "-") + '</span>' +
      '</div>' +
      (order.phone ? '<div class="drv-detail-section"><div class="drv-detail-label">PHONE</div><a href="tel:' + C.escapeHtml(order.phone) + '" style="color:var(--drv-accent);font-size:.85rem;">' + C.escapeHtml(order.phone) + '</a></div>' : '') +
      '<div class="drv-detail-section"><div class="drv-detail-label">PICKUP</div><div class="drv-detail-value">' + C.escapeHtml(pickup) + '</div></div>' +
      '<div class="drv-detail-section"><div class="drv-detail-label">DELIVERY</div><div class="drv-detail-value">' + C.escapeHtml(delivery) + '</div></div>' +
      (order.notes ? '<div class="drv-detail-section"><div class="drv-detail-label">NOTES</div><div class="drv-detail-value">' + C.escapeHtml(order.notes) + '</div></div>' : '') +
      '<div class="drv-detail-section"><div class="drv-detail-label">ACTIONS</div><div class="drv-detail-actions">' +
        '<button class="drv-btn drv-btn-accent drv-btn-sm" data-action="status" data-status="PickedUp" data-order-id="' + C.escapeHtml(order.id) + '">Picked Up</button>' +
        '<button class="drv-btn drv-btn-green drv-btn-sm" data-action="status" data-status="EnRoute" data-order-id="' + C.escapeHtml(order.id) + '">En Route</button>' +
        '<button class="drv-btn drv-btn-red drv-btn-sm" data-action="status" data-status="Failed" data-order-id="' + C.escapeHtml(order.id) + '">Failed</button>' +
      '</div></div>' +
      '<div class="drv-pod-section">' +
        '<div class="drv-detail-label" style="margin-bottom:12px;">PROOF OF DELIVERY</div>' +
        '<div class="drv-field"><span class="drv-field-label">Photo</span><input class="pod-photo" type="file" accept="image/*" capture="environment"></div>' +
        '<div class="drv-field"><span class="drv-field-label">Signature</span><div class="drv-sig-wrap"><canvas class="signature-pad" width="320" height="100"></canvas></div>' +
        '<button class="drv-btn drv-btn-ghost drv-btn-xs" data-action="clear-signature" data-order-id="' + C.escapeHtml(order.id) + '">Clear</button></div>' +
        '<div class="drv-field"><span class="drv-field-label">Notes</span><textarea class="pod-notes" rows="2" placeholder="Left with front desk..."></textarea></div>' +
        '<button class="drv-btn drv-btn-green" style="width:100%" data-action="submit-pod" data-order-id="' + C.escapeHtml(order.id) + '">Submit POD &amp; Deliver</button>' +
      '</div>';

    el.detailPanel.style.display = "flex";
    var canvas = el.detailBody.querySelector("canvas.signature-pad");
    if (canvas) setupSignaturePad(canvas);
  }

  function closeDetailPanel() {
    el.detailPanel.style.display = "none";
    selectedOrderId = null;
    document.querySelectorAll(".drv-order-card").forEach(function (c) { c.classList.remove("selected"); });
  }

  // ── Route Prompt & Navigation ──────────────────────────────────

  function showRoutePrompt(order) {
    // Don't re-prompt if we're already navigating to this order
    if (activeNavigationOrderId === order.id) return;
    var status = String(order.status || "").toLowerCase();
    var label = (status === "pickedup" || status === "enroute") ? "Route to Delivery?" : "Route to Pickup?";
    el.routePromptText.textContent = label;
    pendingNavigation = { order: order, target: (status === "pickedup" || status === "enroute") ? "delivery" : "pickup" };
    el.routePrompt.style.display = "flex";
  }

  function hideRoutePrompt() {
    el.routePrompt.style.display = "none";
    pendingNavigation = null;
  }

  async function executeNavigation() {
    if (!pendingNavigation || !driverLocation) {
      C.showMessage(el.ordersMessage, "Location unavailable.", "error");
      hideRoutePrompt();
      return;
    }
    var order = pendingNavigation.order;
    var target = pendingNavigation.target;
    hideRoutePrompt();

    var destAddress;
    if (target === "delivery") {
      destAddress = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ");
    } else {
      destAddress = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ");
    }

    var destCoords;
    if (target === "delivery" && orderCoords[order.id]) {
      destCoords = orderCoords[order.id];
    } else if (geocodeCache[destAddress]) {
      destCoords = { lat: geocodeCache[destAddress][1], lng: geocodeCache[destAddress][0] };
    } else {
      try {
        var resp = await fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(destAddress) + "&limit=1");
        var data = await resp.json();
        if (data.features && data.features.length) {
          var c = data.features[0].geometry.coordinates;
          geocodeCache[destAddress] = c;
          destCoords = { lat: c[1], lng: c[0] };
        }
      } catch (e) { /* fall through */ }
    }

    if (!destCoords) {
      C.showMessage(el.ordersMessage, "Could not geocode destination.", "error");
      return;
    }

    try {
      // Use OSRM public API for street-level routing with turn-by-turn directions
      var osrmUrl = "https://router.project-osrm.org/route/v1/driving/" +
        driverLocation.lng + "," + driverLocation.lat + ";" +
        destCoords.lng + "," + destCoords.lat +
        "?overview=full&geometries=geojson&steps=true";
      var osrmResp = await fetch(osrmUrl);
      var osrmData = await osrmResp.json();

      var routeCoords = [];
      var routeDistM = 0;
      var routeDurS = 0;
      var routeSteps = [];
      var routeBbox = null;

      if (osrmData.code === "Ok" && osrmData.routes && osrmData.routes.length) {
        var osrmRoute = osrmData.routes[0];
        routeCoords = osrmRoute.geometry.coordinates;
        routeDistM = osrmRoute.distance;
        routeDurS = osrmRoute.duration;

        // Extract turn-by-turn from OSRM legs/steps
        (osrmRoute.legs || []).forEach(function (leg) {
          (leg.steps || []).forEach(function (step) {
            if (!step.maneuver) return;
            var instrParts = [];
            var mod = step.maneuver.modifier || "";
            var mtype = step.maneuver.type || "";
            if (mtype === "depart") instrParts.push("Head " + (mod || "north"));
            else if (mtype === "arrive") instrParts.push("Arrive at destination");
            else if (mtype === "turn") instrParts.push("Turn " + mod);
            else if (mtype === "new name" || mtype === "continue") instrParts.push("Continue " + (mod ? mod + " " : ""));
            else if (mtype === "merge") instrParts.push("Merge " + mod);
            else if (mtype === "fork") instrParts.push("Take the " + mod + " fork");
            else if (mtype === "roundabout" || mtype === "rotary") instrParts.push("Enter roundabout, exit " + (step.maneuver.exit || ""));
            else instrParts.push((mtype + " " + mod).trim());
            if (step.name) instrParts.push("onto " + step.name);
            var osrmType = 6; // straight default
            if (mod.indexOf("left") >= 0) osrmType = mod.indexOf("sharp") >= 0 ? 2 : (mod.indexOf("slight") >= 0 ? 4 : 0);
            else if (mod.indexOf("right") >= 0) osrmType = mod.indexOf("sharp") >= 0 ? 3 : (mod.indexOf("slight") >= 0 ? 5 : 1);
            if (mtype === "depart") osrmType = 10;
            if (mtype === "arrive") osrmType = 11;
            if (mtype === "roundabout" || mtype === "rotary") osrmType = 12;
            routeSteps.push({
              instruction: instrParts.join(" ").replace(/\s+/g, " ").trim(),
              distance_meters: step.distance || 0,
              duration_seconds: step.duration || 0,
              type: osrmType,
            });
          });
        });

        // Calculate bounding box from coordinates
        if (routeCoords.length) {
          var lngs = routeCoords.map(function (c) { return c[0]; });
          var lats = routeCoords.map(function (c) { return c[1]; });
          routeBbox = [Math.min.apply(null, lngs), Math.min.apply(null, lats), Math.max.apply(null, lngs), Math.max.apply(null, lats)];
        }
      } else {
        // Fallback to straight line if OSRM fails
        routeCoords = [[driverLocation.lng, driverLocation.lat], [destCoords.lng, destCoords.lat]];
        routeDistM = _haversine(driverLocation.lat, driverLocation.lng, destCoords.lat, destCoords.lng);
        routeDurS = routeDistM / 13.89;
      }

      drawRoutePolyline(routeCoords);
      activeNavigationOrderId = order.id;

      var miles = (routeDistM / 1609.34).toFixed(1);
      var mins = Math.round(routeDurS / 60);
      el.routeStatsText.textContent = miles + " mi \u00B7 ~" + mins + " min";
      el.routeStats.style.display = "flex";

      // Render turn-by-turn directions
      currentRouteSteps = routeSteps;
      renderDirections(currentRouteSteps, routeDistM, routeDurS);

      // Auto-switch to directions tab if we have steps
      if (currentRouteSteps.length) {
        switchTab("directions");
        expandSheet();
      }

      if (routeBbox && map) {
        map.fitBounds([[routeBbox[0], routeBbox[1]], [routeBbox[2], routeBbox[3]]], { padding: 60, duration: 600 });
      } else if (map) {
        map.flyTo({ center: [destCoords.lng, destCoords.lat], zoom: 13, duration: 800 });
      }
    } catch (e) {
      C.showMessage(el.ordersMessage, "Navigation error: " + e.message, "error");
    }
  }

  // ── Signature Pad ──────────────────────────────────────────────

  function setupSignaturePad(canvas) {
    if (!canvas || canvas.dataset.initialized === "1") return;
    canvas.dataset.initialized = "1";
    canvas.dataset.dirty = "0";
    var ctx = canvas.getContext("2d");
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#8ec8e8";
    var drawing = false;
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      var touch = e.touches ? e.touches[0] : e;
      return { x: ((touch.clientX - r.left) / r.width) * canvas.width, y: ((touch.clientY - r.top) / r.height) * canvas.height };
    }
    canvas.addEventListener("pointerdown", function (e) { drawing = true; var p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.dataset.dirty = "1"; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", function (e) { if (!drawing) return; var p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    function end(e) { drawing = false; if (e.pointerId) canvas.releasePointerCapture(e.pointerId); }
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointerleave", end);
    canvas.addEventListener("pointercancel", end);
  }

  function clearSignature(canvas) {
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.dataset.dirty = "0";
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("Could not capture signature.")); }, "image/png");
    });
  }

  // ── Location ───────────────────────────────────────────────────

  async function getCurrentPosition() {
    if (!navigator.geolocation) return null;
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, heading: typeof pos.coords.heading === "number" && !isNaN(pos.coords.heading) ? pos.coords.heading : null }); },
        function () { resolve(null); },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 7000 }
      );
    });
  }

  async function sendLocationUpdate() {
    if (!requireAuthorized(null)) return;
    var loc = await getCurrentPosition();
    if (!loc) {
      el.locationStatus.textContent = "Location unavailable";
      return;
    }
    try {
      await C.requestJson(apiBase, "/drivers/location", { method: "POST", token: token, json: loc });
      el.locationStatus.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      updateDriverMarker(loc.lat, loc.lng);
      // Center map on first location
      if (map && !driverMarker) {
        map.flyTo({ center: [loc.lng, loc.lat], zoom: 12, duration: 1000 });
      }
      renderOrders(currentOrders);
    } catch (e) {
      console.error("Location update failed:", e);
      el.locationStatus.textContent = "Error sharing location";
    }
  }

  function startAutoLocationShare() {
    if (locationTimer) return;
    sendLocationUpdate();
    locationTimer = window.setInterval(sendLocationUpdate, 60000);
  }

  function stopLocationShare() {
    if (!locationTimer) return;
    window.clearInterval(locationTimer);
    locationTimer = null;
    el.locationStatus.textContent = "Offline";
  }

  // ── API Actions ────────────────────────────────────────────────

  async function refreshInbox() {
    if (!requireAuthorized(el.ordersMessage)) { renderOrders([]); return; }
    try {
      var orders = await C.requestJson(apiBase, "/orders/driver/inbox", { token: token });
      currentOrders = orders || [];
      clearStopMarkers();
      currentOrders.forEach(function (order, i) {
        setTimeout(function () { _geocodeAndPin(order); }, i * 200);
      });
      renderOrders(currentOrders);
      if (currentOrders.length) {
        C.showMessage(el.ordersMessage, currentOrders.length + " stops loaded.", "success");
      }

      if (!driverLocation) {
        var loc = await getCurrentPosition();
        if (loc) {
          driverLocation = loc;
          updateDriverMarker(loc.lat, loc.lng);
          setTimeout(function () { renderOrders(currentOrders); }, currentOrders.length * 200 + 500);
        }
      }
    } catch (e) { C.showMessage(el.ordersMessage, e.message, "error"); }
  }

  async function updateOrderStatus(orderId, statusValue) {
    await C.requestJson(apiBase, "/orders/" + orderId + "/status", { method: "POST", token: token, json: { status: statusValue } });
  }

  async function uploadWithPresignedPost(upload, fileBlob, fileName) {
    var formData = new FormData();
    Object.entries(upload.fields || {}).forEach(function (e) { formData.append(e[0], e[1]); });
    formData.append("file", fileBlob, fileName);
    var resp = await fetch(upload.url, { method: "POST", body: formData });
    if (!resp.ok) throw new Error("Upload failed.");
  }

  async function submitPod(orderId) {
    var panel = el.detailBody;
    var notesEl = panel.querySelector(".pod-notes");
    var notes = notesEl ? notesEl.value.trim() : "";
    var photoInput = panel.querySelector(".pod-photo");
    var photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;
    var sigCanvas = panel.querySelector("canvas.signature-pad");

    var artifacts = [];
    if (photoFile) artifacts.push({ artifact_type: "photo", content_type: photoFile.type || "image/jpeg", file_size_bytes: photoFile.size, file_name: photoFile.name || "photo.jpg", blob: photoFile });
    if (sigCanvas && sigCanvas.dataset.dirty === "1") {
      var sigBlob = await canvasToBlob(sigCanvas);
      artifacts.push({ artifact_type: "signature", content_type: "image/png", file_size_bytes: sigBlob.size, file_name: "signature.png", blob: sigBlob });
    }
    if (!artifacts.length) throw new Error("Attach a photo or signature first.");

    var presigned = await C.requestJson(apiBase, "/pod/presign", { method: "POST", token: token, json: { order_id: orderId, artifacts: artifacts.map(function (a) { return { artifact_type: a.artifact_type, content_type: a.content_type, file_size_bytes: a.file_size_bytes, file_name: a.file_name }; }) } });
    for (var i = 0; i < presigned.uploads.length; i++) {
      await uploadWithPresignedPost(presigned.uploads[i], artifacts[i].blob, artifacts[i].file_name);
    }
    var location = await getCurrentPosition();
    var photoKeys = presigned.uploads.filter(function (u) { return u.artifact_type === "photo"; }).map(function (u) { return u.key; });
    var sigKeys = presigned.uploads.filter(function (u) { return u.artifact_type === "signature"; }).map(function (u) { return u.key; });
    await C.requestJson(apiBase, "/pod/metadata", { method: "POST", token: token, json: { order_id: orderId, photo_keys: photoKeys, signature_keys: sigKeys, notes: notes || null, location: location } });
    await updateOrderStatus(orderId, "Delivered");
  }

  // ── Profile ────────────────────────────────────────────────────

  var currentProfile = null;

  function updateProfileAvatar() {
    if (!el.profileAvatar) return;
    if (currentProfile && currentProfile.photo_url) {
      el.profileAvatar.innerHTML = '<img src="' + C.escapeHtml(currentProfile.photo_url) + '" alt="">';
    } else {
      var claims = _activeClaims();
      var name = (claims && claims.username) || "?";
      var parts = name.split(/[\s@._-]/);
      var init = parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.substring(0, 2).toUpperCase();
      el.profileAvatar.textContent = init;
    }
  }

  function updateProfilePhotoPreview() {
    if (!el.profilePhotoPreview) return;
    var url = el.profilePhotoUrl ? el.profilePhotoUrl.value.trim() : "";
    if (url) {
      el.profilePhotoPreview.innerHTML = '<img src="' + C.escapeHtml(url) + '" alt="">';
    } else {
      el.profilePhotoPreview.textContent = "?";
    }
  }

  function resizeImageToDataUrl(file, maxDim, quality) {
    maxDim = maxDim || 256;
    quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = function () { reject(new Error("Failed to load image")); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error("Failed to read file")); };
      reader.readAsDataURL(file);
    });
  }

  function handleProfilePhotoFile() {
    if (!el.profilePhotoFile || !el.profilePhotoFile.files.length) return;
    var file = el.profilePhotoFile.files[0];
    if (!file.type.startsWith("image/")) return;
    resizeImageToDataUrl(file, 256, 0.85).then(function (dataUrl) {
      if (el.profilePhotoUrl) el.profilePhotoUrl.value = dataUrl;
      updateProfilePhotoPreview();
    }).catch(function () {
      C.showMessage(el.profileMessage, "Could not process image.", "error");
    });
  }

  async function loadProfile() {
    try {
      currentProfile = await C.requestJson(apiBase, "/users/me", { token: token });
      if (currentProfile) {
        updateProfileAvatar();
      }
    } catch (e) { /* ok */ }
  }

  function openProfileModal() {
    if (!el.profileModal) return;
    if (currentProfile) {
      if (el.profilePhone) el.profilePhone.value = currentProfile.phone || "";
      if (el.profileEmail) el.profileEmail.value = currentProfile.email || "";
      if (el.profilePhotoUrl) el.profilePhotoUrl.value = currentProfile.photo_url || "";
      if (el.profileTsa) el.profileTsa.checked = !!currentProfile.tsa_certified;
      updateProfilePhotoPreview();
    }
    el.profileModal.style.display = "flex";
  }

  function closeProfileModal() {
    if (el.profileModal) el.profileModal.style.display = "none";
  }

  async function saveProfile() {
    var updates = {};
    if (el.profilePhone) updates.phone = el.profilePhone.value.trim() || null;
    if (el.profileEmail) updates.email = el.profileEmail.value.trim() || null;
    if (el.profilePhotoUrl) updates.photo_url = el.profilePhotoUrl.value.trim() || null;
    if (el.profileTsa) updates.tsa_certified = el.profileTsa.checked;
    try {
      currentProfile = await C.requestJson(apiBase, "/users/me", { method: "PUT", token: token, json: updates });
      updateProfileAvatar();
      C.showMessage(el.profileMessage, "Profile saved.", "success");
      setTimeout(closeProfileModal, 800);
    } catch (e) {
      C.showMessage(el.profileMessage, e.message, "error");
    }
  }

  // ── Directions Rendering ────────────────────────────────────────

  function _dirIcon(type) {
    // ORS maneuver types: 0=left, 1=right, 2=sharp left, 3=sharp right, 4=slight left, 5=slight right
    // 6=straight, 10=depart, 11=arrive, etc.
    if (type === 10) return "&#x1F3C1;"; // depart (flag)
    if (type === 11) return "&#x1F4CD;"; // arrive (pin)
    if (type === 0 || type === 2 || type === 4) return "&#x2B05;"; // left
    if (type === 1 || type === 3 || type === 5) return "&#x27A1;"; // right
    if (type === 6) return "&#x2B06;"; // straight
    if (type === 12 || type === 13) return "&#x21BA;"; // roundabout
    return "&#x25CF;"; // default dot
  }

  function renderDirections(steps, totalDistM, totalDurS) {
    if (!el.directionsList) return;
    if (!steps || !steps.length) {
      el.directionsList.innerHTML = '<div class="drv-empty"><div class="drv-empty-icon">&#x1F9ED;</div><div class="drv-empty-text">Select a stop and tap Go to see directions</div></div>';
      return;
    }
    var miles = (totalDistM / 1609.34).toFixed(1);
    var mins = Math.round(totalDurS / 60);
    var html = '<div class="drv-directions-summary"><span>Turn-by-turn</span><span class="drv-dir-total">' + miles + ' mi &middot; ~' + mins + ' min</span></div>';
    steps.forEach(function (step, i) {
      var stepMiles = (step.distance_meters / 1609.34);
      var distLabel = stepMiles >= 0.1 ? stepMiles.toFixed(1) + " mi" : Math.round(step.distance_meters * 3.281) + " ft";
      var isFirst = i === 0;
      html += '<div class="drv-direction-step' + (isFirst ? ' current' : '') + '">' +
        '<div class="drv-direction-icon">' + _dirIcon(step.type) + '</div>' +
        '<div class="drv-direction-text">' +
          '<div class="drv-dir-instruction">' + C.escapeHtml(step.instruction) + '</div>' +
          '<div class="drv-direction-meta">' + distLabel + '</div>' +
        '</div></div>';
    });
    el.directionsList.innerHTML = html;
  }

  // ── Tab Switching ─────────────────────────────────────────────

  function switchTab(tabName) {
    document.querySelectorAll(".drv-sheet-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === tabName);
    });
    if (el.tabStops) el.tabStops.classList.toggle("active", tabName === "stops");
    if (el.tabDirections) el.tabDirections.classList.toggle("active", tabName === "directions");
  }

  function expandSheet() {
    if (el.bottomSheet) el.bottomSheet.classList.remove("collapsed");
  }

  function collapseSheet() {
    if (el.bottomSheet) el.bottomSheet.classList.add("collapsed");
  }

  // ── Bottom Sheet Drag ──────────────────────────────────────────

  function setupBottomSheet() {
    if (!el.bottomSheet || !el.sheetHandle) return;
    var startY = 0, startTranslate = 0, isDragging = false;
    var sheetHeight = 0;

    // Tab click handlers
    el.bottomSheet.querySelectorAll(".drv-sheet-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        switchTab(tab.getAttribute("data-tab"));
        expandSheet();
      });
    });

    function getTranslateY() {
      var style = window.getComputedStyle(el.bottomSheet);
      var matrix = style.transform;
      if (!matrix || matrix === "none") return 0;
      var m = matrix.match(/matrix\((.+)\)/);
      if (!m) return 0;
      var values = m[1].split(",");
      return parseFloat(values[5]) || 0;
    }

    el.bottomSheet.addEventListener("touchstart", function (e) {
      // Allow scrolling inside content, only drag from handle area or near top
      var target = e.target;
      var isHandle = target === el.sheetHandle || target.closest(".drv-sheet-handle") || target.closest(".drv-sheet-tabs");
      if (!isHandle) return;
      isDragging = true;
      startY = e.touches[0].clientY;
      sheetHeight = el.bottomSheet.offsetHeight;
      startTranslate = getTranslateY();
      el.bottomSheet.classList.add("dragging");
    }, { passive: true });

    document.addEventListener("touchmove", function (e) {
      if (!isDragging) return;
      var dy = e.touches[0].clientY - startY;
      var newTranslate = startTranslate + dy;
      // Clamp: 0 (fully expanded) to sheetHeight - 90 (collapsed)
      newTranslate = Math.max(0, Math.min(newTranslate, sheetHeight - 90));
      el.bottomSheet.style.transform = "translateY(" + newTranslate + "px)";
    }, { passive: true });

    document.addEventListener("touchend", function () {
      if (!isDragging) return;
      isDragging = false;
      el.bottomSheet.classList.remove("dragging");
      // Read current position BEFORE clearing inline transform
      var currentY = getTranslateY() || 0;
      var threshold = (sheetHeight - 90) / 2;
      el.bottomSheet.style.transform = "";
      if (currentY > threshold) {
        collapseSheet();
      } else {
        expandSheet();
      }
    });

    // Tap on handle toggles
    el.sheetHandle.addEventListener("click", function () {
      if (el.bottomSheet.classList.contains("collapsed")) {
        expandSheet();
      } else {
        collapseSheet();
      }
    });
  }

  // ── Event Handlers ─────────────────────────────────────────────

  el.orders.addEventListener("click", function (e) {
    var card = e.target.closest(".drv-order-card");
    if (!card) return;
    var orderId = card.getAttribute("data-order-id");
    if (orderId) selectOrder(orderId);
  });

  el.detailBody.addEventListener("click", async function (e) {
    var target = e.target;
    if (!(target instanceof HTMLElement)) return;
    var action = target.getAttribute("data-action");
    var orderId = target.getAttribute("data-order-id");
    if (!action) return;

    try {
      if (action === "status") {
        var statusValue = target.getAttribute("data-status");
        await updateOrderStatus(orderId, statusValue);
        C.showMessage(el.ordersMessage, "Updated to " + statusValue + ".", "success");
        await refreshInbox();
        closeDetailPanel();
      } else if (action === "clear-signature") {
        var canvas = el.detailBody.querySelector("canvas.signature-pad");
        if (canvas) clearSignature(canvas);
      } else if (action === "submit-pod") {
        await submitPod(orderId);
        C.showMessage(el.ordersMessage, "POD submitted & delivered.", "success");
        await refreshInbox();
        closeDetailPanel();
      }
    } catch (err) {
      C.showMessage(el.ordersMessage, err.message, "error");
    }
  });

  el.detailClose.addEventListener("click", closeDetailPanel);
  el.routeGo.addEventListener("click", function () { executeNavigation().catch(function (e) { C.showMessage(el.ordersMessage, e.message, "error"); }); });
  el.routeCancel.addEventListener("click", function () { hideRoutePrompt(); clearRouteLayer(); activeNavigationOrderId = null; currentRouteSteps = []; renderDirections([], 0, 0); });
  el.refreshInbox.addEventListener("click", refreshInbox);

  // Profile
  if (el.profileBtn) el.profileBtn.addEventListener("click", openProfileModal);
  if (el.profileClose) el.profileClose.addEventListener("click", closeProfileModal);
  if (el.profileForm) el.profileForm.addEventListener("submit", function (e) { e.preventDefault(); saveProfile(); });
  if (el.profilePhotoFile) el.profilePhotoFile.addEventListener("change", handleProfilePhotoFile);
  if (el.profilePhotoUrl) el.profilePhotoUrl.addEventListener("input", updateProfilePhotoPreview);

  // Login screen button
  if (el.loginScreenBtn) {
    el.loginScreenBtn.addEventListener("click", function () {
      launchHostedLogin().catch(function (e) {
        if (el.loginScreenMessage) C.showMessage(el.loginScreenMessage, e.message, "error");
      });
    });
  }

  if (el.devAuthActions) el.devAuthActions.addEventListener("click", function (e) { onDevAuthActionClick(e).catch(function (err) { if (el.authMessage) C.showMessage(el.authMessage, err.message, "error"); }); });

  if (el.loginHostedUi) {
    el.loginHostedUi.addEventListener("click", function () {
      launchHostedLogin().catch(function (e) { if (el.authMessage) C.showMessage(el.authMessage, e.message, "error"); });
    });
  }

  el.logoutHostedUi.addEventListener("click", function () {
    stopLocationShare();
    logoutDevAuthSession(true).then(function () {
      webSessionClaims = null; setToken(""); renderOrders([]); clearRouteLayer(); clearStopMarkers();
    });
  });

  if (el.saveToken) el.saveToken.addEventListener("click", function () { logoutDevAuthSession(true).then(function () { setToken(el.token.value); }); });
  if (el.clearToken) el.clearToken.addEventListener("click", function () { logoutDevAuthSession(true).then(function () { stopLocationShare(); setToken(""); renderOrders([]); }); });

  // ── Bootstrap ──────────────────────────────────────────────────

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("driver-sw.js", { scope: "./" }).catch(function () {});
  }

  async function bootstrap() {
    if (el.token) el.token.value = token;
    if (el.authDebug) el.authDebug.hidden = !debugAuth;
    setInteractiveState(false);
    showLoginScreen(true);
    renderClaims();
    registerServiceWorker();
    setupBottomSheet();
    await loadUiConfig();

    // Handle Cognito callback
    var cbResult = await C.consumeHostedLoginCallback(apiBase, hostedFlowConfig());
    if (cbResult && cbResult.status === "success") {
      await logoutDevAuthSession(true);
      setToken("");
      await restoreWebAuthSession();
    } else {
      await restoreWebAuthSession();
      await restoreDevAuthSession();
    }

    // Init map after auth
    ensureMap();

    if (isAuthorizedRole) {
      // Auto-share location immediately on login
      startAutoLocationShare();
      await loadProfile();
      await refreshInbox();
    } else {
      renderOrders([]);
    }
  }

  bootstrap();
})();
