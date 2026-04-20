(function () {
  var C = window.DiscraCommon;
  var apiBase = C.deriveApiBase("/ui/login");

  var panels = {
    form: document.getElementById("login-form-panel"),
    newPassword: document.getElementById("login-new-password-panel"),
    forgot: document.getElementById("login-forgot-panel"),
    reset: document.getElementById("login-reset-panel"),
  };

  var el = {
    email: document.getElementById("login-email"),
    password: document.getElementById("login-password"),
    submit: document.getElementById("login-submit"),
    message: document.getElementById("login-message"),
    forgotLink: document.getElementById("login-forgot-link"),
    newPasswordInput: document.getElementById("login-new-password"),
    newPasswordSubmit: document.getElementById("login-new-password-submit"),
    newPasswordMessage: document.getElementById("login-new-password-message"),
    forgotEmail: document.getElementById("login-forgot-email"),
    forgotSubmit: document.getElementById("login-forgot-submit"),
    forgotBack: document.getElementById("login-forgot-back"),
    forgotMessage: document.getElementById("login-forgot-message"),
    resetCode: document.getElementById("login-reset-code"),
    resetPassword: document.getElementById("login-reset-password"),
    resetSubmit: document.getElementById("login-reset-submit"),
    resetBack: document.getElementById("login-reset-back"),
    resetMessage: document.getElementById("login-reset-message"),
  };

  var _pendingChallengeUser = null;
  var _forgotEmail = "";
  var _adminPath = "";

  function showPanel(name) {
    Object.keys(panels).forEach(function (k) {
      panels[k].hidden = k !== name;
    });
  }

  function resolveAdminPath() {
    if (_adminPath.trim()) return _adminPath.trim();
    var p = window.location.pathname;
    return p.endsWith("/login") ? p.slice(0, -"/login".length) + "/admin" : "/ui/admin";
  }

  async function setSessionCookie(idToken) {
    await C.requestJson(apiBase, "/ui/auth/token", {
      method: "POST",
      json: { id_token: idToken },
    });
  }

  function friendlyError(err) {
    var code = (err && (err.code || err.name)) || "";
    var map = {
      NotAuthorizedException: "Incorrect email or password.",
      UserNotFoundException: "No account found with that email.",
      UserNotConfirmedException: "Please confirm your email before signing in.",
      PasswordResetRequiredException: "A password reset is required. Use Forgot Password.",
      LimitExceededException: "Too many attempts. Please wait a moment and try again.",
      InvalidPasswordException: (err && err.message) || "Password does not meet requirements.",
      CodeMismatchException: "Incorrect code. Please try again.",
      ExpiredCodeException: "Code has expired. Request a new one.",
    };
    return map[code] || (err && err.message) || "An unexpected error occurred.";
  }

  async function handleSignIn() {
    var email = el.email.value.trim();
    var password = el.password.value;
    if (!email || !password) {
      C.showMessage(el.message, "Email and password are required.", "error");
      return;
    }
    el.submit.disabled = true;
    C.showMessage(el.message, "", "");
    try {
      var result = await DiscraAuth.signIn(email, password);
      if (result.challenge === "NEW_PASSWORD_REQUIRED") {
        _pendingChallengeUser = result.user;
        showPanel("newPassword");
        return;
      }
      await setSessionCookie(result.idToken);
      window.location.assign(resolveAdminPath());
    } catch (err) {
      C.showMessage(el.message, friendlyError(err), "error");
      el.submit.disabled = false;
    }
  }

  async function handleNewPassword() {
    var newPw = el.newPasswordInput.value;
    if (!newPw) {
      C.showMessage(el.newPasswordMessage, "Password is required.", "error");
      return;
    }
    el.newPasswordSubmit.disabled = true;
    try {
      var result = await DiscraAuth.completeNewPassword(_pendingChallengeUser, newPw);
      await setSessionCookie(result.idToken);
      window.location.assign(resolveAdminPath());
    } catch (err) {
      C.showMessage(el.newPasswordMessage, friendlyError(err), "error");
      el.newPasswordSubmit.disabled = false;
    }
  }

  async function handleForgotRequest() {
    var email = el.forgotEmail.value.trim();
    if (!email) {
      C.showMessage(el.forgotMessage, "Email is required.", "error");
      return;
    }
    el.forgotSubmit.disabled = true;
    try {
      _forgotEmail = email;
      await DiscraAuth.forgotPassword(email);
      showPanel("reset");
    } catch (err) {
      C.showMessage(el.forgotMessage, friendlyError(err), "error");
      el.forgotSubmit.disabled = false;
    }
  }

  async function handleResetPassword() {
    var code = el.resetCode.value.trim();
    var newPw = el.resetPassword.value;
    if (!code || !newPw) {
      C.showMessage(el.resetMessage, "Code and new password are required.", "error");
      return;
    }
    el.resetSubmit.disabled = true;
    try {
      await DiscraAuth.confirmForgotPassword(_forgotEmail, code, newPw);
      C.showMessage(el.resetMessage, "Password reset. You can now sign in.", "success");
      el.email.value = _forgotEmail;
      showPanel("form");
    } catch (err) {
      C.showMessage(el.resetMessage, friendlyError(err), "error");
      el.resetSubmit.disabled = false;
    }
  }

  async function bootstrap() {
    el.submit.disabled = true;
    try {
      var config = await C.requestJson(apiBase, "/ui/config");
      if (config.admin_redirect_path) _adminPath = config.admin_redirect_path;
      if (config.cognito_user_pool_id && config.cognito_client_id) {
        DiscraAuth.init(config.cognito_user_pool_id, config.cognito_client_id);
        el.submit.disabled = false;
      } else {
        C.showMessage(el.message, "Sign-in is not configured. Contact support.", "error");
      }
    } catch (err) {
      C.showMessage(el.message, err.message, "error");
    }
    try {
      var session = await C.getAuthSession(apiBase);
      if (session && session.active) {
        window.location.assign(resolveAdminPath());
        return;
      }
    } catch (_) {}
  }

  el.submit.addEventListener("click", handleSignIn);
  el.password.addEventListener("keydown", function (e) { if (e.key === "Enter") handleSignIn(); });
  el.newPasswordSubmit.addEventListener("click", handleNewPassword);
  el.forgotLink.addEventListener("click", function () { showPanel("forgot"); });
  el.forgotBack.addEventListener("click", function () { showPanel("form"); });
  el.forgotSubmit.addEventListener("click", handleForgotRequest);
  el.resetSubmit.addEventListener("click", handleResetPassword);
  el.resetBack.addEventListener("click", function () { showPanel("form"); });

  bootstrap();
})();
