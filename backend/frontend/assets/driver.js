(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_driver_auth";
  const apiBase = C.deriveApiBase("/ui/driver");
  const driverAllowedRoles = ["Driver"];
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    authState: document.getElementById("driver-auth-state"),
    token: document.getElementById("driver-jwt-token"),
    saveToken: document.getElementById("driver-save-token"),
    clearToken: document.getElementById("driver-clear-token"),
    claims: document.getElementById("driver-claims-view"),
    authMessage: document.getElementById("driver-auth-message"),
    refreshInbox: document.getElementById("refresh-inbox"),
    orders: document.getElementById("driver-orders"),
    ordersMessage: document.getElementById("driver-orders-message"),
    sendLocationNow: document.getElementById("send-location-now"),
    startLocationShare: document.getElementById("start-location-share"),
    stopLocationShare: document.getElementById("stop-location-share"),
    locationStatus: document.getElementById("location-status"),
    cognitoDomain: document.getElementById("driver-cognito-domain"),
    cognitoClientId: document.getElementById("driver-cognito-client-id"),
    loginHostedUi: document.getElementById("driver-login-hosted-ui"),
    logoutHostedUi: document.getElementById("driver-logout-hosted-ui"),
    authDebug: document.getElementById("driver-auth-debug"),
    devAuthPanel: document.getElementById("driver-dev-auth-panel"),
    devAuthActions: document.getElementById("driver-dev-auth-actions"),
  };

  let token = "";
  let locationTimer = null;
  let isAuthorizedRole = false;
  let devAuthEnabled = false;
  let devAuthProfiles = [];
  let devSessionClaims = null;
  let webSessionClaims = null;
  const autoDevBootstrapKey = storageKey + "_auto_dev_bootstrapped";

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
      return driverAllowedRoles.indexOf(role) >= 0;
    });
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

  function setInteractiveState(enabled) {
    el.refreshInbox.disabled = !enabled;
    el.sendLocationNow.disabled = !enabled;
    el.startLocationShare.disabled = !enabled;
    el.stopLocationShare.disabled = !enabled;
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
      C.showMessage(el.authMessage, "Driver role is required for this workspace.", "error");
    }
  }

  function requireAuthorized(messageElement) {
    if (!token && !devSessionClaims && !webSessionClaims) {
      C.showMessage(messageElement, "Sign in to continue.", "error");
      return false;
    }
    if (!isAuthorizedRole) {
      C.showMessage(messageElement, "Current session does not include Driver role.", "error");
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
    } catch (error) {
      devAuthEnabled = false;
      devAuthProfiles = [];
      renderDevAuthActions();
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

    const driverProfiles = devAuthProfiles
      .map(function (profile, index) {
        return { profile: profile, index: index };
      })
      .filter(function (entry) {
        return entry.profile && driverAllowedRoles.indexOf(entry.profile.role) >= 0;
      });
    if (!driverProfiles.length) {
      el.devAuthPanel.hidden = true;
      el.devAuthActions.innerHTML = "";
      return;
    }

    const buttons = driverProfiles
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
    return devAuthProfiles.findIndex(function (profile) {
      return profile && driverAllowedRoles.indexOf(profile.role) >= 0;
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
    C.showMessage(el.authMessage, "Auto-started driver dev session for first-load testing.", "success");
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
  function setupSignaturePad(canvas) {
    if (!canvas || canvas.dataset.initialized === "1") {
      return;
    }
    canvas.dataset.initialized = "1";
    canvas.dataset.dirty = "0";

    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#8ec8e8";

    let drawing = false;

    function pointFromEvent(event) {
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
      return { x, y };
    }

    function start(event) {
      drawing = true;
      const point = pointFromEvent(event);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      canvas.dataset.dirty = "1";
      canvas.setPointerCapture(event.pointerId);
    }

    function move(event) {
      if (!drawing) {
        return;
      }
      const point = pointFromEvent(event);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }

    function end(event) {
      drawing = false;
      if (event.pointerId) {
        canvas.releasePointerCapture(event.pointerId);
      }
    }

    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointerleave", end);
    canvas.addEventListener("pointercancel", end);
  }

  function clearSignature(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.dataset.dirty = "0";
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("Could not capture signature image."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  async function uploadWithPresignedPost(upload, fileBlob, fileName) {
    const formData = new FormData();
    Object.entries(upload.fields || {}).forEach(function (entry) {
      formData.append(entry[0], entry[1]);
    });
    formData.append("file", fileBlob, fileName);
    const response = await fetch(upload.url, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error("Upload failed for POD artifact.");
    }
  }

  async function getCurrentPosition() {
    if (!navigator.geolocation) {
      return null;
    }
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(
        function (position) {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            heading:
              typeof position.coords.heading === "number" && !Number.isNaN(position.coords.heading)
                ? position.coords.heading
                : null,
          });
        },
        function () {
          resolve(null);
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 7000 }
      );
    });
  }

  function _statusBadgeClass(status) {
    var s = String(status || "").toLowerCase();
    if (s === "assigned") return "badge-assigned";
    if (s === "pickedup") return "badge-pickedup";
    if (s === "enroute") return "badge-enroute";
    if (s === "delivered") return "badge-delivered";
    if (s === "failed") return "badge-failed";
    return "badge-created";
  }

  function orderCardMarkup(order) {
    var badgeClass = _statusBadgeClass(order.status);
    var pickup = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip].filter(Boolean).join(", ") || "-";
    var delivery = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip].filter(Boolean).join(", ") || "-";

    return (
      "<article class=\"driver-stop-card\" data-order-id=\"" + C.escapeHtml(order.id) + "\">" +
      "<div class=\"driver-stop-header\">" +
      "<div><strong>" + C.escapeHtml(order.customer_name) + "</strong>" +
      "<br><small class=\"text-muted\">Ref " + C.escapeHtml(order.reference_id || "-") + "</small></div>" +
      "<span class=\"dispatch-status-badge " + badgeClass + "\">" + C.escapeHtml(order.status) + "</span>" +
      "</div>" +
      "<div class=\"driver-stop-addresses\">" +
      "<div class=\"driver-stop-addr\"><small class=\"text-muted\">PICKUP</small><div>" + C.escapeHtml(pickup) + "</div></div>" +
      "<div class=\"driver-stop-addr\"><small class=\"text-muted\">DELIVERY</small><div>" + C.escapeHtml(delivery) + "</div></div>" +
      "</div>" +
      (order.phone ? "<div class=\"driver-stop-meta\"><small class=\"text-muted\">Phone:</small> " + C.escapeHtml(order.phone) + "</div>" : "") +
      (order.notes ? "<div class=\"driver-stop-meta\"><small class=\"text-muted\">Notes:</small> " + C.escapeHtml(order.notes) + "</div>" : "") +
      "<div class=\"driver-stop-actions\">" +
      "<button class=\"btn btn-primary btn-sm\" data-action=\"status\" data-status=\"PickedUp\">Picked Up</button>" +
      "<button class=\"btn btn-accent btn-sm\" data-action=\"status\" data-status=\"EnRoute\">En Route</button>" +
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"status\" data-status=\"Failed\">Failed</button>" +
      "</div>" +
      "<div class=\"driver-stop-pod\">" +
      "<div class=\"driver-pod-row\">" +
      "<label class=\"field\"><span>Photo</span><input class=\"pod-photo compact-input\" type=\"file\" accept=\"image/*\"></label>" +
      "</div>" +
      "<div class=\"driver-pod-row\">" +
      "<label class=\"field\"><span>Signature</span></label>" +
      "<div class=\"driver-signature-wrap\"><canvas class=\"signature-pad\" width=\"320\" height=\"120\"></canvas></div>" +
      "<button class=\"btn btn-ghost btn-xs\" data-action=\"clear-signature\">Clear</button>" +
      "</div>" +
      "<label class=\"field\"><span>Delivery Notes</span><textarea class=\"pod-notes compact-input\" rows=\"2\" placeholder=\"Left with front desk...\"></textarea></label>" +
      "<button class=\"btn btn-accent\" data-action=\"submit-pod\">Submit POD &amp; Deliver</button>" +
      "</div>" +
      "</article>"
    );
  }

  function renderOrders(orders) {
    if (!orders || !orders.length) {
      el.orders.innerHTML = "<p class=\"panel-help\">No assigned orders found.</p>";
      return;
    }
    el.orders.innerHTML = orders.map(orderCardMarkup).join("");
    el.orders.querySelectorAll("canvas.signature-pad").forEach(setupSignaturePad);
  }

  async function refreshInbox() {
    if (!requireAuthorized(el.ordersMessage)) {
      renderOrders([]);
      return;
    }
    try {
      const orders = await C.requestJson(apiBase, "/orders/driver/inbox", { token });
      renderOrders(orders || []);
      C.showMessage(el.ordersMessage, "Loaded " + (orders || []).length + " assigned orders.", "success");
    } catch (error) {
      C.showMessage(el.ordersMessage, error.message, "error");
    }
  }

  async function updateOrderStatus(orderId, statusValue, notes) {
    await C.requestJson(apiBase, "/orders/" + orderId + "/status", {
      method: "POST",
      token,
      json: { status: statusValue, notes: notes || null },
    });
  }

  async function submitPod(orderCard) {
    const orderId = orderCard.getAttribute("data-order-id");
    const notesElement = orderCard.querySelector(".pod-notes");
    const notes = notesElement ? notesElement.value.trim() : "";
    const photoInput = orderCard.querySelector(".pod-photo");
    const photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;
    const signatureCanvas = orderCard.querySelector("canvas.signature-pad");

    const artifacts = [];
    if (photoFile) {
      artifacts.push({
        artifact_type: "photo",
        content_type: photoFile.type || "image/jpeg",
        file_size_bytes: photoFile.size,
        file_name: photoFile.name || "delivery-photo.jpg",
        blob: photoFile,
      });
    }

    if (signatureCanvas && signatureCanvas.dataset.dirty === "1") {
      const signatureBlob = await canvasToBlob(signatureCanvas);
      artifacts.push({
        artifact_type: "signature",
        content_type: "image/png",
        file_size_bytes: signatureBlob.size,
        file_name: "signature.png",
        blob: signatureBlob,
      });
    }

    if (!artifacts.length) {
      throw new Error("Attach a photo or signature before submitting POD.");
    }

    const presignPayload = {
      order_id: orderId,
      artifacts: artifacts.map(function (item) {
        return {
          artifact_type: item.artifact_type,
          content_type: item.content_type,
          file_size_bytes: item.file_size_bytes,
          file_name: item.file_name,
        };
      }),
    };
    const presigned = await C.requestJson(apiBase, "/pod/presign", {
      method: "POST",
      token,
      json: presignPayload,
    });

    const photoKeys = [];
    const signatureKeys = [];
    for (let index = 0; index < presigned.uploads.length; index += 1) {
      const upload = presigned.uploads[index];
      const artifact = artifacts[index];
      await uploadWithPresignedPost(upload, artifact.blob, artifact.file_name);
      if (upload.artifact_type === "photo") {
        photoKeys.push(upload.key);
      } else if (upload.artifact_type === "signature") {
        signatureKeys.push(upload.key);
      }
    }

    const location = await getCurrentPosition();
    await C.requestJson(apiBase, "/pod/metadata", {
      method: "POST",
      token,
      json: {
        order_id: orderId,
        photo_keys: photoKeys,
        signature_keys: signatureKeys,
        notes: notes || null,
        location,
      },
    });

    await updateOrderStatus(orderId, "Delivered", notes);
  }

  async function sendLocationUpdate() {
    if (!requireAuthorized(el.locationStatus)) {
      return;
    }
    const location = await getCurrentPosition();
    if (!location) {
      C.showMessage(el.locationStatus, "Location unavailable. Check browser permissions.", "error");
      return;
    }
    try {
      await C.requestJson(apiBase, "/drivers/location", {
        method: "POST",
        token,
        json: location,
      });
      C.showMessage(
        el.locationStatus,
        "Location sent at " + new Date().toLocaleTimeString() + " (" + location.lat.toFixed(4) + ", " + location.lng.toFixed(4) + ")",
        "success"
      );
    } catch (error) {
      C.showMessage(el.locationStatus, error.message, "error");
    }
  }

  function startLocationShare() {
    if (locationTimer) {
      return;
    }
    if (!requireAuthorized(el.locationStatus)) {
      return;
    }
    sendLocationUpdate();
    locationTimer = window.setInterval(sendLocationUpdate, 60000);
    C.showMessage(el.locationStatus, "Auto-share started (every 60 seconds).", "success");
  }

  function stopLocationShare() {
    if (!locationTimer) {
      C.showMessage(el.locationStatus, "Auto share is already off.", "success");
      return;
    }
    window.clearInterval(locationTimer);
    locationTimer = null;
    C.showMessage(el.locationStatus, "Auto-share stopped.", "success");
  }

  async function onOrderActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.getAttribute("data-action");
    if (!action) {
      return;
    }
    const orderCard = target.closest(".driver-stop-card");
    if (!orderCard) {
      return;
    }
    const orderId = orderCard.getAttribute("data-order-id");
    if (!orderId) {
      return;
    }
    if (!requireAuthorized(el.ordersMessage)) {
      return;
    }

    try {
      if (action === "status") {
        const statusValue = target.getAttribute("data-status");
        await updateOrderStatus(orderId, statusValue);
        C.showMessage(el.ordersMessage, "Updated " + orderId + " to " + statusValue + ".", "success");
      } else if (action === "clear-signature") {
        const canvas = orderCard.querySelector("canvas.signature-pad");
        if (canvas) {
          clearSignature(canvas);
        }
        return;
      } else if (action === "submit-pod") {
        await submitPod(orderCard);
        C.showMessage(el.ordersMessage, "POD submitted and order delivered.", "success");
      }
      await refreshInbox();
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
    stopLocationShare();
    await logoutDevAuthSession(true);
    webSessionClaims = null;
    setToken("");
    renderOrders([]);
    C.showMessage(el.authMessage, "Session cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("driver-sw.js", { scope: "./" }).catch(function () {
      // Keep onboarding flow unblocked when service worker registration fails.
    });
  }

  async function bootstrap() {
    if (el.token) {
      el.token.value = token;
    }
    if (el.authDebug) {
      el.authDebug.hidden = !debugAuth;
    }
    setInteractiveState(false);
    renderClaims();
    registerServiceWorker();
    await loadUiConfig();
    await finishHostedLoginCallback();
    await restoreWebAuthSession();
    await restoreDevAuthSession();
    await maybeAutoBootstrapDevSession();
    if (isAuthorizedRole) {
      await refreshInbox();
    } else {
      renderOrders([]);
    }
  }
  el.saveToken.addEventListener("click", function () {
    logoutDevAuthSession(true)
      .then(function () {
        setToken(el.token.value);
        C.showMessage(el.authMessage, "Token saved.", "success");
      })
      .catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
  });
  el.clearToken.addEventListener("click", function () {
    logoutDevAuthSession(true)
      .then(function () {
        stopLocationShare();
        setToken("");
        renderOrders([]);
        C.showMessage(el.authMessage, "Session cleared.", "success");
      })
      .catch(function (error) {
        C.showMessage(el.authMessage, error.message, "error");
      });
  });
  el.refreshInbox.addEventListener("click", refreshInbox);
  el.orders.addEventListener("click", onOrderActionClick);
  el.sendLocationNow.addEventListener("click", sendLocationUpdate);
  el.startLocationShare.addEventListener("click", startLocationShare);
  el.stopLocationShare.addEventListener("click", stopLocationShare);
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
