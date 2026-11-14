/* ==========================================================================
   Hanging Clozet — shared UI helpers
   ========================================================================== */

(function (global) {
  'use strict';

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  var toastHost = null;
  function getToastHost() {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      toastHost.id = 'toastHost';
      document.body.appendChild(toastHost);
    }
    return toastHost;
  }

  function toast(message, kind) {
    var host = getToastHost();
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    setTimeout(function () {
      el.classList.remove('in');
      setTimeout(function () { el.remove(); }, 260);
    }, 3600);
  }

  /* ---- confirm dialog ------------------------------------------------ */

  var confirmResolver = null;
  var confirmBound = false;

  function bindConfirm() {
    if (confirmBound) return;
    var dlg = $('#confirmDialog');
    if (!dlg) return;
    confirmBound = true;

    var okBtn = $('#confirmOk', dlg);
    var cancelBtn = $('#confirmCancel', dlg);

    function settle(value) {
      dlg.close();
      var resolver = confirmResolver;
      confirmResolver = null;
      if (resolver) resolver(value);
    }

    okBtn.addEventListener('click', function () { settle(true); });
    cancelBtn.addEventListener('click', function () { settle(false); });

    dlg.addEventListener('cancel', function (event) {
      event.preventDefault();
      settle(false);
    });
    dlg.addEventListener('click', function (event) {
      if (event.target === dlg) settle(false);
    });
  }

  function confirmAction(options) {
    var opts = options || {};
    var dlg = $('#confirmDialog');
    if (!dlg) return Promise.resolve(global.confirm(opts.message || 'Are you sure?'));

    bindConfirm();
    $('#confirmTitle', dlg).textContent = opts.title || 'Are you sure?';
    $('#confirmMessage', dlg).textContent = opts.message || '';
    $('#confirmOk', dlg).textContent = opts.confirmLabel || 'Delete';
    $('#confirmOk', dlg).className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');

    if (dlg.open) dlg.close();
    dlg.showModal();
    $('#confirmCancel', dlg).focus();

    return new Promise(function (resolve) { confirmResolver = resolve; });
  }

  /* ---- generic dialogs ----------------------------------------------- */

  function wireDialog(dlg) {
    if (!dlg || dlg.dataset.wired === '1') return;
    dlg.dataset.wired = '1';
    dlg.addEventListener('click', function (event) {
      if (event.target === dlg) dlg.close();
    });
  }

  function openDialog(dlg) {
    if (!dlg) return;
    wireDialog(dlg);
    if (!dlg.open) dlg.showModal();
  }

  function closeDialog(dlg) {
    if (dlg && dlg.open) dlg.close();
  }

  /* ---- nav ----------------------------------------------------------- */

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function mountNav(account) {
    if (!account) return;

    var chip = $('#userChip');
    if (chip) {
      chip.innerHTML = '<span class="avatar">' + Util.esc(initials(account.name)) + '</span>' +
        '<b>' + Util.esc(account.name) + '</b>';
      chip.hidden = false;
    }

    var logoutBtn = $('#logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        Store.logEvent('auth.logout', 'Signed out', account.username);
        Store.logout();
        global.location.replace('index.html');
      });
    }

    var navLinks = $('.nav-links');
    if (navLinks && account.role === 'admin' && !navLinks.querySelector('a[href="admin.html"]')) {
      var adminLink = document.createElement('a');
      adminLink.href = 'admin.html';
      adminLink.textContent = 'Admin';
      navLinks.appendChild(adminLink);
    }

    var path = global.location.pathname.split('/').pop() || 'index.html';
    $$('.nav-links a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (href === path) link.classList.add('active');
    });
  }

  function greeting() {
    var hour = new Date().getHours();
    if (hour < 5) return 'Still up';
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    if (hour < 22) return 'Good evening';
    return 'Good evening';
  }

  function bytesLabel(bytes) {
    if (!bytes || bytes < 1024) return '0 KB';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  // Attach graceful fallbacks for images that fail to load (dead links).
  function hydrateImages(root) {
    $$('img[data-fallback]', root).forEach(function (img) {
      img.addEventListener('error', function () {
        var holder = img.closest('.item-media, figure, .combo-strip');
        img.remove();
        if (holder && !holder.querySelector('.img-missing')) {
          var note = document.createElement('div');
          note.className = 'img-missing';
          note.textContent = 'Image unavailable';
          holder.appendChild(note);
        }
      });
      if (img.complete && img.naturalWidth === 0) img.dispatchEvent(new Event('error'));
    });
  }

  global.UI = {
    $: $,
    $$: $$,
    toast: toast,
    confirmAction: confirmAction,
    openDialog: openDialog,
    closeDialog: closeDialog,
    wireDialog: wireDialog,
    mountNav: mountNav,
    initials: initials,
    greeting: greeting,
    bytesLabel: bytesLabel,
    debounce: debounce,
    hydrateImages: hydrateImages
  };
})(window);
