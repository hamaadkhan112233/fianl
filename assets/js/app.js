/* ==========================================================================
   Hanging Clozet - splash, page transitions and pointer follower
   ========================================================================== */

(function () {
  'use strict';

  var html = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var startedAt = window.performance && performance.now ? performance.now() : Date.now();

  function elapsed() {
    return (window.performance && performance.now ? performance.now() : Date.now()) - startedAt;
  }

  function markReady() {
    html.classList.add('is-ready');
    html.classList.remove('is-leaving');
  }

  function scheduleReady() {
    var wait = reduced ? 0 : Math.max(0, 450 - elapsed());
    var ready = (window.Store && Store.init) ? Store.init() : Promise.resolve();
    ready.then(function () {
      setTimeout(markReady, wait);
    }, function () {
      setTimeout(markReady, wait);
    });
  }

  if (document.readyState === 'complete') scheduleReady();
  else window.addEventListener('load', scheduleReady);

  // If a script fails or the data layer never settles, reveal the app anyway.
  setTimeout(markReady, 12000);

  var leaving = false;

  document.addEventListener('click', function (event) {
    if (leaving || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!event.target || !event.target.closest) return;

    var link = event.target.closest('a[href]');
    if (!link) return;
    if ((link.target && link.target !== '_self') || link.hasAttribute('download') || link.hasAttribute('data-no-transition')) return;

    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;

    var url;
    try {
      url = new URL(link.href, location.href);
    } catch (e) {
      return;
    }

    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;

    event.preventDefault();
    leaving = true;
    html.classList.remove('is-ready');
    html.classList.add('is-leaving');

    setTimeout(function () {
      location.href = link.href;
    }, reduced ? 0 : 240);
  });

  window.addEventListener('pageshow', function () {
    leaving = false;
    html.classList.remove('is-leaving');
    if (document.readyState === 'complete') markReady();
  });

  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (reduced || coarse || navigator.maxTouchPoints > 0) return;

  var dot = document.createElement('div');
  dot.className = 'cursor-dot';
  dot.setAttribute('aria-hidden', 'true');

  var ring = document.createElement('div');
  ring.className = 'cursor-ring';
  ring.setAttribute('aria-hidden', 'true');

  document.body.appendChild(dot);
  document.body.appendChild(ring);

  var visible = false;

  function place(x, y) {
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    if (!visible) {
      visible = true;
      document.body.classList.add('has-cursor');
    }
  }

  document.addEventListener('pointermove', function (event) {
    if (event.pointerType === 'touch') return;
    place(event.clientX, event.clientY);
  }, { passive: true });

  document.addEventListener('pointerover', function (event) {
    if (!event.target || !event.target.closest) return;
    var target = event.target.closest(
      'a, button, input, select, textarea, label, .item-card, .combo-card, .swatch, .chip, .theme-pick'
    );
    ring.classList.toggle('is-active', !!target);
    dot.classList.toggle('is-active', !!target);
  }, { passive: true });

  document.addEventListener('pointerdown', function () { ring.classList.add('is-pressed'); });
  document.addEventListener('pointerup', function () { ring.classList.remove('is-pressed'); });

  document.addEventListener('pointerleave', function () {
    visible = false;
    document.body.classList.remove('has-cursor');
  });

  document.addEventListener('pointerenter', function () {
    visible = true;
    document.body.classList.add('has-cursor');
  });
})();
