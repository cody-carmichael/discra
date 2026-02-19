(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_admin_token";
  const apiBase = C.deriveApiBase("/ui/admin");
  const defaultMapStyle = "https://demotiles.maplibre.org/style.json";
  const adminAllowedRoles = ["Admin", "Dispatcher"];

  const el = {
    authState: document.getElementById("auth-state"),
    token: document.getElementById("jwt-token"),
    saveToken: document.getElementById("save-token"),
    clearToken: document.getElementById("clear-token"),
    claims: document.getElementById("claims-view"),
    authMessage: document.getElementById("auth-message"),
    createForm: document.getElementById("create-order-form"),
    createMessage: document.getElementById("create-order-message"),
    refreshOrders: document.getElementById("refresh-orders"),
    ordersBody: document.getElementById("orders-tbody"),
    ordersMobile: document.getElementById("orders-mobile"),
    ordersMessage: document.getElementById("orders-message"),
    refreshDrivers: document.getElementById("refresh-drivers"),
    driversMessage: document.getElementById("drivers-message"),
    driverList: document.getElementById("driver-list"),
    optimizeForm: document.getElementById("optimize-form"),
    routeResult: document.getElementById("route-result"),
    routeMessage: document.getElementById("route-message"),
    mapStyleUrl: document.getElementById("map-style-url"),
    mapContainer: document.getElementById("driver-map"),
    cognitoDomain: document.getElementById("cognito-domain"),
    cognitoClientId: document.getElementById("cognito-client-id"),
    loginHostedUi: document.getElementById("login-hosted-ui"),
    logoutHostedUi: document.getElementById("logout-hosted-ui"),
  };

  let token = C.pullTokenFromHash(storageKey) || C.getStoredToken(storageKey);
  let map = null;
  let mapMarkers = [];
  let lastOrders = [];
  let isAuthorizedRole = false;

  function claimsRoles(claims) {
    if (!claims) {
      return [];
    }
    const groups = claims["cognito:groups"] || claims.groups || [];
    if (Array.isArray(groups)) {
      return groups;
    }
    if (!groups) {
      return [];
    }
    return [String(groups)];
  }

  function hasAllowedRole(claims) {
    const roles = claimsRoles(claims);
    return roles.some(function (role) {
      return adminAllowedRoles.indexOf(role) >= 0;
    });
  }

  function setInteractiveState(enabled) {
    el.createForm.querySelectorAll("input, textarea, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.refreshOrders.disabled = !enabled;
    el.refreshDrivers.disabled = !enabled;
    el.optimizeForm.querySelectorAll("input, textarea, button").forEach(function (element) {
      element.disabled = !enabled;
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("admin-sw.js", { scope: "./" }).catch(function () {
      // Keep dispatch workflow available even if worker registration fails.
    });
  }

  function evaluateAuthorization(claims) {
    if (!claims) {
      isAuthorizedRole = false;
      setInteractiveState(false);
      return;
    }
    isAuthorizedRole = hasAllowedRole(claims);
    setInteractiveState(isAuthorizedRole);
    if (!isAuthorizedRole) {
      C.showMessage(el.authMessage, "This console requires Admin or Dispatcher role.", "error");
    }
  }

  function requireAuthorized(messageElement) {
    if (!token) {
      C.showMessage(messageElement, "Set a JWT token first.", "error");
      return false;
    }
    if (!isAuthorizedRole) {
      C.showMessage(messageElement, "Current token does not have Admin/Dispatcher role.", "error");
      return false;
    }
    return true;
  }

  function setToken(nextToken) {
    token = C.setStoredToken(storageKey, nextToken);
    el.token.value = token;
    renderClaims();
  }

  function renderClaims() {
    const claims = C.decodeJwt(token);
    if (!claims) {
      el.authState.textContent = "No Token";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No token decoded yet.";
      evaluateAuthorization(null);
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    el.authState.textContent = roles ? "Roles: " + roles : "Token Loaded";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.claims.textContent = JSON.stringify(claims, null, 2);
    evaluateAuthorization(claims);
  }

  async function loadUiConfig() {
    try {
      const config = await C.requestJson(apiBase, "/ui/config");
      if (config && config.cognito_domain) {
        el.cognitoDomain.value = config.cognito_domain;
      }
      if (config && config.cognito_client_id) {
        el.cognitoClientId.value = config.cognito_client_id;
      }
      el.mapStyleUrl.value = (config && config.map_style_url) || defaultMapStyle;
      ensureMap();
    } catch (error) {
      el.mapStyleUrl.value = defaultMapStyle;
      ensureMap();
      C.showMessage(el.authMessage, error.message, "error");
    }
  }

  function normalizeCreatePayload(formData) {
    const payload = {
      customer_name: formData.get("customer_name"),
      reference_number: C.toIntOrNull(formData.get("reference_number")),
      pick_up_address: formData.get("pick_up_address"),
      delivery: formData.get("delivery"),
      dimensions: formData.get("dimensions"),
      weight: C.toNumberOrNull(formData.get("weight")),
      phone: formData.get("phone") || null,
      email: formData.get("email") || null,
      notes: formData.get("notes") || null,
      num_packages: C.toIntOrNull(formData.get("num_packages")) || 1,
    };
    return payload;
  }

  async function createOrder(event) {
    event.preventDefault();
    if (!requireAuthorized(el.createMessage)) {
      return;
    }
    const formData = new FormData(el.createForm);
    try {
      const payload = normalizeCreatePayload(formData);
      const created = await C.requestJson(apiBase, "/orders/", {
        method: "POST",
        token,
        json: payload,
      });
      C.showMessage(el.createMessage, "Created order " + created.id, "success");
      el.createForm.reset();
      await refreshOrders();
    } catch (error) {
      C.showMessage(el.createMessage, error.message, "error");
    }
  }

  function orderCell(order) {
    return (
      "<strong>" +
      C.escapeHtml(order.id) +
      "</strong><br><span class=\"chip\">" +
      C.escapeHtml(order.external_order_id || "internal") +
      "</span>"
    );
  }

  function renderOrders(orders) {
    lastOrders = orders || [];
    if (!lastOrders.length) {
      el.ordersBody.innerHTML = "<tr><td colspan=\"7\">No orders available.</td></tr>";
      el.ordersMobile.innerHTML = "<p class=\"panel-help\">No orders available.</p>";
      return;
    }

    const rows = lastOrders.map(function (order) {
      const statusOptions = C.STATUS_VALUES.map(function (statusValue) {
        const selected = statusValue === order.status ? "selected" : "";
        return "<option " + selected + " value=\"" + statusValue + "\">" + statusValue + "</option>";
      }).join("");

      return (
        "<tr>" +
        "<td>" +
        orderCell(order) +
        "</td>" +
        "<td>" +
        C.escapeHtml(order.customer_name) +
        "<br><small>Ref #" +
        C.escapeHtml(order.reference_number || "-") +
        "</small></td>" +
        "<td><small>Pick Up: " +
        C.escapeHtml(order.pick_up_address || "-") +
        "</small><br><small>Delivery: " +
        C.escapeHtml(order.delivery || "-") +
        "</small><br><small>Dim: " +
        C.escapeHtml(order.dimensions || "-") +
        " | Wt: " +
        C.escapeHtml(order.weight || "-") +
        "</small></td>" +
        "<td>" +
        C.escapeHtml(order.status) +
        "</td>" +
        "<td>" +
        C.escapeHtml(order.assigned_to || "-") +
        "</td>" +
        "<td>" +
        "<input class=\"compact-input\" data-driver-id=\"" +
        C.escapeHtml(order.id) +
        "\" placeholder=\"driver sub\" value=\"" +
        C.escapeHtml(order.assigned_to || "") +
        "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Assign</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"unassign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Unassign</button>" +
        "</div></td>" +
        "<td>" +
        "<select class=\"compact-input\" data-status-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        statusOptions +
        "</select>" +
        "<button class=\"btn btn-accent\" data-action=\"status\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Update</button>" +
        "</td>" +
        "</tr>"
      );
    });
    el.ordersBody.innerHTML = rows.join("");

    const mobileCards = lastOrders.map(function (order) {
      const statusOptions = C.STATUS_VALUES.map(function (statusValue) {
        const selected = statusValue === order.status ? "selected" : "";
        return "<option " + selected + " value=\"" + statusValue + "\">" + statusValue + "</option>";
      }).join("");

      return (
        "<article class=\"mobile-order-card\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        "<h3>" +
        C.escapeHtml(order.customer_name) +
        "</h3>" +
        "<p class=\"mobile-order-meta\">" +
        "Order: " +
        C.escapeHtml(order.id) +
        "<br>Ref #: " +
        C.escapeHtml(order.reference_number || "-") +
        "<br>Pick Up: " +
        C.escapeHtml(order.pick_up_address || "-") +
        "<br>Delivery: " +
        C.escapeHtml(order.delivery || "-") +
        "<br>Status: " +
        C.escapeHtml(order.status) +
        "<br>Assigned: " +
        C.escapeHtml(order.assigned_to || "-") +
        "</p>" +
        "<div class=\"mobile-order-actions\">" +
        "<input class=\"compact-input\" data-driver-id=\"" +
        C.escapeHtml(order.id) +
        "\" placeholder=\"driver sub\" value=\"" +
        C.escapeHtml(order.assigned_to || "") +
        "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Assign</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"unassign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Unassign</button>" +
        "</div>" +
        "<select class=\"compact-input\" data-status-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        statusOptions +
        "</select>" +
        "<button class=\"btn btn-accent\" data-action=\"status\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Update Status</button>" +
        "</div>" +
        "</article>"
      );
    });
    el.ordersMobile.innerHTML = mobileCards.join("");
  }

  async function refreshOrders() {
    if (!requireAuthorized(el.ordersMessage)) {
      renderOrders([]);
      return;
    }
    try {
      const orders = await C.requestJson(apiBase, "/orders/", { token });
      renderOrders(orders || []);
      C.showMessage(el.ordersMessage, "Loaded " + (orders || []).length + " orders.", "success");
    } catch (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    }
  }

  async function assignOrder(orderId, driverId) {
    await C.requestJson(apiBase, "/orders/" + orderId + "/assign", {
      method: "POST",
      token,
      json: { driver_id: driverId },
    });
  }

  async function unassignOrder(orderId) {
    await C.requestJson(apiBase, "/orders/" + orderId + "/unassign", {
      method: "POST",
      token,
    });
  }

  async function updateOrderStatus(orderId, statusValue) {
    await C.requestJson(apiBase, "/orders/" + orderId + "/status", {
      method: "POST",
      token,
      json: { status: statusValue },
    });
  }

  function ensureMap() {
    if (!window.maplibregl || !el.mapContainer) {
      return null;
    }
    if (map) {
      return map;
    }
    map = new window.maplibregl.Map({
      container: el.mapContainer,
      style: el.mapStyleUrl.value || defaultMapStyle,
      center: [-97.7431, 30.2672],
      zoom: 4,
    });
    return map;
  }

  function renderDriverMarkers(driverLocations) {
    const currentMap = ensureMap();
    if (!currentMap) {
      return;
    }
    mapMarkers.forEach(function (marker) {
      marker.remove();
    });
    mapMarkers = [];
    if (!driverLocations.length) {
      return;
    }
    const bounds = new window.maplibregl.LngLatBounds();
    driverLocations.forEach(function (item) {
      const marker = new window.maplibregl.Marker({ color: "#ffb347" })
        .setLngLat([item.lng, item.lat])
        .setPopup(
          new window.maplibregl.Popup({ offset: 15 }).setHTML(
            "<strong>" +
              C.escapeHtml(item.driver_id) +
              "</strong><br>Updated: " +
              C.escapeHtml(C.formatTimestamp(item.timestamp))
          )
        )
        .addTo(currentMap);
      mapMarkers.push(marker);
      bounds.extend([item.lng, item.lat]);
    });
    if (driverLocations.length === 1) {
      currentMap.flyTo({ center: [driverLocations[0].lng, driverLocations[0].lat], zoom: 11 });
      return;
    }
    currentMap.fitBounds(bounds, { padding: 36, maxZoom: 12 });
  }

  function renderDriverList(driverLocations) {
    if (!driverLocations.length) {
      el.driverList.innerHTML = "<li>No active drivers in range.</li>";
      return;
    }
    el.driverList.innerHTML = driverLocations
      .map(function (item) {
        return (
          "<li><strong>" +
          C.escapeHtml(item.driver_id) +
          "</strong> @ " +
          item.lat.toFixed(5) +
          ", " +
          item.lng.toFixed(5) +
          " (" +
          C.escapeHtml(C.formatTimestamp(item.timestamp)) +
          ")</li>"
        );
      })
      .join("");
  }

  async function refreshDrivers() {
    if (!requireAuthorized(el.driversMessage)) {
      return;
    }
    try {
      const drivers = await C.requestJson(apiBase, "/drivers?active_minutes=120", { token });
      renderDriverList(drivers || []);
      renderDriverMarkers(drivers || []);
      C.showMessage(el.driversMessage, "Loaded " + (drivers || []).length + " active drivers.", "success");
    } catch (error) {
      C.showMessage(el.driversMessage, error.message, "error");
    }
  }

  async function optimizeRoute(event) {
    event.preventDefault();
    if (!requireAuthorized(el.routeMessage)) {
      return;
    }
    const formData = new FormData(el.optimizeForm);
    const driverId = (formData.get("driver_id") || "").trim();
    if (!driverId) {
      C.showMessage(el.routeMessage, "Driver ID is required.", "error");
      return;
    }
    const payload = {
      driver_id: driverId,
      start_lat: C.toNumberOrNull(formData.get("start_lat")),
      start_lng: C.toNumberOrNull(formData.get("start_lng")),
    };
    const stopsJson = (formData.get("stops_json") || "").trim();
    if (stopsJson) {
      try {
        const parsedStops = JSON.parse(stopsJson);
        if (!Array.isArray(parsedStops)) {
          throw new Error("Stops JSON must be an array.");
        }
        payload.stops = parsedStops;
      } catch (error) {
        C.showMessage(el.routeMessage, "Invalid stops JSON.", "error");
        return;
      }
    }
    try {
      const result = await C.requestJson(apiBase, "/routes/optimize", {
        method: "POST",
        token,
        json: payload,
      });
      el.routeResult.textContent = JSON.stringify(result, null, 2);
      C.showMessage(el.routeMessage, "Route optimized with " + result.ordered_stops.length + " stops.", "success");
    } catch (error) {
      C.showMessage(el.routeMessage, error.message, "error");
    }
  }

  async function onOrderActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.getAttribute("data-action");
    const orderId = target.getAttribute("data-order-id");
    if (!action || !orderId) {
      return;
    }
    if (!requireAuthorized(el.ordersMessage)) {
      return;
    }

    try {
      if (action === "assign") {
        const contextCard = target.closest(".mobile-order-card");
        const input = contextCard
          ? contextCard.querySelector("input[data-driver-id=\"" + orderId + "\"]")
          : el.ordersBody.querySelector("input[data-driver-id=\"" + orderId + "\"]");
        const driverId = input ? input.value.trim() : "";
        if (!driverId) {
          throw new Error("Driver ID is required to assign an order.");
        }
        await assignOrder(orderId, driverId);
      } else if (action === "unassign") {
        await unassignOrder(orderId);
      } else if (action === "status") {
        const contextCard = target.closest(".mobile-order-card");
        const select = contextCard
          ? contextCard.querySelector("select[data-status-id=\"" + orderId + "\"]")
          : el.ordersBody.querySelector("select[data-status-id=\"" + orderId + "\"]");
        const statusValue = select ? select.value : "";
        if (!statusValue) {
          throw new Error("Choose a status first.");
        }
        await updateOrderStatus(orderId, statusValue);
      }
      await refreshOrders();
    } catch (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    }
  }

  function hostedFlowConfig() {
    const redirectUri = window.location.origin + window.location.pathname;
    return {
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      redirectUri,
      storageKey,
    };
  }

  async function launchHostedLogin() {
    const loginUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!loginUrl) {
      C.showMessage(el.authMessage, "Hosted UI domain + client id are required.", "error");
      return;
    }
    window.location.assign(loginUrl);
  }

  async function finishHostedLoginCallback() {
    const result = await C.consumeHostedLoginCallback(hostedFlowConfig());
    if (result.status === "success") {
      setToken(result.token || "");
      C.showMessage(el.authMessage, "Hosted UI login complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.authMessage, result.message || "Hosted UI login failed.", "error");
    }
  }

  function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname;
    const logoutUrl = C.buildHostedLogoutUrl({
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      logoutUri,
    });
    setToken("");
    renderOrders([]);
    renderDriverList([]);
    C.showMessage(el.authMessage, "Token cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  async function bootstrap() {
    el.token.value = token;
    setInteractiveState(false);
    renderClaims();
    registerServiceWorker();
    await loadUiConfig();
    await finishHostedLoginCallback();
    if (isAuthorizedRole) {
      await refreshOrders();
      await refreshDrivers();
    } else {
      renderOrders([]);
      renderDriverList([]);
    }
  }

  el.saveToken.addEventListener("click", function () {
    setToken(el.token.value);
    C.showMessage(el.authMessage, "Token saved.", "success");
  });
  el.clearToken.addEventListener("click", function () {
    setToken("");
    C.showMessage(el.authMessage, "Token cleared.", "success");
  });
  el.createForm.addEventListener("submit", createOrder);
  el.refreshOrders.addEventListener("click", refreshOrders);
  el.ordersBody.addEventListener("click", onOrderActionClick);
  el.ordersMobile.addEventListener("click", onOrderActionClick);
  el.refreshDrivers.addEventListener("click", refreshDrivers);
  el.optimizeForm.addEventListener("submit", optimizeRoute);
  el.loginHostedUi.addEventListener("click", function () {
    launchHostedLogin().catch(function (error) {
      C.showMessage(el.authMessage, error.message, "error");
    });
  });
  el.logoutHostedUi.addEventListener("click", launchHostedLogout);
  el.mapStyleUrl.addEventListener("change", function () {
    if (map) {
      map.setStyle(el.mapStyleUrl.value || defaultMapStyle);
    }
  });

  bootstrap();
})();
