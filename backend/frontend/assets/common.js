(function () {
  const STATUS_VALUES = ["Created", "Assigned", "PickedUp", "EnRoute", "Delivered", "Failed"];

  function deriveApiBase(pageSuffix) {
    const path = window.location.pathname;
    const index = path.lastIndexOf(pageSuffix);
    if (index >= 0) {
      return path.slice(0, index);
    }
    return "";
  }

  function decodeJwt(token) {
    if (!token || token.split(".").length < 2) {
      return null;
    }
    try {
      const payload = token.split(".")[1];
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (error) {
      return null;
    }
  }

  function parseHashFragment() {
    const value = window.location.hash || "";
    if (!value.startsWith("#")) {
      return new URLSearchParams();
    }
    return new URLSearchParams(value.slice(1));
  }

  function parseQueryParams() {
    const value = window.location.search || "";
    if (!value.startsWith("?")) {
      return new URLSearchParams();
    }
    return new URLSearchParams(value.slice(1));
  }

  function pullTokenFromHash(storageKey) {
    const params = parseHashFragment();
    const idToken = params.get("id_token") || params.get("access_token");
    if (!idToken) {
      return null;
    }
    localStorage.setItem(storageKey, idToken);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return idToken;
  }

  function _authStateStorageKey(storageKey) {
    return storageKey + "_oauth_state";
  }

  function _authVerifierStorageKey(storageKey) {
    return storageKey + "_oauth_verifier";
  }

  function _authDomainStorageKey(storageKey) {
    return storageKey + "_oauth_domain";
  }

  function _authClientStorageKey(storageKey) {
    return storageKey + "_oauth_client";
  }

  function _authRandomString(length) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    let output = "";
    for (let index = 0; index < bytes.length; index += 1) {
      output += alphabet[bytes[index] % alphabet.length];
    }
    return output;
  }

  function _base64Url(bytes) {
    let raw = "";
    for (let index = 0; index < bytes.length; index += 1) {
      raw += String.fromCharCode(bytes[index]);
    }
    return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function _pkceChallengeFromVerifier(verifier) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("PKCE requires browser crypto support.");
    }
    const encoder = new TextEncoder();
    const digest = await window.crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    return _base64Url(new Uint8Array(digest));
  }

  function _clearAuthFlowState(storageKey) {
    localStorage.removeItem(_authStateStorageKey(storageKey));
    localStorage.removeItem(_authVerifierStorageKey(storageKey));
  }

  function _clearOAuthQueryParams() {
    const params = parseQueryParams();
    if (!params.has("code") && !params.has("state") && !params.has("error") && !params.has("error_description")) {
      return;
    }
    params.delete("code");
    params.delete("state");
    params.delete("error");
    params.delete("error_description");
    const nextQuery = params.toString();
    const nextUrl = window.location.pathname + (nextQuery ? "?" + nextQuery : "");
    history.replaceState(null, "", nextUrl);
  }

  function getStoredToken(storageKey) {
    return (localStorage.getItem(storageKey) || "").trim();
  }

  function setStoredToken(storageKey, token) {
    const value = (token || "").trim();
    if (value) {
      localStorage.setItem(storageKey, value);
      return value;
    }
    localStorage.removeItem(storageKey);
    return "";
  }

  function endpointUrl(apiBase, path) {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    const suffix = path.startsWith("/") ? path : "/" + path;
    return apiBase + suffix;
  }

  async function requestJson(apiBase, path, options) {
    const requestOptions = options || {};
    const headers = new Headers(requestOptions.headers || {});
    if (requestOptions.token) {
      headers.set("Authorization", "Bearer " + requestOptions.token);
    }
    if (requestOptions.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(endpointUrl(apiBase, path), {
      method: requestOptions.method || "GET",
      headers,
      body: requestOptions.json === undefined ? requestOptions.body : JSON.stringify(requestOptions.json),
    });
    const responseText = await response.text();
    let payload = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        payload = responseText;
      }
    }
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && payload.detail
          ? payload.detail
          : "Request failed (" + response.status + ")";
      throw new Error(detail);
    }
    return payload;
  }

  function toNumberOrNull(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function toIntOrNull(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatTimestamp(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  function escapeHtml(value) {
    const text = String(value || "");
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showMessage(element, text, variant) {
    if (!element) {
      return;
    }
    element.textContent = text || "";
    element.classList.remove("error");
    element.classList.remove("success");
    if (variant === "error" || variant === "success") {
      element.classList.add(variant);
    }
  }

  function buildHostedLoginUrl(config) {
    if (!config || !config.domain || !config.clientId || !config.redirectUri) {
      return "";
    }
    const domain = config.domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const url = new URL("https://" + domain + "/oauth2/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("redirect_uri", config.redirectUri);
    return url.toString();
  }

  async function startHostedLogin(config) {
    if (!config || !config.storageKey) {
      throw new Error("Hosted login requires a storage key.");
    }
    const baseUrl = buildHostedLoginUrl(config);
    if (!baseUrl) {
      return "";
    }
    const state = _authRandomString(32);
    const verifier = _authRandomString(64);
    const challenge = await _pkceChallengeFromVerifier(verifier);
    localStorage.setItem(_authStateStorageKey(config.storageKey), state);
    localStorage.setItem(_authVerifierStorageKey(config.storageKey), verifier);
    localStorage.setItem(_authDomainStorageKey(config.storageKey), config.domain.trim());
    localStorage.setItem(_authClientStorageKey(config.storageKey), config.clientId.trim());
    const url = new URL(baseUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async function consumeHostedLoginCallback(config) {
    if (!config || !config.storageKey || !config.redirectUri) {
      return { status: "none" };
    }
    const query = parseQueryParams();
    const oauthError = query.get("error");
    if (oauthError) {
      const description = query.get("error_description") || oauthError;
      _clearOAuthQueryParams();
      return { status: "error", message: description };
    }
    const code = query.get("code");
    if (!code) {
      return { status: "none" };
    }

    const domainValue = (config.domain || localStorage.getItem(_authDomainStorageKey(config.storageKey)) || "").trim();
    const clientIdValue = (config.clientId || localStorage.getItem(_authClientStorageKey(config.storageKey)) || "").trim();
    if (!domainValue || !clientIdValue) {
      _clearAuthFlowState(config.storageKey);
      _clearOAuthQueryParams();
      return { status: "error", message: "Hosted login domain/client config is missing." };
    }

    const expectedState = localStorage.getItem(_authStateStorageKey(config.storageKey)) || "";
    const actualState = query.get("state") || "";
    if (!expectedState || !actualState || expectedState !== actualState) {
      _clearAuthFlowState(config.storageKey);
      _clearOAuthQueryParams();
      return { status: "error", message: "Hosted login state check failed." };
    }
    const verifier = localStorage.getItem(_authVerifierStorageKey(config.storageKey)) || "";
    if (!verifier) {
      _clearAuthFlowState(config.storageKey);
      _clearOAuthQueryParams();
      return { status: "error", message: "Hosted login verifier is missing." };
    }

    const domain = domainValue.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const tokenUrl = "https://" + domain + "/oauth2/token";
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("client_id", clientIdValue);
    form.set("code", code);
    form.set("redirect_uri", config.redirectUri);
    form.set("code_verifier", verifier);

    let response;
    try {
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
    } catch (error) {
      _clearAuthFlowState(config.storageKey);
      _clearOAuthQueryParams();
      return { status: "error", message: "Hosted login token exchange failed." };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    _clearAuthFlowState(config.storageKey);
    _clearOAuthQueryParams();

    if (!response.ok) {
      const message = payload && payload.error_description ? payload.error_description : "Hosted login token exchange failed.";
      return { status: "error", message: message };
    }

    const token = (payload && (payload.id_token || payload.access_token)) || "";
    if (!token) {
      return { status: "error", message: "Hosted login response did not include a token." };
    }
    setStoredToken(config.storageKey, token);
    return {
      status: "success",
      token: token,
      claims: decodeJwt(token),
    };
  }

  function buildHostedLogoutUrl(config) {
    if (!config || !config.domain || !config.clientId || !config.logoutUri) {
      return "";
    }
    const domain = config.domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const url = new URL("https://" + domain + "/logout");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("logout_uri", config.logoutUri);
    return url.toString();
  }

  function tokenRoleSummary(claims) {
    if (!claims) {
      return "";
    }
    const groups = claims["cognito:groups"] || claims.groups || [];
    if (Array.isArray(groups)) {
      return groups.join(", ");
    }
    return String(groups || "");
  }

  window.DiscraCommon = {
    STATUS_VALUES,
    deriveApiBase,
    decodeJwt,
    pullTokenFromHash,
    getStoredToken,
    setStoredToken,
    startHostedLogin,
    consumeHostedLoginCallback,
    buildHostedLogoutUrl,
    requestJson,
    toNumberOrNull,
    toIntOrNull,
    formatTimestamp,
    escapeHtml,
    showMessage,
    buildHostedLoginUrl,
    tokenRoleSummary,
  };
})();
