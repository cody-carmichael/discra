(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_register_token";
  const apiBase = C.deriveApiBase("/ui/register");

  const el = {
    authState: document.getElementById("register-auth-state"),
    token: document.getElementById("register-jwt-token"),
    saveToken: document.getElementById("register-save-token"),
    clearToken: document.getElementById("register-clear-token"),
    claims: document.getElementById("register-claims-view"),
    message: document.getElementById("register-message"),
    form: document.getElementById("register-form"),
    tenantName: document.getElementById("register-tenant-name"),
    contactName: document.getElementById("register-contact-name"),
    notes: document.getElementById("register-notes"),
    emailView: document.getElementById("register-email-view"),
    statusSurface: document.getElementById("register-status-surface"),
    refreshStatus: document.getElementById("register-refresh-status"),
    cognitoDomain: document.getElementById("register-cognito-domain"),
    cognitoClientId: document.getElementById("register-cognito-client-id"),
    loginHostedUi: document.getElementById("register-login-hosted-ui"),
    logoutHostedUi: document.getElementById("register-logout-hosted-ui"),
  };

  let token = C.pullTokenFromHash(storageKey) || C.getStoredToken(storageKey);
  let currentRegistration = null;

  function activeClaims() {
    return C.decodeJwt(token);
  }

  function statusLabel(status) {
    if (!status) {
      return "";
    }
    if (status === "Approved") {
      return '<span class="table-status status-delivered">Approved</span>';
    }
    if (status === "Rejected") {
      return '<span class="table-status status-failed">Rejected</span>';
    }
    return '<span class="table-status">Pending</span>';
  }

  function renderRegistration(registration) {
    currentRegistration = registration || null;
    if (!registration) {
      el.statusSurface.innerHTML = "No registration found for this user yet.";
      return;
    }
    const decidedAt = registration.decided_at ? C.formatTimestamp(registration.decided_at) : "-";
    const submittedAt = registration.submitted_at ? C.formatTimestamp(registration.submitted_at) : "-";
    const nextStep =
      registration.status === "Approved"
        ? "Re-login via Hosted UI to receive fresh org claims, then continue to Admin view."
        : registration.status === "Rejected"
          ? "Update details and resubmit your registration."
          : "Your request is pending App Dev approval. You can refresh status anytime.";

    el.statusSurface.innerHTML =
      "<div class=\"kv-grid\">" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Tenant</span><span class=\"kv-value\">" +
      C.escapeHtml(registration.tenant_name || "-") +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Status</span><span class=\"kv-value\">" +
      statusLabel(registration.status) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Submitted</span><span class=\"kv-value\">" +
      C.escapeHtml(submittedAt) +
      "</span></div>" +
      "<div class=\"kv-item\"><span class=\"kv-label\">Last Decision</span><span class=\"kv-value\">" +
      C.escapeHtml(decidedAt) +
      "</span></div>" +
      "</div>" +
      "<p class=\"panel-help\" style=\"margin-top:0.75rem\">" +
      C.escapeHtml(nextStep) +
      "</p>";

    if (!el.tenantName.value.trim()) {
      el.tenantName.value = registration.tenant_name || "";
    }
    if (!el.contactName.value.trim()) {
      el.contactName.value = registration.contact_name || "";
    }
    if (!el.notes.value.trim()) {
      el.notes.value = registration.notes || "";
    }
  }

  function renderClaims() {
    const claims = activeClaims();
    if (!claims) {
      el.authState.textContent = "No Token";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.claims.textContent = "No token decoded yet.";
      el.emailView.value = "";
      return;
    }
    const roles = C.tokenRoleSummary(claims);
    el.authState.textContent = roles ? "Roles: " + roles : "Token Loaded";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.claims.textContent = JSON.stringify(claims, null, 2);
    el.emailView.value = claims.email ? String(claims.email) : "";
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

  async function refreshStatus() {
    if (!token) {
      C.showMessage(el.message, "Login first to check registration status.", "error");
      renderRegistration(null);
      return;
    }
    try {
      const payload = await C.requestJson(apiBase, "/onboarding/registrations/me", { token: token });
      renderRegistration(payload && payload.exists ? payload.registration : null);
      if (payload && payload.exists && payload.registration) {
        C.showMessage(el.message, "Registration status loaded.", "success");
      } else {
        C.showMessage(el.message, "No registration found yet. Submit the form to start review.", "success");
      }
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function submitRegistration(event) {
    event.preventDefault();
    if (!token) {
      C.showMessage(el.message, "Hosted UI login is required before submitting registration.", "error");
      return;
    }
    const tenantName = el.tenantName.value.trim();
    if (!tenantName) {
      C.showMessage(el.message, "Tenant name is required.", "error");
      return;
    }
    const payload = {
      tenant_name: tenantName,
      contact_name: el.contactName.value.trim() || null,
      notes: el.notes.value.trim() || null,
    };
    try {
      const result = await C.requestJson(apiBase, "/onboarding/registrations", {
        method: "POST",
        token: token,
        json: payload,
      });
      renderRegistration(result && result.registration ? result.registration : null);
      C.showMessage(el.message, "Registration submitted for App Dev review.", "success");
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
      await refreshStatus();
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Hosted UI login failed.", "error");
    }
  }

  async function launchHostedLogout() {
    const logoutUri = window.location.origin + window.location.pathname;
    const logoutUrl = C.buildHostedLogoutUrl({
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      logoutUri,
    });
    setToken("");
    renderRegistration(null);
    C.showMessage(el.message, "Session cleared.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  async function bootstrap() {
    el.token.value = token;
    renderClaims();
    await loadUiConfig();
    await finishHostedLoginCallback();
    if (token) {
      await refreshStatus();
    }
    if (currentRegistration && currentRegistration.status === "Approved") {
      C.showMessage(el.message, "Registration is approved. Re-login to continue with fresh claims.", "success");
    }
  }

  el.saveToken.addEventListener("click", function () {
    setToken(el.token.value);
    C.showMessage(el.message, token ? "Token saved." : "Token cleared.", "success");
    if (token) {
      refreshStatus().catch(function () {
        renderRegistration(null);
      });
    }
  });
  el.clearToken.addEventListener("click", function () {
    setToken("");
    renderRegistration(null);
    C.showMessage(el.message, "Session cleared.", "success");
  });
  el.refreshStatus.addEventListener("click", function () {
    refreshStatus().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.form.addEventListener("submit", submitRegistration);
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
