(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_admin_auth";
  const apiBase = C.deriveApiBase("/ui/admin");
  const defaultMapStyle = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  const terminalStatuses = new Set(["Delivered", "Failed"]);
  const dueSoonMinutes = 120;
  const adminAllowedRoles = ["Admin", "Dispatcher"];
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    loginScreen: document.getElementById("login-screen"),
    loginScreenBtn: document.getElementById("login-screen-btn"),
    loginScreenMessage: document.getElementById("login-screen-message"),
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
    refreshOrdersTable: document.getElementById("refresh-orders-table"),
    ordersFilterForm: document.getElementById("orders-filter-form"),
    ordersStatusFilter: document.getElementById("orders-status-filter"),
    ordersAssignedFilter: document.getElementById("orders-assigned-filter"),
    ordersAssignmentFilter: document.getElementById("orders-assignment-filter"),
    ordersDueFilter: document.getElementById("orders-due-filter"),
    ordersSearchFilter: document.getElementById("orders-search-filter"),
    ordersSortField: document.getElementById("orders-sort-field"),
    ordersSortDirection: document.getElementById("orders-sort-direction"),
    ordersClearFilters: document.getElementById("orders-clear-filters"),
    ordersBody: document.getElementById("orders-tbody"),
    ordersMobile: document.getElementById("orders-mobile"),
    ordersMessage: document.getElementById("orders-message"),
    assignmentMessage: document.getElementById("assignment-message"),
    assignmentContext: document.getElementById("assignment-context"),
    selectedDriverLabel: document.getElementById("selected-driver-label"),
    unassignedQueueCount: document.getElementById("unassigned-queue-count"),
    assignedQueueCount: document.getElementById("assigned-queue-count"),
    unassignedOrdersList: document.getElementById("unassigned-orders-list"),
    assignedOrdersList: document.getElementById("assigned-orders-list"),
    statsUpcomingDue: document.getElementById("stats-upcoming-due"),
    statsUpcomingDueCard: document.getElementById("stats-upcoming-due-card"),
    orderSortButtons: Array.from(document.querySelectorAll("[data-order-sort-field]")),
    driverOptions: document.getElementById("driver-options"),
    refreshDrivers: document.getElementById("refresh-drivers"),
    driversMessage: document.getElementById("drivers-message"),
    driverList: document.getElementById("driver-list"),
    optimizeForm: document.getElementById("optimize-form"),  // removed from DOM
    routeResult: document.getElementById("route-result"),    // removed from DOM
    routeMessage: document.getElementById("route-message"),  // removed from DOM
    inflightList: document.getElementById("inflight-list"),
    inflightCount: document.getElementById("inflight-count"),
    inflightMessage: document.getElementById("inflight-message"),
    refreshInflight: document.getElementById("refresh-inflight"),
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
    billingCheckoutForm: document.getElementById("billing-checkout-form"),
    billingPortalForm: document.getElementById("billing-portal-form"),
    billingInviteForm: document.getElementById("billing-invite-form"),
    refreshInvitations: document.getElementById("refresh-invitations"),
    billingInvitations: document.getElementById("billing-invitations"),
    billingMessage: document.getElementById("billing-message"),
    seatDispatcherUsage: document.getElementById("seat-dispatcher-usage"),
    seatDispatcherDetail: document.getElementById("seat-dispatcher-detail"),
    seatDriverUsage: document.getElementById("seat-driver-usage"),
    seatDriverDetail: document.getElementById("seat-driver-detail"),
    seatAvailableTotal: document.getElementById("seat-available-total"),
    seatAvailableDetail: document.getElementById("seat-available-detail"),
    seatPendingTotal: document.getElementById("seat-pending-total"),
    openPurchaseModal: document.getElementById("open-purchase-modal"),
    closePurchaseModal: document.getElementById("close-purchase-modal"),
    purchaseModal: document.getElementById("purchase-modal"),
    mapContainer: document.getElementById("driver-map"),
    cognitoDomain: document.getElementById("cognito-domain"),
    cognitoClientId: document.getElementById("cognito-client-id"),
    loginHostedUi: document.getElementById("login-hosted-ui"),
    logoutHostedUi: document.getElementById("logout-hosted-ui"),
    logoutHostedUiAuth: document.getElementById("logout-hosted-ui-auth"),
    authDebug: document.getElementById("admin-auth-debug"),
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
    dispatchOrderList: document.getElementById("dispatch-order-list"),
    dispatchOrderSearch: document.getElementById("dispatch-order-search"),
    dispatchFilterBtns: Array.from(document.querySelectorAll("[data-dispatch-filter]")),
  };

  let token = "";
  let map = null;
  let mapMarkers = new Map(); // driver_id → { marker, lat, lng }
  let orderMarkers = [];
  let mapStyleUrl = defaultMapStyle;
  let activeRouteSourceId = "route-line-source";
  let activeRouteLayerId = "route-line-layer";
  let driverRefreshTimer = null;
  let allOrders = [];
  let lastOrders = [];
  let lastDriverLocations = [];
  let lastDriverRoster = [];
  let selectedDriverId = "";
  let isAuthorizedRole = false;
  let isAdminRole = false;
  let devAuthEnabled = false;
  let devAuthProfiles = [];
  let devSessionClaims = null;
  let webSessionClaims = null;
  const autoDevBootstrapKey = storageKey + "_auto_dev_bootstrapped";
  let selectedOrderIds = new Set();
  let orderFilters = {
    status: "",
    assignedTo: "",
    assignment: "",
    due: "",
    search: "",
    sortField: "dropoff_deadline",
    sortDirection: "asc",
  };
  let auditFilters = {
    action: "",
    targetType: "",
    actorId: "",
    limit: 50,
  };
  let activeWorkspace = "operations";
  let dispatchFilter = "all";
  let dispatchSearchTerm = "";

  function _closestDeadlineMs(order) {
    if (!order) return Infinity;
    var candidates = [
      _parseDateOrNull(order.pickup_deadline),
      _parseDateOrNull(order.dropoff_deadline),
    ].filter(Boolean);
    if (!candidates.length) return Infinity;
    return Math.min.apply(null, candidates.map(function (d) { return d.getTime(); }));
  }

  function _statusBadgeClass(status) {
    var s = String(status || "").toLowerCase();
    if (s === "created") return "badge-created";
    if (s === "assigned") return "badge-assigned";
    if (s === "pickedup") return "badge-pickedup";
    if (s === "enroute") return "badge-enroute";
    if (s === "delivered") return "badge-delivered";
    if (s === "failed") return "badge-failed";
    return "badge-created";
  }

  function _dispatchFilterOrders(orders) {
    var list = Array.isArray(orders) ? orders : [];
    var nowDate = new Date();
    var search = (dispatchSearchTerm || "").toLowerCase();

    var filtered = list.filter(function (order) {
      if (dispatchFilter === "dispatched") {
        return order.status === "Assigned" || order.status === "PickedUp";
      }
      if (dispatchFilter === "enroute") {
        return order.status === "EnRoute";
      }
      if (dispatchFilter === "unassigned") {
        return !order.assigned_to || order.status === "Created";
      }
      return true;
    });

    if (search) {
      filtered = filtered.filter(function (order) {
        return _matchesOrderSearch(order, search);
      });
    }

    if (dispatchFilter === "unassigned") {
      filtered.sort(function (a, b) {
        var aMs = _closestDeadlineMs(a);
        var bMs = _closestDeadlineMs(b);
        if (aMs === Infinity && bMs === Infinity) return 0;
        if (aMs === Infinity) return 1;
        if (bMs === Infinity) return -1;
        return aMs - bMs;
      });
    }

    return filtered;
  }

  function _formatDeadlineRelative(order, nowDate) {
    var deadlineDate = _parseDateOrNull(order.pickup_deadline) || _parseDateOrNull(order.dropoff_deadline);
    if (!deadlineDate) return { text: "No deadline", cssClass: "" };
    var deltaMs = deadlineDate.getTime() - nowDate.getTime();
    if (deltaMs < 0) {
      var overdueMin = Math.abs(Math.round(deltaMs / 60000));
      if (overdueMin < 60) return { text: overdueMin + "m overdue", cssClass: "overdue" };
      return { text: Math.floor(overdueMin / 60) + "h overdue", cssClass: "overdue" };
    }
    var minLeft = Math.round(deltaMs / 60000);
    if (minLeft < 60) return { text: minLeft + "m left", cssClass: minLeft <= 30 ? "due-soon" : "" };
    if (minLeft < 1440) return { text: Math.floor(minLeft / 60) + "h " + (minLeft % 60) + "m", cssClass: "" };
    return { text: Math.floor(minLeft / 1440) + "d", cssClass: "" };
  }

  function renderDispatchOrderList() {
    if (!el.dispatchOrderList) return;
    var filtered = _dispatchFilterOrders(allOrders);
    var nowDate = new Date();

    if (el.unassignedQueueCount) {
      var unassignedCount = allOrders.filter(function (o) {
        return !o.assigned_to || o.status === "Created";
      }).length;
      el.unassignedQueueCount.textContent = String(filtered.length);
    }

    if (!filtered.length) {
      el.dispatchOrderList.innerHTML = "<div class=\"dispatch-empty\">No orders match the current filter.</div>";
      return;
    }

    el.dispatchOrderList.innerHTML = filtered.map(function (order) {
      var isUnassigned = !order.assigned_to;
      var deadline = _formatDeadlineRelative(order, nowDate);
      var statusLabel = isUnassigned ? "Unassigned" : order.status;
      var badgeClass = isUnassigned ? "badge-unassigned" : _statusBadgeClass(order.status);
      var driverLabel = isUnassigned ? "Unassigned" : C.escapeHtml(order.assigned_to);
      var dotClass = isUnassigned ? "dispatch-driver-dot unassigned" : "dispatch-driver-dot";
      var pickup = C.escapeHtml([order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ") || "-");
      var delivery = C.escapeHtml([order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-");
      if (pickup.length > 32) pickup = pickup.substring(0, 30) + "...";
      if (delivery.length > 32) delivery = delivery.substring(0, 30) + "...";

      var assignBtnHtml = "";
      if (isUnassigned) {
        assignBtnHtml = "<button class=\"dispatch-card-assign-btn\" type=\"button\" data-queue-action=\"assign-selected\" data-order-id=\"" +
          C.escapeHtml(order.id) + "\"" + (selectedDriverId ? "" : " disabled") + ">Assign" +
          (selectedDriverId ? " to " + C.escapeHtml(selectedDriverId) : " (select driver)") + "</button>";
      } else if (order.status !== "Delivered" && order.status !== "Failed") {
        assignBtnHtml = "<button class=\"dispatch-card-unassign-btn\" type=\"button\" data-queue-action=\"unassign\" data-order-id=\"" +
          C.escapeHtml(order.id) + "\">Unassign</button>";
      }

      return (
        "<article class=\"dispatch-order-card\" data-dispatch-order-id=\"" + C.escapeHtml(order.id) + "\">" +
        "<div class=\"dispatch-card-header\">" +
        "<div class=\"dispatch-card-id\">" +
        "<div class=\"dispatch-card-pin\"><div class=\"dispatch-card-pin-inner\"></div></div>" +
        "<span class=\"dispatch-card-number\">" + C.escapeHtml(order.customer_name || "Order") + "</span>" +
        "</div>" +
        "<span class=\"dispatch-status-badge " + badgeClass + "\">" + C.escapeHtml(statusLabel) + "</span>" +
        "</div>" +
        "<div class=\"dispatch-card-details\">" +
        "<div class=\"dispatch-card-detail\"><span class=\"dispatch-card-label\">Pickup</span><span class=\"dispatch-card-value\">" + pickup + "</span></div>" +
        "<div class=\"dispatch-card-detail\"><span class=\"dispatch-card-label\">Delivery</span><span class=\"dispatch-card-value\">" + delivery + "</span></div>" +
        "</div>" +
        "<div class=\"dispatch-card-footer\">" +
        "<div class=\"dispatch-card-driver\"><span class=\"" + dotClass + "\"></span>" + driverLabel + "</div>" +
        "<div class=\"dispatch-card-time\">" +
        "<div class=\"dispatch-card-time-label\">" + (deadline.text === "No deadline" ? "" : "Due") + "</div>" +
        "<div class=\"dispatch-card-time-value " + deadline.cssClass + "\">" + C.escapeHtml(deadline.text) + "</div>" +
        "</div>" +
        "</div>" +
        assignBtnHtml +
        "</article>"
      );
    }).join("");
  }

  function setDispatchFilter(filter) {
    dispatchFilter = filter || "all";
    el.dispatchFilterBtns.forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-dispatch-filter") === dispatchFilter);
    });
    renderDispatchOrderList();
  }

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

  function _claimsFromWebSessionUser(user) {
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
      _web_session: true,
    };
  }

  function _activeClaims() {
    return devSessionClaims || webSessionClaims || C.decodeJwt(token);
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

  function _parseDateOrNull(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  function _orderDeadlineDate(order) {
    return _parseDateOrNull(order && (order.dropoff_deadline || order.time_window_end || order.pickup_deadline));
  }

  function _isTerminalOrder(order) {
    return terminalStatuses.has(String(order && order.status ? order.status : ""));
  }

  function _isUpcomingDue(order, nowDate) {
    if (!order || _isTerminalOrder(order)) {
      return false;
    }
    const deadline = _orderDeadlineDate(order);
    if (!deadline) {
      return false;
    }
    const deltaMs = deadline.getTime() - nowDate.getTime();
    return deltaMs >= 0 && deltaMs <= dueSoonMinutes * 60 * 1000;
  }

  function _isOverdue(order, nowDate) {
    if (!order || _isTerminalOrder(order)) {
      return false;
    }
    const deadline = _orderDeadlineDate(order);
    if (!deadline) {
      return false;
    }
    return deadline.getTime() < nowDate.getTime();
  }

  function _formatOrderDeadlines(order) {
    return (
      "Pickup: " +
      C.formatTimestamp(order && order.pickup_deadline) +
      " -> Dropoff: " +
      C.formatTimestamp(order && order.dropoff_deadline)
    );
  }

  function _dueBadge(order, nowDate) {
    if (_isOverdue(order, nowDate)) {
      return { label: "Overdue", cssClass: "due-pill overdue" };
    }
    if (_isUpcomingDue(order, nowDate)) {
      return { label: "Due Soon", cssClass: "due-pill" };
    }
    const deadline = _orderDeadlineDate(order);
    if (!deadline) {
      return { label: "No Deadline", cssClass: "due-pill" };
    }
    return { label: "Scheduled", cssClass: "due-pill" };
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
    });
    if (activeWorkspace === "operations" && map) {
      setTimeout(function () { map.resize(); }, 50);
    }
  }

  function initWorkspaceTabs() {
    if (!el.workspaceTabs.length || !el.workspacePanels.length) {
      return;
    }
    const hashPanel = (window.location.hash || "").replace("#", "").trim();
    const knownPanels = new Set(["operations", "orders", "planning", "insights", "admin"]);
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
    const nowDate = new Date();
    const upcomingDue = list.filter(function (order) {
      return _isUpcomingDue(order, nowDate);
    }).length;
    if (el.statsTotalOrders) {
      el.statsTotalOrders.textContent = String(total);
    }
    if (el.statsAssignedOrders) {
      el.statsAssignedOrders.textContent = String(assigned);
    }
    if (el.statsUnassignedOrders) {
      el.statsUnassignedOrders.textContent = String(unassigned);
    }
    if (el.statsUpcomingDue) {
      el.statsUpcomingDue.textContent = String(upcomingDue);
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
    if (el.statsUpcomingDueCard) {
      el.statsUpcomingDueCard.disabled = !enabled;
    }
    if (Array.isArray(el.orderSortButtons)) {
      el.orderSortButtons.forEach(function (button) {
        button.disabled = !enabled;
      });
    }
    el.refreshDrivers.disabled = !enabled;
    if (el.optimizeForm) {
      el.optimizeForm.querySelectorAll("input, textarea, button").forEach(function (element) {
        element.disabled = !enabled;
      });
    }
    if (el.refreshInflight) el.refreshInflight.disabled = !enabled;
    el.refreshAuditLogs.disabled = !enabled;
    el.auditFilterForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
  }

  function setBillingInteractiveState(enabled) {
    el.refreshBilling.disabled = !enabled;
    el.refreshInvitations.disabled = !enabled;
    el.billingCheckoutForm.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingPortalForm.querySelectorAll("button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.billingInviteForm.querySelectorAll("input, select, button").forEach(function (element) {
      element.disabled = !enabled;
    });
    el.openPurchaseModal.disabled = !enabled;
  }

  function _readOrderFilters() {
    return {
      status: (el.ordersStatusFilter.value || "").trim(),
      assignedTo: (el.ordersAssignedFilter.value || "").trim(),
      assignment: (el.ordersAssignmentFilter.value || "").trim(),
      due: (el.ordersDueFilter.value || "").trim(),
      search: (el.ordersSearchFilter.value || "").trim(),
      sortField: (el.ordersSortField.value || "dropoff_deadline").trim(),
      sortDirection: (el.ordersSortDirection.value || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc",
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
    el.ordersAssignmentFilter.value = orderFilters.assignment || "";
    el.ordersDueFilter.value = orderFilters.due || "";
    el.ordersSearchFilter.value = orderFilters.search || "";
    el.ordersSortField.value = orderFilters.sortField || "dropoff_deadline";
    el.ordersSortDirection.value = orderFilters.sortDirection || "asc";
  }

  function _ordersPathFromFilters() {
    return "/orders/";
  }

  function _orderSortValue(order, field) {
    if (!order || !field) {
      return "";
    }
    if (field === "dropoff_deadline") {
      return _orderDeadlineDate(order) || null;
    }
    if (field === "pickup_deadline") {
      return _parseDateOrNull(order.pickup_deadline);
    }
    if (field === "time_window_end") {
      return _parseDateOrNull(order.time_window_end);
    }
    if (field === "created_at") {
      return _parseDateOrNull(order.created_at);
    }
    if (field === "reference_id") {
      return (order.reference_id || "").toLowerCase();
    }
    const raw = order[field];
    if (raw === null || raw === undefined) {
      return "";
    }
    return String(raw).toLowerCase();
  }

  function _compareOrderSortValues(left, right) {
    if (left === right) {
      return 0;
    }
    if (left === null || left === undefined || left === "") {
      return 1;
    }
    if (right === null || right === undefined || right === "") {
      return -1;
    }
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() - right.getTime();
    }
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  }

  function _matchesOrderSearch(order, search) {
    if (!search) {
      return true;
    }
    const ref = order.reference_id || "";
    const pickupFull = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(" ");
    const deliveryFull = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(" ");
    const haystack = [
      order.id,
      order.external_order_id,
      order.customer_name,
      ref,
      pickupFull,
      deliveryFull,
      order.assigned_to,
      order.status,
      order.pickup_deadline,
      order.dropoff_deadline,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(search) >= 0;
  }

  function _passesDueFilter(order, dueFilter, nowDate) {
    if (!dueFilter) {
      return true;
    }
    if (dueFilter === "upcoming") {
      return _isUpcomingDue(order, nowDate);
    }
    if (dueFilter === "overdue") {
      return _isOverdue(order, nowDate);
    }
    if (dueFilter === "none") {
      return !_orderDeadlineDate(order);
    }
    return true;
  }

  function _applyOrderFiltersAndSort(orders) {
    const list = Array.isArray(orders) ? orders.slice() : [];
    const nowDate = new Date();
    const search = (orderFilters.search || "").toLowerCase();
    const filtered = list.filter(function (order) {
      if (orderFilters.status && String(order.status || "") !== orderFilters.status) {
        return false;
      }
      if (orderFilters.assignedTo && String(order.assigned_to || "").trim() !== orderFilters.assignedTo) {
        return false;
      }
      if (orderFilters.assignment === "assigned" && !order.assigned_to) {
        return false;
      }
      if (orderFilters.assignment === "unassigned" && !!order.assigned_to) {
        return false;
      }
      if (!_passesDueFilter(order, orderFilters.due, nowDate)) {
        return false;
      }
      return _matchesOrderSearch(order, search);
    });

    const sortField = orderFilters.sortField || "dropoff_deadline";
    const direction = orderFilters.sortDirection === "desc" ? -1 : 1;
    filtered.sort(function (left, right) {
      const leftValue = _orderSortValue(left, sortField);
      const rightValue = _orderSortValue(right, sortField);
      const leftMissing = leftValue === null || leftValue === undefined || leftValue === "";
      const rightMissing = rightValue === null || rightValue === undefined || rightValue === "";
      if (leftMissing !== rightMissing) {
        return leftMissing ? 1 : -1;
      }
      const primary = _compareOrderSortValues(leftValue, rightValue);
      if (primary !== 0) {
        return primary * direction;
      }
      return _compareOrderSortValues(_parseDateOrNull(right.created_at), _parseDateOrNull(left.created_at));
    });
    return filtered;
  }

  async function applyOrderFilters(event) {
    if (event) {
      event.preventDefault();
    }
    orderFilters = _readOrderFilters();
    await refreshOrders();
  }

  async function clearOrderFilters() {
    orderFilters = {
      status: "",
      assignedTo: "",
      assignment: "",
      due: "",
      search: "",
      sortField: "dropoff_deadline",
      sortDirection: "asc",
    };
    _writeOrderFilters();
    await refreshOrders();
  }

  async function applyUpcomingDueFilter() {
    orderFilters.status = "";
    orderFilters.assignedTo = "";
    orderFilters.due = "upcoming";
    orderFilters.assignment = "";
    orderFilters.search = "";
    orderFilters.sortField = "dropoff_deadline";
    orderFilters.sortDirection = "asc";
    _writeOrderFilters();
    renderWorkspace("orders");
    history.replaceState(null, "", "#orders");
    await refreshOrders();
  }

  async function sortOrdersByField(field) {
    if (!field) {
      return;
    }
    if (orderFilters.sortField === field) {
      orderFilters.sortDirection = orderFilters.sortDirection === "asc" ? "desc" : "asc";
    } else {
      orderFilters.sortField = field;
      orderFilters.sortDirection = field === "dropoff_deadline" || field === "pickup_deadline" ? "asc" : "desc";
    }
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

  function renderAssignmentQueues(orders) {
    const list = Array.isArray(orders) ? orders : [];
    const nowDate = new Date();
    const unassigned = list.filter(function (order) {
      return !order.assigned_to;
    });
    const assigned = list.filter(function (order) {
      return !!order.assigned_to;
    });

    if (el.unassignedQueueCount) {
      el.unassignedQueueCount.textContent = String(unassigned.length);
    }
    if (el.assignedQueueCount) {
      el.assignedQueueCount.textContent = String(assigned.length);
    }

    if (el.unassignedOrdersList) {
      if (!unassigned.length) {
        el.unassignedOrdersList.innerHTML = "<p class=\"assignment-empty\">No unassigned orders.</p>";
      } else {
        el.unassignedOrdersList.innerHTML = unassigned
          .slice(0, 12)
          .map(function (order) {
            const due = _dueBadge(order, nowDate);
            return (
              "<article class=\"assignment-item\">" +
              "<h4>" +
              C.escapeHtml(order.customer_name || order.id) +
              "</h4>" +
              "<p>Order: " +
              C.escapeHtml(order.id) +
              "<br>Dropoff: " +
              C.escapeHtml([order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-") +
              "<br>" +
              C.escapeHtml(_formatOrderDeadlines(order)) +
              "</p>" +
              "<div class=\"assignment-item-footer\">" +
              "<span class=\"" +
              C.escapeHtml(due.cssClass) +
              "\">" +
              C.escapeHtml(due.label) +
              "</span>" +
              "<button class=\"btn btn-primary\" type=\"button\" data-queue-action=\"assign-selected\" data-order-id=\"" +
              C.escapeHtml(order.id) +
              "\">Assign Selected Driver</button>" +
              "</div>" +
              "</article>"
            );
          })
          .join("");
      }
    }

    if (el.assignedOrdersList) {
      if (!assigned.length) {
        el.assignedOrdersList.innerHTML = "<p class=\"assignment-empty\">No assigned orders yet.</p>";
      } else {
        el.assignedOrdersList.innerHTML = assigned
          .slice(0, 12)
          .map(function (order) {
            const due = _dueBadge(order, nowDate);
            return (
              "<article class=\"assignment-item\">" +
              "<h4>" +
              C.escapeHtml(order.customer_name || order.id) +
              "</h4>" +
              "<p>Driver: " +
              C.escapeHtml(order.assigned_to || "-") +
              "<br>Status: " +
              C.escapeHtml(order.status || "-") +
              "<br>" +
              C.escapeHtml(_formatOrderDeadlines(order)) +
              "</p>" +
              "<div class=\"assignment-item-footer\">" +
              "<span class=\"" +
              C.escapeHtml(due.cssClass) +
              "\">" +
              C.escapeHtml(due.label) +
              "</span>" +
              "<button class=\"btn btn-ghost\" type=\"button\" data-queue-action=\"unassign\" data-order-id=\"" +
              C.escapeHtml(order.id) +
              "\">Unassign</button>" +
              "</div>" +
              "</article>"
            );
          })
          .join("");
      }
    }

    if (el.selectedDriverLabel) {
      el.selectedDriverLabel.textContent = selectedDriverId || "None";
    }
    if (el.assignmentContext) {
      if (selectedDriverId) {
        el.assignmentContext.textContent = "Driver " + selectedDriverId + " selected — assign from orders list.";
      } else {
        el.assignmentContext.textContent = "Select a driver to begin assigning";
      }
    }
    renderDispatchOrderList();
  }

  function selectDriver(driverId, options) {
    const safeDriverId = String(driverId || "").trim();
    selectedDriverId = safeDriverId;
    if (el.bulkDriverId) {
      el.bulkDriverId.value = safeDriverId;
    }
    renderDriverList(lastDriverLocations, lastDriverRoster);
    renderDriverMarkers(lastDriverLocations, { focusDriverId: safeDriverId, keepCurrentViewport: !!(options && options.keepViewport), roster: lastDriverRoster });
    renderAssignmentQueues(allOrders);
    fetchAndDrawRoute(safeDriverId);
    if (!(options && options.silent) && safeDriverId) {
      C.showMessage(el.assignmentMessage || el.ordersMessage, "Selected driver " + safeDriverId + ".", "success");
    }
  }

  async function onDriverListClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("[data-driver-id]");
    if (!(button instanceof HTMLElement)) {
      return;
    }
    const driverId = button.getAttribute("data-driver-id");
    if (!driverId) {
      return;
    }
    selectDriver(driverId);
  }

  async function applyQuickAssign(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.getAttribute("data-queue-action");
    const orderId = target.getAttribute("data-order-id");
    if (!action || !orderId) {
      return;
    }
    if (!requireAuthorized(el.assignmentMessage || el.ordersMessage)) {
      return;
    }
    try {
      if (action === "assign-selected") {
        if (!selectedDriverId) {
          C.showMessage(el.assignmentMessage || el.ordersMessage, "Select a driver first.", "error");
          return;
        }
        await assignOrder(orderId, selectedDriverId);
        C.showMessage(el.assignmentMessage || el.ordersMessage, "Order assigned to " + selectedDriverId + ".", "success");
      } else if (action === "unassign") {
        await unassignOrder(orderId);
        C.showMessage(el.assignmentMessage || el.ordersMessage, "Order unassigned.", "success");
      }
      await refreshOrders();
    } catch (error) {
      C.showMessage(el.assignmentMessage || el.ordersMessage, error.message, "error");
    }
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
    navigator.serviceWorker.register("admin-sw.js?v=20260322e", { scope: "./" }).catch(function () {
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
    }, 15000);
  }

  function stopDriverAutoRefresh() {
    if (!driverRefreshTimer) {
      return;
    }
    window.clearInterval(driverRefreshTimer);
    driverRefreshTimer = null;
  }

  function showLoginScreen(show) {
    if (el.loginScreen) {
      el.loginScreen.classList.toggle("hidden", !show);
    }
  }

  function evaluateAuthorization(claims) {
    if (!claims) {
      isAuthorizedRole = false;
      isAdminRole = false;
      showLoginScreen(true);
      stopDriverAutoRefresh();
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      lastDriverRoster = [];
      selectedDriverId = "";
      _clearSelection();
      renderDriverOptions([]);
      renderDriverList([], []);
      renderDriverMarkers([]);
      renderAssignmentQueues([]);
      updateOrderStats([]);
      updateActiveDriverStat(0);
      setInteractiveState(false);
      setBillingInteractiveState(false);
      el.billingStatus.innerHTML = "No billing provider status loaded.";
      _resetSeatCards();
      el.billingInvitations.innerHTML = "<li>No invitations found.</li>";
      renderInflight([]);
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      if (el.routeResult) el.routeResult.innerHTML = "No route computed yet.";
      return;
    }
    isAuthorizedRole = hasAllowedRole(claims);
    isAdminRole = hasAdminRole(claims);
    if (!isAuthorizedRole) {
      showLoginScreen(true);
      stopDriverAutoRefresh();
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      lastDriverRoster = [];
      selectedDriverId = "";
      _clearSelection();
    } else {
      showLoginScreen(false);
    }
    setInteractiveState(isAuthorizedRole);
    setBillingInteractiveState(isAuthorizedRole && isAdminRole);
    if (!isAuthorizedRole) {
      renderInflight([]);
      renderDriverOptions([]);
      renderDriverList([], []);
      renderDriverMarkers([]);
      renderAssignmentQueues([]);
      C.showMessage(el.authMessage, "This console requires Admin or Dispatcher role.", "error");
      return;
    }
    startDriverAutoRefresh();
    if (!isAdminRole) {
      C.showMessage(el.billingMessage, "Billing controls require Admin role.", "error");
    }
  }
  function requireAuthorized(messageElement) {
    if (!token && !devSessionClaims && !webSessionClaims) {
      C.showMessage(messageElement, "Sign in to continue.", "error");
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
    token = C.setStoredToken(storageKey + "_debug", nextToken);
    if (token) {
      devSessionClaims = null;
      webSessionClaims = null;
    }
    if (el.token) {
      el.token.value = token;
    }
    renderClaims();
  }

  function renderClaims() {
    const claims = _activeClaims();
    if (!claims) {
      el.authState.textContent = "Not Signed In";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No active web session.";
      evaluateAuthorization(null);
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    const usingDevSession = !!claims._dev_session;
    const usingWebSession = !!claims._web_session;
    el.authState.textContent = usingDevSession
      ? (roles ? "Dev Session: " + roles : "Dev Session")
      : usingWebSession
        ? (roles ? "Signed In: " + roles : "Signed In")
        : (roles ? "Roles: " + roles : "Session Active");
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
      mapStyleUrl = (config && config.map_style_url) || defaultMapStyle;
      ensureMap();
    } catch (error) {
      devAuthEnabled = false;
      devAuthProfiles = [];
      renderDevAuthActions();
      mapStyleUrl = defaultMapStyle;
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
    if (!devAuthEnabled || token || devSessionClaims || webSessionClaims) {
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
        token = C.setStoredToken(storageKey + "_debug", "");
        if (el.token) {
          el.token.value = token;
        }
        renderClaims();
      }
    } catch (error) {
      // Leave normal token auth available when dev session lookup fails.
    }
  }

  async function restoreWebAuthSession() {
    try {
      const session = await C.getAuthSession(apiBase);
      if (session && session.active && session.user) {
        webSessionClaims = _claimsFromWebSessionUser(session.user);
      } else {
        webSessionClaims = null;
      }
    } catch (error) {
      webSessionClaims = null;
    }
    renderClaims();
    return !!webSessionClaims;
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
    webSessionClaims = null;
    token = C.setStoredToken(storageKey + "_debug", "");
    if (el.token) {
      el.token.value = token;
    }
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
    const pickupDeadlineRaw = formData.get("pickup_deadline");
    const dropoffDeadlineRaw = formData.get("dropoff_deadline");
    const pickupDeadlineDate = pickupDeadlineRaw ? new Date(pickupDeadlineRaw) : null;
    const dropoffDeadlineDate = dropoffDeadlineRaw ? new Date(dropoffDeadlineRaw) : null;
    const pickupDeadline = pickupDeadlineDate && !Number.isNaN(pickupDeadlineDate.getTime()) ? pickupDeadlineDate.toISOString() : null;
    const dropoffDeadline = dropoffDeadlineDate && !Number.isNaN(dropoffDeadlineDate.getTime()) ? dropoffDeadlineDate.toISOString() : null;
    const payload = {
      customer_name: formData.get("customer_name"),
      reference_id: formData.get("reference_id"),
      pick_up_street: formData.get("pick_up_street"),
      pick_up_city: formData.get("pick_up_city"),
      pick_up_state: formData.get("pick_up_state"),
      pick_up_zip: formData.get("pick_up_zip"),
      delivery_street: formData.get("delivery_street"),
      delivery_city: formData.get("delivery_city"),
      delivery_state: formData.get("delivery_state"),
      delivery_zip: formData.get("delivery_zip"),
      dimensions: formData.get("dimensions") || null,
      weight: C.toNumberOrNull(formData.get("weight")),
      pickup_deadline: pickupDeadline,
      dropoff_deadline: dropoffDeadline,
      phone: formData.get("phone") || null,
      email: formData.get("email") || null,
      notes: formData.get("notes") || null,
      num_packages: C.toIntOrNull(formData.get("num_packages")) || 1,
    };
    return payload;
  }

  // --- Photon address autocomplete ---
  var autocompleteTimeout = null;
  function setupAddressAutocomplete(streetInput, cityInput, stateInput, zipInput) {
    if (!streetInput) return;
    var dropdown = document.createElement("div");
    dropdown.className = "autocomplete-dropdown";
    dropdown.style.display = "none";
    streetInput.parentElement.style.position = "relative";
    streetInput.parentElement.appendChild(dropdown);

    streetInput.addEventListener("input", function () {
      clearTimeout(autocompleteTimeout);
      var query = streetInput.value.trim();
      if (query.length < 3) { dropdown.style.display = "none"; return; }
      autocompleteTimeout = setTimeout(function () {
        fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(query) + "&limit=5")
          .then(function (r) { return r.json(); })
          .then(function (data) {
            dropdown.innerHTML = "";
            if (!data.features || data.features.length === 0) { dropdown.style.display = "none"; return; }
            data.features.forEach(function (f) {
              var props = f.properties;
              var item = document.createElement("div");
              item.className = "autocomplete-item";
              var parts = [props.housenumber, props.street].filter(Boolean).join(" ");
              var line2 = [props.city || props.town || props.village, props.state, props.postcode].filter(Boolean).join(", ");
              item.innerHTML = "<strong>" + C.escapeHtml(parts || props.name || "") + "</strong><br><small>" + C.escapeHtml(line2) + "</small>";
              item.addEventListener("click", function () {
                streetInput.value = parts || props.name || "";
                if (cityInput) cityInput.value = props.city || props.town || props.village || "";
                if (stateInput) stateInput.value = props.state || "";
                if (zipInput) zipInput.value = props.postcode || "";
                dropdown.style.display = "none";
              });
              dropdown.appendChild(item);
            });
            dropdown.style.display = "block";
          })
          .catch(function () { dropdown.style.display = "none"; });
      }, 300);
    });

    document.addEventListener("click", function (e) {
      if (!streetInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });
  }

  // Wire up autocomplete for pick-up and delivery street fields
  (function () {
    var form = el.createForm;
    if (!form) return;
    setupAddressAutocomplete(
      form.querySelector("[name='pick_up_street']"),
      form.querySelector("[name='pick_up_city']"),
      form.querySelector("[name='pick_up_state']"),
      form.querySelector("[name='pick_up_zip']")
    );
    setupAddressAutocomplete(
      form.querySelector("[name='delivery_street']"),
      form.querySelector("[name='delivery_city']"),
      form.querySelector("[name='delivery_state']"),
      form.querySelector("[name='delivery_zip']")
    );
  })();

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
    renderAssignmentQueues(allOrders);
    if (!lastOrders.length) {
      el.ordersBody.innerHTML = "<tr><td colspan=\"7\">No orders for the current filters.</td></tr>";
      el.ordersMobile.innerHTML = "<p class=\"panel-help\">No orders available.</p>";
      _syncSelectAllCheckbox();
      _renderSelectionCount();
      return;
    }

    const nowDate = new Date();
    const rows = lastOrders.map(function (order) {
      const isSelected = selectedOrderIds.has(order.id);
      const assignLabel = order.assigned_to ? "Reassign" : "Assign";
      const currentStatusClass = statusClass(order.status);
      const due = _dueBadge(order, nowDate);
      const suggestedDriver = order.assigned_to || selectedDriverId || "";
      const pickup = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ") || "-";
      const delivery = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-";

      return (
        "<tr>" +
        "<td><input type=\"checkbox\" data-select-order-id=\"" +
        C.escapeHtml(order.id) + "\" " + (isSelected ? "checked" : "") + "></td>" +
        "<td class=\"order-cell-name\">" +
        "<strong>" + C.escapeHtml(order.customer_name) + "</strong>" +
        "<br><small class=\"text-muted\">Ref " + C.escapeHtml(order.reference_id || "-") + "</small>" +
        (order.phone ? "<br><small class=\"text-muted\">" + C.escapeHtml(order.phone) + "</small>" : "") +
        "</td>" +
        "<td class=\"order-cell-stops\">" +
        "<div class=\"order-stop\"><small class=\"text-muted\">PICKUP</small><br>" + C.escapeHtml(pickup) + "</div>" +
        "<div class=\"order-stop\"><small class=\"text-muted\">DELIVERY</small><br>" + C.escapeHtml(delivery) + "</div>" +
        "</td>" +
        "<td class=\"order-cell-deadlines\">" +
        "<small>" + C.escapeHtml(_formatOrderDeadlines(order)) + "</small>" +
        "<br><span class=\"" + C.escapeHtml(due.cssClass) + "\">" + C.escapeHtml(due.label) + "</span>" +
        "</td>" +
        "<td><span class=\"table-status " + currentStatusClass + "\">" + C.escapeHtml(order.status) + "</span></td>" +
        "<td class=\"order-cell-assign\">" +
        C.escapeHtml(order.assigned_to || "Unassigned") +
        "<div class=\"mobile-order-actions\">" +
        "<input class=\"compact-input\" list=\"driver-options\" data-driver-id=\"" +
        C.escapeHtml(order.id) + "\" placeholder=\"driver sub\" value=\"" +
        C.escapeHtml(suggestedDriver) + "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">" + assignLabel + "</button>" +
        "<button class=\"btn btn-accent\" data-action=\"assign-selected\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Assign Selected Driver</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"unassign\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Unassign</button>" +
        "</div></div></td>" +
        "<td><button class=\"btn btn-ghost btn-sm\" data-action=\"edit\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Edit</button></td>" +
        "</tr>"
      );
    });
    el.ordersBody.innerHTML = rows.join("");

    const mobileCards = lastOrders.map(function (order) {
      const isSelected = selectedOrderIds.has(order.id);
      const assignLabel = order.assigned_to ? "Reassign" : "Assign";
      const currentStatusClass = statusClass(order.status);
      const due = _dueBadge(order, nowDate);
      const suggestedDriver = order.assigned_to || selectedDriverId || "";

      return (
        "<article class=\"mobile-order-card\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">" +
        "<h3>" + C.escapeHtml(order.customer_name) + "</h3>" +
        "<label class=\"field\"><span>Select</span><input type=\"checkbox\" data-select-order-id=\"" +
        C.escapeHtml(order.id) + "\" " + (isSelected ? "checked" : "") + "></label>" +
        "<p class=\"mobile-order-meta\">" +
        "Ref: " + C.escapeHtml(order.reference_id || "-") +
        "<br>Pick Up: " + C.escapeHtml([order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ") || "-") +
        "<br>Delivery: " + C.escapeHtml([order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-") +
        "<br>Deadlines: " + C.escapeHtml(_formatOrderDeadlines(order)) +
        "<br>Due: <span class=\"" + C.escapeHtml(due.cssClass) + "\">" + C.escapeHtml(due.label) + "</span>" +
        "<br>Status: <span class=\"table-status " + currentStatusClass + "\">" + C.escapeHtml(order.status) + "</span>" +
        "<br>Assigned: " + C.escapeHtml(order.assigned_to || "-") +
        "</p>" +
        "<div class=\"mobile-order-actions\">" +
        "<input class=\"compact-input\" list=\"driver-options\" data-driver-id=\"" +
        C.escapeHtml(order.id) + "\" placeholder=\"driver sub\" value=\"" +
        C.escapeHtml(suggestedDriver) + "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">" + assignLabel + "</button>" +
        "<button class=\"btn btn-accent\" data-action=\"assign-selected\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Assign Selected</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"unassign\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Unassign</button>" +
        "<button class=\"btn btn-ghost\" data-action=\"edit\" data-order-id=\"" +
        C.escapeHtml(order.id) + "\">Edit</button>" +
        "</div></div>" +
        "</article>"
      );
    });
    el.ordersMobile.innerHTML = mobileCards.join("");
    _syncSelectAllCheckbox();
    _renderSelectionCount();
  }

  async function refreshOrders() {
    if (!requireAuthorized(el.ordersMessage)) {
      allOrders = [];
      renderOrders([]);
      updateOrderStats([]);
      return;
    }
    try {
      const orders = await C.requestJson(apiBase, _ordersPathFromFilters(), { token });
      allOrders = Array.isArray(orders) ? orders : [];
      updateOrderStats(allOrders);
      renderOrderPins(allOrders);
      const filteredOrders = _applyOrderFiltersAndSort(allOrders);
      renderOrders(filteredOrders || []);
      setLastSyncStamp();
      C.showMessage(
        el.ordersMessage,
        "Loaded " + (filteredOrders || []).length + " orders (" + allOrders.length + " total).",
        "success"
      );
    } catch (error) {
      allOrders = [];
      renderOrders([]);
      updateOrderStats([]);
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
      style: mapStyleUrl || defaultMapStyle,
      center: [-97.7431, 30.2672],
      zoom: 4,
    });
    return map;
  }

  // ── Route polyline drawing ──────────────────────────────────────────

  function clearRouteLayer() {
    var currentMap = ensureMap();
    if (!currentMap) return;
    if (currentMap.getLayer(activeRouteLayerId)) {
      currentMap.removeLayer(activeRouteLayerId);
    }
    if (currentMap.getSource(activeRouteSourceId)) {
      currentMap.removeSource(activeRouteSourceId);
    }
    var chipEl = document.getElementById("route-stats-chip");
    if (chipEl) chipEl.style.display = "none";
  }

  function drawRoutePolyline(coordinates) {
    var currentMap = ensureMap();
    if (!currentMap || !coordinates || coordinates.length < 2) return;
    clearRouteLayer();

    var geojson = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coordinates },
    };

    currentMap.addSource(activeRouteSourceId, { type: "geojson", data: geojson });
    currentMap.addLayer({
      id: activeRouteLayerId,
      type: "line",
      source: activeRouteSourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#e63946",
        "line-width": 4,
        "line-opacity": 0.85,
      },
    });
  }

  function fetchAndDrawRoute(driverId) {
    if (!driverId || !token) {
      clearRouteLayer();
      return;
    }
    C.apiFetch("/routes/directions", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ driver_id: driverId }),
    })
      .then(function (resp) {
        if (!resp.ok) {
          clearRouteLayer();
          return;
        }
        return resp.json();
      })
      .then(function (data) {
        if (!data || !data.coordinates || data.coordinates.length < 2) {
          clearRouteLayer();
          return;
        }
        drawRoutePolyline(data.coordinates);
        // Update route stats chip overlay on map.
        var statsEl = document.getElementById("route-stats");
        var chipEl = document.getElementById("route-stats-chip");
        if (statsEl) {
          var miles = (data.distance_meters / 1609.344).toFixed(1);
          var mins = Math.round(data.duration_seconds / 60);
          statsEl.textContent = data.ordered_stops.length + " stops · " + miles + " mi · ~" + mins + " min";
          if (chipEl) chipEl.style.display = "";
        }
      })
      .catch(function () {
        clearRouteLayer();
      });
  }

  // ── Order pins (unassigned orders on the map) ──────────────────────

  var _orderGeoCache = {};
  var _orderPinCoords = {};  // orderId → [lng, lat]

  function _unassignedPinSvg() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 24 36">' +
      '<text x="12" y="28" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="36" font-weight="900" fill="#f5c542" stroke="#1a1a2e" stroke-width="1.5" paint-order="stroke">!</text>' +
      '</svg>'
    );
  }

  function _createPinElement() {
    var el = document.createElement("div");
    el.innerHTML = _unassignedPinSvg();
    el.style.cursor = "pointer";
    el.style.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.5))";
    return el;
  }

  function clearOrderMarkers() {
    orderMarkers.forEach(function (m) { m.remove(); });
    orderMarkers = [];
    _orderPinCoords = {};
  }

  function _geocodeAndPin(order, currentMap) {
    var address = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ");
    if (!address) return;

    if (_orderGeoCache[address]) {
      _placeOrderPin(order, _orderGeoCache[address], currentMap);
      return;
    }

    fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(address) + "&limit=1")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.features || !data.features.length) return;
        var coords = data.features[0].geometry.coordinates; // [lng, lat]
        _orderGeoCache[address] = coords;
        _placeOrderPin(order, coords, currentMap);
      })
      .catch(function () { /* silently skip */ });
  }

  function _placeOrderPin(order, coords, currentMap) {
    var pinEl = _createPinElement();
    var popup = new window.maplibregl.Popup({ offset: 15, className: "order-popup" }).setHTML(
      "<div class='order-popup-content'>" +
      "<strong class='order-popup-name'>" + C.escapeHtml(order.customer_name) + "</strong>" +
      "<span class='order-popup-status'>UNASSIGNED</span>" +
      "<span class='order-popup-address'>" + C.escapeHtml(order.delivery_street || "") + "</span>" +
      "<span class='order-popup-ref'>Ref: " + C.escapeHtml(order.reference_id || "-") + "</span>" +
      "</div>"
    );
    var marker = new window.maplibregl.Marker({ element: pinEl, anchor: "center" })
      .setLngLat(coords)
      .setPopup(popup)
      .addTo(currentMap);
    orderMarkers.push(marker);
    _orderPinCoords[order.id] = coords;
  }

  function renderOrderPins(orders) {
    var currentMap = ensureMap();
    if (!currentMap || !window.maplibregl) return;
    clearOrderMarkers();

    var unassigned = (orders || []).filter(function (o) {
      return !o.assigned_to && o.status !== "Delivered" && o.status !== "Failed";
    });
    if (!unassigned.length) return;

    // Stagger geocode requests to respect Photon rate limits (1 req/s max).
    unassigned.forEach(function (order, i) {
      setTimeout(function () { _geocodeAndPin(order, currentMap); }, i * 200);
    });
  }

  function flyToOrderPin(orderId) {
    var currentMap = ensureMap();
    if (!currentMap || !orderId) return;

    // Highlight the active card in the left panel.
    var cards = document.querySelectorAll("[data-dispatch-order-id]");
    cards.forEach(function (c) {
      c.classList.toggle("dispatch-order-card-active", c.getAttribute("data-dispatch-order-id") === orderId);
    });

    var coords = _orderPinCoords[orderId];
    if (coords) {
      currentMap.flyTo({ center: coords, zoom: 14, duration: 1200 });
      // Open the popup for this order's marker.
      orderMarkers.forEach(function (m) {
        var lngLat = m.getLngLat();
        if (Math.abs(lngLat.lng - coords[0]) < 0.0001 && Math.abs(lngLat.lat - coords[1]) < 0.0001) {
          m.togglePopup();
        }
      });
      return;
    }

    // If pin not yet geocoded, geocode now and fly.
    var order = allOrders.find(function (o) { return o.id === orderId; });
    if (!order) return;
    var address = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ");
    if (!address) return;

    if (_orderGeoCache[address]) {
      _orderPinCoords[orderId] = _orderGeoCache[address];
      currentMap.flyTo({ center: _orderGeoCache[address], zoom: 14, duration: 1200 });
      return;
    }

    fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(address) + "&limit=1")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.features || !data.features.length) return;
        var c = data.features[0].geometry.coordinates;
        _orderGeoCache[address] = c;
        _orderPinCoords[orderId] = c;
        currentMap.flyTo({ center: c, zoom: 14, duration: 1200 });
      })
      .catch(function () { /* silently skip */ });
  }

  function _createDriverMarkerElement(item, rosterEntry, isSelectedDriver) {
    var photoUrl = rosterEntry && rosterEntry.photo_url;
    var isTsa = rosterEntry && rosterEntry.tsa_certified;
    var borderColor = isSelectedDriver ? "#e63946" : (isTsa ? "#1565c0" : "#3498db");
    if (isTsa) {
      var tsaEl = document.createElement("div");
      tsaEl.className = "dispatch-map-marker-tsa";
      tsaEl.style.cssText = "width:42px;height:42px;cursor:pointer;position:relative;";
      tsaEl.innerHTML = '<svg width="42" height="42" viewBox="0 0 42 42">' +
        '<circle cx="21" cy="21" r="19" fill="#1565c0" stroke="#fff" stroke-width="2.5"/>' +
        '<circle cx="21" cy="21" r="16" fill="none" stroke="#fff" stroke-width="1" opacity=".5"/>' +
        '<g transform="translate(21,22) rotate(-45) scale(.55)">' +
          '<path d="M-2,-14 L2,-14 L2,-4 L12,2 L12,5 L2,1 L2,8 L5,10 L5,12.5 L0,11 L-5,12.5 L-5,10 L-2,8 L-2,1 L-12,5 L-12,2 L-2,-4 Z" fill="#fff"/>' +
        '</g>' +
        (photoUrl ? '' : '<text x="21" y="37" text-anchor="middle" font-size="7" font-weight="700" fill="#fff" font-family="Inter,sans-serif">TSA</text>') +
      '</svg>';
      if (photoUrl) {
        var photoOverlay = document.createElement("div");
        photoOverlay.style.cssText = "position:absolute;bottom:-2px;right:-2px;width:18px;height:18px;border-radius:50%;border:2px solid #1565c0;overflow:hidden;background:#fff;";
        var pImg = document.createElement("img");
        pImg.src = photoUrl; pImg.alt = "";
        pImg.style.cssText = "width:100%;height:100%;object-fit:cover;";
        photoOverlay.appendChild(pImg);
        tsaEl.appendChild(photoOverlay);
      }
      return { element: tsaEl, offset: 20 };
    } else if (photoUrl) {
      var elDiv = document.createElement("div");
      elDiv.className = "dispatch-map-marker-photo";
      elDiv.style.cssText = "width:36px;height:36px;border-radius:50%;border:3px solid " + borderColor + ";overflow:hidden;cursor:pointer;background:#fff;";
      var img = document.createElement("img");
      img.src = photoUrl; img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      elDiv.appendChild(img);
      return { element: elDiv, offset: 15 };
    }
    return { color: borderColor, offset: 15 };
  }

  function renderDriverMarkers(driverLocations, options) {
    const currentMap = ensureMap();
    if (!currentMap) {
      return;
    }
    if (!driverLocations.length) {
      mapMarkers.forEach(function (entry) { entry.marker.remove(); });
      mapMarkers = new Map();
      return;
    }
    const markerOptions = options || {};
    const focusDriverId = String(markerOptions.focusDriverId || selectedDriverId || "").trim();
    let focusedDriver = null;
    const bounds = new window.maplibregl.LngLatBounds();
    var roster = Array.isArray(markerOptions.roster) ? markerOptions.roster : [];
    var activeIds = new Set();

    driverLocations.forEach(function (item) {
      activeIds.add(item.driver_id);
      const isSelectedDriver = !!focusDriverId && item.driver_id === focusDriverId;
      var rosterEntry = roster.find(function (r) { return r.user_id === item.driver_id; });
      var driverName = (rosterEntry && rosterEntry.username) || item.driver_id;
      var isTsa = rosterEntry && rosterEntry.tsa_certified;
      var popupHtml = "<strong>" + C.escapeHtml(driverName) + "</strong>" +
        (isTsa ? "<br><span style=\"color:#1565c0;font-weight:700;font-size:.75rem;\">TSA CERTIFIED</span>" : "") +
        "<br>Updated: " + C.escapeHtml(C.formatTimestamp(item.timestamp));

      var existing = mapMarkers.get(item.driver_id);
      if (existing) {
        // Animate existing marker to new position
        existing.marker.setLngLat([item.lng, item.lat]);
        existing.marker.setPopup(new window.maplibregl.Popup({ offset: 15 }).setHTML(popupHtml));
        existing.lat = item.lat;
        existing.lng = item.lng;
      } else {
        // Create new marker
        var markerConfig = _createDriverMarkerElement(item, rosterEntry, isSelectedDriver);
        var marker;
        if (markerConfig.element) {
          marker = new window.maplibregl.Marker({ element: markerConfig.element })
            .setLngLat([item.lng, item.lat])
            .setPopup(new window.maplibregl.Popup({ offset: markerConfig.offset }).setHTML(popupHtml))
            .addTo(currentMap);
        } else {
          marker = new window.maplibregl.Marker({ color: markerConfig.color })
            .setLngLat([item.lng, item.lat])
            .setPopup(new window.maplibregl.Popup({ offset: markerConfig.offset }).setHTML(popupHtml))
            .addTo(currentMap);
        }
        marker.getElement().addEventListener("click", function () {
          selectDriver(item.driver_id, { silent: true, keepViewport: false });
        });
        mapMarkers.set(item.driver_id, { marker: marker, lat: item.lat, lng: item.lng });
      }
      bounds.extend([item.lng, item.lat]);
      if (isSelectedDriver) {
        focusedDriver = item;
      }
    });

    // Remove markers for drivers no longer active
    mapMarkers.forEach(function (entry, driverId) {
      if (!activeIds.has(driverId)) {
        entry.marker.remove();
        mapMarkers.delete(driverId);
      }
    });

    if (markerOptions.keepCurrentViewport) {
      return;
    }
    if (focusedDriver) {
      currentMap.flyTo({ center: [focusedDriver.lng, focusedDriver.lat], zoom: 12 });
      return;
    }
    if (driverLocations.length === 1) {
      currentMap.flyTo({ center: [driverLocations[0].lng, driverLocations[0].lat], zoom: 11 });
      return;
    }
    currentMap.fitBounds(bounds, { padding: 36, maxZoom: 12 });
  }

  function renderDriverList(driverLocations, roster) {
    var initials = function (name) {
      var parts = String(name || "").split(/[\s@._-]/);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return String(name || "?").substring(0, 2).toUpperCase();
    };
    roster = Array.isArray(roster) ? roster : [];
    var onlineIds = new Set(driverLocations.map(function (d) { return d.driver_id; }));
    var offlineDrivers = roster.filter(function (r) { return !r.is_online; });
    var html = "";
    if (driverLocations.length) {
      html += "<li class=\"dispatch-driver-section-label\">Online (" + driverLocations.length + ")</li>";
      html += driverLocations.map(function (item) {
        var rosterEntry = roster.find(function (r) { return r.user_id === item.driver_id; });
        var displayName = (rosterEntry && rosterEntry.username) || item.driver_id;
        var photoUrl = rosterEntry && rosterEntry.photo_url;
        var selectedClass = item.driver_id === selectedDriverId ? " is-selected" : "";
        var avatarHtml = photoUrl
          ? "<img src=\"" + C.escapeHtml(photoUrl) + "\" class=\"dispatch-driver-avatar-img\" alt=\"\">"
          : C.escapeHtml(initials(displayName));
        return (
          "<li><button type=\"button\" class=\"dispatch-driver-card" + selectedClass +
          "\" data-driver-id=\"" + C.escapeHtml(item.driver_id) +
          "\"><div class=\"dispatch-driver-avatar\">" + avatarHtml +
          "<span class=\"dispatch-driver-status-dot status-online\"></span>" +
          "</div><div class=\"dispatch-driver-info\">" +
          "<span class=\"dispatch-driver-name\">" + C.escapeHtml(displayName) +
          "</span><span class=\"dispatch-driver-meta\">" +
          C.escapeHtml(item.lat.toFixed(4) + ", " + item.lng.toFixed(4)) +
          " | " + C.escapeHtml(C.formatTimestamp(item.timestamp)) +
          "</span></div></button></li>"
        );
      }).join("");
    }
    if (offlineDrivers.length) {
      html += "<li class=\"dispatch-driver-section-label\">Offline (" + offlineDrivers.length + ")</li>";
      html += offlineDrivers.map(function (d) {
        var displayName = d.username || d.user_id;
        var photoUrl = d.photo_url;
        var selectedClass = d.user_id === selectedDriverId ? " is-selected" : "";
        var avatarHtml = photoUrl
          ? "<img src=\"" + C.escapeHtml(photoUrl) + "\" class=\"dispatch-driver-avatar-img\" alt=\"\">"
          : C.escapeHtml(initials(displayName));
        var lastSeen = d.last_seen ? C.formatTimestamp(d.last_seen) : "Never";
        return (
          "<li><button type=\"button\" class=\"dispatch-driver-card dispatch-driver-offline" + selectedClass +
          "\" data-driver-id=\"" + C.escapeHtml(d.user_id) +
          "\"><div class=\"dispatch-driver-avatar dispatch-driver-avatar-offline\">" + avatarHtml +
          "<span class=\"dispatch-driver-status-dot status-offline\"></span>" +
          "</div><div class=\"dispatch-driver-info\">" +
          "<span class=\"dispatch-driver-name\">" + C.escapeHtml(displayName) +
          "</span><span class=\"dispatch-driver-meta\">Last seen: " + C.escapeHtml(lastSeen) +
          "</span></div></button></li>"
        );
      }).join("");
    }
    if (!html) {
      html = "<li class=\"dispatch-empty\">No drivers registered.</li>";
    }
    el.driverList.innerHTML = html;
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
    if (!isAuthorizedRole) {
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
      lastDriverLocations = [];
      lastDriverRoster = [];
      selectedDriverId = "";
      renderDriverList([], []);
      renderDriverMarkers([]);
      renderAssignmentQueues(allOrders);
      updateActiveDriverStat(0);
      return;
    }
    try {
      var results = await Promise.all([
        C.requestJson(apiBase, "/drivers?active_minutes=120", { token }),
        C.requestJson(apiBase, "/drivers/roster?active_minutes=120", { token }).catch(function () { return []; })
      ]);
      var drivers = results[0];
      var roster = results[1];
      lastDriverLocations = Array.isArray(drivers) ? drivers : [];
      lastDriverRoster = Array.isArray(roster) ? roster : [];
      const selectedStillActive = selectedDriverId && (
        lastDriverLocations.some(function (item) {
          return item.driver_id === selectedDriverId;
        }) ||
        lastDriverRoster.some(function (item) {
          return item.user_id === selectedDriverId;
        })
      );
      if (!selectedStillActive) {
        selectedDriverId = "";
      }
      renderDriverList(lastDriverLocations, lastDriverRoster);
      renderDriverMarkers(lastDriverLocations, { keepCurrentViewport: !!selectedStillActive, roster: lastDriverRoster });
      renderAssignmentQueues(allOrders);
      updateActiveDriverStat(lastDriverLocations.length);
      setLastSyncStamp();
      C.showMessage(el.driversMessage, "Loaded " + lastDriverLocations.length + " active driver" + (lastDriverLocations.length === 1 ? "" : "s") + " (" + lastDriverRoster.length + " total).", "success");
    } catch (error) {
      lastDriverLocations = [];
      lastDriverRoster = [];
      renderDriverList([], []);
      renderDriverMarkers([]);
      renderAssignmentQueues(allOrders);
      updateActiveDriverStat(0);
      C.showMessage(el.driversMessage, error.message, "error");
    }
  }

  function _inflightStatusDot(status) {
    var s = String(status || "").toLowerCase();
    if (s === "assigned") return "dot-assigned";
    if (s === "pickedup") return "dot-pickedup";
    if (s === "enroute") return "dot-enroute";
    return "dot-created";
  }

  function _inflightBarClass(status) {
    var s = String(status || "").toLowerCase();
    if (s === "assigned") return "status-assigned";
    if (s === "pickedup") return "status-pickedup";
    if (s === "enroute") return "status-enroute";
    return "status-created";
  }

  function _inflightBarWidth(status) {
    var s = String(status || "").toLowerCase();
    if (s === "created") return "5%";
    if (s === "assigned") return "20%";
    if (s === "pickedup") return "50%";
    if (s === "enroute") return "75%";
    return "5%";
  }

  function _inflightActionLabel(status) {
    var s = String(status || "").toLowerCase();
    if (s === "assigned") return "Awaiting Pickup";
    if (s === "pickedup") return "Arrive at Destination";
    if (s === "enroute") return "Arrive at Destination";
    return "Pending Assignment";
  }

  function _fmtDeadline(dt) {
    if (!dt) return "-";
    var d = new Date(dt);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleDateString([], { month: "2-digit", day: "2-digit" }) + " " +
           d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function _estimateEta(order) {
    if (order.dropoff_deadline) {
      var dl = new Date(order.dropoff_deadline);
      var now = new Date();
      var diffMs = dl - now;
      if (diffMs <= 0) return "Overdue";
      var h = Math.floor(diffMs / 3600000);
      var m = Math.round((diffMs % 3600000) / 60000);
      if (h > 0) return "~" + h + "h " + m + "m";
      return "~" + m + "m";
    }
    return "-";
  }

  function renderInflight(orders) {
    if (!el.inflightList) return;
    var active = (orders || []).filter(function (o) {
      return o.status !== "Delivered" && o.status !== "Failed";
    });
    if (el.inflightCount) el.inflightCount.textContent = active.length;
    if (!active.length) {
      el.inflightList.innerHTML = '<div class="inflight-empty">No active shipments.</div>';
      return;
    }
    // Group by status
    var inProgress = active.filter(function (o) { return o.status === "PickedUp" || o.status === "EnRoute"; });
    var assigned = active.filter(function (o) { return o.status === "Assigned"; });
    var created = active.filter(function (o) { return o.status === "Created"; });

    var html = "";
    if (inProgress.length) {
      html += '<div class="inflight-section-label">In Progress (' + inProgress.length + ')</div>';
      html += inProgress.map(_renderInflightCard).join("");
    }
    if (assigned.length) {
      html += '<div class="inflight-section-label">Assigned (' + assigned.length + ')</div>';
      html += assigned.map(_renderInflightCard).join("");
    }
    if (created.length) {
      html += '<div class="inflight-section-label">Unassigned (' + created.length + ')</div>';
      html += created.map(_renderInflightCard).join("");
    }
    el.inflightList.innerHTML = html;
  }

  function _renderInflightCard(order) {
    var pickup = [order.pick_up_street, order.pick_up_city].filter(Boolean).join(", ") || "-";
    var delivery = [order.delivery_street, order.delivery_city].filter(Boolean).join(", ") || "-";
    var pickupFull = [order.pick_up_city, order.pick_up_state].filter(Boolean).join(", ");
    var deliveryFull = [order.delivery_city, order.delivery_state].filter(Boolean).join(", ");
    var driver = order.assigned_to || "Unassigned";
    var eta = _estimateEta(order);

    return (
      '<div class="inflight-card">' +
        '<div>' +
          '<div class="inflight-ref">' +
            '<span class="inflight-status-dot ' + _inflightStatusDot(order.status) + '"></span>' +
            C.escapeHtml(order.reference_id || order.id.slice(0, 8)) +
          '</div>' +
          '<div class="inflight-pkgs">' + order.num_packages + ' pcs' +
            (order.weight ? ' &middot; ' + order.weight + ' lbs' : '') +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="inflight-driver">' + C.escapeHtml(order.customer_name) + '</div>' +
          '<div class="inflight-driver-sub">' + C.escapeHtml(driver) + '</div>' +
        '</div>' +
        '<div class="inflight-progress-area">' +
          '<div class="inflight-progress-header">' +
            '<span class="inflight-eta">' + C.escapeHtml(eta) + '</span>' +
          '</div>' +
          '<div class="inflight-bar-wrap">' +
            '<div class="inflight-bar-fill ' + _inflightBarClass(order.status) + '" style="width:' + _inflightBarWidth(order.status) + '"></div>' +
          '</div>' +
          '<div class="inflight-progress-labels">' +
            '<div class="inflight-progress-label"><strong>' + C.escapeHtml(pickupFull || "Pickup") + '</strong>' + C.escapeHtml(pickup) + '</div>' +
            '<div class="inflight-progress-label" style="text-align:right;"><strong>' + C.escapeHtml(deliveryFull || "Delivery") + '</strong>' + C.escapeHtml(delivery) + '</div>' +
          '</div>' +
          '<div class="inflight-action-btn"><button class="btn btn-xs btn-ghost">' + _inflightActionLabel(order.status) + '</button></div>' +
        '</div>' +
        '<div class="inflight-dest">' +
          '<div class="inflight-deadlines">' +
            '<span class="deadline-label">Pickup: </span>' + _fmtDeadline(order.pickup_deadline) + '<br>' +
            '<span class="deadline-label">Delivery: </span>' + _fmtDeadline(order.dropoff_deadline) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  async function refreshInflight() {
    if (!requireAuthorized(el.inflightMessage)) {
      renderInflight([]);
      return;
    }
    try {
      var orders = await C.requestJson(apiBase, "/orders", { token });
      renderInflight(orders);
      setLastSyncStamp();
    } catch (error) {
      if (el.inflightMessage) C.showMessage(el.inflightMessage, error.message, "error");
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

  function _resetSeatCards() {
    el.seatDispatcherUsage.textContent = "0 / 0";
    el.seatDispatcherDetail.textContent = "0 pending";
    el.seatDriverUsage.textContent = "0 / 0";
    el.seatDriverDetail.textContent = "0 pending";
    el.seatAvailableTotal.textContent = "0";
    el.seatAvailableDetail.textContent = "ready to assign";
    el.seatPendingTotal.textContent = "0";
  }

  function renderBillingSummary(summary) {
    if (!summary || typeof summary !== "object") {
      _resetSeatCards();
      return;
    }
    var dispatcher = summary.dispatcher_seats || {};
    var driver = summary.driver_seats || {};
    var dispUsed = dispatcher.used || 0;
    var dispTotal = dispatcher.total || 0;
    var dispPending = dispatcher.pending || 0;
    var drvUsed = driver.used || 0;
    var drvTotal = driver.total || 0;
    var drvPending = driver.pending || 0;
    var dispAvail = dispatcher.available || 0;
    var drvAvail = driver.available || 0;
    var totalAvail = dispAvail + drvAvail;
    var totalPending = dispPending + drvPending;

    el.seatDispatcherUsage.textContent = dispUsed + " / " + dispTotal;
    el.seatDispatcherDetail.textContent = dispPending + " pending";
    el.seatDriverUsage.textContent = drvUsed + " / " + drvTotal;
    el.seatDriverDetail.textContent = drvPending + " pending";
    el.seatAvailableTotal.textContent = String(totalAvail);
    el.seatAvailableDetail.textContent = dispAvail + " dispatcher, " + drvAvail + " driver";
    el.seatPendingTotal.textContent = String(totalPending);
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
      el.purchaseModal.hidden = true;
      if (response.mode === "subscription_update" && response.summary) {
        renderBillingSummary(response.summary);
        setLastSyncStamp();
        C.showMessage(el.billingMessage, "Seat limits updated via Stripe.", "success");
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
    var formData = new FormData(el.billingInviteForm);
    var email = String(formData.get("email") || "").trim();
    var role = String(formData.get("role") || "").trim();
    var userId = String(formData.get("user_id") || "").trim();
    if (!email && !userId) {
      C.showMessage(el.billingMessage, "Email address is required.", "error");
      return;
    }
    var payload = {
      email: email || undefined,
      role: role || "Dispatcher",
    };
    if (userId) {
      payload.user_id = userId;
    }
    try {
      var invitation = await C.requestJson(apiBase, "/billing/invitations", {
        method: "POST",
        token,
        json: payload,
      });
      C.showMessage(el.billingMessage, "Invitation sent to " + C.escapeHtml(email || userId) + ".", "success");
      el.billingInviteForm.reset();
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

  // Route optimization UI removed (backend endpoint preserved)

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
      } else if (action === "assign-selected") {
        if (!selectedDriverId) {
          throw new Error("Select a driver from the map/list first.");
        }
        await assignOrder(orderId, selectedDriverId);
      } else if (action === "unassign") {
        await unassignOrder(orderId);
      } else if (action === "edit") {
        openEditOrderModal(orderId);
        return;
      }
      await refreshOrders();
    } catch (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    }
  }

  // ── Edit Order Modal ────────────────────────────────────────────────

  function _findOrderById(orderId) {
    return allOrders.find(function (o) { return o.id === orderId; });
  }

  function _toLocalDatetime(isoStr) {
    if (!isoStr) return "";
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function openEditOrderModal(orderId) {
    var order = _findOrderById(orderId);
    if (!order) return;
    document.getElementById("edit-order-id").value = order.id;
    document.getElementById("edit-order-title").textContent = "Edit: " + (order.customer_name || "Order");
    document.getElementById("edit-customer-name").value = order.customer_name || "";
    document.getElementById("edit-reference-id").value = order.reference_id || "";
    document.getElementById("edit-phone").value = order.phone || "";
    document.getElementById("edit-email").value = order.email || "";
    document.getElementById("edit-pickup-street").value = order.pick_up_street || "";
    document.getElementById("edit-pickup-city").value = order.pick_up_city || "";
    document.getElementById("edit-pickup-state").value = order.pick_up_state || "";
    document.getElementById("edit-pickup-zip").value = order.pick_up_zip || "";
    document.getElementById("edit-delivery-street").value = order.delivery_street || "";
    document.getElementById("edit-delivery-city").value = order.delivery_city || "";
    document.getElementById("edit-delivery-state").value = order.delivery_state || "";
    document.getElementById("edit-delivery-zip").value = order.delivery_zip || "";
    document.getElementById("edit-pickup-deadline").value = _toLocalDatetime(order.pickup_deadline);
    document.getElementById("edit-dropoff-deadline").value = _toLocalDatetime(order.dropoff_deadline);
    document.getElementById("edit-dimensions").value = order.dimensions || "";
    document.getElementById("edit-weight").value = order.weight || "";
    document.getElementById("edit-num-packages").value = order.num_packages || 1;
    document.getElementById("edit-notes").value = order.notes || "";
    document.getElementById("edit-order-message").textContent = "";
    document.getElementById("edit-order-overlay").style.display = "flex";
  }

  function closeEditOrderModal() {
    document.getElementById("edit-order-overlay").style.display = "none";
  }

  async function submitEditOrder(e) {
    e.preventDefault();
    var orderId = document.getElementById("edit-order-id").value;
    var msgEl = document.getElementById("edit-order-message");
    var weight = document.getElementById("edit-weight").value;
    var body = {
      customer_name: document.getElementById("edit-customer-name").value.trim(),
      reference_id: document.getElementById("edit-reference-id").value.trim(),
      phone: document.getElementById("edit-phone").value.trim() || null,
      email: document.getElementById("edit-email").value.trim() || null,
      pick_up_street: document.getElementById("edit-pickup-street").value.trim(),
      pick_up_city: document.getElementById("edit-pickup-city").value.trim(),
      pick_up_state: document.getElementById("edit-pickup-state").value.trim(),
      pick_up_zip: document.getElementById("edit-pickup-zip").value.trim(),
      delivery_street: document.getElementById("edit-delivery-street").value.trim(),
      delivery_city: document.getElementById("edit-delivery-city").value.trim(),
      delivery_state: document.getElementById("edit-delivery-state").value.trim(),
      delivery_zip: document.getElementById("edit-delivery-zip").value.trim(),
      pickup_deadline: document.getElementById("edit-pickup-deadline").value || null,
      dropoff_deadline: document.getElementById("edit-dropoff-deadline").value || null,
      dimensions: document.getElementById("edit-dimensions").value.trim() || null,
      weight: weight ? parseFloat(weight) : null,
      num_packages: parseInt(document.getElementById("edit-num-packages").value, 10) || 1,
      notes: document.getElementById("edit-notes").value.trim() || null,
    };
    try {
      await C.requestJson(apiBase, "/orders/" + encodeURIComponent(orderId), {
        token: token,
        method: "PUT",
        json: body,
      });
      closeEditOrderModal();
      await refreshOrders();
      C.showMessage(el.ordersMessage, "Order updated.", "success");
    } catch (err) {
      C.showMessage(msgEl, err.message, "error");
    }
  }

  document.getElementById("edit-order-form").addEventListener("submit", submitEditOrder);
  document.getElementById("edit-order-close").addEventListener("click", closeEditOrderModal);
  document.getElementById("edit-order-cancel").addEventListener("click", closeEditOrderModal);
  document.getElementById("edit-order-overlay").addEventListener("click", function (e) {
    if (e.target === e.currentTarget) closeEditOrderModal();
  });

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
      C.showMessage(el.authMessage, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    window.location.assign(loginUrl);
  }

  async function finishHostedLoginCallback() {
    const result = await C.consumeHostedLoginCallback(apiBase, hostedFlowConfig());
    if (result.status === "success") {
      await logoutDevAuthSession(true);
      setToken("");
      await restoreWebAuthSession();
      C.showMessage(el.authMessage, "Sign-in complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.authMessage, result.message || "Sign-in failed.", "error");
    }
  }

  async function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname;
    let logoutUrl = "";
    try {
      const result = await C.logoutAuthSession(apiBase, {
        domain: el.cognitoDomain.value.trim(),
        client_id: el.cognitoClientId.value.trim(),
        logout_uri: logoutUri,
      });
      if (result && result.logout_url) {
        logoutUrl = result.logout_url;
      }
    } catch (error) {
      logoutUrl = C.buildHostedLogoutUrl({
        domain: el.cognitoDomain.value.trim(),
        clientId: el.cognitoClientId.value.trim(),
        logoutUri,
      });
    }
    await logoutDevAuthSession(true);
    webSessionClaims = null;
    setToken("");
    allOrders = [];
    lastOrders = [];
    lastDriverLocations = [];
    lastDriverRoster = [];
    selectedDriverId = "";
    renderOrders([]);
    renderDriverList([], []);
    renderDriverMarkers([]);
    renderAssignmentQueues([]);
    updateOrderStats([]);
    updateActiveDriverStat(0);
    renderBillingStatus(null);
    renderBillingSummary(null);
    renderBillingInvitations([]);
    renderInflight([]);
    el.auditLogsView.innerHTML = "No audit logs loaded.";
    el.routeResult.innerHTML = "No route computed yet.";
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  async function bootstrap() {
    if (el.token) {
      el.token.value = token;
    }
    setInteractiveState(false);
    setBillingInteractiveState(false);
    initWorkspaceTabs();
    if (el.authDebug) {
      el.authDebug.hidden = !debugAuth;
    }
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
    await finishHostedLoginCallback();
    await restoreWebAuthSession();
    await restoreDevAuthSession();
    _writeOrderFilters();
    _writeAuditFilters();
    _renderSelectionCount();
    _syncSelectAllCheckbox();
    if (isAuthorizedRole) {
      await Promise.all([
        refreshAssignableDrivers(),
        refreshOrders(),
        refreshDrivers(),
        refreshInflight(),
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
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      lastDriverRoster = [];
      selectedDriverId = "";
      renderOrders([]);
      renderDriverList([], []);
      renderDriverMarkers([]);
      renderAssignmentQueues([]);
      updateActiveDriverStat(0);
      renderBillingStatus(null);
      renderBillingSummary(null);
      renderBillingInvitations([]);
      renderInflight([]);
      el.auditLogsView.innerHTML = "No audit logs loaded.";
      if (el.routeResult) el.routeResult.innerHTML = "No route computed yet.";
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
        allOrders = [];
        lastOrders = [];
        lastDriverLocations = [];
        lastDriverRoster = [];
        selectedDriverId = "";
        renderDriverOptions([]);
        renderOrders([]);
        renderDriverList([], []);
        renderDriverMarkers([]);
        renderAssignmentQueues([]);
        renderInflight([]);
        if (el.routeResult) el.routeResult.innerHTML = "No route computed yet.";
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
  if (el.statsUpcomingDueCard) {
    el.statsUpcomingDueCard.addEventListener("click", function () {
      applyUpcomingDueFilter().catch(function (error) {
        C.showMessage(el.ordersMessage, error.message, "error");
      });
    });
  }
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
  if (el.ordersSortField) {
    el.ordersSortField.addEventListener("change", function () {
      applyOrderFilters().catch(function (error) {
        C.showMessage(el.ordersMessage, error.message, "error");
      });
    });
  }
  if (el.ordersSortDirection) {
    el.ordersSortDirection.addEventListener("change", function () {
      applyOrderFilters().catch(function (error) {
        C.showMessage(el.ordersMessage, error.message, "error");
      });
    });
  }
  if (Array.isArray(el.orderSortButtons)) {
    el.orderSortButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const field = button.getAttribute("data-order-sort-field");
        sortOrdersByField(field).catch(function (error) {
          C.showMessage(el.ordersMessage, error.message, "error");
        });
      });
    });
  }
  el.ordersBody.addEventListener("change", onOrderSelectionChange);
  el.ordersMobile.addEventListener("change", onOrderSelectionChange);
  el.ordersBody.addEventListener("click", onOrderActionClick);
  el.ordersMobile.addEventListener("click", onOrderActionClick);
  if (el.unassignedOrdersList) {
    el.unassignedOrdersList.addEventListener("click", function (event) {
      applyQuickAssign(event).catch(function (error) {
        C.showMessage(el.assignmentMessage || el.ordersMessage, error.message, "error");
      });
    });
  }
  if (el.assignedOrdersList) {
    el.assignedOrdersList.addEventListener("click", function (event) {
      applyQuickAssign(event).catch(function (error) {
        C.showMessage(el.assignmentMessage || el.ordersMessage, error.message, "error");
      });
    });
  }
  el.refreshDrivers.addEventListener("click", refreshDrivers);
  if (el.driverList) {
    el.driverList.addEventListener("click", function (event) {
      onDriverListClick(event).catch(function (error) {
        C.showMessage(el.driversMessage, error.message, "error");
      });
    });
  }
  if (el.refreshInflight) {
    el.refreshInflight.addEventListener("click", function () {
      refreshInflight().catch(function (error) {
        if (el.inflightMessage) C.showMessage(el.inflightMessage, error.message, "error");
      });
    });
  }
  el.refreshAuditLogs.addEventListener("click", refreshAuditLogs);
  el.auditFilterForm.addEventListener("submit", function (event) {
    applyAuditFilters(event).catch(function (error) {
      C.showMessage(el.auditMessage, error.message, "error");
    });
  });
  if (el.optimizeForm) { el.optimizeForm.addEventListener("submit", function(e) { e.preventDefault(); }); }
  el.refreshBilling.addEventListener("click", refreshBillingSummary);
  el.refreshInvitations.addEventListener("click", refreshBillingInvitations);
  el.billingCheckoutForm.addEventListener("submit", startBillingCheckout);
  el.billingPortalForm.addEventListener("submit", startBillingPortal);
  el.billingInviteForm.addEventListener("submit", createBillingInvitation);
  el.billingInvitations.addEventListener("click", onInvitationActionClick);
  el.openPurchaseModal.addEventListener("click", function () {
    el.purchaseModal.hidden = false;
  });
  el.closePurchaseModal.addEventListener("click", function () {
    el.purchaseModal.hidden = true;
  });
  el.purchaseModal.addEventListener("click", function (event) {
    if (event.target === el.purchaseModal) {
      el.purchaseModal.hidden = true;
    }
  });
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
  if (el.loginScreenBtn) {
    el.loginScreenBtn.addEventListener("click", function () {
      launchHostedLogin().catch(function (error) {
        C.showMessage(el.loginScreenMessage, error.message, "error");
      });
    });
  }
  el.logoutHostedUi.addEventListener("click", function () {
    launchHostedLogout().catch(function (error) {
      C.showMessage(el.authMessage, error.message, "error");
    });
  });
  if (el.logoutHostedUiAuth) {
    el.logoutHostedUiAuth.addEventListener("click", function () {
      launchHostedLogout().catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
    });
  }
  if (el.refreshOrdersTable) {
    el.refreshOrdersTable.addEventListener("click", refreshOrders);
  }

  // Dispatch filter tabs
  el.dispatchFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setDispatchFilter(btn.getAttribute("data-dispatch-filter") || "all");
    });
  });

  // Dispatch order search
  if (el.dispatchOrderSearch) {
    el.dispatchOrderSearch.addEventListener("input", function () {
      dispatchSearchTerm = (el.dispatchOrderSearch.value || "").trim();
      renderDispatchOrderList();
    });
  }

  // Dispatch order list clicks (assign actions)
  if (el.dispatchOrderList) {
    el.dispatchOrderList.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement)) return;

      // Handle assign button clicks.
      var btn = target.closest("[data-queue-action]");
      if (btn) {
        var action = btn.getAttribute("data-queue-action");
        var orderId = btn.getAttribute("data-order-id");
        if (!action || !orderId) return;
        if (!requireAuthorized(el.assignmentMessage || el.ordersMessage)) return;
        if (action === "assign-selected") {
          if (!selectedDriverId) {
            C.showMessage(el.assignmentMessage || el.ordersMessage, "Select a driver first.", "error");
            return;
          }
          assignOrder(orderId, selectedDriverId)
            .then(function () {
              C.showMessage(el.assignmentMessage || el.ordersMessage, "Order assigned to " + selectedDriverId + ".", "success");
              return refreshOrders();
            })
            .catch(function (error) {
              C.showMessage(el.assignmentMessage || el.ordersMessage, error.message, "error");
            });
        } else if (action === "unassign") {
          unassignOrder(orderId)
            .then(function () {
              C.showMessage(el.assignmentMessage || el.ordersMessage, "Order unassigned.", "success");
              return refreshOrders();
            })
            .catch(function (error) {
              C.showMessage(el.assignmentMessage || el.ordersMessage, error.message, "error");
            });
        }
        return;
      }

      // Handle order card click → fly to pin on map.
      var card = target.closest("[data-dispatch-order-id]");
      if (card) {
        var clickedOrderId = card.getAttribute("data-dispatch-order-id");
        flyToOrderPin(clickedOrderId);
      }
    });
  }

  bootstrap();
})();
