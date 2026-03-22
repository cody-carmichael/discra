(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_admin_token";
  const apiBase = C.deriveApiBase("/ui/login");
  const query = new URLSearchParams(window.location.search || "");
  const debugAuth = query.get("debug_auth") === "1";

  const el = {
    loginButton: document.getElementById("login-gateway-button"),
    message: document.getElementById("login-gateway-message"),
    cognitoDomain: document.getElementById("login-cognito-domain"),
    cognitoClientId: document.getElementById("login-cognito-client-id"),
    debugPanel: document.getElementById("login-gateway-debug"),
  };

  let adminRedirectPath = "";

  function fallbackAdminPath() {
    const currentPath = window.location.pathname || "";
    if (currentPath.endsWith("/login")) {
      return currentPath.slice(0, -"/login".length) + "/admin";
    }
    return "/ui/admin";
  }

  function resolveAdminPath() {
    return (adminRedirectPath || "").trim() || fallbackAdminPath();
  }

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

  function updateUiAvailability() {
    el.loginButton.disabled = !hostedUiConfigured();
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
      if (config && config.admin_redirect_path) {
        adminRedirectPath = config.admin_redirect_path;
      }
      if (!hostedUiConfigured()) {
        C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      }
    } catch (error) {
      C.showMessage(el.message, error.message, "error");
    }
    updateUiAvailability();
  }

  async function launchHostedLogin() {
    if (!hostedUiConfigured()) {
      C.showMessage(el.message, "Secure sign-in is not configured yet. Please contact support.", "error");
      return;
    }
    const loginUrl = await C.startHostedLogin(hostedFlowConfig());
    if (!loginUrl) {
      C.showMessage(el.message, "Secure sign-in is unavailable right now.", "error");
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
      C.showMessage(el.message, "Sign-in complete. Redirecting to your workspace...", "success");
      window.location.assign(resolveAdminPath());
      return;
    }
    if (result.status === "error") {
      C.showMessage(el.message, result.message || "Sign-in failed.", "error");
    }
  }

  async function bootstrap() {
    if (el.debugPanel) {
      el.debugPanel.hidden = !debugAuth;
    }
    updateUiAvailability();
    await loadUiConfig();
    try {
      const session = await C.getAuthSession(apiBase);
      if (session && session.active) {
        window.location.assign(resolveAdminPath());
        return;
      }
    } catch (error) {
      // Keep login flow available even when session lookup fails.
    }
    await finishHostedLoginCallback();
  }

  el.loginButton.addEventListener("click", function () {
    launchHostedLogin().catch(function (error) {
      C.showMessage(el.message, error.message, "error");
    });
  });

  bootstrap();
})();
