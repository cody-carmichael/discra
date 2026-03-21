(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_review_auth";
  const apiBase = C.deriveApiBase("/ui/review");
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    authState: document.getElementById("review-auth-state"),
    claims: document.getElementById("review-claims-view"),
    message: document.getElementById("review-message"),
    reviewToken: document.getElementById("review-token"),
    loadButton: document.getElementById("review-load"),
    summarySurface: document.getElementById("review-summary-surface"),
    reason: document.getElementById("review-reason"),
    approve: document.getElementById("review-approve"),
    reject: document.getElementById("review-reject"),
    cognitoDomain: document.getElementById("review-cognito-domain"),
    cognitoClientId: document.getElementById("review-cognito-client-id"),
    loginHostedUi: document.getElementById("review-login-hosted-ui"),
    logoutHostedUi: document.getElementById("review-logout-hosted-ui"),
    authDebug: document.getElementById("review-auth-debug"),
  };

  let loadedReview = null;
  let sessionClaims = null;

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
      el.summarySurface.innerHTML = "Paste a token to load registration details.";
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
    el.approve.disabled = !decisionAllowed;
    el.reject.disabled = !decisionAllowed;
  }

  function renderClaims() {
    const claims = sessionClaims;
    if (!claims) {
      el.authState.textContent = "Not Signed In";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No active web session.";
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    el.authState.textContent = roles ? "Signed In: " + roles : "Signed In";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.claims.textContent = JSON.stringify(claims, null, 2);
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
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function resolveToken() {
    const signedToken = reviewTokenValue();
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
      renderSummary(result);
      C.showMessage(el.message, "Review token resolved.", "success");
    } catch (error) {
      renderSummary(null);
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function applyDecision(decision) {
    const signedToken = reviewTokenValue();
    if (!signedToken) {
      C.showMessage(el.message, "Review token is required.", "error");
      return;
    }
    if (!sessionClaims) {
      C.showMessage(el.message, "Sign in as an approver first.", "error");
      return;
    }
    try {
      const response = await C.requestJson(apiBase, "/onboarding/review/decision", {
        method: "POST",
        json: {
          token: signedToken,
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
      C.showMessage(el.message, response.message || "Decision applied.", "success");
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  function hostedFlowConfig() {
    return {
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      redirectUri: window.location.origin + window.location.pathname + window.location.search,
      storageKey,
    };
  }

  async function launchHostedLogin() {
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
      await restoreWebSession();
      C.showMessage(el.message, "Sign-in complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Sign-in failed.", "error");
    }
  }

  async function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname + window.location.search;
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
    renderClaims();
    C.showMessage(el.message, "Session cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  function preloadReviewTokenFromQuery() {
    const params = new URLSearchParams(window.location.search || "");
    const value = params.get("token");
    if (!value) {
      return;
    }
    el.reviewToken.value = value;
  }

  async function bootstrap() {
    if (el.authDebug) {
      el.authDebug.hidden = !debugAuth;
    }
    renderClaims();
    preloadReviewTokenFromQuery();
    await loadUiConfig();
    await restoreWebSession();
    await finishHostedLoginCallback();
    if (reviewTokenValue()) {
      await resolveToken();
    }
  }

  el.loadButton.addEventListener("click", function () {
    resolveToken().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
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
