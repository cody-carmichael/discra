(function (global) {
  var _pool = null;

  function init(userPoolId, clientId) {
    _pool = new global.AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: clientId,
    });
  }

  function _makeUser(email) {
    return new global.AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: _pool });
  }

  function signIn(email, password) {
    return new Promise(function (resolve, reject) {
      if (!_pool) { reject(new Error("DiscraAuth not initialized")); return; }
      var details = new global.AmazonCognitoIdentity.AuthenticationDetails({
        Username: email,
        Password: password,
      });
      var user = _makeUser(email);
      user.authenticateUser(details, {
        onSuccess: function (session) {
          resolve({ idToken: session.getIdToken().getJwtToken(), user: user });
        },
        onFailure: function (err) {
          reject(err);
        },
        newPasswordRequired: function (userAttributes) {
          resolve({ challenge: "NEW_PASSWORD_REQUIRED", user: user, userAttributes: userAttributes });
        },
      });
    });
  }

  function completeNewPassword(user, newPassword) {
    return new Promise(function (resolve, reject) {
      user.completeNewPasswordChallenge(newPassword, {}, {
        onSuccess: function (session) {
          resolve({ idToken: session.getIdToken().getJwtToken() });
        },
        onFailure: function (err) {
          reject(err);
        },
      });
    });
  }

  function forgotPassword(email) {
    return new Promise(function (resolve, reject) {
      if (!_pool) { reject(new Error("DiscraAuth not initialized")); return; }
      _makeUser(email).forgotPassword({
        onSuccess: function () { resolve({}); },
        onFailure: function (err) { reject(err); },
        inputVerificationCode: function (data) { resolve({ codeDestination: data.CodeDeliveryDetails }); },
      });
    });
  }

  function confirmForgotPassword(email, code, newPassword) {
    return new Promise(function (resolve, reject) {
      if (!_pool) { reject(new Error("DiscraAuth not initialized")); return; }
      _makeUser(email).confirmPassword(code, newPassword, {
        onSuccess: function () { resolve(); },
        onFailure: function (err) { reject(err); },
      });
    });
  }

  global.DiscraAuth = {
    init: init,
    signIn: signIn,
    completeNewPassword: completeNewPassword,
    forgotPassword: forgotPassword,
    confirmForgotPassword: confirmForgotPassword,
  };
})(window);
