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
    bulkDriverId: document.getElementById("bulk-driver-id"),
    bulkAssignSelected: document.getElementById("bulk-assign-selected"),
    bulkUnassignSelected: document.getElementById("bulk-unassign-selected"),
    clearSelection: document.getElementById("clear-selection"),
    selectionCount: document.getElementById("selection-count"),
    selectAllOrders: document.getElementById("select-all-orders"),
    refreshOrders: document.getElementById("refresh-orders"),
    ordersFilterForm: document.getElementById("orders-filter-form"),
    ordersStatusFilter: document.getElementById("orders-status-filter"),
    ordersAssignedFilter: document.getElementById("orders-assigned-filter"),
    ordersSearchFilter: document.getElementById("orders-search-filter"),
    ordersClearFilters: document.getElementById("orders-clear-filters"),
    ordersBody: document.getElementById("orders-tbody"),
    ordersMobile: document.getElementById("orders-mobile"),
    ordersMessage: document.getElementById("orders-message"),
    driverOptions: document.getElementById("driver-options"),
    refreshDrivers: document.getElementById("refresh-drivers"),
    driversMessage: document.getElementById("drivers-message"),
    driverList: document.getElementById("driver-list"),
    optimizeForm: document.getElementById("optimize-form"),
    routeResult: document.getElementById("route-result"),
    routeMessage: document.getElementById("route-message"),
    refreshBilling: document.getElementById("refresh-billing"),
    billingStatus: document.getElementById("billing-status"),
    billingSummary: document.getElementById("billing-summary"),
    billingSeatsForm: document.getElementById("billing-seats-form"),
    billingCheckoutForm: document.getElementById("billing-checkout-form"),
    billingPortalForm: document.getElementById("billing-portal-form"),
    billingInviteForm: document.getElementById("billing-invite-form"),
    billingActivateForm: document.getElementById("billing-activate-form"),
    refreshInvitations: document.getElementById("refresh-invitations"),
    billingInvitations: document.getElementById("billing-invitations"),
    billingMessage: document.getElementById("billing-message"),
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
  let isAdminRole = false;
  let selectedOrderIds = new Set();
  let orderFilters = {
    status: "",
    assignedTo: "",
    search: "",
  };

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

  function hasAdminRole(claims) {
    return claimsRoles(claims).indexOf("Admin") >= 0;
  }

  function setInteractiveState(enabled) {
    el.createForm.querySelectorAll("input, textarea, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.refreshOrders.disabled = !enabled;
    el.bulkDriverId.disabled = !enabled;
    el.bulkAssignSelected.disabled = !enabled;
    el.bulkUnassignSelected.disabled = !enabled;
    el.clearSelection.disabled = !enabled;
    el.selectAllOrders.disabled = !enabled;
    el.ordersFilterForm.querySelectorAll("input, select, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.refreshDrivers.disabled = !enabled;
    el.optimizeForm.querySelectorAll("input, textarea, button").forEach(function (element) {
      element.disabled = !enabled;
    });
  }

  function setBillingInteractiveState(enabled) {
    el.refreshBilling.disabled = !enabled;
    el.refreshInvitations.disabled = !enabled;
    el.billingSeatsForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingCheckoutForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingPortalForm.querySelectorAll("button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingInviteForm.querySelectorAll("input, select, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingActivateForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
  }

  function _readOrderFilters() {
    return {
      status: (el.ordersStatusFilter.value || "").trim(),
      assignedTo: (el.ordersAssignedFilter.value || "").trim(),
      search: (el.ordersSearchFilter.value || "").trim(),
    };
  }

  function _writeOrderFilters() {
    el.ordersStatusFilter.value = orderFilters.status || "";
    el.ordersAssignedFilter.value = orderFilters.assignedTo || "";
    el.ordersSearchFilter.value = orderFilters.search || "";
  }

  function _ordersPathFromFilters() {
    const params = new URLSearchParams();
    if (orderFilters.status) {
      params.set("status", orderFilters.status);
    }
    if (orderFilters.assignedTo) {
      params.set("assignedTo", orderFilters.assignedTo);
    }
    return "/orders/" + (params.toString() ? "?" + params.toString() : "");
  }

  function _filterOrdersBySearch(orders) {
    if (!orderFilters.search) {
      return orders;
    }
    const search = orderFilters.search.toLowerCase();
    return (orders || []).filter(function (order) {
      const ref = order.reference_number === null || order.reference_number === undefined ? "" : String(order.reference_number);
      const haystack = [
        order.id,
        order.external_order_id,
        order.customer_name,
        ref,
        order.pick_up_address,
        order.delivery,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.indexOf(search) >= 0;
    });
  }

  async function applyOrderFilters(event) {
    if (event) {
      event.preventDefault();
    }
    orderFilters = _readOrderFilters();
    await refreshOrders();
  }

  async function clearOrderFilters() {
    orderFilters = { status: "", assignedTo: "", search: "" };
    _writeOrderFilters();
    await refreshOrders();
  }

  function _syncSelectAllCheckbox() {
    if (!lastOrders.length) {
      el.selectAllOrders.checked = false;
      el.selectAllOrders.indeterminate = false;
      return;
    }
    const selectedCount = lastOrders.filter(function (order) {
      return selectedOrderIds.has(order.id);
    }).length;
    el.selectAllOrders.checked = selectedCount > 0 && selectedCount === lastOrders.length;
    el.selectAllOrders.indeterminate = selectedCount > 0 && selectedCount < lastOrders.length;
  }

  function _renderSelectionCount() {
    const count = selectedOrderIds.size;
    el.selectionCount.textContent = count + " selected";
    if (!count) {
      el.selectionCount.classList.add("status-idle");
      el.selectionCount.classList.remove("status-live");
      return;
    }
    el.selectionCount.classList.remove("status-idle");
    el.selectionCount.classList.add("status-live");
  }

  function _pruneSelectionToVisibleOrders() {
    const visibleIds = new Set(lastOrders.map(function (order) {
      return order.id;
    }));
    selectedOrderIds = new Set(
      Array.from(selectedOrderIds).filter(function (orderId) {
        return visibleIds.has(orderId);
      })
    );
    _syncSelectAllCheckbox();
    _renderSelectionCount();
  }

  function _clearSelection() {
    selectedOrderIds = new Set();
    _syncSelectAllCheckbox();
    _renderSelectionCount();
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
      isAdminRole = false;
      _clearSelection();
      renderDriverOptions([]);
      setInteractiveState(false);
      setBillingInteractiveState(false);
      el.billingStatus.textContent = "No billing provider status loaded.";
      el.billingSummary.textContent = "No billing summary loaded.";
      el.billingInvitations.innerHTML = "<li>No invitations found.</li>";
      return;
    }
    isAuthorizedRole = hasAllowedRole(claims);
    isAdminRole = hasAdminRole(claims);
    if (!isAuthorizedRole) {
      _clearSelection();
    }
    setInteractiveState(isAuthorizedRole);
    setBillingInteractiveState(isAuthorizedRole && isAdminRole);
    if (!isAuthorizedRole) {
      renderDriverOptions([]);
      C.showMessage(el.authMessage, "This console requires Admin or Dispatcher role.", "error");
      return;
    }
    if (!isAdminRole) {
      C.showMessage(el.billingMessage, "Billing controls require Admin role.", "error");
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

  function requireAdmin(messageElement) {
    if (!requireAuthorized(messageElement)) {
      return false;
    }
    if (!isAdminRole) {
      C.showMessage(messageElement, "Admin role is required.", "error");
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
    const startRaw = formData.get("time_window_start");
    const endRaw = formData.get("time_window_end");
    const startDate = startRaw ? new Date(startRaw) : null;
    const endDate = endRaw ? new Date(endRaw) : null;
    const timeWindowStart = startDate && !Number.isNaN(startDate.getTime()) ? startDate.toISOString() : null;
    const timeWindowEnd = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;
    const payload = {
      customer_name: formData.get("customer_name"),
      reference_number: C.toIntOrNull(formData.get("reference_number")),
      pick_up_address: formData.get("pick_up_address"),
      delivery: formData.get("delivery"),
      dimensions: formData.get("dimensions"),
      weight: C.toNumberOrNull(formData.get("weight")),
      time_window_start: timeWindowStart,
      time_window_end: timeWindowEnd,
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
    _pruneSelectionToVisibleOrders();
    if (!lastOrders.length) {
      el.ordersBody.innerHTML = "<tr><td colspan=\"8\">No orders available.</td></tr>";
      el.ordersMobile.innerHTML = "<p class=\"panel-help\">No orders available.</p>";
      return;
    }

    const rows = lastOrders.map(function (order) {
      const isSelected = selectedOrderIds.has(order.id);
      const statusOptions = C.STATUS_VALUES.map(function (statusValue) {
        const selected = statusValue === order.status ? "selected" : "";
        return "<option " + selected + " value=\"" + statusValue + "\">" + statusValue + "</option>";
      }).join("");

      return (
        "<tr>" +
        "<td><input type=\"checkbox\" data-select-order-id=\"" +
        C.escapeHtml(order.id) +
        "\" " +
        (isSelected ? "checked" : "") +
        "></td>" +
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
        "</small><br><small>Window: " +
        C.escapeHtml(C.formatTimestamp(order.time_window_start)) +
        " -> " +
        C.escapeHtml(C.formatTimestamp(order.time_window_end)) +
        "</small></td>" +
        "<td>" +
        C.escapeHtml(order.status) +
        "</td>" +
        "<td>" +
        C.escapeHtml(order.assigned_to || "-") +
        "</td>" +
        "<td>" +
        "<input class=\"compact-input\" list=\"driver-options\" data-driver-id=\"" +
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
      const isSelected = selectedOrderIds.has(order.id);
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
        "<label class=\"field\"><span>Select</span><input type=\"checkbox\" data-select-order-id=\"" +
        C.escapeHtml(order.id) +
        "\" " +
        (isSelected ? "checked" : "") +
        "></label>" +
        "<p class=\"mobile-order-meta\">" +
        "Order: " +
        C.escapeHtml(order.id) +
        "<br>Ref #: " +
        C.escapeHtml(order.reference_number || "-") +
        "<br>Pick Up: " +
        C.escapeHtml(order.pick_up_address || "-") +
        "<br>Delivery: " +
        C.escapeHtml(order.delivery || "-") +
        "<br>Window: " +
        C.escapeHtml(C.formatTimestamp(order.time_window_start)) +
        " -> " +
        C.escapeHtml(C.formatTimestamp(order.time_window_end)) +
        "<br>Status: " +
        C.escapeHtml(order.status) +
        "<br>Assigned: " +
        C.escapeHtml(order.assigned_to || "-") +
        "</p>" +
        "<div class=\"mobile-order-actions\">" +
        "<input class=\"compact-input\" list=\"driver-options\" data-driver-id=\"" +
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
    _syncSelectAllCheckbox();
    _renderSelectionCount();
  }

  async function refreshOrders() {
    if (!requireAuthorized(el.ordersMessage)) {
      renderOrders([]);
      return;
    }
    try {
      const orders = await C.requestJson(apiBase, _ordersPathFromFilters(), { token });
      const filteredOrders = _filterOrdersBySearch(orders || []);
      renderOrders(filteredOrders || []);
      C.showMessage(
        el.ordersMessage,
        "Loaded " + (filteredOrders || []).length + " orders.",
        "success"
      );
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

  function onOrderSelectionChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const orderId = target.getAttribute("data-select-order-id");
    if (!orderId) {
      return;
    }
    if (target.checked) {
      selectedOrderIds.add(orderId);
    } else {
      selectedOrderIds.delete(orderId);
    }
    _syncSelectAllCheckbox();
    _renderSelectionCount();
  }

  function toggleSelectAllOrders() {
    if (!lastOrders.length) {
      _clearSelection();
      return;
    }
    if (el.selectAllOrders.checked) {
      lastOrders.forEach(function (order) {
        selectedOrderIds.add(order.id);
      });
    } else {
      lastOrders.forEach(function (order) {
        selectedOrderIds.delete(order.id);
      });
    }
    renderOrders(lastOrders);
  }

  function _selectedOrderIdList() {
    return Array.from(selectedOrderIds);
  }

  async function bulkAssignSelectedOrders() {
    if (!requireAuthorized(el.ordersMessage)) {
      return;
    }
    const orderIds = _selectedOrderIdList();
    if (!orderIds.length) {
      C.showMessage(el.ordersMessage, "Select at least one order first.", "error");
      return;
    }
    const driverId = (el.bulkDriverId.value || "").trim();
    if (!driverId) {
      C.showMessage(el.ordersMessage, "Driver ID is required for bulk assign.", "error");
      return;
    }
    await C.requestJson(apiBase, "/orders/bulk-assign", {
      method: "POST",
      token,
      json: {
        order_ids: orderIds,
        driver_id: driverId,
      },
    });
    C.showMessage(el.ordersMessage, "Bulk assigned " + orderIds.length + " order(s).", "success");
    await refreshOrders();
  }

  async function bulkUnassignSelectedOrders() {
    if (!requireAuthorized(el.ordersMessage)) {
      return;
    }
    const orderIds = _selectedOrderIdList();
    if (!orderIds.length) {
      C.showMessage(el.ordersMessage, "Select at least one order first.", "error");
      return;
    }
    await C.requestJson(apiBase, "/orders/bulk-unassign", {
      method: "POST",
      token,
      json: {
        order_ids: orderIds,
      },
    });
    C.showMessage(el.ordersMessage, "Bulk unassigned " + orderIds.length + " order(s).", "success");
    await refreshOrders();
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

  function renderDriverOptions(users) {
    if (!el.driverOptions) {
      return;
    }
    if (!users || !users.length) {
      el.driverOptions.innerHTML = "";
      return;
    }
    const seen = new Set();
    const options = [];
    users.forEach(function (user) {
      const userId = (user && user.user_id ? String(user.user_id) : "").trim();
      if (!userId || seen.has(userId)) {
        return;
      }
      seen.add(userId);
      const username = user && user.username ? String(user.username).trim() : "";
      const email = user && user.email ? String(user.email).trim() : "";
      const label = [username, email].filter(Boolean).join(" | ");
      options.push(
        "<option value=\"" +
        C.escapeHtml(userId) +
        "\"" +
        (label ? " label=\"" + C.escapeHtml(label) + "\"" : "") +
        "></option>"
      );
    });
    el.driverOptions.innerHTML = options.join("");
  }

  async function refreshAssignableDrivers() {
    if (!token || !isAuthorizedRole) {
      renderDriverOptions([]);
      return;
    }
    try {
      const users = await C.requestJson(apiBase, "/users?role=Driver", { token });
      renderDriverOptions(users || []);
    } catch (error) {
      renderDriverOptions([]);
    }
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

  function renderBillingSummary(summary) {
    if (!summary) {
      el.billingSummary.textContent = "No billing summary loaded.";
      return;
    }
    el.billingSummary.textContent = JSON.stringify(summary, null, 2);
  }

  function renderBillingStatus(statusPayload) {
    if (!statusPayload) {
      el.billingStatus.textContent = "No billing provider status loaded.";
      return;
    }
    el.billingStatus.textContent = JSON.stringify(statusPayload, null, 2);
  }

  function renderBillingInvitations(invitations) {
    if (!invitations || !invitations.length) {
      el.billingInvitations.innerHTML = "<li>No invitations found.</li>";
      return;
    }

    el.billingInvitations.innerHTML = invitations
      .map(function (invitation) {
        const status = C.escapeHtml(invitation.status || "-");
        const invitationId = C.escapeHtml(invitation.invitation_id || "-");
        const userId = C.escapeHtml(invitation.user_id || "-");
        const role = C.escapeHtml(invitation.role || "-");
        const email = C.escapeHtml(invitation.email || "-");
        const updatedAt = C.escapeHtml(C.formatTimestamp(invitation.updated_at));
        const activateDisabled = invitation.status === "Accepted" ? "disabled" : "";
        const cancelDisabled = invitation.status === "Pending" ? "" : "disabled";

        return (
          "<li>" +
          "<strong>" +
          invitationId +
          "</strong><br>" +
          "User: " +
          userId +
          " | Role: " +
          role +
          " | Status: " +
          status +
          "<br>Email: " +
          email +
          " | Updated: " +
          updatedAt +
          "<div class=\"actions-stack\">" +
          "<button class=\"btn btn-accent\" data-invitation-action=\"activate\" data-invitation-id=\"" +
          invitationId +
          "\" " +
          activateDisabled +
          ">Activate</button>" +
          "<button class=\"btn btn-ghost\" data-invitation-action=\"cancel\" data-invitation-id=\"" +
          invitationId +
          "\" " +
          cancelDisabled +
          ">Cancel</button>" +
          "</div>" +
          "</li>"
        );
      })
      .join("");
  }

  async function refreshBillingSummary() {
    if (!requireAdmin(el.billingMessage)) {
      renderBillingSummary(null);
      renderBillingStatus(null);
      return;
    }
    try {
      const [statusPayload, summary] = await Promise.all([
        C.requestJson(apiBase, "/billing/status", { token }),
        C.requestJson(apiBase, "/billing/summary", { token }),
      ]);
      renderBillingStatus(statusPayload);
      renderBillingSummary(summary);
      C.showMessage(el.billingMessage, "Loaded billing summary.", "success");
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function refreshBillingInvitations() {
    if (!requireAdmin(el.billingMessage)) {
      renderBillingInvitations([]);
      return;
    }
    try {
      const invitations = await C.requestJson(apiBase, "/billing/invitations", { token });
      renderBillingInvitations(invitations || []);
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function updateBillingSeats(event) {
    event.preventDefault();
    if (!requireAdmin(el.billingMessage)) {
      return;
    }
    const formData = new FormData(el.billingSeatsForm);
    const dispatcherLimit = C.toIntOrNull(formData.get("dispatcher_seat_limit"));
    const driverLimit = C.toIntOrNull(formData.get("driver_seat_limit"));
    if (dispatcherLimit === null && driverLimit === null) {
      C.showMessage(el.billingMessage, "Provide at least one seat limit value.", "error");
      return;
    }
    const payload = {};
    if (dispatcherLimit !== null) {
      payload.dispatcher_seat_limit = dispatcherLimit;
    }
    if (driverLimit !== null) {
      payload.driver_seat_limit = driverLimit;
    }
    try {
      const response = await C.requestJson(apiBase, "/billing/seats", {
        method: "POST",
        token,
        json: payload,
      });
      renderBillingSummary(response.summary);
      C.showMessage(el.billingMessage, "Seat limits updated.", "success");
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function startBillingCheckout(event) {
    event.preventDefault();
    if (!requireAdmin(el.billingMessage)) {
      return;
    }

    const formData = new FormData(el.billingCheckoutForm);
    const dispatcherLimit = C.toIntOrNull(formData.get("dispatcher_seat_limit"));
    const driverLimit = C.toIntOrNull(formData.get("driver_seat_limit"));
    if (dispatcherLimit === null && driverLimit === null) {
      C.showMessage(el.billingMessage, "Provide at least one checkout seat limit value.", "error");
      return;
    }

    const currentPageUrl = window.location.origin + window.location.pathname;
    const payload = {
      success_url: currentPageUrl + "?billing=success",
      cancel_url: currentPageUrl + "?billing=cancel",
    };
    if (dispatcherLimit !== null) {
      payload.dispatcher_seat_limit = dispatcherLimit;
    }
    if (driverLimit !== null) {
      payload.driver_seat_limit = driverLimit;
    }

    try {
      const response = await C.requestJson(apiBase, "/billing/checkout", {
        method: "POST",
        token,
        json: payload,
      });
      if (response.mode === "subscription_update" && response.summary) {
        renderBillingSummary(response.summary);
        C.showMessage(el.billingMessage, "Stripe subscription updated.", "success");
        return;
      }
      if (response.mode === "checkout_session" && response.checkout_url) {
        C.showMessage(el.billingMessage, "Redirecting to Stripe checkout...", "success");
        window.location.assign(response.checkout_url);
        return;
      }
      C.showMessage(el.billingMessage, "Checkout response did not include a redirect URL.", "error");
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function startBillingPortal(event) {
    event.preventDefault();
    if (!requireAdmin(el.billingMessage)) {
      return;
    }
    const currentPageUrl = window.location.origin + window.location.pathname;
    try {
      const response = await C.requestJson(apiBase, "/billing/portal", {
        method: "POST",
        token,
        json: { return_url: currentPageUrl },
      });
      if (response.portal_url) {
        C.showMessage(el.billingMessage, "Redirecting to Stripe billing portal...", "success");
        window.location.assign(response.portal_url);
        return;
      }
      C.showMessage(el.billingMessage, "Portal response did not include a redirect URL.", "error");
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function createBillingInvitation(event) {
    event.preventDefault();
    if (!requireAdmin(el.billingMessage)) {
      return;
    }
    const formData = new FormData(el.billingInviteForm);
    const userId = String(formData.get("user_id") || "").trim();
    const role = String(formData.get("role") || "").trim();
    if (!userId) {
      C.showMessage(el.billingMessage, "User ID is required.", "error");
      return;
    }
    const payload = {
      user_id: userId,
      role: role || "Dispatcher",
    };
    const email = String(formData.get("email") || "").trim();
    if (email) {
      payload.email = email;
    }
    try {
      const invitation = await C.requestJson(apiBase, "/billing/invitations", {
        method: "POST",
        token,
        json: payload,
      });
      C.showMessage(el.billingMessage, "Invitation created: " + invitation.invitation_id, "success");
      el.billingInviteForm.reset();
      await refreshBillingSummary();
      await refreshBillingInvitations();
      await refreshAssignableDrivers();
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function activateBillingInvitation(event) {
    event.preventDefault();
    if (!requireAdmin(el.billingMessage)) {
      return;
    }
    const formData = new FormData(el.billingActivateForm);
    const invitationId = String(formData.get("invitation_id") || "").trim();
    if (!invitationId) {
      C.showMessage(el.billingMessage, "Invitation ID is required.", "error");
      return;
    }
    try {
      const userRecord = await C.requestJson(apiBase, "/billing/invitations/" + invitationId + "/activate", {
        method: "POST",
        token,
      });
      C.showMessage(el.billingMessage, "Invitation activated for " + (userRecord.user_id || "user"), "success");
      el.billingActivateForm.reset();
      await refreshBillingSummary();
      await refreshBillingInvitations();
      await refreshAssignableDrivers();
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  async function onInvitationActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.getAttribute("data-invitation-action");
    const invitationId = target.getAttribute("data-invitation-id");
    if (!action || !invitationId) {
      return;
    }
    if (!requireAdmin(el.billingMessage)) {
      return;
    }

    try {
      if (action === "activate") {
        await C.requestJson(apiBase, "/billing/invitations/" + invitationId + "/activate", {
          method: "POST",
          token,
        });
        C.showMessage(el.billingMessage, "Invitation activated: " + invitationId, "success");
      } else if (action === "cancel") {
        await C.requestJson(apiBase, "/billing/invitations/" + invitationId + "/cancel", {
          method: "POST",
          token,
        });
        C.showMessage(el.billingMessage, "Invitation cancelled: " + invitationId, "success");
      }
      await refreshBillingSummary();
      await refreshBillingInvitations();
      await refreshAssignableDrivers();
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
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
    renderBillingStatus(null);
    renderBillingSummary(null);
    renderBillingInvitations([]);
    C.showMessage(el.authMessage, "Token cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  async function bootstrap() {
    el.token.value = token;
    setInteractiveState(false);
    setBillingInteractiveState(false);
    renderClaims();
    const params = new URLSearchParams(window.location.search);
    const billingState = params.get("billing");
    if (billingState === "success") {
      C.showMessage(el.billingMessage, "Stripe checkout completed. Refresh summary to confirm webhook sync.", "success");
    } else if (billingState === "cancel") {
      C.showMessage(el.billingMessage, "Stripe checkout canceled.", "error");
    }
    if (billingState) {
      params.delete("billing");
      const nextQuery = params.toString();
      const nextUrl = window.location.pathname + (nextQuery ? "?" + nextQuery : "");
      history.replaceState(null, "", nextUrl);
    }
    registerServiceWorker();
    await loadUiConfig();
    await finishHostedLoginCallback();
    _writeOrderFilters();
    _renderSelectionCount();
    _syncSelectAllCheckbox();
    if (isAuthorizedRole) {
      await refreshAssignableDrivers();
      await refreshOrders();
      await refreshDrivers();
      if (isAdminRole) {
        await refreshBillingSummary();
        await refreshBillingInvitations();
      } else {
        renderBillingStatus(null);
        renderBillingSummary(null);
        renderBillingInvitations([]);
      }
    } else {
      renderOrders([]);
      renderDriverList([]);
      renderBillingStatus(null);
      renderBillingSummary(null);
      renderBillingInvitations([]);
    }
  }

  el.saveToken.addEventListener("click", function () {
    setToken(el.token.value);
    C.showMessage(el.authMessage, "Token saved.", "success");
    if (isAuthorizedRole) {
      refreshAssignableDrivers().catch(function () {
        renderDriverOptions([]);
      });
    }
  });
  el.clearToken.addEventListener("click", function () {
    setToken("");
    renderDriverOptions([]);
    C.showMessage(el.authMessage, "Token cleared.", "success");
  });
  el.createForm.addEventListener("submit", createOrder);
  el.refreshOrders.addEventListener("click", refreshOrders);
  el.bulkAssignSelected.addEventListener("click", function () {
    bulkAssignSelectedOrders().catch(function (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    });
  });
  el.bulkUnassignSelected.addEventListener("click", function () {
    bulkUnassignSelectedOrders().catch(function (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    });
  });
  el.clearSelection.addEventListener("click", function () {
    _clearSelection();
    renderOrders(lastOrders);
  });
  el.selectAllOrders.addEventListener("change", toggleSelectAllOrders);
  el.ordersFilterForm.addEventListener("submit", function (event) {
    applyOrderFilters(event).catch(function (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    });
  });
  el.ordersClearFilters.addEventListener("click", function () {
    clearOrderFilters().catch(function (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    });
  });
  el.ordersBody.addEventListener("change", onOrderSelectionChange);
  el.ordersMobile.addEventListener("change", onOrderSelectionChange);
  el.ordersBody.addEventListener("click", onOrderActionClick);
  el.ordersMobile.addEventListener("click", onOrderActionClick);
  el.refreshDrivers.addEventListener("click", refreshDrivers);
  el.optimizeForm.addEventListener("submit", optimizeRoute);
  el.refreshBilling.addEventListener("click", refreshBillingSummary);
  el.refreshInvitations.addEventListener("click", refreshBillingInvitations);
  el.billingSeatsForm.addEventListener("submit", updateBillingSeats);
  el.billingCheckoutForm.addEventListener("submit", startBillingCheckout);
  el.billingPortalForm.addEventListener("submit", startBillingPortal);
  el.billingInviteForm.addEventListener("submit", createBillingInvitation);
  el.billingActivateForm.addEventListener("submit", activateBillingInvitation);
  el.billingInvitations.addEventListener("click", onInvitationActionClick);
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
