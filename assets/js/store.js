/* ==========================================================================
   Hanging Clozet — data layer
   - accounts + session (localStorage, PBKDF2-SHA256 hashed passwords)
   - wardrobe items per account
   - image intake: upload (compressed to WebP) or remote link
   - colour detection + colour harmony scoring for outfit combinations
   ========================================================================== */

(function (global) {
  'use strict';

  var NS = 'ember.wardrobe.v1';
  var SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  var PBKDF2_ITERATIONS = 150000;
  var MAX_IMAGE_DIM = 1100;
  var IMAGE_QUALITY = 0.82;
  var ADMIN_USERNAME = 'admin';
  var ADMIN_DEFAULT_PASSWORD = 'Hamaadkhan123@';
  var ADMIN_PASSWORD_KEY = NS + '.adminpw.v3';

  var KEYS = {
    accounts: NS + '.accounts',
    session: NS + '.session',
    audit: NS + '.audit',
    items: function (uid) { return NS + '.items.' + uid; }
  };

  /* ------------------------------------------------------------------ */
  /* shared server mode                                                 */
  /* ------------------------------------------------------------------ */

  var TOKEN_KEY = NS + '.token';
  var remote = false;
  var remoteBase = '';
  var remoteAccount = null;
  var remoteItems = [];
  var remoteAccounts = null;
  var remoteEvents = null;
  var itemCache = {};
  var initPromise = null;
  var pushTimer = null;

  function configuredBase() {
    var raw = global.CLOZET_CONFIG && global.CLOZET_CONFIG.apiBase;
    return String(raw || '').trim().replace(/\/+$/, '');
  }

  function apiCandidates() {
    var configured = configuredBase();
    if (configured) return [configured];

    var host = global.location.hostname;
    var local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    var bases = [''];
    if (local) {
      for (var port = 8000; port <= 8002; port++) {
        bases.push('http://127.0.0.1:' + port);
      }
    }
    return bases;
  }

  function getToken() {
    try { return global.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try {
      if (token) global.localStorage.setItem(TOKEN_KEY, token);
      else global.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
  }

  function apiFetch(base, path, options, timeoutMs) {
    if (!global.fetch) return Promise.reject(new Error('remote-unavailable'));

    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    var controller = typeof global.AbortController !== 'undefined'
      ? new global.AbortController()
      : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, timeoutMs || 15000);

    var request = { method: opts.method || 'GET', headers: headers, cache: 'no-store' };
    if (opts.body !== undefined) request.body = JSON.stringify(opts.body);
    if (controller) request.signal = controller.signal;

    return global.fetch((base || '') + path, request)
      .then(function (response) {
        clearTimeout(timer);
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok || data.ok === false) {
            var error = new Error(data.error || ('http-' + response.status));
            error.status = response.status;
            throw error;
          }
          return data;
        });
      }, function () {
        clearTimeout(timer);
        throw new Error('remote-unavailable');
      });
  }

  function init() {
    if (initPromise) return initPromise;

    initPromise = new Promise(function (resolve) {
      var bases = apiCandidates();
      var index = 0;

      function next() {
        if (index >= bases.length) {
          remote = false;
          resolve({ mode: 'local' });
          return;
        }

        var base = bases[index++];
        apiFetch(base, '/api/health', {}, 1100).then(function (health) {
          if (!health || health.ok !== true || health.service !== 'hanging-clozet') {
            throw new Error('remote-unavailable');
          }

          remote = true;
          remoteBase = base;

          var token = getToken();
          if (!token) {
            resolve({ mode: 'remote', account: null });
            return;
          }

          return apiFetch(base, '/api/auth/session', {}, 12000)
            .then(function (session) {
              remoteAccount = session.account;
              remoteItems = session.items || [];
              itemCache[remoteAccount.id] = remoteItems;
              resolve({ mode: 'remote', account: remoteAccount });
            })
            .catch(function (err) {
              if (err && (err.message === 'unauthorized' || err.status === 401)) setToken('');
              remoteAccount = null;
              remoteItems = [];
              resolve({ mode: 'remote', account: null });
            });
        }).catch(next);
      }

      next();
    });

    return initPromise;
  }

  function isRemote() {
    return remote;
  }

  /* ------------------------------------------------------------------ */
  /* palette & taxonomy                                                 */
  /* ------------------------------------------------------------------ */

  var COLORS = [
    { key: 'black', label: 'Black', hex: '#241f1c' },
    { key: 'grey', label: 'Grey', hex: '#7d746c' },
    { key: 'cream', label: 'Cream / White', hex: '#e9dcc8' },
    { key: 'camel', label: 'Camel', hex: '#c39a6b' },
    { key: 'brown', label: 'Brown', hex: '#7a5236' },
    { key: 'navy', label: 'Navy', hex: '#2c3a52' },
    { key: 'denim', label: 'Denim', hex: '#4d6a86' },
    { key: 'blue', label: 'Blue', hex: '#4a6f96' },
    { key: 'teal', label: 'Teal', hex: '#3f7d7b' },
    { key: 'green', label: 'Green', hex: '#4f7a4c' },
    { key: 'olive', label: 'Olive', hex: '#77794a' },
    { key: 'mustard', label: 'Mustard', hex: '#c09647' },
    { key: 'orange', label: 'Orange', hex: '#b9703c' },
    { key: 'maroon', label: 'Maroon', hex: '#6e2f36' },
    { key: 'red', label: 'Red', hex: '#a4483f' },
    { key: 'pink', label: 'Pink', hex: '#c08390' },
    { key: 'purple', label: 'Purple', hex: '#6b5178' }
  ];

  var COLOR_MAP = {};
  COLORS.forEach(function (c) { COLOR_MAP[c.key] = c; });

  var NEUTRAL_COLORS = ['black', 'grey', 'cream', 'camel', 'brown', 'navy', 'denim'];
  var WARM_COLORS = ['camel', 'brown', 'maroon', 'red', 'mustard', 'orange', 'pink'];

  var CATEGORIES = [
    { key: 'shirt', label: 'Shirt', plural: 'Shirts' },
    { key: 'pants', label: 'Pants', plural: 'Pants' },
    { key: 'suit', label: 'Suit', plural: 'Suits' },
    { key: 'shoes', label: 'Shoes', plural: 'Shoes' },
    { key: 'accessory', label: 'Accessory', plural: 'Accessories' }
  ];

  var CATEGORY_MAP = {};
  CATEGORIES.forEach(function (c) { CATEGORY_MAP[c.key] = c; });

  /* ------------------------------------------------------------------ */
  /* tiny utils                                                         */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // Only allow inline image data and http(s) URLs. Blocks javascript:/data:text/html.
  function safeSrc(value) {
    var raw = String(value == null ? '' : value).trim();
    if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(raw)) return raw;
    try {
      var url = new URL(raw, global.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (e) { /* fall through */ }
    return '';
  }

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      var err = new Error('storage-full');
      err.cause = e;
      throw err;
    }
  }

  function storageAvailable() {
    try {
      var probe = NS + '.probe';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function bytesToB64(bytes) {
    var str = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(str);
  }

  function b64ToBytes(b64) {
    var bin = global.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomId(prefix) {
    var bytes = new Uint8Array(9);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
    return (prefix || 'id') + '_' + hex;
  }

  function hashInt(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function colorLabel(key) {
    return COLOR_MAP[key] ? COLOR_MAP[key].label : 'Unspecified';
  }

  function colorHex(key) {
    return COLOR_MAP[key] ? COLOR_MAP[key].hex : '#7d746c';
  }

  function categoryLabel(key) {
    return CATEGORY_MAP[key] ? CATEGORY_MAP[key].label : 'Piece';
  }

  /* ------------------------------------------------------------------ */
  /* accounts                                                           */
  /* ------------------------------------------------------------------ */

  function cryptoReady() {
    return !!(global.crypto && global.crypto.subtle && global.crypto.getRandomValues);
  }

  function getAccounts() {
    var list = readJSON(KEYS.accounts, []);
    return Array.isArray(list) ? list : [];
  }

  function saveAccounts(list) {
    writeJSON(KEYS.accounts, list);
  }

  function findAccount(username) {
    var uname = String(username || '').trim().toLowerCase();
    if (!uname) return null;
    var list = getAccounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].username === uname) return list[i];
    }
    return null;
  }

  function publicAccount(account) {
    if (!account) return null;
    return {
      id: account.id,
      name: account.name,
      username: account.username,
      role: account.role === 'admin' ? 'admin' : 'user',
      disabled: !!account.disabled,
      defaultPassword: !!account.defaultPassword,
      createdAt: account.createdAt
    };
  }

  /* ------------------------------------------------------------------ */
  /* activity log                                                       */
  /* ------------------------------------------------------------------ */

  function logEvent(kind, message, actor) {
    try {
      var list = readJSON(KEYS.audit, []);
      if (!Array.isArray(list)) list = [];
      list.unshift({
        id: randomId('e'),
        ts: Date.now(),
        kind: String(kind || 'event'),
        message: String(message || ''),
        actor: String(actor || 'system')
      });
      if (list.length > 300) list.length = 300;
      writeJSON(KEYS.audit, list);
    } catch (e) {
      /* logging must never take the app down */
    }
  }

  function listEvents() {
    if (remote) return remoteEvents ? remoteEvents.slice() : [];
    var list = readJSON(KEYS.audit, []);
    return Array.isArray(list) ? list : [];
  }

  function deriveHash(password, saltB64, iterations) {
    var enc = new TextEncoder();
    return global.crypto.subtle
      .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return global.crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: iterations, hash: 'SHA-256' },
          key,
          256
        );
      })
      .then(function (bits) { return bytesToB64(new Uint8Array(bits)); });
  }

  function signup(name, username, password) {
    if (remote) {
      return apiFetch(remoteBase, '/api/auth/signup', {
        method: 'POST',
        body: { name: name, username: username, password: password }
      }, 20000).then(function (data) {
        clearTimeout(pushTimer);
        setToken(data.token);
        remoteAccount = data.account;
        remoteItems = data.items || [];
        itemCache[remoteAccount.id] = remoteItems;
        remoteAccounts = null;
        remoteEvents = null;
        return data.account;
      });
    }

    if (!cryptoReady()) return Promise.reject(new Error('crypto-unavailable'));

    var uname = String(username || '').trim().toLowerCase();
    var display = String(name || '').trim() || uname;

    if (!/^[a-z0-9._-]{3,24}$/.test(uname)) return Promise.reject(new Error('invalid-username'));
    if (uname === ADMIN_USERNAME) return Promise.reject(new Error('reserved-username'));
    if (String(password || '').length < 8) return Promise.reject(new Error('weak-password'));
    if (findAccount(uname)) return Promise.reject(new Error('username-taken'));
    if (!storageAvailable()) return Promise.reject(new Error('storage-unavailable'));

    var saltBytes = new Uint8Array(16);
    global.crypto.getRandomValues(saltBytes);
    var salt = bytesToB64(saltBytes);

    return deriveHash(password, salt, PBKDF2_ITERATIONS).then(function (hash) {
      var account = {
        id: randomId('u'),
        name: display,
        username: uname,
        role: 'user',
        disabled: false,
        defaultPassword: false,
        salt: salt,
        hash: hash,
        iterations: PBKDF2_ITERATIONS,
        createdAt: Date.now()
      };
      var list = getAccounts();
      list.push(account);
      saveAccounts(list);
      startSession(account.id);
      logEvent('auth.signup', 'New account @' + uname + ' created', display);
      return publicAccount(account);
    });
  }

  function login(username, password) {
    if (remote) {
      return apiFetch(remoteBase, '/api/auth/login', {
        method: 'POST',
        body: { username: username, password: password }
      }, 20000).then(function (data) {
        clearTimeout(pushTimer);
        setToken(data.token);
        remoteAccount = data.account;
        remoteItems = data.items || [];
        itemCache[remoteAccount.id] = remoteItems;
        remoteAccounts = null;
        remoteEvents = null;
        return data.account;
      });
    }

    if (!cryptoReady()) return Promise.reject(new Error('crypto-unavailable'));

    var account = findAccount(username);
    if (!account) return Promise.reject(new Error('invalid-credentials'));
    if (account.disabled) return Promise.reject(new Error('account-disabled'));

    return deriveHash(password, account.salt, account.iterations || PBKDF2_ITERATIONS).then(function (hash) {
      if (hash !== account.hash) throw new Error('invalid-credentials');
      startSession(account.id);
      logEvent('auth.login', 'Signed in as @' + account.username, account.username);
      return publicAccount(account);
    });
  }

  function startSession(uid) {
    writeJSON(KEYS.session, { uid: uid, expiresAt: Date.now() + SESSION_MS });
  }

  function getSession() {
    if (remote) return remoteAccount;

    var session = readJSON(KEYS.session, null);
    if (!session || !session.uid) return null;
    if (!session.expiresAt || session.expiresAt < Date.now()) {
      logout();
      return null;
    }
    var list = getAccounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== session.uid) continue;
      if (list[i].disabled) {
        logout();
        return null;
      }
      return publicAccount(list[i]);
    }
    logout();
    return null;
  }

  function requireSession(redirectTo) {
    var account = getSession();
    if (!account) {
      global.location.replace(redirectTo || 'index.html');
      return null;
    }
    return account;
  }

  function requireAdmin(redirectTo) {
    var account = getSession();
    if (!account || account.role !== 'admin') {
      if (redirectTo) global.location.replace(redirectTo);
      return null;
    }
    return account;
  }

  function logout() {
    if (remote) {
      var token = getToken();
      if (token) {
        apiFetch(remoteBase, '/api/auth/logout', { method: 'POST', body: {} }, 8000)
          .catch(function () { /* offline logout still clears locally */ });
      }
      clearTimeout(pushTimer);
      setToken('');
      remoteAccount = null;
      remoteItems = [];
      remoteAccounts = null;
      remoteEvents = null;
      itemCache = {};
    }
    try { global.localStorage.removeItem(KEYS.session); } catch (e) { /* ignore */ }
  }

  function findById(uid) {
    var list = getAccounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === uid) return list[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* administration                                                     */
  /* ------------------------------------------------------------------ */

  // Seeds the built-in administrator on first run. The default password is
  // intentionally public (shown on the admin sign-in card until changed) —
  // this is a local, browser-only gateway, not server-side security.
  function adminPasswordSynced() {
    try {
      return global.localStorage.getItem(ADMIN_PASSWORD_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function markAdminPasswordSynced() {
    try {
      global.localStorage.setItem(ADMIN_PASSWORD_KEY, '1');
    } catch (e) {
      /* ignore */
    }
  }

  function ensureAdmin() {
    if (remote) return Promise.resolve(false);

    var existing = findAccount(ADMIN_USERNAME);
    if (existing) {
      // Accounts created before roles existed could have claimed this name.
      if (existing.role !== 'admin') {
        patchAccount(existing.id, { role: 'admin' });
        logEvent('admin.promote', 'Existing account @admin promoted to administrator', 'system');
      }

      // One-time move to the currently documented administrator password.
      if (cryptoReady() && !adminPasswordSynced()) {
        var resetSaltBytes = new Uint8Array(16);
        global.crypto.getRandomValues(resetSaltBytes);
        var resetSalt = bytesToB64(resetSaltBytes);
        return deriveHash(ADMIN_DEFAULT_PASSWORD, resetSalt, PBKDF2_ITERATIONS).then(function (hash) {
          patchAccount(existing.id, {
            salt: resetSalt,
            hash: hash,
            iterations: PBKDF2_ITERATIONS,
            defaultPassword: true
          });
          markAdminPasswordSynced();
          logEvent('admin.password', 'Administrator password set to the documented default', 'system');
          return false;
        });
      }

      return Promise.resolve(false);
    }
    if (!cryptoReady() || !storageAvailable()) return Promise.resolve(false);

    var saltBytes = new Uint8Array(16);
    global.crypto.getRandomValues(saltBytes);
    var salt = bytesToB64(saltBytes);

    return deriveHash(ADMIN_DEFAULT_PASSWORD, salt, PBKDF2_ITERATIONS).then(function (hash) {
      if (findAccount(ADMIN_USERNAME)) return false;
      var list = getAccounts();
      list.push({
        id: randomId('u'),
        name: 'Clozet Admin',
        username: ADMIN_USERNAME,
        role: 'admin',
        disabled: false,
        defaultPassword: true,
        salt: salt,
        hash: hash,
        iterations: PBKDF2_ITERATIONS,
        createdAt: Date.now()
      });
      saveAccounts(list);
      markAdminPasswordSynced();
      logEvent('admin.seed', 'Default administrator created', 'system');
      return true;
    });
  }

  function itemsStats(uid) {
    var list = listItems(uid);
    var favorites = 0;
    var tops = 0;
    var bottoms = 0;
    list.forEach(function (item) {
      if (item.favorite) favorites += 1;
      if (item.category === 'shirt') tops += 1;
      if (item.category === 'pants') bottoms += 1;
    });
    return { pieces: list.length, favorites: favorites, looks: tops * bottoms, bytes: storageUsage(uid) };
  }

  function listAccounts() {
    if (remote) return remoteAccounts ? remoteAccounts.slice() : [];
    return getAccounts().map(function (account) {
      return {
        id: account.id,
        name: account.name,
        username: account.username,
        role: account.role === 'admin' ? 'admin' : 'user',
        disabled: !!account.disabled,
        defaultPassword: !!account.defaultPassword,
        createdAt: account.createdAt,
        stats: itemsStats(account.id)
      };
    });
  }

  function getAccountDetails(uid) {
    if (remote) {
      if (!remoteAccounts) return null;
      var remoteAccount = remoteAccounts.filter(function (account) { return account.id === uid; })[0];
      return remoteAccount || null;
    }

    var account = findById(uid);
    if (!account) return null;

    return {
      id: account.id,
      name: account.name,
      username: account.username,
      role: account.role === 'admin' ? 'admin' : 'user',
      disabled: !!account.disabled,
      defaultPassword: !!account.defaultPassword,
      createdAt: account.createdAt,
      password: {
        algorithm: 'PBKDF2-SHA256',
        iterations: account.iterations || PBKDF2_ITERATIONS,
        hashPrefix: account.hash ? String(account.hash).slice(0, 12) + '…' : '—'
      },
      stats: itemsStats(uid)
    };
  }

  function fetchAccounts() {
    if (!remote) return Promise.resolve(listAccounts());
    return apiFetch(remoteBase, '/api/admin/accounts', {}, 15000).then(function (data) {
      remoteAccounts = data.accounts || [];
      return remoteAccounts;
    });
  }

  function fetchEvents() {
    if (!remote) return Promise.resolve(listEvents());
    return apiFetch(remoteBase, '/api/admin/audit', {}, 15000).then(function (data) {
      remoteEvents = data.events || [];
      return remoteEvents;
    });
  }

  function fetchItems(uid) {
    if (!remote) return Promise.resolve(listItems(uid));
    return apiFetch(remoteBase, '/api/admin/accounts/' + encodeURIComponent(uid) + '/items', {}, 20000)
      .then(function (data) {
        var items = data.items || [];
        itemCache[uid] = items;
        return items;
      });
  }

  function deleteAdminItem(uid, itemId) {
    if (!remote) {
      deleteItem(uid, itemId);
      return Promise.resolve(listItems(uid));
    }
    return apiFetch(remoteBase, '/api/admin/accounts/' + encodeURIComponent(uid) + '/items/' + encodeURIComponent(itemId), {
      method: 'DELETE'
    }, 20000).then(function (data) {
      var items = data.items || [];
      itemCache[uid] = items;
      return items;
    });
  }

  function adminCount() {
    return getAccounts().filter(function (account) {
      return account.role === 'admin' && !account.disabled;
    }).length;
  }

  function patchAccount(uid, patch) {
    var list = getAccounts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== uid) continue;
      list[i] = Object.assign({}, list[i], patch, { id: list[i].id });
      saveAccounts(list);
      return list[i];
    }
    return null;
  }

  function setAccountDisabled(uid, disabled, actor) {
    if (remote) {
      return apiFetch(remoteBase, '/api/admin/accounts/' + encodeURIComponent(uid) + '/disabled', {
        method: 'POST', body: { disabled: !!disabled }
      }, 15000);
    }

    var target = findById(uid);
    if (!target) throw new Error('not-found');
    if (disabled && target.role === 'admin' && adminCount() <= 1) throw new Error('last-admin');

    patchAccount(uid, { disabled: !!disabled });

    var session = readJSON(KEYS.session, null);
    if (disabled && session && session.uid === uid) logout();

    logEvent(
      disabled ? 'admin.disable' : 'admin.enable',
      (disabled ? 'Disabled account @' : 'Re-enabled account @') + target.username,
      actor || 'admin'
    );
  }

  function deleteAccount(uid, actor) {
    if (remote) {
      return apiFetch(remoteBase, '/api/admin/accounts/' + encodeURIComponent(uid), {
        method: 'DELETE'
      }, 15000);
    }

    var target = findById(uid);
    if (!target) throw new Error('not-found');
    if (target.role === 'admin' && adminCount() <= 1) throw new Error('last-admin');

    saveAccounts(getAccounts().filter(function (account) { return account.id !== uid; }));
    try { global.localStorage.removeItem(itemsKey(uid)); } catch (e) { /* ignore */ }

    var session = readJSON(KEYS.session, null);
    if (session && session.uid === uid) logout();

    logEvent('admin.delete', 'Deleted account @' + target.username, actor || 'admin');
  }

  function setPassword(uid, newPassword, actor) {
    if (remote) {
      if (String(newPassword || '').length < 8) return Promise.reject(new Error('weak-password'));
      return apiFetch(remoteBase, '/api/admin/accounts/' + encodeURIComponent(uid) + '/password', {
        method: 'POST', body: { password: newPassword }
      }, 20000);
    }

    if (!cryptoReady()) return Promise.reject(new Error('crypto-unavailable'));
    if (String(newPassword || '').length < 8) return Promise.reject(new Error('weak-password'));

    var target = findById(uid);
    if (!target) return Promise.reject(new Error('not-found'));

    var saltBytes = new Uint8Array(16);
    global.crypto.getRandomValues(saltBytes);
    var salt = bytesToB64(saltBytes);

    return deriveHash(newPassword, salt, PBKDF2_ITERATIONS).then(function (hash) {
      patchAccount(uid, {
        salt: salt,
        hash: hash,
        iterations: PBKDF2_ITERATIONS,
        defaultPassword: false
      });
      logEvent('admin.password', 'Password reset for @' + target.username, actor || 'admin');
    });
  }

  function changePassword(uid, currentPassword, newPassword) {
    if (remote) {
      if (String(newPassword || '').length < 8) return Promise.reject(new Error('weak-password'));
      return apiFetch(remoteBase, '/api/auth/password', {
        method: 'POST',
        body: { currentPassword: currentPassword, newPassword: newPassword }
      }, 20000).then(function (data) {
        if (data.token) setToken(data.token);
        if (remoteAccount) remoteAccount.defaultPassword = false;
      });
    }

    if (!cryptoReady()) return Promise.reject(new Error('crypto-unavailable'));
    if (String(newPassword || '').length < 8) return Promise.reject(new Error('weak-password'));

    var target = findById(uid);
    if (!target) return Promise.reject(new Error('not-found'));

    return deriveHash(currentPassword, target.salt, target.iterations || PBKDF2_ITERATIONS).then(function (currentHash) {
      if (currentHash !== target.hash) throw new Error('invalid-credentials');

      var saltBytes = new Uint8Array(16);
      global.crypto.getRandomValues(saltBytes);
      var salt = bytesToB64(saltBytes);

      return deriveHash(newPassword, salt, PBKDF2_ITERATIONS).then(function (hash) {
        patchAccount(uid, {
          salt: salt,
          hash: hash,
          iterations: PBKDF2_ITERATIONS,
          defaultPassword: false
        });
        logEvent('auth.password', 'Password changed', target.username);
      });
    });
  }

  function clearWardrobes(actor) {
    if (remote) {
      return apiFetch(remoteBase, '/api/admin/clear-closets', {
        method: 'POST', body: {}
      }, 20000).then(function (data) { return data.removed || 0; });
    }

    var accounts = getAccounts();
    accounts.forEach(function (account) {
      try { global.localStorage.removeItem(itemsKey(account.id)); } catch (e) { /* ignore */ }
    });
    logEvent('admin.purge', 'Cleared wardrobes for ' + accounts.length + ' account(s)', actor || 'admin');
    return accounts.length;
  }

  function exportAll() {
    if (remote) {
      return apiFetch(remoteBase, '/api/admin/export', {}, 30000).then(function (data) {
        return data.export;
      });
    }

    var accounts = listAccounts();
    var wardrobes = {};
    accounts.forEach(function (account) {
      wardrobes[account.id] = listItems(account.id);
    });
    return {
      app: 'hanging-clozet',
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: accounts,
      wardrobes: wardrobes,
      events: listEvents()
    };
  }

  function importItems(uid, payload) {
    var incoming = payload && Array.isArray(payload.items) ? payload.items : payload;
    if (!Array.isArray(incoming)) throw new Error('invalid-backup');

    var existing = listItems(uid);
    var seen = {};
    existing.forEach(function (item) { seen[item.id] = true; });

    var added = [];
    incoming.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (!CATEGORY_MAP[raw.category] || !COLOR_MAP[raw.color]) return;
      if (!raw.image || !raw.image.value) return;

      var src = safeSrc(raw.image.value);
      if (!src) return;

      var id = (typeof raw.id === 'string' && raw.id && !seen[raw.id]) ? raw.id : randomId('i');
      seen[id] = true;

      added.push({
        id: id,
        name: String(raw.name || '').trim().slice(0, 80) || categoryLabel(raw.category),
        category: raw.category,
        color: raw.color,
        image: { kind: /^data:/i.test(src) ? 'data' : 'url', value: src },
        favorite: !!raw.favorite,
        createdAt: Number(raw.createdAt) || Date.now()
      });
    });

    if (!added.length) throw new Error('invalid-backup');

    if (remote && remoteAccount && uid === remoteAccount.id) {
      remoteItems = added.concat(existing);
      itemCache[uid] = remoteItems;
      schedulePushItems();
      return added.length;
    }

    saveItems(uid, added.concat(existing));
    return added.length;
  }

  /* ------------------------------------------------------------------ */
  /* items                                                              */
  /* ------------------------------------------------------------------ */

  function itemsKey(uid) { return KEYS.items(uid); }

  function listItems(uid) {
    if (remote) {
      if (remoteAccount && uid === remoteAccount.id) return remoteItems.slice();
      return itemCache[uid] ? itemCache[uid].slice() : [];
    }

    var list = readJSON(itemsKey(uid), []);
    return Array.isArray(list) ? list : [];
  }

  function saveItems(uid, list) {
    writeJSON(itemsKey(uid), list);
  }

  function buildItem(draft) {
    return {
      id: randomId('i'),
      name: String(draft.name || '').trim() || categoryLabel(draft.category),
      category: CATEGORY_MAP[draft.category] ? draft.category : 'shirt',
      color: COLOR_MAP[draft.color] ? draft.color : 'grey',
      image: draft.image,
      favorite: false,
      createdAt: Date.now()
    };
  }

  function schedulePushItems() {
    if (!remote || !remoteAccount) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      apiFetch(remoteBase, '/api/items', {
        method: 'PUT',
        body: { items: remoteItems }
      }, 30000).then(function (data) {
        if (Array.isArray(data.items)) {
          remoteItems = data.items;
          itemCache[remoteAccount.id] = remoteItems;
        }
      }).catch(function (err) {
        try {
          global.dispatchEvent(new CustomEvent('clozet-sync-error', {
            detail: { message: err && err.message ? err.message : 'sync-failed' }
          }));
        } catch (e) { /* ignore */ }
      });
    }, 350);
  }

  function flushPushItems() {
    if (!remote || !remoteAccount || !pushTimer) return;
    clearTimeout(pushTimer);
    pushTimer = null;

    var headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    try {
      global.fetch((remoteBase || '') + '/api/items', {
        method: 'PUT',
        headers: headers,
        body: JSON.stringify({ items: remoteItems }),
        keepalive: true
      }).catch(function () { /* best effort */ });
    } catch (e) {
      /* ignore */
    }
  }

  global.addEventListener('pagehide', flushPushItems);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushPushItems();
  });

  function createItem(uid, draft) {
    if (remote && remoteAccount && uid === remoteAccount.id) {
      var remoteItem = buildItem(draft);
      remoteItems.unshift(remoteItem);
      itemCache[uid] = remoteItems;
      schedulePushItems();
      return remoteItem;
    }

    var item = buildItem(draft);
    var list = listItems(uid);
    list.unshift(item);
    saveItems(uid, list);
    return item;
  }

  function updateItem(uid, id, patch) {
    if (remote && remoteAccount && uid === remoteAccount.id) {
      for (var r = 0; r < remoteItems.length; r++) {
        if (remoteItems[r].id !== id) continue;
        var remoteNext = Object.assign({}, remoteItems[r], patch, { id: remoteItems[r].id });
        remoteItems[r] = remoteNext;
        itemCache[uid] = remoteItems;
        schedulePushItems();
        return remoteNext;
      }
      return null;
    }

    var list = listItems(uid);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var next = Object.assign({}, list[i], patch, { id: list[i].id });
      list[i] = next;
      saveItems(uid, list);
      return next;
    }
    return null;
  }

  function deleteItem(uid, id) {
    if (remote && remoteAccount && uid === remoteAccount.id) {
      remoteItems = remoteItems.filter(function (item) { return item.id !== id; });
      itemCache[uid] = remoteItems;
      schedulePushItems();
      return remoteItems.slice();
    }

    var list = listItems(uid).filter(function (item) { return item.id !== id; });
    saveItems(uid, list);
    return list;
  }

  function storageUsage(uid) {
    if (remote) {
      try {
        return JSON.stringify(listItems(uid)).length * 2;
      } catch (e) {
        return 0;
      }
    }

    try {
      var raw = global.localStorage.getItem(itemsKey(uid)) || '';
      return raw.length * 2; // UTF-16 code units → rough bytes
    } catch (e) {
      return 0;
    }
  }

  function imageOf(item) {
    if (!item || !item.image) return '';
    return item.image.kind === 'url' ? safeSrc(item.image.value) : safeSrc(item.image.value);
  }

  /* ------------------------------------------------------------------ */
  /* colour detection from pixels                                       */
  /* ------------------------------------------------------------------ */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0, s = 0;

    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function familyFromRgb(r, g, b) {
    var hsl = rgbToHsl(r, g, b);
    var h = hsl[0], s = hsl[1], l = hsl[2];

    if (s < 0.11) {
      if (l > 0.82) return 'cream';
      if (l > 0.3) return 'grey';
      return 'black';
    }
    // pale, low-saturation tones read as cream/ivory regardless of hue
    if (l > 0.78 && s < 0.5) return 'cream';

    if (h < 15 || h >= 345) {
      if (l < 0.32) return 'maroon';
      if (l > 0.76) return 'pink';
      return 'red';
    }
    if (h < 45) {
      if (l < 0.5) return 'brown';
      if (s > 0.6 && l > 0.6) return 'orange';
      if (s < 0.22) return 'cream';
      return 'camel';
    }
    if (h < 70) {
      if (s < 0.28 && h >= 50) return 'olive';
      if (l < 0.42) return 'brown';
      if (s < 0.3) return 'cream';
      if (s > 0.45 && l > 0.45) return 'mustard';
      return 'camel';
    }
    if (h < 160) {
      if (s < 0.26) return 'olive';
      return l < 0.4 && s < 0.5 ? 'olive' : 'green';
    }
    if (h < 200) return 'teal';
    if (h < 250) return l < 0.36 ? 'navy' : 'blue';
    if (h < 300) return 'purple';
    return 'pink';
  }

  function detectColorFromCanvas(canvas) {
    try {
      var size = 48;
      var probe = document.createElement('canvas');
      probe.width = size;
      probe.height = size;
      var ctx = probe.getContext('2d', { willReadFrequently: true });
      // centre crop: garments sit in the middle of product shots
      ctx.drawImage(
        canvas,
        canvas.width * 0.18, canvas.height * 0.12,
        canvas.width * 0.64, canvas.height * 0.72,
        0, 0, size, size
      );
      var data = ctx.getImageData(0, 0, size, size).data;
      var counts = {};
      var bestKey = null;
      var bestCount = -1;

      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 180) continue;
        var family = familyFromRgb(data[i], data[i + 1], data[i + 2]);
        counts[family] = (counts[family] || 0) + 1;
      }
      for (var key in counts) {
        if (counts[key] > bestCount) {
          bestCount = counts[key];
          bestKey = key;
        }
      }
      return bestKey || 'grey';
    } catch (e) {
      return null; // tainted canvas (remote image without CORS)
    }
  }

  /* ------------------------------------------------------------------ */
  /* image intake                                                       */
  /* ------------------------------------------------------------------ */

  function loadImage(src, crossOrigin) {
    return new Promise(function (resolve, reject) {
      if (!src) return reject(new Error('invalid-image'));
      var img = new Image();
      if (crossOrigin === 'anonymous') img.crossOrigin = 'anonymous';
      var timer = setTimeout(function () {
        img.onload = img.onerror = null;
        reject(new Error('image-timeout'));
      }, 15000);

      img.onload = function () {
        clearTimeout(timer);
        if (!img.naturalWidth || !img.naturalHeight) return reject(new Error('invalid-image'));
        resolve(img);
      };
      img.onerror = function () {
        clearTimeout(timer);
        reject(new Error('image-failed'));
      };
      img.src = src;
    });
  }

  function compressImage(src, maxDim, quality) {
    return loadImage(src).then(function (img) {
      var limit = maxDim || MAX_IMAGE_DIM;
      var scale = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      var q = quality || IMAGE_QUALITY;
      var dataUrl = canvas.toDataURL('image/webp', q);
      if (dataUrl.indexOf('data:image/webp') !== 0) {
        dataUrl = canvas.toDataURL('image/jpeg', q);
      }

      return {
        dataUrl: dataUrl,
        width: w,
        height: h,
        color: detectColorFromCanvas(canvas)
      };
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('read-failed')); };
      reader.readAsDataURL(file);
    });
  }

  function prepareFile(file) {
    if (!file) return Promise.reject(new Error('missing-file'));
    if (!/^image\//.test(file.type)) return Promise.reject(new Error('not-an-image'));
    if (file.size > 25 * 1024 * 1024) return Promise.reject(new Error('file-too-large'));

    return readFileAsDataUrl(file)
      .then(function (dataUrl) { return compressImage(dataUrl); })
      .then(function (result) {
        return {
          image: { kind: 'data', value: result.dataUrl },
          color: result.color,
          width: result.width,
          height: result.height
        };
      });
  }

  function extractImageUrl(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    if (/^data:image\//i.test(value)) return value;

    try {
      var url = new URL(value, global.location.href);
      var host = url.hostname.toLowerCase();
      var param = null;

      // Image result pages wrap the real file in a query parameter.
      if (/(^|\.)google\.[a-z.]+$/.test(host)) {
        param = url.searchParams.get('imgurl') ||
          url.searchParams.get('mediaurl') ||
          url.searchParams.get('url');
      } else if (/(^|\.)bing\.[a-z.]+$/.test(host)) {
        param = url.searchParams.get('mediaurl') || url.searchParams.get('imgurl');
      } else if (/(^|\.)duckduckgo\.com$/.test(host)) {
        param = url.searchParams.get('u');
      }

      // Some result pages encode the target twice.
      var decoded = param ? param.trim() : '';
      for (var i = 0; i < 2 && /^https?%3A/i.test(decoded); i++) {
        try { decoded = decodeURIComponent(decoded); } catch (e) { break; }
      }

      return decoded || url.href;
    } catch (e) {
      return '';
    }
  }

  function isGalleryPage(raw) {
    try {
      var url = new URL(String(raw || ''), global.location.href);
      if (!/^https?:$/.test(url.protocol)) return false;
      var host = url.hostname.toLowerCase();
      var path = url.pathname;
      if (/(^|\.)google\.[a-z.]+$/.test(host) && /\/imgres|\/search/.test(path)) return true;
      if (/(^|\.)bing\.[a-z.]+$/.test(host) && /\/images\/search/.test(path)) return true;
      if (/(^|\.)pinterest\.[a-z.]+$/.test(host) && /\/pin\//.test(path)) return true;
      if (/(^|\.)duckduckgo\.com$/.test(host) && /\/i\.js/.test(path)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* local link resolver (server.py)                                    */
  /* ------------------------------------------------------------------ */

  var RESOLVER_PORTS = [8000, 8001, 8002, 8003, 8004, 8005];
  var resolverBase = null;

  function fetchJson(url, timeoutMs) {
    if (!global.fetch) return Promise.reject(new Error('resolver-unavailable'));

    return new Promise(function (resolve, reject) {
      var controller = typeof global.AbortController !== 'undefined'
        ? new global.AbortController()
        : null;

      var timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('resolver-unavailable'));
      }, timeoutMs);

      var options = { cache: 'no-store', headers: { Accept: 'application/json' } };
      if (controller) options.signal = controller.signal;

      global.fetch(url, options)
        .then(function (response) {
          clearTimeout(timer);
          if (!response.ok) {
            reject(new Error('resolver-unavailable'));
            return;
          }
          response.json().then(resolve, function () {
            reject(new Error('resolver-unavailable'));
          });
        })
        .catch(function () {
          clearTimeout(timer);
          reject(new Error('resolver-unavailable'));
        });
    });
  }

  function pingResolver(base) {
    return fetchJson(base + '/ping', 900).then(function (data) {
      if (!data || data.service !== 'ember-resolver') throw new Error('resolver-unavailable');
    });
  }

  function resolverCandidates() {
    var bases = [];
    function add(base) {
      if (base && bases.indexOf(base) < 0) bases.push(base);
    }

    var configured = configuredBase();
    if (configured) add(configured + '/api');
    if (remoteBase) add(remoteBase + '/api');
    add('api');

    var host = global.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      RESOLVER_PORTS.forEach(function (port) {
        add('http://127.0.0.1:' + port + '/api');
      });
    }
    return bases;
  }

  function findResolver() {
    if (resolverBase) return Promise.resolve(resolverBase);

    var bases = resolverCandidates();

    var index = 0;
    function next() {
      if (index >= bases.length) return Promise.reject(new Error('resolver-unavailable'));
      var base = bases[index++];
      return pingResolver(base).then(function () {
        resolverBase = base;
        return base;
      }, next);
    }
    return next();
  }

  function resolveWithServer(rawUrl) {
    return findResolver()
      .then(function (base) {
        return fetchJson(base + '/resolve?url=' + encodeURIComponent(rawUrl), 30000);
      })
      .then(function (data) {
        if (!data || typeof data.ok !== 'boolean') throw new Error('resolver-unavailable');
        if (!data.ok) {
          var error = new Error(data.error || 'resolve-failed');
          error.resolver = true;
          throw error;
        }
        if (!data.image) throw new Error('resolve-failed');
        return data;
      });
  }

  function resolverAvailable() {
    return findResolver().then(function () { return true; }, function () { return false; });
  }

  function prepareLink(rawUrl) {
    var raw = String(rawUrl == null ? '' : rawUrl).trim();
    if (/^data:image\//i.test(raw)) return prepareLinkLocal(raw);

    return resolveWithServer(raw).then(function (data) {
      return compressImage(data.image).then(function (result) {
        return {
          image: { kind: 'data', value: result.dataUrl },
          color: result.color,
          width: result.width,
          height: result.height
        };
      });
    }, function (err) {
      if (err && err.resolver) throw err;
      return prepareLinkLocal(raw);
    });
  }

  function prepareLinkLocal(rawUrl) {
    var original = String(rawUrl == null ? '' : rawUrl).trim();
    var resolved = extractImageUrl(original);
    var url = safeSrc(resolved);

    if (!url) return Promise.reject(new Error('invalid-url'));
    if (resolved === original && isGalleryPage(original)) {
      return Promise.reject(new Error('page-link'));
    }

    if (/^data:/i.test(url)) {
      return compressImage(url).then(function (result) {
        return {
          image: { kind: 'data', value: result.dataUrl },
          color: result.color,
          width: result.width,
          height: result.height
        };
      });
    }

    // Try to pull the bytes in so the piece still shows offline. If the host
    // forbids CORS we keep the URL and let the browser render it directly.
    return compressImage(url)
      .then(function (result) {
        if (!result.color || !result.dataUrl) throw new Error('tainted');
        return {
          image: { kind: 'data', value: result.dataUrl },
          color: result.color,
          width: result.width,
          height: result.height
        };
      })
      .catch(function () {
        return loadImage(url).then(function () {
          return { image: { kind: 'url', value: url }, color: null, width: 0, height: 0 };
        });
      });
  }

  // Crop a rectangle (0–1 coordinates) out of an image and re-encode it.
  // Remote files are loaded with CORS so the canvas stays readable.
  function cropImage(src, rect) {
    if (!src) return Promise.reject(new Error('invalid-image'));

    var remote = /^https?:/i.test(String(src));
    var box = rect || { x: 0, y: 0, w: 1, h: 1 };

    return loadImage(src, remote ? 'anonymous' : undefined)
      .catch(function () { throw new Error('crop-unavailable'); })
      .then(function (img) {
        var nw = img.naturalWidth;
        var nh = img.naturalHeight;

        var x = Math.max(0, Math.min(nw - 1, Math.round(box.x * nw)));
        var y = Math.max(0, Math.min(nh - 1, Math.round(box.y * nh)));
        var w = Math.max(1, Math.min(nw - x, Math.round(box.w * nw)));
        var h = Math.max(1, Math.min(nh - y, Math.round(box.h * nh)));

        var scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
        var outW = Math.max(1, Math.round(w * scale));
        var outH = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y, w, h, 0, 0, outW, outH);

        var dataUrl;
        try {
          dataUrl = canvas.toDataURL('image/webp', IMAGE_QUALITY);
        } catch (e) {
          throw new Error('crop-unavailable');
        }
        if (dataUrl.indexOf('data:image/webp') !== 0) {
          try {
            dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
          } catch (e) {
            throw new Error('crop-unavailable');
          }
        }

        return {
          image: { kind: 'data', value: dataUrl },
          color: detectColorFromCanvas(canvas),
          width: outW,
          height: outH
        };
      });
  }

  /* ------------------------------------------------------------------ */
  /* combination scoring                                                */
  /* ------------------------------------------------------------------ */

  function harmony(a, b) {
    if (!a || !b) return 0.7;
    if (a === b) return 0.82;

    var aNeutral = NEUTRAL_COLORS.indexOf(a) > -1;
    var bNeutral = NEUTRAL_COLORS.indexOf(b) > -1;
    if (aNeutral && bNeutral) return 0.92;
    if (aNeutral || bNeutral) {
      var other = aNeutral ? b : a;
      return WARM_COLORS.indexOf(other) > -1 ? 0.89 : 0.85;
    }

    var aWarm = WARM_COLORS.indexOf(a) > -1;
    var bWarm = WARM_COLORS.indexOf(b) > -1;
    if (aWarm && bWarm) return 0.78;
    if (!aWarm && !bWarm) return 0.76;
    return 0.66; // warm × cool: deliberate, but the hardest to wear
  }

  function jitterFor(ids) {
    // sorted so the same two garments score identically whichever way round
    return ((hashInt(ids.slice().sort().join('|')) % 5) - 2) / 100;
  }

  function pairScore(top, bottom) {
    var score = harmony(top.color, bottom.color) + jitterFor([top.id, bottom.id]);
    return Math.min(0.98, Math.round(score * 100) / 100);
  }

  function lookScore(top, bottom, shoes) {
    var score;
    if (shoes) {
      score = harmony(top.color, bottom.color) * 0.62 + harmony(bottom.color, shoes.color) * 0.38;
    } else {
      score = harmony(top.color, bottom.color);
    }
    score += jitterFor(shoes ? [top.id, bottom.id, shoes.id] : [top.id, bottom.id]);
    return Math.min(0.98, Math.round(score * 100) / 100);
  }

  function scoreTone(score) {
    if (score >= 0.89) return 'good';
    if (score >= 0.81) return 'mid';
    return 'low';
  }

  function scoreLabel(score) {
    if (score >= 0.91) return 'Effortless — these belong together.';
    if (score >= 0.87) return 'Refined pairing with a calm base.';
    if (score >= 0.83) return 'Quiet contrast — a neutral keeps it grounded.';
    if (score >= 0.78) return 'Tonal and warm; keep accessories simple.';
    if (score >= 0.72) return 'Same-saturation pair — sharpen it with a neutral.';
    return 'Bold clash — wear it as a deliberate statement.';
  }

  /* ------------------------------------------------------------------ */

  global.Util = {
    esc: esc,
    safeSrc: safeSrc,
    formatDate: formatDate,
    hashInt: hashInt,
    randomId: randomId
  };

  global.Store = {
    COLORS: COLORS,
    COLOR_MAP: COLOR_MAP,
    CATEGORIES: CATEGORIES,
    CATEGORY_MAP: CATEGORY_MAP,
    colorLabel: colorLabel,
    colorHex: colorHex,
    categoryLabel: categoryLabel,
    storageAvailable: storageAvailable,
    cryptoReady: cryptoReady,
    init: init,
    isRemote: isRemote,
    signup: signup,
    login: login,
    getSession: getSession,
    requireSession: requireSession,
    requireAdmin: requireAdmin,
    logout: logout,
    ensureAdmin: ensureAdmin,
    listAccounts: listAccounts,
    fetchAccounts: fetchAccounts,
    fetchEvents: fetchEvents,
    fetchItems: fetchItems,
    deleteAdminItem: deleteAdminItem,
    getAccountDetails: getAccountDetails,
    setAccountDisabled: setAccountDisabled,
    deleteAccount: deleteAccount,
    setPassword: setPassword,
    changePassword: changePassword,
    clearWardrobes: clearWardrobes,
    exportAll: exportAll,
    importItems: importItems,
    logEvent: logEvent,
    listEvents: listEvents,
    listItems: listItems,
    createItem: createItem,
    updateItem: updateItem,
    deleteItem: deleteItem,
    storageUsage: storageUsage,
    imageOf: imageOf,
    prepareFile: prepareFile,
    prepareLink: prepareLink,
    resolverAvailable: resolverAvailable,
    extractImageUrl: extractImageUrl,
    cropImage: cropImage,
    pairScore: pairScore,
    lookScore: lookScore,
    scoreTone: scoreTone,
    scoreLabel: scoreLabel,
    harmony: harmony
  };
})(window);
