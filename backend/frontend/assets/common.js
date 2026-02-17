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
    const url = new URL("https://" + domain + "/login");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("redirect_uri", config.redirectUri);
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
