(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_review_auth";
  const reviewTokenStorageKey = "discra_review_token";
  const apiBase = C.deriveApiBase("/ui/review");
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    authState: document.getElementById("review-auth-state"),
    claims: document.getElementById("review-claims-view"),
    message: document.getElementById("review-message"),
    linkMode: document.getElementById("review-link-mode"),
    queue: document.getElementById("review-queue"),
    pendingSelect: document.getElementById("review-pending-select"),
    loadPending: document.getElementById("review-load-pending"),
    tokenManual: document.getElementById("review-token-manual"),
    reviewToken: document.getElementById("review-token"),
    loadButton: document.getElementById("review-load"),
    summarySurface: document.getElementById("review-summary-surface"),
    sessionHelp: document.getElementById("review-session-help"),
    approverEmail: document.getElementById("review-approver-email"),
    reason: document.getElementById("review-reason"),
    decisionGate: document.getElementById("review-decision-gate"),
    approve: document.getElementById("review-approve"),
    reject: document.getElementById("review-reject"),
    cognitoDomain: document.getElementById("review-cognito-domain"),
    cognitoClientId: document.getElementById("review-cognito-client-id"),
    loginHostedUi: document.getElementById("review-login-hosted-ui"),
    logoutHostedUi: document.getElementById("review-logout-hosted-ui"),
    authConfig: document.getElementById("review-auth-config"),
    authDebug: document.getElementById("review-auth-debug"),
  };

  let loadedReview = null;
  let sessionClaims = null;
  let tokenLoadedFromLink = false;
  let pendingRegistrations = [];
  let selectedPendingRegistrationId = "";

  function claimsFromSessionUser(user) {
    if (!user || typeof user !== "object") {
      return null;
    }
    const groups = Array.isArray(user.groups) ? user.groups : [];
    return {
      sub: user.sub || user.username || "",
      username: user.username || user.sub || "",
      email: user.email || "",
      org_id: user.org_id || "",
      "custom:org_id": user.org_id || "",
      groups: groups,
      "cognito:groups": groups,
      _web_session: true,
    };
  }

  function reviewTokenValue() {
    return (el.reviewToken.value || "").trim();
  }

  function hostedUiConfigured() {
    return Boolean(el.cognitoDomain.value.trim() && el.cognitoClientId.value.trim());
  }

  function decisionAllowed() {
    if (!loadedReview || !loadedReview.registration) {
      return false;
    }
    return !!loadedReview.decision_allowed && String(loadedReview.registration.status || "") === "Pending";
  }

  function findPendingById(registrationId) {
    if (!registrationId) {
      return null;
    }
    for (let index = 0; index < pendingRegistrations.length; index += 1) {
      const item = pendingRegistrations[index];
      if (item && item.registration_id === registrationId) {
        return item;
      }
    }
    return null;
  }

  function registrationOptionLabel(registration) {
    if (!registration) {
      return "";
    }
    const tenant = registration.tenant_name || "Unknown Tenant";
    const requester = registration.requester_email || registration.identity_sub || "unknown";
    return tenant + " - " + requester;
  }

  function renderPendingOptions() {
    if (!el.pendingSelect) {
      return;
    }
    while (el.pendingSelect.firstChild) {
      el.pendingSelect.removeChild(el.pendingSelect.firstChild);
    }
    if (!pendingRegistrations.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No pending requests";
      el.pendingSelect.appendChild(option);
      el.pendingSelect.disabled = true;
      return;
    }
    el.pendingSelect.disabled = false;
    for (let index = 0; index < pendingRegistrations.length; index += 1) {
      const registration = pendingRegistrations[index];
      const option = document.createElement("option");
      option.value = registration.registration_id || "";
      option.textContent = registrationOptionLabel(registration);
      option.selected = option.value === selectedPendingRegistrationId;
      el.pendingSelect.appendChild(option);
    }
  }

  function selectPendingRegistration(registrationId) {
    const registration = findPendingById(registrationId);
    if (!registration) {
      selectedPendingRegistrationId = "";
      if (!reviewTokenValue()) {
        renderSummary(null);
      }
      return;
    }
    selectedPendingRegistrationId = registration.registration_id || "";
    if (el.pendingSelect) {
      el.pendingSelect.value = selectedPendingRegistrationId;
    }
    if (!reviewTokenValue()) {
      renderSummary({
        registration,
        token_expires_at:
          registration.review_token_expires_at ||
          registration.updated_at ||
          registration.submitted_at ||
          new Date().toISOString(),
        decision_allowed: String(registration.status || "") === "Pending",
      });
    }
  }

  async function loadPendingRegistrations(options) {
    const opts = options || {};
    if (!sessionClaims) {
      pendingRegistrations = [];
      selectedPendingRegistrationId = "";
      renderPendingOptions();
      syncGateState();
      return;
    }
    try {
      const payload = await C.requestJson(apiBase, "/onboarding/registrations/pending");
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      pendingRegistrations = items;
      if (items.length && !selectedPendingRegistrationId) {
        selectedPendingRegistrationId = items[0].registration_id || "";
      }
      if (selectedPendingRegistrationId && !findPendingById(selectedPendingRegistrationId)) {
        selectedPendingRegistrationId = items.length ? items[0].registration_id || "" : "";
      }
      renderPendingOptions();
      if (!reviewTokenValue()) {
        if (selectedPendingRegistrationId) {
          selectPendingRegistration(selectedPendingRegistrationId);
        } else {
          renderSummary(null);
        }
      }
      if (opts.notify === true) {
        C.showMessage(
          el.message,
          items.length
            ? "Loaded " + String(items.length) + " pending request(s)."
            : "No pending registration requests right now.",
          "success"
        );
      }
    } catch (error) {
      pendingRegistrations = [];
      selectedPendingRegistrationId = "";
      renderPendingOptions();
      if (opts.notify === true) {
        C.showMessage(el.message, error.message, "error");
      }
    }
    syncGateState();
  }

  function updateTokenEntryMode() {
    const hasToken = !!reviewTokenValue();
    if (el.linkMode) {
      if (hasToken && tokenLoadedFromLink) {
        el.linkMode.textContent = "Secure token loaded from your email link.";
      } else if (hasToken) {
        el.linkMode.textContent = "Review token loaded.";
      } else if (sessionClaims) {
        el.linkMode.textContent = "No signed link loaded. Use the pending requests queue below.";
      } else {
        el.linkMode.textContent = "Open a signed review link from email to load request details.";
      }
    }
    if (el.tokenManual) {
      el.tokenManual.hidden = false;
      el.tokenManual.open = !hasToken || !tokenLoadedFromLink;
    }
  }

  function syncGateState() {
    const authenticated = !!sessionClaims;
    const hasToken = !!reviewTokenValue();
    const queueSelection = selectedPendingRegistrationId ? findPendingById(selectedPendingRegistrationId) : null;
    const canDecide = authenticated && (hasToken ? decisionAllowed() : !!queueSelection && decisionAllowed());

    el.approve.disabled = !canDecide;
    el.reject.disabled = !canDecide;
    if (el.reason) {
      el.reason.disabled = !authenticated;
    }

    if (el.loginHostedUi) {
      el.loginHostedUi.hidden = authenticated;
      el.loginHostedUi.disabled = authenticated || !hostedUiConfigured();
    }
    if (el.logoutHostedUi) {
      el.logoutHostedUi.hidden = !authenticated;
      el.logoutHostedUi.disabled = !authenticated;
    }

    if (el.sessionHelp) {
      if (authenticated) {
        el.sessionHelp.textContent = "Approver session active. You can now review and apply a decision.";
      } else {
        el.sessionHelp.textContent = "Sign in as an allowlisted App Dev user before applying a decision.";
      }
    }
    if (el.queue) {
      el.queue.hidden = !authenticated || hasToken;
    }
    if (el.loadPending) {
      el.loadPending.disabled = !authenticated;
    }
    if (el.pendingSelect) {
      el.pendingSelect.disabled = !authenticated || !pendingRegistrations.length;
    }
    if (el.approverEmail) {
      const email = sessionClaims && sessionClaims.email ? String(sessionClaims.email) : "";
      if (authenticated && email) {
        el.approverEmail.hidden = false;
        el.approverEmail.innerHTML = "<strong>Signed in as:</strong> " + C.escapeHtml(email);
      } else {
        el.approverEmail.hidden = true;
        el.approverEmail.textContent = "";
      }
    }
    if (el.decisionGate) {
      if (!authenticated) {
        el.decisionGate.textContent = "Sign in to review before approving or rejecting.";
      } else if (!hasToken && !pendingRegistrations.length) {
        el.decisionGate.textContent = "No pending requests in queue. Open a signed review link from email if needed.";
      } else if (!hasToken && !queueSelection) {
        el.decisionGate.textContent = "Select a pending request from the approver queue.";
      } else if (!hasToken) {
        el.decisionGate.textContent = "Queue mode active. Approve or reject the selected pending request.";
      } else if (!loadedReview) {
        el.decisionGate.textContent = "Resolve token details first.";
      } else if (!decisionAllowed()) {
        el.decisionGate.textContent = "Decision is already final for this request.";
      } else {
        el.decisionGate.textContent = "Ready. Apply approve or reject for this tenant request.";
      }
    }
    if (el.authConfig) {
      el.authConfig.hidden = hostedUiConfigured();
    }
  }

  function statusLabel(status) {
    if (status === "Approved") {
      return '<span class="table-status status-delivered">Approved</span>';
    }
    if (status === "Rejected") {
      return '<span class="table-status status-failed">Rejected</span>';
    }
    return '<span class="table-status">Pending</span>';
  }

  function renderSummary(reviewPayload) {
    loadedReview = reviewPayload || null;
    if (!reviewPayload || !reviewPayload.registration) {
      if (reviewTokenValue()) {
        el.summarySurface.innerHTML = "Token loaded. Resolve to view registration details.";
      } else if (sessionClaims && pendingRegistrations.length) {
        el.summarySurface.innerHTML = "Select a pending request from the queue to review details.";
      } else {
        el.summarySurface.innerHTML = "Open your signed review email link to load registration details.";
      }
      syncGateState();
      return;
    }
    const registration = reviewPayload.registration;
    const status = registration.status || "Pending";
    const decisionAllowed = !!reviewPayload.decision_allowed && status === "Pending";
    const details = [
      { label: "Tenant", value: registration.tenant_name || "-" },
      { label: "Status", value: statusLabel(status) },
      { label: "Requester", value: registration.requester_email || registration.identity_sub || "-" },
      { label: "Submitted", value: C.formatTimestamp(registration.submitted_at) },
      { label: "Token Expires", value: C.formatTimestamp(reviewPayload.token_expires_at) },
      { label: "Org ID", value: registration.org_id || "-" },
    ];
    const rows = details
      .map(function (item) {
        return (
          '<div class="kv-item"><span class="kv-label">' +
          C.escapeHtml(item.label) +
          '</span><span class="kv-value">' +
          item.value +
          "</span></div>"
        );
      })
      .join("");
    const footer =
      '<p class="panel-help" style="margin-top:0.75rem">' +
      C.escapeHtml(
        decisionAllowed
          ? "Decision can be applied once by an allowlisted App Dev approver."
          : "Decision is already final for this registration (idempotent replay only)."
      ) +
      "</p>";
    el.summarySurface.innerHTML = '<div class="kv-grid">' + rows + "</div>" + footer;
    syncGateState();
  }

  function renderClaims() {
    const claims = sessionClaims;
    if (!claims) {
      el.authState.textContent = "Not Signed In";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No active web session.";
      syncGateState();
      return;
    }
    const email = claims.email ? String(claims.email) : "";
    el.authState.textContent = email ? "Signed In" : "Signed In";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.claims.textContent = JSON.stringify(claims, null, 2);
    syncGateState();
  }

  async function restoreWebSession() {
    try {
      const session = await C.getAuthSession(apiBase);
      if (session && session.active && session.user) {
        sessionClaims = claimsFromSessionUser(session.user);
      } else {
        sessionClaims = null;
      }
    } catch (error) {
      sessionClaims = null;
    }
    renderClaims();
    return !!sessionClaims;
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
      if (!hostedUiConfigured()) {
        C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      }
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
    syncGateState();
  }

  async function resolveToken() {
    const signedToken = reviewTokenValue();
    updateTokenEntryMode();
    if (!signedToken) {
      C.showMessage(el.message, "Review token is required.", "error");
      renderSummary(null);
      return;
    }
    try {
      const result = await C.requestJson(
        apiBase,
        "/onboarding/review?token=" + encodeURIComponent(signedToken),
        { method: "GET" }
      );
      localStorage.setItem(reviewTokenStorageKey, signedToken);
      if (result && result.registration && result.registration.registration_id) {
        selectedPendingRegistrationId = result.registration.registration_id;
      }
      renderSummary(result);
      C.showMessage(el.message, "Review token resolved.", "success");
    } catch (error) {
      renderSummary(null);
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function applyDecision(decision) {
    const signedToken = reviewTokenValue();
    if (!sessionClaims) {
      C.showMessage(el.message, "Sign in as an approver first.", "error");
      return;
    }
    const queueSelection = selectedPendingRegistrationId ? findPendingById(selectedPendingRegistrationId) : null;
    if (!signedToken && !queueSelection) {
      C.showMessage(el.message, "Select a pending request or open a signed review link first.", "error");
      return;
    }
    try {
      const response = signedToken
        ? await C.requestJson(apiBase, "/onboarding/review/decision", {
            method: "POST",
            json: {
              token: signedToken,
              decision: decision,
              reason: el.reason.value.trim() || null,
            },
          })
        : await C.requestJson(apiBase, "/onboarding/review/decision/by-registration", {
            method: "POST",
            json: {
              registration_id: queueSelection.registration_id,
              decision: decision,
              reason: el.reason.value.trim() || null,
            },
          });
      renderSummary({
        registration: response.registration,
        token_expires_at:
          loadedReview && loadedReview.token_expires_at
            ? loadedReview.token_expires_at
            : new Date(Date.now() + 60000).toISOString(),
        decision_allowed: false,
      });
      if (!signedToken) {
        await loadPendingRegistrations();
      }
      C.showMessage(el.message, response.message || "Decision applied.", "success");
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  function hostedFlowConfig() {
    return {
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      redirectUri: window.location.origin + window.location.pathname,
      storageKey,
    };
  }

  function persistReviewTokenForAuthRoundtrip() {
    const value = reviewTokenValue();
    if (!value) {
      localStorage.removeItem(reviewTokenStorageKey);
      return;
    }
    localStorage.setItem(reviewTokenStorageKey, value);
  }

  function restoreReviewTokenAfterAuthRoundtrip() {
    if (reviewTokenValue()) {
      return;
    }
    const stored = (localStorage.getItem(reviewTokenStorageKey) || "").trim();
    if (!stored) {
      return;
    }
    el.reviewToken.value = stored;
  }

  async function launchHostedLogin() {
    if (sessionClaims) {
      C.showMessage(el.message, "Approver session already active.", "success");
      return;
    }
    if (!hostedUiConfigured()) {
      C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    persistReviewTokenForAuthRoundtrip();
    const loginUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!loginUrl) {
      C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    window.location.assign(loginUrl);
  }

  async function finishHostedLoginCallback() {
    const config = hostedFlowConfig();
    let result = { status: "none" };
    if (typeof C.consumeHostedLoginCallback === "function") {
      // Support both callback helper signatures:
      // - legacy: consumeHostedLoginCallback(config)
      // - current: consumeHostedLoginCallback(apiBase, config)
      if (C.consumeHostedLoginCallback.length <= 1) {
        result = await C.consumeHostedLoginCallback(config);
      } else {
        result = await C.consumeHostedLoginCallback(apiBase, config);
      }
    }
    if (result.status === "success") {
      restoreReviewTokenAfterAuthRoundtrip();
      tokenLoadedFromLink = !!reviewTokenValue();
      updateTokenEntryMode();
      await restoreWebSession();
      if (!reviewTokenValue()) {
        await loadPendingRegistrations();
      }
      C.showMessage(el.message, "Sign-in complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Sign-in failed.", "error");
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
    sessionClaims = null;
    pendingRegistrations = [];
    selectedPendingRegistrationId = "";
    renderPendingOptions();
    renderClaims();
    C.showMessage(el.message, "Session cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  function preloadReviewTokenFromQuery() {
    const params = new URLSearchParams(window.location.search || "");
    const value = params.get("token");
    if (value) {
      el.reviewToken.value = value;
      localStorage.setItem(reviewTokenStorageKey, value);
      tokenLoadedFromLink = true;
      updateTokenEntryMode();
      return;
    }
    const callbackRoundtrip = params.has("code") || params.has("state");
    if (!callbackRoundtrip) {
      localStorage.removeItem(reviewTokenStorageKey);
      tokenLoadedFromLink = false;
      updateTokenEntryMode();
      return;
    }
    restoreReviewTokenAfterAuthRoundtrip();
    tokenLoadedFromLink = !!reviewTokenValue();
    updateTokenEntryMode();
  }

  async function bootstrap() {
    if (el.authDebug) {
      el.authDebug.hidden = !debugAuth;
    }
    renderPendingOptions();
    renderSummary(null);
    updateTokenEntryMode();
    renderClaims();
    preloadReviewTokenFromQuery();
    await loadUiConfig();
    await finishHostedLoginCallback();
    await restoreWebSession();
    if (reviewTokenValue()) {
      await resolveToken();
    } else if (sessionClaims) {
      await loadPendingRegistrations();
    } else {
      renderSummary(null);
    }
    syncGateState();
  }

  el.loadButton.addEventListener("click", function () {
    resolveToken().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.loadPending.addEventListener("click", function () {
    loadPendingRegistrations({ notify: true }).catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.pendingSelect.addEventListener("change", function () {
    selectedPendingRegistrationId = el.pendingSelect.value || "";
    selectPendingRegistration(selectedPendingRegistrationId);
    syncGateState();
  });
  el.reviewToken.addEventListener("input", function () {
    tokenLoadedFromLink = false;
    loadedReview = null;
    updateTokenEntryMode();
    syncGateState();
  });
  el.cognitoDomain.addEventListener("input", function () {
    syncGateState();
  });
  el.cognitoClientId.addEventListener("input", function () {
    syncGateState();
  });
  el.approve.addEventListener("click", function () {
    applyDecision("approve").catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.reject.addEventListener("click", function () {
    applyDecision("reject").catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.loginHostedUi.addEventListener("click", function () {
    launchHostedLogin().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.logoutHostedUi.addEventListener("click", function () {
    launchHostedLogout().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });

  bootstrap();
})();
