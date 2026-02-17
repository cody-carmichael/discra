(function () {
  const C = window.DiscraCommon;
  const storageKey = "discra_driver_token";
  const apiBase = C.deriveApiBase("/ui/driver");

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
  };

  let token = C.pullTokenFromHash(storageKey) || C.getStoredToken(storageKey);
  let locationTimer = null;

  function setToken(nextToken) {
    token = C.setStoredToken(storageKey, nextToken);
    el.token.value = token;
    renderClaims();
  }

  function renderClaims() {
    const claims = C.decodeJwt(token);
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
      C.showMessage(el.authMessage, error.message, "error");
    }
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
    ctx.strokeStyle = "#e6f4fb";

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

  function orderCardMarkup(order) {
    return (
      "<article class=\"order-card\" data-order-id=\"" +
      C.escapeHtml(order.id) +
      "\">" +
      "<h3>" +
      C.escapeHtml(order.customer_name) +
      "</h3>" +
      "<p class=\"order-meta\">" +
      C.escapeHtml(order.address) +
      "<br>Order: " +
      C.escapeHtml(order.id) +
      "<br>Status: <span class=\"chip\">" +
      C.escapeHtml(order.status) +
      "</span></p>" +
      "<div class=\"status-row\">" +
      "<button class=\"btn btn-ghost\" data-action=\"status\" data-status=\"PickedUp\">Picked Up</button>" +
      "<button class=\"btn btn-ghost\" data-action=\"status\" data-status=\"EnRoute\">En Route</button>" +
      "<button class=\"btn btn-ghost\" data-action=\"status\" data-status=\"Failed\">Mark Failed</button>" +
      "</div>" +
      "<label class=\"field\"><span>Delivery Photo</span><input class=\"pod-photo\" type=\"file\" accept=\"image/*\"></label>" +
      "<div class=\"signature-wrap\"><canvas class=\"signature-pad\" width=\"320\" height=\"140\"></canvas></div>" +
      "<div class=\"row\"><button class=\"btn btn-ghost\" data-action=\"clear-signature\">Clear Signature</button></div>" +
      "<label class=\"field\"><span>Delivery Notes</span><textarea class=\"pod-notes\" rows=\"2\" placeholder=\"Left with front desk\"></textarea></label>" +
      "<div class=\"row\">" +
      "<button class=\"btn btn-accent\" data-action=\"submit-pod\">Submit POD + Mark Delivered</button>" +
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
    if (!token) {
      C.showMessage(el.ordersMessage, "Set a JWT token first.", "error");
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
    if (!token) {
      C.showMessage(el.locationStatus, "Set a JWT token first.", "error");
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
    const orderCard = target.closest(".order-card");
    if (!orderCard) {
      return;
    }
    const orderId = orderCard.getAttribute("data-order-id");
    if (!orderId) {
      return;
    }
    if (!token) {
      C.showMessage(el.ordersMessage, "Set a JWT token first.", "error");
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

  function launchHostedLogin() {
    const redirectUri = window.location.origin + window.location.pathname;
    const loginUrl = C.buildHostedLoginUrl({
      domain: el.cognitoDomain.value.trim(),
      clientId: el.cognitoClientId.value.trim(),
      redirectUri,
    });
    if (!loginUrl) {
      C.showMessage(el.authMessage, "Hosted UI domain + client id are required.", "error");
      return;
    }
    window.location.assign(loginUrl);
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
    el.token.value = token;
    renderClaims();
    registerServiceWorker();
    await loadUiConfig();
    await refreshInbox();
  }

  el.saveToken.addEventListener("click", function () {
    setToken(el.token.value);
    C.showMessage(el.authMessage, "Token saved.", "success");
  });
  el.clearToken.addEventListener("click", function () {
    setToken("");
    C.showMessage(el.authMessage, "Token cleared.", "success");
  });
  el.refreshInbox.addEventListener("click", refreshInbox);
  el.orders.addEventListener("click", onOrderActionClick);
  el.sendLocationNow.addEventListener("click", sendLocationUpdate);
  el.startLocationShare.addEventListener("click", startLocationShare);
  el.stopLocationShare.addEventListener("click", stopLocationShare);
  el.loginHostedUi.addEventListener("click", launchHostedLogin);

  bootstrap();
})();
