/* ==========================================================================
   Hanging Clozet — administrator console
   Local-only gateway: the built-in admin account is seeded on first run and
   protected by the same PBKDF2 hashing as normal accounts.
   ========================================================================== */

(function () {
  'use strict';

  Store.init().then(function () {

  var $ = UI.$, $$ = UI.$$;

  var PANES = {
    users: 'paneUsers',
    activity: 'paneActivity',
    data: 'paneData',
    account: 'paneAccount'
  };

  var state = {
    admin: null,
    accounts: [],
    query: '',
    resetTarget: null,
    inspectAccount: null,
    detailsAccount: null,
    knownIds: null,
    newIds: {},
    newTimer: null
  };

  var gate = $('#adminGate');
  var panel = $('#adminPanel');

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  boot();

  function boot() {
    if (!Store.cryptoReady() && !Store.isRemote()) {
      showGate();
      showError($('#adminLoginError'),
        'Secure password hashing is unavailable. Open the app through run.bat (http://localhost:8000) instead of the file directly.');
      return;
    }

    Store.ensureAdmin()
      .then(function () {
        var session = Store.getSession();
        if (session && session.role === 'admin') showPanel(session);
        else showGate();
      })
      .catch(function () { showGate(); });
  }

  function showGate() {
    state.admin = null;
    panel.hidden = true;
    gate.hidden = false;

    setTimeout(function () { $('#adminUser').focus(); }, 40);
  }

  function showPanel(admin) {
    state.admin = admin;
    gate.hidden = true;
    panel.hidden = false;
    $('#logoutBtn').hidden = false;

    UI.mountNav(admin);
    $('#adminWho').textContent = '@' + admin.username + ' signed in';

    var origin = $('#usersOrigin');
    if (origin) {
      if (Store.isRemote()) {
        origin.textContent = 'Connected to the shared server. Accounts from every device appear here.';
      } else {
        origin.innerHTML = 'Showing accounts saved in this browser for <b>' +
          Util.esc(window.location.origin) +
          '</b>. Admin and wardrobe must use the same address.';
      }
    }

    refresh();
    switchTab('users');
    window.scrollTo(0, 0);
  }

  function refresh() {
    if (Store.isRemote()) {
      Promise.all([
        Store.fetchAccounts(),
        Store.fetchEvents().catch(function () { return []; })
      ]).then(function () {
        applyAccounts();
      }).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast('Could not reach the shared account server.', 'error');
      });
      return;
    }

    applyAccounts();
  }

  function adminSessionLost(err) {
    if (err && (err.message === 'unauthorized' || err.status === 401)) {
      Store.logout();
      showGate();
      UI.toast('Your admin session expired. Sign in again.', 'error');
      return true;
    }
    return false;
  }

  function applyAccounts() {
    try {
      state.accounts = Store.listAccounts();
    } catch (e) {
      state.accounts = [];
    }

    var self = state.accounts.filter(function (account) {
      return state.admin && account.id === state.admin.id;
    })[0];
    if (self) state.admin = self;

    trackNewAccounts();

    updateStats();
    renderUsers();
    renderActivity();
    renderStorage();
    renderMeta();
  }

  function trackNewAccounts() {
    var current = {};
    state.accounts.forEach(function (account) { current[account.id] = true; });

    if (state.knownIds === null) {
      state.knownIds = current;
      return;
    }

    var fresh = state.accounts.filter(function (account) {
      return !state.knownIds[account.id];
    });
    state.knownIds = current;

    if (!fresh.length) return;

    fresh.forEach(function (account) { state.newIds[account.id] = true; });

    var latest = fresh[fresh.length - 1];
    UI.toast(
      fresh.length === 1
        ? 'New registration: ' + latest.name + ' (@' + latest.username + ')'
        : fresh.length + ' new registrations — newest: ' + latest.name + ' (@' + latest.username + ')',
      'success'
    );

    clearTimeout(state.newTimer);
    state.newTimer = setTimeout(function () {
      state.newIds = {};
      if (state.admin && !panel.hidden) renderUsers();
    }, 15000);
  }

  /* ---------------------------------------------------------------- */
  /* overview                                                          */
  /* ---------------------------------------------------------------- */

  function updateStats() {
    var pieces = 0;
    var bytes = 0;
    var looks = 0;

    state.accounts.forEach(function (account) {
      pieces += account.stats.pieces;
      bytes += account.stats.bytes;
      looks += account.stats.looks;
    });

    $('#adminUsers').textContent = state.accounts.length;
    $('#adminPieces').textContent = pieces;
    $('#adminStorage').textContent = UI.bytesLabel(bytes);
    $('#adminLooks').textContent = looks;
  }

  function findAccount(id) {
    return state.accounts.filter(function (account) { return account.id === id; })[0] || null;
  }

  /* ---------------------------------------------------------------- */
  /* users table                                                       */
  /* ---------------------------------------------------------------- */

  function renderUsers() {
    var host = $('#usersHost');
    var query = state.query.trim().toLowerCase();

    var rows = state.accounts.filter(function (account) {
      if (!query) return true;
      return (account.name + ' ' + account.username + ' ' + account.role).toLowerCase().indexOf(query) > -1;
    });

    if (!rows.length) {
      host.innerHTML = '<p class="admin-empty">' +
        (state.accounts.length ? 'No accounts match that search.' : 'No other accounts yet. Create one from the sign-in page.') +
        '</p>';
      return;
    }

    var selfId = state.admin ? state.admin.id : '';

    host.innerHTML = '<table class="admin-table">' +
      '<thead><tr>' +
        '<th>Account</th><th>Role</th><th>Pieces</th><th>Storage</th><th>Joined</th><th>Status</th>' +
        '<th style="text-align:right">Actions</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (account) {
        var self = account.id === selfId;
        return '<tr data-id="' + account.id + '" title="Open full account details">' +
          '<td><div class="admin-user">' +
            '<span class="avatar">' + Util.esc(UI.initials(account.name)) + '</span>' +
            '<div><b>' + Util.esc(account.name) +
              (state.newIds[account.id] ? ' <em class="new-badge">New</em>' : '') +
              '</b><span>@' + Util.esc(account.username) + '</span></div>' +
          '</div></td>' +
          '<td><span class="role-badge ' + (account.role === 'admin' ? 'admin' : 'user') + '">' +
            (account.role === 'admin' ? 'Admin' : 'User') + '</span></td>' +
          '<td>' + account.stats.pieces + '</td>' +
          '<td>' + Util.esc(UI.bytesLabel(account.stats.bytes)) + '</td>' +
          '<td>' + Util.esc(Util.formatDate(account.createdAt)) + '</td>' +
          '<td><span class="status' + (account.disabled ? ' off' : '') + '"><i></i>' +
            (account.disabled ? 'Disabled' : 'Active') + '</span></td>' +
          '<td><div class="admin-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="details">Details</button>' +
            '<button type="button" class="btn btn-ghost" data-act="toggle"' +
              (self ? ' disabled title="You cannot disable your own session"' : '') + '>' +
              (account.disabled ? 'Enable' : 'Disable') + '</button>' +
            '<button type="button" class="btn btn-ghost" data-act="password">Reset</button>' +
            '<button type="button" class="btn btn-danger" data-act="delete"' +
              (self ? ' disabled title="You cannot delete your own account here"' : '') + '>Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  $('#usersHost').addEventListener('click', function (event) {
    var button = event.target.closest('[data-act]');
    var row = event.target.closest('tr[data-id]');
    var account = findAccount(row && row.dataset.id);
    if (!account) return;

    if (!button) {
      openDetails(account);
      return;
    }

    var action = button.dataset.act;
    if (action === 'details') openDetails(account);
    if (action === 'inspect') openInspect(account);
    if (action === 'toggle') toggleDisabled(account);
    if (action === 'password') openReset(account);
    if (action === 'delete') removeAccount(account);
  });

  function factHTML(label, value) {
    return '<div class="account-fact"><span>' + Util.esc(label) + '</span><b>' + Util.esc(value) + '</b></div>';
  }

  function openDetails(account) {
    var details = Store.getAccountDetails(account.id);
    if (!details) {
      UI.toast('That account could not be read.', 'error');
      return;
    }

    state.detailsAccount = account;
    $('#accountTitle').textContent = details.name;

    var events = Store.listEvents().filter(function (event) {
      return event.actor === details.username || event.message.indexOf('@' + details.username) > -1;
    }).slice(0, 12);

    var lastLogin = null;
    for (var i = 0; i < events.length; i++) {
      if (events[i].kind === 'auth.login') {
        lastLogin = events[i];
        break;
      }
    }
    if (!lastLogin) {
      for (var s = 0; s < events.length; s++) {
        if (events[s].kind === 'auth.signup') {
          lastLogin = events[s];
          break;
        }
      }
    }

    $('#accountFacts').innerHTML =
      factHTML('Display name', details.name) +
      factHTML('Username', '@' + details.username) +
      factHTML('Role', details.role === 'admin' ? 'Administrator' : 'User') +
      factHTML('Status', details.disabled ? 'Disabled' : 'Active') +
      factHTML('Joined', new Date(details.createdAt).toLocaleString()) +
      factHTML('Last sign-in', lastLogin ? new Date(lastLogin.ts).toLocaleString() : 'No sign-in recorded') +
      factHTML('Account ID', details.id);

    $('#accountPassword').innerHTML =
      factHTML('Algorithm', details.password.algorithm) +
      factHTML('Iterations', details.password.iterations.toLocaleString()) +
      factHTML('Hash fingerprint', details.password.hashPrefix) +
      factHTML('Credential source', details.defaultPassword ? 'Default password' : 'Custom / admin-set');

    $('#accountStats').innerHTML =
      factHTML('Pieces', String(details.stats.pieces)) +
      factHTML('Favourites', String(details.stats.favorites)) +
      factHTML('Possible looks', String(details.stats.looks)) +
      factHTML('Closet storage', UI.bytesLabel(details.stats.bytes));

    var host = $('#accountActivity');
    if (!events.length) {
      host.innerHTML = '<p class="account-empty">No activity recorded for this account yet.</p>';
    } else {
      host.innerHTML = events.map(function (event) {
        return '<div class="account-event">' +
          '<time>' + Util.esc(new Date(event.ts).toLocaleString()) + '</time>' +
          '<p><span class="log-kind">' + Util.esc(event.kind) + '</span> ' + Util.esc(event.message) + '</p>' +
        '</div>';
      }).join('');
    }

    UI.openDialog($('#accountDialog'));
  }

  function toggleDisabled(account) {
    var next = !account.disabled;

    function run() {
      Promise.resolve().then(function () {
        return Store.setAccountDisabled(account.id, next, state.admin.username);
      }).then(function () {
        UI.toast(next ? 'Account disabled.' : 'Account re-enabled.', next ? 'error' : 'success');
        refresh();
      }).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast(err && err.message === 'last-admin'
          ? 'At least one active administrator is required.'
          : 'Could not update that account.', 'error');
      });
    }

    if (!next) return run();

    UI.confirmAction({
      title: 'Disable @' + account.username + '?',
      message: 'The account stays in the list but cannot sign in until you re-enable it.',
      confirmLabel: 'Disable account'
    }).then(function (confirmed) { if (confirmed) run(); });
  }

  function removeAccount(account) {
    UI.confirmAction({
      title: 'Delete @' + account.username + '?',
      message: 'The account and every piece in its closet are removed permanently. This cannot be undone.',
      confirmLabel: 'Delete account'
    }).then(function (confirmed) {
      if (!confirmed) return;
      Promise.resolve().then(function () {
        return Store.deleteAccount(account.id, state.admin.username);
      }).then(function () {
        refresh();
        UI.toast('Account deleted.', 'success');
      }).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast(err && err.message === 'last-admin'
          ? 'At least one active administrator is required.'
          : 'Could not delete that account.', 'error');
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* reset password                                                    */
  /* ---------------------------------------------------------------- */

  function openReset(account) {
    state.resetTarget = account;
    var dlg = $('#resetDialog');

    $('#resetSub').textContent = 'Choose a new password for @' + account.username + '. Share it privately.';
    $('#resetPass').value = '';
    $('#resetConfirm').value = '';
    $('#resetPass').type = 'password';
    $('#resetConfirm').type = 'password';
    $('#resetError').hidden = true;
    $$('.pw-toggle', dlg).forEach(function (btn) { btn.textContent = 'Show'; });

    UI.openDialog(dlg);
    setTimeout(function () { $('#resetPass').focus(); }, 60);
  }

  $('#resetForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var target = state.resetTarget;
    if (!target) return;

    var error = $('#resetError');
    error.hidden = true;

    var password = $('#resetPass').value;
    var confirm = $('#resetConfirm').value;

    if (password.length < 8) {
      showError(error, 'Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      showError(error, 'Those passwords do not match.');
      return;
    }

    var button = $('#resetSave');
    busy(button, true, 'Saving…');

    Store.setPassword(target.id, password, state.admin.username)
      .then(function () {
        busy(button, false);
        $('#resetDialog').close();
        UI.toast('Password updated for @' + target.username + '.', 'success');
        refresh();
      })
      .catch(function (err) {
        busy(button, false);
        if (adminSessionLost(err)) {
          $('#resetDialog').close();
          return;
        }
        showError(error, passwordError(err));
      });
  });

  /* ---------------------------------------------------------------- */
  /* closet inspector                                                  */
  /* ---------------------------------------------------------------- */

  function openInspect(account) {
    state.inspectAccount = account;

    function show(items) {
      $('#inspectTitle').textContent = account.name;
      $('#inspectSub').textContent = '@' + account.username + ' · ' +
        items.length + (items.length === 1 ? ' piece' : ' pieces') + ' · ' + UI.bytesLabel(account.stats.bytes);

      renderInspect(items);
      UI.openDialog($('#inspectDialog'));
    }

    if (Store.isRemote()) {
      Store.fetchItems(account.id).then(show).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast('Could not load that closet from the server.', 'error');
      });
    } else {
      show(Store.listItems(account.id));
    }
  }

  function renderInspect(items) {
    var grid = $('#inspectGrid');

    if (!items.length) {
      grid.innerHTML = '<p class="inspect-empty">This closet is empty.</p>';
      return;
    }

    grid.innerHTML = items.map(function (item) {
      return '<div class="inspect-item">' +
        '<img src="' + Util.esc(Store.imageOf(item)) + '" alt="' + Util.esc(item.name) + '" loading="lazy" data-fallback>' +
        '<div class="inspect-meta">' +
          '<b title="' + Util.esc(item.name) + '">' + Util.esc(item.name) + '</b>' +
          '<span>' + Util.esc(Store.categoryLabel(item.category)) + ' · ' + Util.esc(Store.colorLabel(item.color)) + '</span>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost" data-remove-item="' + item.id + '">Remove</button>' +
      '</div>';
    }).join('');

    UI.hydrateImages(grid);
  }

  $('#inspectGrid').addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove-item]');
    var account = state.inspectAccount;
    if (!button || !account) return;

    var items = Store.listItems(account.id);
    var item = items.filter(function (entry) { return entry.id === button.dataset.removeItem; })[0];
    if (!item) return;

    UI.confirmAction({
      title: 'Remove “' + item.name + '”?',
      message: 'This piece disappears from ' + account.name + '’s closet.',
      confirmLabel: 'Delete piece'
    }).then(function (confirmed) {
      if (!confirmed) return;

      Store.deleteAdminItem(account.id, item.id).then(function (next) {
        Store.logEvent(
          'admin.item.delete',
          'Removed “' + item.name + '” from @' + account.username + '’s closet',
          state.admin.username
        );

        account.stats.pieces = next.length;
        renderInspect(next);
        $('#inspectSub').textContent = '@' + account.username + ' · ' +
          next.length + (next.length === 1 ? ' piece' : ' pieces');
        refresh();
        UI.toast('Piece removed.', 'success');
      }).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast('Could not delete that piece.', 'error');
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /* activity                                                          */
  /* ---------------------------------------------------------------- */

  function renderActivity() {
    var events = Store.listEvents();
    var host = $('#activityHost');

    $('#activityCount').textContent = events.length
      ? events.length + (events.length === 1 ? ' event recorded' : ' events recorded')
      : 'No events recorded yet';

    if (!events.length) {
      host.innerHTML = '<p class="admin-empty">Nothing logged yet.</p>';
      return;
    }

    host.innerHTML = events.map(function (event) {
      return '<div class="log-row">' +
        '<time>' + Util.esc(new Date(event.ts).toLocaleString()) + '</time>' +
        '<span class="log-kind" title="' + Util.esc(event.kind) + '">' + Util.esc(event.kind) + '</span>' +
        '<p>' + Util.esc(event.message) + ' <span class="log-actor">· ' + Util.esc(event.actor) + '</span></p>' +
      '</div>';
    }).join('');
  }

  function renderStorage() {
    var host = $('#storageBreakdown');

    if (!state.accounts.length) {
      host.innerHTML = '<p class="small dim">No accounts yet.</p>';
      return;
    }

    host.innerHTML = state.accounts.map(function (account) {
      return '<div class="meter-row"><span>@' + Util.esc(account.username) + '</span>' +
        '<b>' + Util.esc(UI.bytesLabel(account.stats.bytes)) + '</b></div>';
    }).join('');
  }

  /* ---------------------------------------------------------------- */
  /* account pane                                                      */
  /* ---------------------------------------------------------------- */

  function renderMeta() {
    if (!state.admin) return;
    var admin = state.admin;

    $('#adminMeta').innerHTML =
      '<div><b>Username</b> @' + Util.esc(admin.username) + '</div>' +
      '<div><b>Display name</b> ' + Util.esc(admin.name) + '</div>' +
      '<div><b>Role</b> Administrator</div>' +
      '<div><b>Joined</b> ' + Util.esc(Util.formatDate(admin.createdAt)) + '</div>' +
      (admin.defaultPassword
        ? '<div class="warn-note">You are still using the default password. Change it below.</div>'
        : '');
  }

  $('#passwordForm').addEventListener('submit', function (event) {
    event.preventDefault();

    var error = $('#pwError');
    error.hidden = true;

    var current = $('#pwCurrent').value;
    var next = $('#pwNext').value;
    var confirm = $('#pwConfirm').value;

    if (!current || !next) {
      showError(error, 'Fill in every field.');
      return;
    }
    if (next.length < 8) {
      showError(error, 'The new password needs at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      showError(error, 'Those new passwords do not match.');
      return;
    }

    var button = $('#pwSubmit');
    busy(button, true, 'Saving…');

    Store.changePassword(state.admin.id, current, next)
      .then(function () {
        busy(button, false);
        $('#passwordForm').reset();
        UI.toast('Password updated.', 'success');
        refresh();
      })
      .catch(function (err) {
        busy(button, false);
        if (adminSessionLost(err)) return;
        showError(error, passwordError(err));
      });
  });

  /* ---------------------------------------------------------------- */
  /* tabs + data tools                                                 */
  /* ---------------------------------------------------------------- */

  function switchTab(tab) {
    if (!PANES[tab]) return;

    $$('#adminTabs [data-tab]').forEach(function (button) {
      var active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    Object.keys(PANES).forEach(function (key) {
      $('#' + PANES[key]).hidden = key !== tab;
    });

    if (tab === 'activity') renderActivity();
  }

  $('#adminTabs').addEventListener('click', function (event) {
    var button = event.target.closest('[data-tab]');
    if (button) switchTab(button.dataset.tab);
  });

  $('#adminSearch').addEventListener('input', UI.debounce(function (event) {
    state.query = event.target.value;
    renderUsers();
  }, 120));

  $('#adminRefresh').addEventListener('click', function () {
    refresh();
    UI.toast('Console refreshed.');
  });

  $('#activityRefresh').addEventListener('click', function () { refresh(); });
  $('#activityJumpBtn').addEventListener('click', function () { switchTab('activity'); });

  $('#exportAllBtn').addEventListener('click', function () {
    Promise.resolve().then(function () {
      return Store.exportAll();
    }).then(function (payload) {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);

      var link = document.createElement('a');
      link.href = url;
      link.download = 'hanging-clozet-admin-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

      Store.logEvent('admin.export', 'Exported full backup', state.admin.username);
      renderActivity();
      UI.toast('Backup downloaded.', 'success');
    }).catch(function (err) {
      if (adminSessionLost(err)) return;
      UI.toast('Could not export the backup.', 'error');
    });
  });

  $('#clearClosetsBtn').addEventListener('click', function () {
    UI.confirmAction({
      title: 'Clear every closet?',
      message: 'All pieces and photos for ' + state.accounts.length +
        ' account(s) will be deleted. Accounts stay, but this cannot be undone.',
      confirmLabel: 'Clear all closets'
    }).then(function (confirmed) {
      if (!confirmed) return;

      Promise.resolve().then(function () {
        return Store.clearWardrobes(state.admin.username);
      }).then(function () {
        refresh();
        UI.toast('All closets cleared.', 'success');
      }).catch(function (err) {
        if (adminSessionLost(err)) return;
        UI.toast('Could not clear the closets.', 'error');
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /* admin sign in                                                     */
  /* ---------------------------------------------------------------- */

  $('#adminLoginForm').addEventListener('submit', function (event) {
    event.preventDefault();

    var error = $('#adminLoginError');
    error.hidden = true;

    var username = $('#adminUser').value.trim();
    var password = $('#adminPass').value;

    if (!username || !password) {
      showError(error, 'Enter both your username and password.');
      return;
    }

    var button = $('#adminSubmit');
    busy(button, true, 'Checking…');

    Store.login(username, password)
      .then(function (account) {
        if (account.role !== 'admin') {
          Store.logout();
          throw new Error('not-admin');
        }
        busy(button, false);
        showPanel(account);
        UI.toast('Welcome back, ' + account.name + '.', 'success');
      })
      .catch(function (err) {
        busy(button, false);
        showError(error, loginError(err));
        $('#adminPass').select();
      });
  });

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  function loginError(err) {
    var code = err && err.message ? err.message : '';
    switch (code) {
      case 'invalid-credentials':
        return 'That username and password do not match.';
      case 'not-admin':
        return 'That account is not an administrator.';
      case 'account-disabled':
        return 'That account has been disabled by an administrator.';
      case 'crypto-unavailable':
        return 'Secure hashing is unavailable. Load the app through http://localhost:8000.';
      case 'storage-unavailable':
        return 'Local storage is unavailable. Turn off private mode or allow site data.';
      default:
        return 'Could not sign in. Please try again.';
    }
  }

  function passwordError(err) {
    var code = err && err.message ? err.message : '';
    if (code === 'weak-password') return 'Use at least 8 characters.';
    if (code === 'invalid-credentials') return 'That current password is incorrect.';
    if (code === 'crypto-unavailable') return 'Secure hashing is unavailable. Load the app through http://localhost:8000.';
    return 'Could not update the password.';
  }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function busy(button, isBusy, label) {
    if (!button) return;
    button.disabled = isBusy;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'Working…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }

  /* password reveal buttons */
  $$('.pw-toggle').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.dataset.target);
      if (!input) return;
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? 'Hide' : 'Show';
      button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });
  });

  /* live account updates */
  var autoRefreshTimer = null;

  function scheduleAutoRefresh() {
    if (!state.admin || panel.hidden) return;
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(refresh, 150);
  }

  window.addEventListener('storage', scheduleAutoRefresh);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleAutoRefresh();
  });
  setInterval(function () {
    if (!document.hidden && state.admin && !panel.hidden) refresh();
  }, 8000);

  /* dialogs */
  UI.wireDialog($('#resetDialog'));
  UI.wireDialog($('#inspectDialog'));
  UI.wireDialog($('#accountDialog'));
  $('#resetClose').addEventListener('click', function () { $('#resetDialog').close(); });
  $('#resetCancel').addEventListener('click', function () { $('#resetDialog').close(); });
  $('#inspectClose').addEventListener('click', function () { $('#inspectDialog').close(); });
  $('#accountClose').addEventListener('click', function () { $('#accountDialog').close(); });
  $('#accountDone').addEventListener('click', function () { $('#accountDialog').close(); });
  $('#accountResetBtn').addEventListener('click', function () {
    var account = state.detailsAccount;
    if (!account) return;
    $('#accountDialog').close();
    openReset(account);
  });
  $('#accountClosetBtn').addEventListener('click', function () {
    var account = state.detailsAccount;
    if (!account) return;
    $('#accountDialog').close();
    openInspect(account);
  });
  });
})();
