(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_register_auth";
  const apiBase = C.deriveApiBase("/ui/register");
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    authState: document.getElementById("register-auth-state"),
    message: document.getElementById("register-message"),
    form: document.getElementById("register-form"),
    tenantPanel: document.getElementById("register-tenant-panel"),
    gateSurface: document.getElementById("register-gate-surface"),
    tenantName: document.getElementById("register-tenant-name"),
    contactName: document.getElementById("register-contact-name"),
    notes: document.getElementById("register-notes"),
    emailView: document.getElementById("register-email-view"),
    statusSurface: document.getElementById("register-status-surface"),
    refreshStatus: document.getElementById("register-refresh-status"),
    accountHint: document.getElementById("register-account-hint"),
    cognitoDomain: document.getElementById("register-cognito-domain"),
    cognitoClientId: document.getElementById("register-cognito-client-id"),
    signupHostedUi: document.getElementById("register-signup-hosted-ui"),
    loginHostedUi: document.getElementById("register-login-hosted-ui"),
    logoutHostedUi: document.getElementById("register-logout-hosted-ui"),
    claims: document.getElementById("register-claims-view"),
    authDebug: document.getElementById("register-auth-debug"),
    confirmationPanel: document.getElementById("register-confirmation-panel"),
    confirmationDetails: document.getElementById("register-confirmation-details"),
    checkStatus: document.getElementById("register-check-status"),
  };

  let currentRegistration = null;
  let sessionClaims = null;

  function hostedFlowConfig() {
    return {
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      redirectUri: window.location.origin + window.location.pathname,
      storageKey,
    };
  }

  function hostedUiConfigured() {
    const config = hostedFlowConfig();
    return Boolean(config.domain && config.clientId);
  }

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

  function isSubmissionLocked(registration) {
    if (!registration || !registration.status) {
      return false;
    }
    const normalized = String(registration.status).trim().toLowerCase();
    return normalized === "pending" || normalized === "approved";
  }

  // ── Confirmation Panel ─────────────────────────────────────────
  function showConfirmation(registration) {
    if (!el.confirmationPanel || !registration) {
      return;
    }
    // Hide the form panel, show the confirmation panel
    if (el.tenantPanel) {
      el.tenantPanel.hidden = true;
    }
    el.confirmationPanel.hidden = false;

    var submittedAt = registration.submitted_at ? C.formatTimestamp(registration.submitted_at) : "-";
    var status = registration.status || "Pending";

    // Build confirmation details
    var detailsHtml =
      '<div class="kv-grid">' +
      '<div class="kv-item"><span class="kv-label">Tenant</span><span class="kv-value">' +
      C.escapeHtml(registration.tenant_name || "-") +
      '</span></div>' +
      '<div class="kv-item"><span class="kv-label">Status</span><span class="kv-value">' +
      statusLabel(status) +
      '</span></div>' +
      '<div class="kv-item"><span class="kv-label">Submitted</span><span class="kv-value">' +
      C.escapeHtml(submittedAt) +
      '</span></div>' +
      '</div>';

    if (el.confirmationDetails) {
      el.confirmationDetails.innerHTML = detailsHtml;
    }

    // Update the heading and message based on status
    var heading = el.confirmationPanel.querySelector("h2");
    var messageParagraph = el.confirmationPanel.querySelector("p");
    var icon = el.confirmationPanel.querySelector(".register-confirmation-icon");

    if (status === "Approved") {
      if (heading) heading.textContent = "Registration Approved";
      if (messageParagraph) messageParagraph.textContent = "Your tenant has been approved! Sign in to the Admin console to get started.";
      if (icon) { icon.textContent = "\u2713"; icon.style.background = "var(--text-success, #4A9E5C)"; }
    } else if (status === "Rejected") {
      if (heading) heading.textContent = "Registration Update Needed";
      if (messageParagraph) messageParagraph.textContent = "Your registration needs updates. Please revise your details and resubmit.";
      if (icon) { icon.textContent = "!"; icon.style.background = "var(--text-danger, #D94D4D)"; }
      // Show the form again for resubmission
      el.confirmationPanel.hidden = true;
      if (el.tenantPanel) {
        el.tenantPanel.hidden = false;
      }
    } else {
      if (heading) heading.textContent = "Request Received";
      if (messageParagraph) messageParagraph.textContent = "We've received your request to try Discra. Our team will review your registration and respond soon.";
      if (icon) { icon.textContent = "\u2713"; icon.style.background = "var(--gold-primary, #C8973A)"; }
    }
  }

  function syncSubmitButtonState() {
    const submitButton = el.form.querySelector('button[type="submit"]');
    if (!submitButton) {
      return;
    }
    const authenticated = !!sessionClaims;
    const locked = isSubmissionLocked(currentRegistration);
    submitButton.disabled = !authenticated || locked;
    submitButton.textContent = locked ? "Registration Submitted" : "Submit Registration";
    submitButton.setAttribute("aria-disabled", submitButton.disabled ? "true" : "false");
  }

  function applyUiAvailability() {
    const authReady = hostedUiConfigured();
    const authenticated = !!sessionClaims;

    el.signupHostedUi.hidden = authenticated;
    el.loginHostedUi.hidden = authenticated;
    el.logoutHostedUi.hidden = !authenticated;
    el.signupHostedUi.style.display = authenticated ? "none" : "";
    el.loginHostedUi.style.display = authenticated ? "none" : "";
    el.logoutHostedUi.style.display = authenticated ? "" : "none";
    el.signupHostedUi.disabled = !authReady || authenticated;
    el.loginHostedUi.disabled = !authReady || authenticated;
    el.logoutHostedUi.disabled = !authenticated;
    syncSubmitButtonState();
    el.refreshStatus.disabled = !authenticated;
    if (el.accountHint) {
      if (authenticated) {
        el.accountHint.innerHTML =
          "You are signed in. Complete your tenant details below and submit for App Dev approval.";
      } else {
        el.accountHint.innerHTML =
          'Just created your account? Click <strong>Sign In</strong> to continue. ' +
          'New here? Click <strong>Create Account</strong> to get started.';
      }
    }
    if (el.tenantPanel) {
      // Only show the form if authenticated AND not already showing confirmation
      var showForm = authenticated && (el.confirmationPanel ? el.confirmationPanel.hidden : true);
      el.tenantPanel.hidden = !showForm;
    }
    if (el.gateSurface) {
      el.gateSurface.hidden = authenticated;
      if (!authenticated && !authReady) {
        el.gateSurface.innerHTML =
          "<strong>Account sign-in is unavailable right now.</strong> Please contact support. " +
          "Cognito Hosted UI domain/client are not configured for this environment.";
      } else if (!authenticated) {
        el.gateSurface.innerHTML =
          "<strong>Almost there!</strong> Sign in with your new account to complete your tenant registration.";
      } else {
        el.gateSurface.textContent = "";
      }
    }
  }

  function renderRegistration(registration) {
    currentRegistration = registration || null;
    if (!registration) {
      el.statusSurface.innerHTML = "No registration found for this user yet.";
      // Hide confirmation if no registration
      if (el.confirmationPanel) {
        el.confirmationPanel.hidden = true;
      }
      syncSubmitButtonState();
      return;
    }

    // If registration is pending or approved, show the confirmation panel instead of the form
    if (isSubmissionLocked(registration)) {
      showConfirmation(registration);
    }

    const decidedAt = registration.decided_at ? C.formatTimestamp(registration.decided_at) : "-";
    const submittedAt = registration.submitted_at ? C.formatTimestamp(registration.submitted_at) : "-";
    const nextStep =
      registration.status === "Approved"
        ? "Access approved. Sign in again, then continue to the Admin workspace."
        : registration.status === "Rejected"
          ? "Update details and resubmit your registration."
          : "Your request is pending App Dev approval. Refresh status anytime.";

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
    syncSubmitButtonState();
  }

  function renderClaims() {
    const claims = sessionClaims;
    if (!claims) {
      el.authState.textContent = "Not Signed In";
      el.authState.classList.add("status-idle");
      el.authState.classList.remove("status-live");
      el.emailView.value = "";
      renderRegistration(null);
      if (el.claims) {
        el.claims.textContent = "No active web session.";
      }
      applyUiAvailability();
      return;
    }
    const email = claims.email ? String(claims.email) : "";
    el.authState.textContent = email ? "Signed In" : "Session Active";
    el.authState.classList.remove("status-idle");
    el.authState.classList.add("status-live");
    el.emailView.value = email;
    if (el.claims) {
      el.claims.textContent = JSON.stringify(claims, null, 2);
    }
    applyUiAvailability();
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
      const uiConfig = await C.requestJson(apiBase, "/ui/config");
      if (uiConfig && uiConfig.cognito_domain) {
        el.cognitoDomain.value = uiConfig.cognito_domain;
      }
      if (uiConfig && uiConfig.cognito_client_id) {
        el.cognitoClientId.value = uiConfig.cognito_client_id;
      }
      if (!hostedUiConfigured()) {
        C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      }
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
    applyUiAvailability();
  }

  async function refreshStatus() {
    if (!sessionClaims) {
      return;
    }
    try {
      const payload = await C.requestJson(apiBase, "/onboarding/registrations/me");
      renderRegistration(payload && payload.exists ? payload.registration : null);
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function submitRegistration(event) {
    event.preventDefault();
    if (!sessionClaims) {
      C.showMessage(el.message, "Sign in is required before submitting registration.", "error");
      return;
    }
    if (isSubmissionLocked(currentRegistration)) {
      C.showMessage(el.message, "Registration has already been submitted.", "error");
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
        json: payload,
      });
      var registration = result && result.registration ? result.registration : null;
      renderRegistration(registration);
      if (registration) {
        showConfirmation(registration);
      }
      C.showMessage(el.message, "", "success");
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
  }

  async function launchHostedLogin() {
    if (sessionClaims) {
      C.showMessage(el.message, "You are already signed in. Continue with tenant registration below.", "success");
      return;
    }
    if (!hostedUiConfigured()) {
      C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    const loginUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!loginUrl) {
      C.showMessage(el.message, "Secure sign-in is unavailable right now.", "error");
      return;
    }
    // Force Cognito to show login form even if user has an existing session
    try {
      const parsed = new URL(loginUrl);
      parsed.searchParams.set("prompt", "login");
      window.location.assign(parsed.toString());
    } catch (_) {
      window.location.assign(loginUrl);
    }
  }

  async function launchHostedSignup() {
    if (sessionClaims) {
      C.showMessage(el.message, "You are already signed in. Sign out first to create a different account.", "error");
      return;
    }
    if (!hostedUiConfigured()) {
      C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    const authorizeUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!authorizeUrl) {
      C.showMessage(el.message, "Secure sign-up is unavailable right now.", "error");
      return;
    }
    let signupUrl = "";
    try {
      const parsed = new URL(authorizeUrl);
      parsed.pathname = "/signup";
      signupUrl = parsed.toString();
    } catch (error) {
      signupUrl = "";
    }
    if (!signupUrl) {
      C.showMessage(el.message, "Secure sign-up is unavailable right now.", "error");
      return;
    }
    window.location.assign(signupUrl);
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
      C.showMessage(el.message, "Sign-in complete. Fill out your tenant details below to finish registration.", "success");
      await refreshStatus();
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Sign-in failed.", "error");
    }
  }

  async function launchHostedLogout() {
    // After logout, redirect to admin login screen instead of back to register page
    const adminPath = window.location.pathname.replace(/\/register$/, "/admin");
    const logoutUri = window.location.origin + adminPath;
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
    renderRegistration(null);
    if (el.confirmationPanel) {
      el.confirmationPanel.hidden = true;
    }
    C.showMessage(el.message, "Signed out.", "success");
    if (logoutUrl) {
      window.location.assign(logoutUrl);
    }
  }

  function redirectToAdmin() {
    var adminPath = window.location.pathname.replace(/\/register$/, "/admin");
    window.location.replace(window.location.origin + adminPath);
  }

  async function bootstrap() {
    if (el.authDebug) {
      el.authDebug.hidden = !debugAuth;
    }
    renderClaims();
    await loadUiConfig();
    await restoreWebSession();
    await finishHostedLoginCallback();

    // If not signed in after all auth checks, redirect to admin login screen.
    // The register page should only be accessible to authenticated users.
    if (!sessionClaims) {
      redirectToAdmin();
      return;
    }

    await refreshStatus();
    if (currentRegistration && currentRegistration.status === "Approved") {
      C.showMessage(el.message, "Registration is approved. Sign in again, then continue to Admin.", "success");
    }
  }

  el.refreshStatus.addEventListener("click", function () {
    refreshStatus().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });
  el.form.addEventListener("submit", submitRegistration);
  el.signupHostedUi.addEventListener("click", function () {
    launchHostedSignup().catch(function (error) {
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
  if (el.checkStatus) {
    el.checkStatus.addEventListener("click", function () {
      refreshStatus().catch(function (error) {
        C.showMessage(el.message, error.message, "error");
      });
    });
  }

  bootstrap();
})();
