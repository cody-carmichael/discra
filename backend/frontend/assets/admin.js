(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_admin_auth";
  const apiBase = C.deriveApiBase("/ui/admin");
  const defaultMapStyle = "https://demotiles.maplibre.org/style.json";
  const terminalStatuses = new Set(["Delivered", "Failed"]);
  const dueSoonMinutes = 120;
  const adminAllowedRoles = ["Admin", "Dispatcher"];
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

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
  };

  let token = "";
  let map = null;
  let mapMarkers = [];
  let mapStyleUrl = defaultMapStyle;
  let driverRefreshTimer = null;
  let allOrders = [];
  let lastOrders = [];
  let lastDriverLocations = [];
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
    if (field === "reference_number") {
      return Number.isFinite(order.reference_number) ? order.reference_number : Number.parseInt(order.reference_number || "0", 10) || 0;
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
    const ref = order.reference_number === null || order.reference_number === undefined ? "" : String(order.reference_number);
    const haystack = [
      order.id,
      order.external_order_id,
      order.customer_name,
      ref,
      order.pick_up_address,
      order.delivery,
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
              C.escapeHtml(order.delivery || "-") +
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
      el.selectedDriverLabel.textContent = selectedDriverId || "None selected";
    }
    if (el.assignmentContext) {
      if (selectedDriverId) {
        el.assignmentContext.textContent = "Driver " + selectedDriverId + " selected. Use Assign Selected Driver on unassigned orders.";
      } else {
        el.assignmentContext.textContent = "Select a driver, then assign from the unassigned queue in one click.";
      }
    }
  }

  function selectDriver(driverId, options) {
    const safeDriverId = String(driverId || "").trim();
    selectedDriverId = safeDriverId;
    if (el.bulkDriverId) {
      el.bulkDriverId.value = safeDriverId;
    }
    renderDriverList(lastDriverLocations);
    renderDriverMarkers(lastDriverLocations, { focusDriverId: safeDriverId, keepCurrentViewport: !!(options && options.keepViewport) });
    renderAssignmentQueues(allOrders);
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
    navigator.serviceWorker.register("admin-sw.js?v=20260322c", { scope: "./" }).catch(function () {
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
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      selectedDriverId = "";
      _clearSelection();
      renderDriverOptions([]);
      renderDriverList([]);
      renderDriverMarkers([]);
      renderAssignmentQueues([]);
      updateOrderStats([]);
      updateActiveDriverStat(0);
      setInteractiveState(false);
      setBillingInteractiveState(false);
      el.billingStatus.innerHTML = "No billing provider status loaded.";
      _resetSeatCards();
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
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      selectedDriverId = "";
      _clearSelection();
    }
    setInteractiveState(isAuthorizedRole);
    setBillingInteractiveState(isAuthorizedRole && isAdminRole);
    if (!isAuthorizedRole) {
      el.dispatchSummaryView.innerHTML = "No dispatch summary loaded.";
      renderDriverOptions([]);
      renderDriverList([]);
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
    const startRaw = formData.get("time_window_start");
    const endRaw = formData.get("time_window_end");
    const pickupDeadlineRaw = formData.get("pickup_deadline");
    const dropoffDeadlineRaw = formData.get("dropoff_deadline");
    const startDate = startRaw ? new Date(startRaw) : null;
    const endDate = endRaw ? new Date(endRaw) : null;
    const pickupDeadlineDate = pickupDeadlineRaw ? new Date(pickupDeadlineRaw) : null;
    const dropoffDeadlineDate = dropoffDeadlineRaw ? new Date(dropoffDeadlineRaw) : null;
    const timeWindowStart = startDate && !Number.isNaN(startDate.getTime()) ? startDate.toISOString() : null;
    const timeWindowEnd = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;
    const pickupDeadline = pickupDeadlineDate && !Number.isNaN(pickupDeadlineDate.getTime()) ? pickupDeadlineDate.toISOString() : null;
    const dropoffDeadline = dropoffDeadlineDate && !Number.isNaN(dropoffDeadlineDate.getTime()) ? dropoffDeadlineDate.toISOString() : null;
    const payload = {
      customer_name: formData.get("customer_name"),
      reference_number: C.toIntOrNull(formData.get("reference_number")),
      pick_up_address: formData.get("pick_up_address"),
      delivery: formData.get("delivery"),
      dimensions: formData.get("dimensions"),
      weight: C.toNumberOrNull(formData.get("weight")),
      time_window_start: timeWindowStart,
      time_window_end: timeWindowEnd,
      pickup_deadline: pickupDeadline,
      dropoff_deadline: dropoffDeadline,
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
    renderAssignmentQueues(allOrders);
    if (!lastOrders.length) {
      el.ordersBody.innerHTML = "<tr><td colspan=\"7\">No orders available for the current filters.</td></tr>";
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
        C.escapeHtml(_formatOrderDeadlines(order)) +
        "</small><br><span class=\"" +
        C.escapeHtml(due.cssClass) +
        "\">" +
        C.escapeHtml(due.label) +
        "</span></td>" +
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
        C.escapeHtml(suggestedDriver) +
        "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        assignLabel +
        "</button>" +
        "<button class=\"btn btn-accent\" data-action=\"assign-selected\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Assign Selected Driver</button>" +
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
      const due = _dueBadge(order, nowDate);
      const suggestedDriver = order.assigned_to || selectedDriverId || "";
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
        "<br>Deadlines: " +
        C.escapeHtml(_formatOrderDeadlines(order)) +
        "<br>Due: <span class=\"" +
        C.escapeHtml(due.cssClass) +
        "\">" +
        C.escapeHtml(due.label) +
        "</span>" +
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
        C.escapeHtml(suggestedDriver) +
        "\">" +
        "<div class=\"actions-stack\">" +
        "<button class=\"btn btn-primary\" data-action=\"assign\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">" +
        assignLabel +
        "</button>" +
        "<button class=\"btn btn-accent\" data-action=\"assign-selected\" data-order-id=\"" +
        C.escapeHtml(order.id) +
        "\">Assign Selected</button>" +
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
      allOrders = [];
      renderOrders([]);
      updateOrderStats([]);
      return;
    }
    try {
      const orders = await C.requestJson(apiBase, _ordersPathFromFilters(), { token });
      allOrders = Array.isArray(orders) ? orders : [];
      updateOrderStats(allOrders);
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

  function renderDriverMarkers(driverLocations, options) {
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
    const markerOptions = options || {};
    const focusDriverId = String(markerOptions.focusDriverId || selectedDriverId || "").trim();
    let focusedDriver = null;
    const bounds = new window.maplibregl.LngLatBounds();
    driverLocations.forEach(function (item) {
      const isSelectedDriver = !!focusDriverId && item.driver_id === focusDriverId;
      const marker = new window.maplibregl.Marker({ color: isSelectedDriver ? "#0e7aa6" : "#ffb347" })
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
      marker.getElement().addEventListener("click", function () {
        selectDriver(item.driver_id, { silent: true, keepViewport: false });
      });
      mapMarkers.push(marker);
      bounds.extend([item.lng, item.lat]);
      if (isSelectedDriver) {
        focusedDriver = item;
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

  function renderDriverList(driverLocations) {
    if (!driverLocations.length) {
      el.driverList.innerHTML = "<li>No active drivers in range.</li>";
      return;
    }
    el.driverList.innerHTML = driverLocations
      .map(function (item) {
        const selectedClass = item.driver_id === selectedDriverId ? " is-selected" : "";
        return (
          "<li><button type=\"button\" class=\"driver-list-button" +
          selectedClass +
          "\" data-driver-id=\"" +
          C.escapeHtml(item.driver_id) +
          "\"><strong>" +
          C.escapeHtml(item.driver_id) +
          "</strong><small>" +
          C.escapeHtml(item.lat.toFixed(5) + ", " + item.lng.toFixed(5)) +
          " | " +
          C.escapeHtml(C.formatTimestamp(item.timestamp)) +
          "</small></button></li>"
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
      selectedDriverId = "";
      renderDriverList([]);
      renderDriverMarkers([]);
      renderAssignmentQueues(allOrders);
      updateActiveDriverStat(0);
      return;
    }
    try {
      const drivers = await C.requestJson(apiBase, "/drivers?active_minutes=120", { token });
      lastDriverLocations = Array.isArray(drivers) ? drivers : [];
      const selectedStillActive = selectedDriverId && lastDriverLocations.some(function (item) {
        return item.driver_id === selectedDriverId;
      });
      if (!selectedStillActive) {
        selectedDriverId = "";
      }
      renderDriverList(lastDriverLocations);
      renderDriverMarkers(lastDriverLocations, { keepCurrentViewport: !!selectedStillActive });
      renderAssignmentQueues(allOrders);
      updateActiveDriverStat(lastDriverLocations.length);
      setLastSyncStamp();
      C.showMessage(el.driversMessage, "Loaded " + lastDriverLocations.length + " active drivers.", "success");
    } catch (error) {
      lastDriverLocations = [];
      renderDriverList([]);
      renderDriverMarkers([]);
      renderAssignmentQueues(allOrders);
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
      } else if (action === "assign-selected") {
        if (!selectedDriverId) {
          throw new Error("Select a driver from the map/list first.");
        }
        await assignOrder(orderId, selectedDriverId);
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
    selectedDriverId = "";
    renderOrders([]);
    renderDriverList([]);
    renderDriverMarkers([]);
    renderAssignmentQueues([]);
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
      allOrders = [];
      lastOrders = [];
      lastDriverLocations = [];
      selectedDriverId = "";
      renderOrders([]);
      renderDriverList([]);
      renderDriverMarkers([]);
      renderAssignmentQueues([]);
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
        allOrders = [];
        lastOrders = [];
        lastDriverLocations = [];
        selectedDriverId = "";
        renderDriverOptions([]);
        renderOrders([]);
        renderDriverList([]);
        renderDriverMarkers([]);
        renderAssignmentQueues([]);
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
  el.logoutHostedUi.addEventListener("click", function () {
    launchHostedLogout().catch(function (error) {
      C.showMessage(el.authMessage, error.message, "error");
    });
  });

  bootstrap();
})();
