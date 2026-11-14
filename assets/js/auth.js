/* ==========================================================================
   Hanging Clozet — authentication screen
   ========================================================================== */

(function () {
  'use strict';

  var $ = UI.$;
  var DEST = 'wardrobe.html';

  // Already signed in? Go straight to the closet.
  if (Store.getSession()) {
    window.location.replace(DEST);
    return;
  }

  var heading = $('#authHeading');
  var sub = $('#authSub');
  var tabLogin = $('#tabLogin');
  var tabSignup = $('#tabSignup');
  var loginForm = $('#loginForm');
  var signupForm = $('#signupForm');
  var loginError = $('#loginError');
  var signupError = $('#signupError');

  var COPY = {
    login: {
      heading: 'Welcome back',
      sub: 'Sign in once — your wardrobe will be waiting next time.'
    },
    signup: {
      heading: 'Start your closet',
      sub: 'One account, kept in this browser. Add your first pieces right after.'
    }
  };

  function showPanel(panel) {
    var isLogin = panel === 'login';
    loginForm.hidden = !isLogin;
    signupForm.hidden = isLogin;
    tabLogin.classList.toggle('is-active', isLogin);
    tabSignup.classList.toggle('is-active', !isLogin);
    tabLogin.setAttribute('aria-selected', String(isLogin));
    tabSignup.setAttribute('aria-selected', String(!isLogin));
    heading.textContent = COPY[panel].heading;
    sub.textContent = COPY[panel].sub;
    hideErrors();
    (isLogin ? $('#loginUser') : $('#signupName')).focus();
  }

  tabLogin.addEventListener('click', function () { showPanel('login'); });
  tabSignup.addEventListener('click', function () { showPanel('signup'); });

  /* password visibility toggles */
  UI.$$('.pw-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.dataset.target);
      if (!input) return;
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      btn.textContent = reveal ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });
  });

  function hideErrors() {
    loginError.hidden = true;
    signupError.hidden = true;
  }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function busy(button, isBusy, label) {
    button.disabled = isBusy;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'Working…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }

  function messageFor(err) {
    var code = err && err.message ? err.message : '';
    switch (code) {
      case 'invalid-credentials':
        return "That username and password don't match. Try again.";
      case 'account-disabled':
        return 'That account has been disabled by an administrator.';
      case 'username-taken':
        return 'That username is already taken in this browser.';
      case 'reserved-username':
        return 'That username is reserved for the administrator.';
      case 'invalid-username':
        return 'Usernames need 3–24 characters: letters, numbers, dots, dashes or underscores.';
      case 'weak-password':
        return 'Passwords need at least 8 characters.';
      case 'crypto-unavailable':
        return 'This browser blocked secure password hashing. Open the site through run.bat (http://localhost:8000) instead of the file directly.';
      case 'storage-unavailable':
        return 'Local storage is unavailable. Turn off private mode or allow site data.';
      case 'storage-full':
        return 'Local storage is full. Remove some pieces and try again.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    hideErrors();

    var username = $('#loginUser').value.trim();
    var password = $('#loginPass').value;

    if (!username || !password) {
      showError(loginError, 'Please enter both your username and password.');
      (!username ? $('#loginUser') : $('#loginPass')).focus();
      return;
    }

    var button = $('#loginSubmit');
    busy(button, true, 'Opening…');

    Store.login(username, password)
      .then(function (account) {
        window.location.replace(account.role === 'admin' ? 'admin.html' : DEST);
      })
      .catch(function (err) {
        busy(button, false);
        showError(loginError, messageFor(err));
        $('#loginPass').select();
      });
  });

  signupForm.addEventListener('submit', function (event) {
    event.preventDefault();
    hideErrors();

    var name = $('#signupName').value.trim();
    var username = $('#signupUser').value.trim();
    var password = $('#signupPass').value;
    var confirm = $('#signupConfirm').value;

    if (!/^[a-z0-9._-]{3,24}$/i.test(username)) {
      showError(signupError, 'Usernames need 3–24 characters: letters, numbers, dots, dashes or underscores.');
      $('#signupUser').focus();
      return;
    }
    if (password.length < 8) {
      showError(signupError, 'Passwords need at least 8 characters.');
      $('#signupPass').focus();
      return;
    }
    if (password !== confirm) {
      showError(signupError, "Those passwords don't match.");
      $('#signupConfirm').focus();
      return;
    }

    var button = $('#signupSubmit');
    busy(button, true, 'Creating…');

    Store.signup(name, username, password)
      .then(function () {
        window.location.replace(DEST);
      })
      .catch(function (err) {
        busy(button, false);
        showError(signupError, messageFor(err));
      });
  });

  // Enter moves from username straight to password even before autofill settles.
  $('#loginUser').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#loginPass').focus();
    }
  });
})();
