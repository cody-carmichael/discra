(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_review_token";
  const apiBase = C.deriveApiBase("/ui/review");

  const el = {
    authState: document.getElementById("review-auth-state"),
    token: document.getElementById("review-jwt-token"),
    saveToken: document.getElementById("review-save-token"),
    clearToken: document.getElementById("review-clear-token"),
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
  };

  let token = C.pullTokenFromHash(storageKey) || C.getStoredToken(storageKey);
  let loadedReview = null;

  function activeClaims() {
    return C.decodeJwt(token);
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
    const claims = activeClaims();
    if (!claims) {
      el.authState.textContent = "No Token";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No token decoded yet.";
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    el.authState.textContent = roles ? "Roles: " + roles : "Token Loaded";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.claims.textContent = JSON.stringify(claims, null, 2);
  }

  function setToken(nextToken) {
    token = C.setStoredToken(storageKey, nextToken);
    el.token.value = token;
    renderClaims();
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
    if (!token) {
      C.showMessage(el.message, "Approver JWT token is required.", "error");
      return;
    }
    try {
      const response = await C.requestJson(apiBase, "/onboarding/review/decision", {
        method: "POST",
        token: token,
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
      C.showMessage(el.message, "Hosted UI domain + client id are required.", "error");
      return;
    }
    window.location.assign(loginUrl);
  }

  async function finishHostedLoginCallback() {
    const result = await C.consumeHostedLoginCallback(hostedFlowConfig());
    if (result.status === "success") {
      setToken(result.token || "");
      C.showMessage(el.message, "Hosted UI login complete.", "success");
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Hosted UI login failed.", "error");
    }
  }

  async function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname + window.location.search;
    const logoutUrl = C.buildHostedLogoutUrl({
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      logoutUri,
    });
    setToken("");
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
    el.token.value = token;
    renderClaims();
    preloadReviewTokenFromQuery();
    await loadUiConfig();
    await finishHostedLoginCallback();
    if (reviewTokenValue()) {
      await resolveToken();
    }
  }

  el.saveToken.addEventListener("click", function () {
    setToken(el.token.value);
    C.showMessage(el.message, token ? "Token saved." : "Token cleared.", "success");
  });
  el.clearToken.addEventListener("click", function () {
    setToken("");
    C.showMessage(el.message, "Session cleared.", "success");
  });
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
