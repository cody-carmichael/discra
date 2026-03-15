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
    refreshDispatchSummary: document.getElementById("refresh-dispatch-summary"),
    dispatchSummaryForm: document.getElementById("dispatch-summary-form"),
    dispatchActiveMinutes: document.getElementById("dispatch-active-minutes"),
    dispatchSummaryView: document.getElementById("dispatch-summary-view"),
    dispatchSummaryMessage: document.getElementById("dispatch-summary-message"),
    refreshAuditLogs: document.getElementById("refresh-audit-logs"),
    auditFilterForm: document.getElementById("audit-filter-form"),
    auditActionFilter: document.getElementById("audit-action-filter"),
    auditTargetFilter: document.getElementById("audit-target-filter"),
    auditActorFilter: document.getElementById("audit-actor-filter"),
    auditLimitFilter: document.getElementById("audit-limit-filter"),
    auditLogsView: document.getElementById("audit-logs-view"),
    auditMessage: document.getElementById("audit-message"),
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
    devAuthPanel: document.getElementById("dev-auth-panel"),
    devAuthActions: document.getElementById("dev-auth-actions"),
    workspaceTabs: Array.from(document.querySelectorAll("[data-workspace-target]")),
    workspacePanels: Array.from(document.querySelectorAll("[data-workspace-panel]")),
    statsLastSync: document.getElementById("stats-last-sync"),
    statsSelection: document.getElementById("stats-selection"),
    statsTotalOrders: document.getElementById("stats-total-orders"),
    statsAssignedOrders: document.getElementById("stats-assigned-orders"),
    statsUnassignedOrders: document.getElementById("stats-unassigned-orders"),
    statsActiveDrivers: document.getElementById("stats-active-drivers"),
  };

  let token = C.pullTokenFromHash(storageKey) || C.getStoredToken(storageKey);
  let map = null;
  let mapMarkers = [];
  let driverRefreshTimer = null;
  let lastOrders = [];
  let isAuthorizedRole = false;
  let isAdminRole = false;
  let devAuthEnabled = false;
  let devAuthProfiles = [];
  let devSessionClaims = null;
  const autoDevBootstrapKey = storageKey + "_auto_dev_bootstrapped";
  let selectedOrderIds = new Set();
  let orderFilters = {
    status: "",
    assignedTo: "",
    search: "",
  };
  let auditFilters = {
    action: "",
    targetType: "",
    actorId: "",
    limit: 50,
  };
  let activeWorkspace = "operations";

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
  function _claimsFromDevUser(user) {
    if (!user || typeof user !== "object") {
      return null;
    }
    const groups = Array.isArray(user.groups) ? user.groups : [];
    return {
      sub: user.sub || user.username || "",
      username: user.username || user.sub || "",
      email: user.email || null,
      org_id: user.org_id || "",
      "custom:org_id": user.org_id || "",
      groups: groups,
      "cognito:groups": groups,
      _dev_session: true,
    };
  }

  function _activeClaims() {
    return devSessionClaims || C.decodeJwt(token);
  }

  function formatDistanceMiles(meters) {
    if (!Number.isFinite(meters) || meters < 0) {
      return "-";
    }
    return (meters / 1609.344).toFixed(1) + " mi";
  }

  function formatDurationMinutes(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "-";
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) {
      return minutes + " min";
    }
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return remaining ? hours + "h " + remaining + "m" : hours + "h";
  }

  function statusClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "delivered") {
      return "status-delivered";
    }
    if (value === "failed") {
      return "status-failed";
    }
    return "";
  }

  function setLastSyncStamp() {
    if (!el.statsLastSync) {
      return;
    }
    el.statsLastSync.textContent = new Date().toLocaleTimeString();
  }

  function renderWorkspace(target) {
    activeWorkspace = target || "operations";
    el.workspaceTabs.forEach(function (tab) {
      const isActive = tab.getAttribute("data-workspace-target") === activeWorkspace;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    el.workspacePanels.forEach(function (panel) {
      const isActive = panel.getAttribute("data-workspace-panel") === activeWorkspace;
      panel.classList.toggle("is-active", isActive);
      if (isActive) {
        panel.removeAttribute("hidden");
      } else {
        panel.setAttribute("hidden", "hidden");
      }
    });
  }

  function initWorkspaceTabs() {
    if (!el.workspaceTabs.length || !el.workspacePanels.length) {
      return;
    }
    const hashPanel = (window.location.hash || "").replace("#", "").trim();
    const knownPanels = new Set(["operations", "planning", "insights", "admin"]);
    renderWorkspace(knownPanels.has(hashPanel) ? hashPanel : "operations");
    el.workspaceTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const target = tab.getAttribute("data-workspace-target") || "operations";
        renderWorkspace(target);
        history.replaceState(null, "", "#" + target);
      });
    });
  }

  function updateOrderStats(orders) {
    const list = orders || [];
    const total = list.length;
    const assigned = list.filter(function (order) {
      return !!order.assigned_to;
    }).length;
    const unassigned = Math.max(total - assigned, 0);
    if (el.statsTotalOrders) {
      el.statsTotalOrders.textContent = String(total);
    }
    if (el.statsAssignedOrders) {
      el.statsAssignedOrders.textContent = String(assigned);
    }
    if (el.statsUnassignedOrders) {
      el.statsUnassignedOrders.textContent = String(unassigned);
    }
  }

  function updateActiveDriverStat(count) {
    if (!el.statsActiveDrivers) {
      return;
    }
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    el.statsActiveDrivers.textContent = String(safeCount);
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
    el.refreshDispatchSummary.disabled = !enabled;
    el.dispatchSummaryForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.refreshAuditLogs.disabled = !enabled;
    el.auditFilterForm.querySelectorAll("input, button").forEach(function (element) {
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

  function _readAuditFilters() {
    const parsedLimit = Number.parseInt(el.auditLimitFilter.value || "50", 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;
    return {
      action: (el.auditActionFilter.value || "").trim(),
      targetType: (el.auditTargetFilter.value || "").trim(),
      actorId: (el.auditActorFilter.value || "").trim(),
      limit: safeLimit,
    };
  }

  function _writeAuditFilters() {
    el.auditActionFilter.value = auditFilters.action || "";
    el.auditTargetFilter.value = auditFilters.targetType || "";
    el.auditActorFilter.value = auditFilters.actorId || "";
    el.auditLimitFilter.value = String(auditFilters.limit || 50);
  }

  function _auditLogsPathFromFilters() {
    const params = new URLSearchParams();
    params.set("limit", String(auditFilters.limit || 50));
    if (auditFilters.action) {
      params.set("action", auditFilters.action);
    }
    if (auditFilters.targetType) {
      params.set("target_type", auditFilters.targetType);
    }
    if (auditFilters.actorId) {
      params.set("actor_id", auditFilters.actorId);
    }
    return "/audit/logs?" + params.toString();
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

  async function applyAuditFilters(event) {
    if (event) {
      event.preventDefault();
    }
    auditFilters = _readAuditFilters();
    await refreshAuditLogs();
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
    if (el.statsSelection) {
      el.statsSelection.textContent = String(count);
    }
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

  function startDriverAutoRefresh() {
    if (driverRefreshTimer || !isAuthorizedRole) {
      return;
    }
    driverRefreshTimer = window.setInterval(function () {
      refreshDrivers().catch(function () {
        // Do not interrupt dispatch work if background refresh fails.
      });
    }, 30000);
  }

  function stopDriverAutoRefresh() {
    if (!driverRefreshTimer) {
      return;
    }
    window.clearInterval(driverRefreshTimer);
    driverRefreshTimer = null;
  }

  function evaluateAuthorization(claims) {
    if (!claims) {
      isAuthorizedRole = false;
      isAdminRole = false;
      stopDriverAutoRefresh();
      _clearSelection();
      renderDriverOptions([]);
      updateOrderStats([]);
      updateActiveDriverStat(0);
      setInteractiveState(false);
      setBillingInteractiveState(false);
      el.billingStatus.innerHTML = "No billing provider status loaded.";
      el.billingSummary.innerHTML = "No billing summary loaded.";
      el.billingInvitations.innerHTML = "<li>No invitations found.</li>";
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      el.routeResult.innerHTML = "No route computed yet.";
      return;
    }
    isAuthorizedRole = hasAllowedRole(claims);
    isAdminRole = hasAdminRole(claims);
    if (!isAuthorizedRole) {
      stopDriverAutoRefresh();
      _clearSelection();
    }
    setInteractiveState(isAuthorizedRole);
    setBillingInteractiveState(isAuthorizedRole && isAdminRole);
    if (!isAuthorizedRole) {
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      renderDriverOptions([]);
      C.showMessage(el.authMessage, "This console requires Admin or Dispatcher role.", "error");
      return;
    }
    startDriverAutoRefresh();
    if (!isAdminRole) {
      C.showMessage(el.billingMessage, "Billing controls require Admin role.", "error");
    }
  }
  function requireAuthorized(messageElement) {
    if (!token && !devSessionClaims) {
      C.showMessage(messageElement, "Set a JWT token or start a dev test session first.", "error");
      return false;
    }
    if (!isAuthorizedRole) {
      C.showMessage(messageElement, "Current session does not have Admin/Dispatcher role.", "error");
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
    if (token) {
      devSessionClaims = null;
    }
    el.token.value = token;
    renderClaims();
  }

  function renderClaims() {
    const claims = _activeClaims();
    if (!claims) {
      el.authState.textContent = "No Token";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No token decoded yet.";
      evaluateAuthorization(null);
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    const usingDevSession = !!claims._dev_session && !token;
    el.authState.textContent = usingDevSession
      ? (roles ? "Dev Session: " + roles : "Dev Session")
      : (roles ? "Roles: " + roles : "Token Loaded");
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
      devAuthEnabled = !!(config && config.dev_auth_enabled);
      devAuthProfiles = Array.isArray(config && config.dev_auth_profiles) ? config.dev_auth_profiles : [];
      renderDevAuthActions();
      el.mapStyleUrl.value = (config && config.map_style_url) || defaultMapStyle;
      ensureMap();
    } catch (error) {
      devAuthEnabled = false;
      devAuthProfiles = [];
      renderDevAuthActions();
      el.mapStyleUrl.value = defaultMapStyle;
      ensureMap();
      C.showMessage(el.authMessage, error.message, "error");
    }
  }

  function renderDevAuthActions() {
    if (!el.devAuthPanel || !el.devAuthActions) {
      return;
    }
    if (!devAuthEnabled) {
      el.devAuthPanel.hidden = true;
      el.devAuthActions.innerHTML = "";
      return;
    }

    const adminProfiles = devAuthProfiles
      .map(function (profile, index) {
        return { profile: profile, index: index };
      })
      .filter(function (entry) {
        return entry.profile && adminAllowedRoles.indexOf(entry.profile.role) >= 0;
      });
    if (!adminProfiles.length) {
      el.devAuthPanel.hidden = true;
      el.devAuthActions.innerHTML = "";
      return;
    }

    const buttons = adminProfiles
      .map(function (entry) {
        const profile = entry.profile;
        const label = C.escapeHtml(profile.label || (profile.role + " " + profile.user_id));
        return (
          '<button class="btn btn-accent" type="button" data-dev-auth-index="' +
          entry.index +
          '">' +
          label +
          "</button>"
        );
      })
      .join("");

    el.devAuthPanel.hidden = false;
    el.devAuthActions.innerHTML =
      buttons +
      '<button class="btn btn-ghost" type="button" data-dev-auth-logout="1">Exit Dev Session</button>';
  }

  function _preferredAutoDevProfileIndex() {
    if (!Array.isArray(devAuthProfiles) || !devAuthProfiles.length) {
      return -1;
    }
    const adminIndex = devAuthProfiles.findIndex(function (profile) {
      return profile && profile.role === "Admin";
    });
    if (adminIndex >= 0) {
      return adminIndex;
    }
    return devAuthProfiles.findIndex(function (profile) {
      return profile && adminAllowedRoles.indexOf(profile.role) >= 0;
    });
  }

  async function maybeAutoBootstrapDevSession() {
    if (!devAuthEnabled || token || devSessionClaims) {
      return false;
    }
    if (window.sessionStorage && window.sessionStorage.getItem(autoDevBootstrapKey) === "1") {
      return false;
    }
    const profileIndex = _preferredAutoDevProfileIndex();
    if (profileIndex < 0) {
      return false;
    }
    await loginDevAuthProfile(profileIndex);
    if (window.sessionStorage) {
      window.sessionStorage.setItem(autoDevBootstrapKey, "1");
    }
    C.showMessage(el.authMessage, "Auto-started dev session for first-load testing.", "success");
    return true;
  }

  async function restoreDevAuthSession() {
    if (!devAuthEnabled) {
      devSessionClaims = null;
      return;
    }
    try {
      const session = await C.getDevAuthSession(apiBase);
      if (session && session.active && session.user) {
        devSessionClaims = _claimsFromDevUser(session.user);
        token = C.setStoredToken(storageKey, "");
        el.token.value = token;
        renderClaims();
      }
    } catch (error) {
      // Leave normal token auth available when dev session lookup fails.
    }
  }

  async function loginDevAuthProfile(index) {
    const profile = devAuthProfiles[index];
    if (!profile) {
      return;
    }
    const result = await C.loginDevAuthSession(apiBase, {
      role: profile.role,
      user_id: profile.user_id,
      org_id: profile.org_id,
      email: profile.email || null,
    });
    devSessionClaims = _claimsFromDevUser((result && result.user) || profile);
    token = C.setStoredToken(storageKey, "");
    el.token.value = token;
    renderClaims();
    C.showMessage(el.authMessage, "Dev session ready for " + (profile.label || profile.user_id) + ".", "success");
  }

  async function logoutDevAuthSession(silent) {
    if (devAuthEnabled) {
      try {
        await C.logoutDevAuthSession(apiBase);
      } catch (error) {
        // Keep UI usable even if logout endpoint is unavailable.
      }
    }
    devSessionClaims = null;
    renderClaims();
    if (!silent) {
      C.showMessage(el.authMessage, "Dev session cleared.", "success");
    }
  }

  async function onDevAuthActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.getAttribute("data-dev-auth-logout") === "1") {
      await logoutDevAuthSession();
      return;
    }

    const rawIndex = target.getAttribute("data-dev-auth-index");
    if (rawIndex === null) {
      return;
    }
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || index < 0) {
      return;
    }
    await loginDevAuthProfile(index);
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
    updateOrderStats(lastOrders);
    if (!lastOrders.length) {
      el.ordersBody.innerHTML = "<tr><td colspan=\"6\">No orders available.</td></tr>";
      el.ordersMobile.innerHTML = "<p class=\"panel-help\">No orders available.</p>";
      return;
    }

    const rows = lastOrders.map(function (order) {
      const isSelected = selectedOrderIds.has(order.id);
      const assignLabel = order.assigned_to ? "Reassign" : "Assign";
      const currentStatusClass = statusClass(order.status);
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
        C.escapeHtml(order.customer_name) +
        "<br><small>Ref #" +
        C.escapeHtml(order.reference_number || "-") +
        "</small><br>" +
        orderCell(order) +
        "</td>" +
        "<td><small>Pick Up</small><br>" +
        C.escapeHtml(order.pick_up_address || "-") +
        "<br><small>Delivery</small><br>" +
        C.escapeHtml(order.delivery || "-") +
        "<br><small>Dim: " +
        C.escapeHtml(order.dimensions || "-") +
        " | Wt: " +
        C.escapeHtml(order.weight || "-") +
        "</small></td>" +
        "<td><small>" +
        C.escapeHtml(C.formatTimestamp(order.time_window_start)) +
        " -> " +
        C.escapeHtml(C.formatTimestamp(order.time_window_end)) +
        "</small></td>" +
        "<td>" +
        "<small>Current</small><br>" +
        C.escapeHtml(order.assigned_to || "Unassigned") +
        "<div class=\"mobile-order-actions\">" +
        "<input class=\"compact-input\" list=\"driver-options\" data-driver-id=\"" +
        C.escapeHtml(order.id) +
        "\" placeholder=\"driver sub\" value=\"" +
        C.escapeHtml(order.assigned_to || "") +
        "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        assignLabel +
        "</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"unassign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Unassign</button>" +
        "</div></div></td>" +
        "<td>" +
        "<span class=\"table-status " +
        currentStatusClass +
        "\">" +
        C.escapeHtml(order.status) +
        "</span>" +
        "<div class=\"mobile-order-actions\">" +
        "<select class=\"compact-input\" data-status-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        statusOptions +
        "</select>" +
        "<button class=\"btn btn-accent\" data-action=\"status\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Update</button>" +
        "</div></td>" +
        "</tr>"
      );
    });
    el.ordersBody.innerHTML = rows.join("");

    const mobileCards = lastOrders.map(function (order) {
      const isSelected = selectedOrderIds.has(order.id);
      const assignLabel = order.assigned_to ? "Reassign" : "Assign";
      const currentStatusClass = statusClass(order.status);
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
        "<br>Status: <span class=\"table-status " +
        currentStatusClass +
        "\">" +
        C.escapeHtml(order.status) +
        "</span>" +
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
        "\">" +
        assignLabel +
        "</button>" +
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
      setLastSyncStamp();
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
      updateActiveDriverStat(0);
      return;
    }
    try {
      const drivers = await C.requestJson(apiBase, "/drivers?active_minutes=120", { token });
      renderDriverList(drivers || []);
      renderDriverMarkers(drivers || []);
      updateActiveDriverStat((drivers || []).length);
      setLastSyncStamp();
      C.showMessage(el.driversMessage, "Loaded " + (drivers || []).length + " active drivers.", "success");
    } catch (error) {
      updateActiveDriverStat(0);
      C.showMessage(el.driversMessage, error.message, "error");
    }
  }

  function renderDispatchSummary(summary) {
    if (!summary || typeof summary !== "object") {
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      return;
    }
    const statuses = summary.by_status && typeof summary.by_status === "object"
      ? Object.entries(summary.by_status)
      : [];
    const activeDrivers = Array.isArray(summary.active_driver_ids) ? summary.active_driver_ids : [];
    const statusMarkup = statuses.length
      ? statuses
          .map(function (entry) {
            return (
              "<span class=\"chip\">" +
              C.escapeHtml(entry[0]) +
              ": " +
              C.escapeHtml(String(entry[1])) +
              "</span>"
            );
          })
          .join(" ")
      : "<span class=\"panel-help\">No status counts available.</span>";

    const driversMarkup = activeDrivers.length
      ? activeDrivers.map(function (driverId) {
          return "<span class=\"chip\">" + C.escapeHtml(driverId) + "</span>";
        }).join(" ")
      : "<span class=\"panel-help\">No active drivers in this window.</span>";

    el.dispatchSummaryView.innerHTML =
      "<div class=\"metric-grid\">" +
      "<div class=\"metric-item\"><span>Total Orders</span><strong>" +
      C.escapeHtml(String(summary.total_orders || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Assigned</span><strong>" +
      C.escapeHtml(String(summary.assigned_orders || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Unassigned</span><strong>" +
      C.escapeHtml(String(summary.unassigned_orders || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Active Drivers</span><strong>" +
      C.escapeHtml(String(summary.active_drivers || 0)) +
      "</strong></div>" +
      "</div>" +
      "<p class=\"panel-help\">Generated " +
      C.escapeHtml(C.formatTimestamp(summary.generated_at)) +
      " for org " +
      C.escapeHtml(summary.org_id || "-") +
      ".</p>" +
      "<div><strong>Status Breakdown</strong><div class=\"row\">" +
      statusMarkup +
      "</div></div>" +
      "<div style=\"margin-top:0.6rem;\"><strong>Active Driver IDs</strong><div class=\"row\">" +
      driversMarkup +
      "</div></div>";
  }

  async function refreshDispatchSummary(event) {
    if (event) {
      event.preventDefault();
    }
    if (!requireAuthorized(el.dispatchSummaryMessage)) {
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      return;
    }

    const parsedWindow = Number.parseInt(el.dispatchActiveMinutes.value || "120", 10);
    const activeMinutes = Number.isFinite(parsedWindow) ? Math.min(Math.max(parsedWindow, 1), 1440) : 120;
    el.dispatchActiveMinutes.value = String(activeMinutes);

    try {
      const summary = await C.requestJson(
        apiBase,
        "/reports/dispatch-summary?active_minutes=" + encodeURIComponent(String(activeMinutes)),
        { token }
      );
      renderDispatchSummary(summary);
      setLastSyncStamp();
      C.showMessage(el.dispatchSummaryMessage, "Dispatch summary loaded.", "success");
    } catch (error) {
      C.showMessage(el.dispatchSummaryMessage, error.message, "error");
    }
  }

  function _renderDetailsPreview(details) {
    if (!details || typeof details !== "object") {
      return "No additional details.";
    }
    const entries = Object.entries(details).slice(0, 4);
    if (!entries.length) {
      return "No additional details.";
    }
    return entries
      .map(function (entry) {
        return C.escapeHtml(entry[0]) + ": " + C.escapeHtml(typeof entry[1] === "string" ? entry[1] : JSON.stringify(entry[1]));
      })
      .join(" | ");
  }

  function renderAuditLogs(events) {
    if (!Array.isArray(events) || !events.length) {
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      return;
    }
    const listMarkup = events.map(function (event) {
      return (
        "<li class=\"audit-item\">" +
        "<div class=\"audit-item-head\">" +
        "<strong>" +
        C.escapeHtml(event.action || "-") +
        "</strong>" +
        "<small>" +
        C.escapeHtml(C.formatTimestamp(event.created_at)) +
        "</small>" +
        "</div>" +
        "<p>Actor: " +
        C.escapeHtml(event.actor_id || "system") +
        " | Target: " +
        C.escapeHtml(event.target_type || "-") +
        " " +
        C.escapeHtml(event.target_id || "") +
        "</p>" +
        "<p>" +
        _renderDetailsPreview(event.details) +
        "</p>" +
        "</li>"
      );
    }).join("");
    el.auditLogsView.innerHTML = "<ul class=\"audit-list\">" + listMarkup + "</ul>";
  }

  async function refreshAuditLogs() {
    if (!requireAuthorized(el.auditMessage)) {
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      return;
    }
    try {
      const events = await C.requestJson(apiBase, _auditLogsPathFromFilters(), { token });
      renderAuditLogs(events || []);
      setLastSyncStamp();
      C.showMessage(el.auditMessage, "Loaded " + (events || []).length + " audit event(s).", "success");
    } catch (error) {
      C.showMessage(el.auditMessage, error.message, "error");
    }
  }

  function _pillFromBoolean(value) {
    return value
      ? "<span class=\"pill pill-yes\">Enabled</span>"
      : "<span class=\"pill pill-no\">Disabled</span>";
  }

  function renderBillingSummary(summary) {
    if (!summary || typeof summary !== "object") {
      el.billingSummary.innerHTML = "No billing summary loaded.";
      return;
    }
    const dispatcher = summary.dispatcher_seats || {};
    const driver = summary.driver_seats || {};
    el.billingSummary.innerHTML =
      "<div class=\"panel-title-row\"><h3>Seat Summary</h3></div>" +
      "<div class=\"metric-grid\">" +
      "<div class=\"metric-item\"><span>Dispatcher Used</span><strong>" +
      C.escapeHtml(String(dispatcher.used || 0)) +
      " / " +
      C.escapeHtml(String(dispatcher.total || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Dispatcher Pending</span><strong>" +
      C.escapeHtml(String(dispatcher.pending || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Driver Used</span><strong>" +
      C.escapeHtml(String(driver.used || 0)) +
      " / " +
      C.escapeHtml(String(driver.total || 0)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Driver Pending</span><strong>" +
      C.escapeHtml(String(driver.pending || 0)) +
      "</strong></div>" +
      "</div>" +
      "<div class=\"kv-grid\">" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Plan</span><span class=\"kv-value\">" +
      C.escapeHtml(summary.plan_name || "-") +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Status</span><span class=\"kv-value\">" +
      C.escapeHtml(summary.status || "-") +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Stripe Customer</span><span class=\"kv-value\">" +
      C.escapeHtml(summary.stripe_customer_id || "-") +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Stripe Subscription</span><span class=\"kv-value\">" +
      C.escapeHtml(summary.stripe_subscription_id || "-") +
      "</span></div>" +
      "</div>" +
      "<p class=\"panel-help\">Updated " +
      C.escapeHtml(C.formatTimestamp(summary.updated_at)) +
      ".</p>";
  }

  function renderBillingStatus(statusPayload) {
    if (!statusPayload || typeof statusPayload !== "object") {
      el.billingStatus.innerHTML = "No billing provider status loaded.";
      return;
    }
    el.billingStatus.innerHTML =
      "<div class=\"panel-title-row\"><h3>Provider Status</h3></div>" +
      "<div class=\"kv-grid\">" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Stripe Mode</span><span class=\"kv-value\">" +
      C.escapeHtml(statusPayload.stripe_mode || "-") +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Checkout</span><span class=\"kv-value\">" +
      _pillFromBoolean(!!statusPayload.checkout_enabled) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Webhook Verification</span><span class=\"kv-value\">" +
      _pillFromBoolean(!!statusPayload.webhook_signature_verification_enabled) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Secret Key</span><span class=\"kv-value\">" +
      _pillFromBoolean(!!statusPayload.stripe_secret_key_configured) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Dispatcher Price</span><span class=\"kv-value\">" +
      _pillFromBoolean(!!statusPayload.stripe_dispatcher_price_id_configured) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Driver Price</span><span class=\"kv-value\">" +
      _pillFromBoolean(!!statusPayload.stripe_driver_price_id_configured) +
      "</span></div>" +
      "</div>";
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
      setLastSyncStamp();
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
      setLastSyncStamp();
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
      setLastSyncStamp();
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
        setLastSyncStamp();
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
      await Promise.all([refreshBillingSummary(), refreshBillingInvitations(), refreshAssignableDrivers()]);
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
      await Promise.all([refreshBillingSummary(), refreshBillingInvitations(), refreshAssignableDrivers()]);
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
      await Promise.all([refreshBillingSummary(), refreshBillingInvitations(), refreshAssignableDrivers()]);
    } catch (error) {
      C.showMessage(el.billingMessage, error.message, "error");
    }
  }

  function renderRouteResult(result) {
    if (!result || typeof result !== "object") {
      el.routeResult.innerHTML = "No route computed yet.";
      return;
    }
    const stops = Array.isArray(result.ordered_stops) ? result.ordered_stops : [];
    const stopMarkup = stops.length
      ? stops.map(function (stop) {
          return (
            "<li class=\"route-stop-item\">" +
            "<div class=\"route-stop-head\">" +
            "<strong>Stop " +
            C.escapeHtml(String(stop.sequence || 0)) +
            "</strong>" +
            "<small>Order " +
            C.escapeHtml(stop.order_id || "-") +
            "</small>" +
            "</div>" +
            "<p>" +
            C.escapeHtml(stop.address || (stop.lat + ", " + stop.lng)) +
            "</p>" +
            "<p>Leg: " +
            C.escapeHtml(formatDistanceMiles(stop.distance_from_previous_meters)) +
            " / " +
            C.escapeHtml(formatDurationMinutes(stop.duration_from_previous_seconds)) +
            "</p>" +
            "</li>"
          );
        }).join("")
      : "<li class=\"route-stop-item\"><p>No stops returned by optimizer.</p></li>";

    el.routeResult.innerHTML =
      "<div class=\"metric-grid\">" +
      "<div class=\"metric-item\"><span>Stops</span><strong>" +
      C.escapeHtml(String(stops.length)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Total Distance</span><strong>" +
      C.escapeHtml(formatDistanceMiles(result.total_distance_meters)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Total Duration</span><strong>" +
      C.escapeHtml(formatDurationMinutes(result.total_duration_seconds)) +
      "</strong></div>" +
      "<div class=\"metric-item\"><span>Matrix Source</span><strong>" +
      C.escapeHtml(result.matrix_source || "-") +
      "</strong></div>" +
      "</div>" +
      "<ul class=\"route-stop-list\">" +
      stopMarkup +
      "</ul>";
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
      const stopCount = Array.isArray(result && result.ordered_stops) ? result.ordered_stops.length : 0;
      renderRouteResult(result);
      setLastSyncStamp();
      C.showMessage(el.routeMessage, "Route optimized with " + stopCount + " stops.", "success");
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
      await logoutDevAuthSession(true);
      setToken(result.token || "");
      C.showMessage(el.authMessage, "Hosted UI login complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.authMessage, result.message || "Hosted UI login failed.", "error");
    }
  }

  async function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname;
    const logoutUrl = C.buildHostedLogoutUrl({
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      logoutUri,
    });
    await logoutDevAuthSession(true);
    setToken("");
    renderOrders([]);
    renderDriverList([]);
    updateOrderStats([]);
    updateActiveDriverStat(0);
    renderBillingStatus(null);
    renderBillingSummary(null);
    renderBillingInvitations([]);
    el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
    el.auditLogsView.innerHTML = "No audit logs loaded.";
    el.routeResult.innerHTML = "No route computed yet.";
    C.showMessage(el.authMessage, "Session cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  async function bootstrap() {
    el.token.value = token;
    setInteractiveState(false);
    setBillingInteractiveState(false);
    initWorkspaceTabs();
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
      const nextUrl = window.location.pathname + (nextQuery ? "?" + nextQuery : "") + (window.location.hash || "");
      history.replaceState(null, "", nextUrl);
    }
    registerServiceWorker();
    await loadUiConfig();
    await restoreDevAuthSession();
    await finishHostedLoginCallback();
    await maybeAutoBootstrapDevSession();
    _writeOrderFilters();
    _writeAuditFilters();
    _renderSelectionCount();
    _syncSelectAllCheckbox();
    if (isAuthorizedRole) {
      await Promise.all([
        refreshAssignableDrivers(),
        refreshOrders(),
        refreshDrivers(),
        refreshDispatchSummary(),
        refreshAuditLogs(),
      ]);
      if (isAdminRole) {
        await Promise.all([refreshBillingSummary(), refreshBillingInvitations()]);
      } else {
        renderBillingStatus(null);
        renderBillingSummary(null);
        renderBillingInvitations([]);
      }
    } else {
      renderOrders([]);
      renderDriverList([]);
      updateActiveDriverStat(0);
      renderBillingStatus(null);
      renderBillingSummary(null);
      renderBillingInvitations([]);
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      el.routeResult.innerHTML = "No route computed yet.";
    }
  }

  el.saveToken.addEventListener("click", function () {
    logoutDevAuthSession(true)
      .then(function () {
        setToken(el.token.value);
        C.showMessage(el.authMessage, "Token saved.", "success");
        if (isAuthorizedRole) {
          refreshAssignableDrivers().catch(function () {
            renderDriverOptions([]);
          });
        }
      })
      .catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
  });
  el.clearToken.addEventListener("click", function () {
    logoutDevAuthSession(true)
      .then(function () {
        setToken("");
        renderDriverOptions([]);
        el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
        el.routeResult.innerHTML = "No route computed yet.";
        updateOrderStats([]);
        updateActiveDriverStat(0);
        C.showMessage(el.authMessage, "Session cleared.", "success");
      })
      .catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
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
  el.refreshDispatchSummary.addEventListener("click", function () {
    refreshDispatchSummary().catch(function (error) {
      C.showMessage(el.dispatchSummaryMessage, error.message, "error");
    });
  });
  el.dispatchSummaryForm.addEventListener("submit", function (event) {
    refreshDispatchSummary(event).catch(function (error) {
      C.showMessage(el.dispatchSummaryMessage, error.message, "error");
    });
  });
  el.refreshAuditLogs.addEventListener("click", refreshAuditLogs);
  el.auditFilterForm.addEventListener("submit", function (event) {
    applyAuditFilters(event).catch(function (error) {
      C.showMessage(el.auditMessage, error.message, "error");
    });
  });
  el.optimizeForm.addEventListener("submit", optimizeRoute);
  el.refreshBilling.addEventListener("click", refreshBillingSummary);
  el.refreshInvitations.addEventListener("click", refreshBillingInvitations);
  el.billingSeatsForm.addEventListener("submit", updateBillingSeats);
  el.billingCheckoutForm.addEventListener("submit", startBillingCheckout);
  el.billingPortalForm.addEventListener("submit", startBillingPortal);
  el.billingInviteForm.addEventListener("submit", createBillingInvitation);
  el.billingActivateForm.addEventListener("submit", activateBillingInvitation);
  el.billingInvitations.addEventListener("click", onInvitationActionClick);
  if (el.devAuthActions) {
    el.devAuthActions.addEventListener("click", function (event) {
      onDevAuthActionClick(event).catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
    });
  }
  el.loginHostedUi.addEventListener("click", function () {
    launchHostedLogin().catch(function (error) {
      C.showMessage(el.authMessage, error.message, "error");
    });
  });
  el.logoutHostedUi.addEventListener("click", function () {
    launchHostedLogout().catch(function (error) {
      C.showMessage(el.authMessage, error.message, "error");
    });
  });
  el.mapStyleUrl.addEventListener("change", function () {
    if (map) {
      map.setStyle(el.mapStyleUrl.value || defaultMapStyle);
    }
  });

  bootstrap();
})();
