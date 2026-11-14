/* ==========================================================================
   Hanging Clozet — combinations page
   ========================================================================== */

(function () {
  'use strict';

  Store.init().then(function () {

  var $ = UI.$;
  var account = Store.requireSession('index.html');
  if (!account) return;

  var PAGE_SIZE = 24;

  var state = {
    items: Store.listItems(account.id),
    mode: 'pair',
    sort: 'best',
    limit: PAGE_SIZE
  };

  var grid = $('#comboGrid');
  var emptyHost = $('#comboEmpty');
  var loadMoreBtn = $('#loadMoreBtn');
  var spotlightHost = $('#spotlightHost');

  UI.mountNav(account);

  function tops() {
    return state.items.filter(function (item) { return item.category === 'shirt'; });
  }
  function bottoms() {
    return state.items.filter(function (item) { return item.category === 'pants'; });
  }
  function shoes() {
    return state.items.filter(function (item) { return item.category === 'shoes'; });
  }

  /* ---------------------------------------------------------------- */
  /* build + rank                                                      */
  /* ---------------------------------------------------------------- */

  function buildCombos() {
    var shirts = tops();
    var trousers = bottoms();
    var pairs = [];

    if (!shirts.length || !trousers.length) return pairs;

    if (state.mode === 'look') {
      var footwear = shoes();
      for (var s = 0; s < shirts.length; s++) {
        for (var t = 0; t < trousers.length; t++) {
          if (!footwear.length) {
            pairs.push(makeCombo(shirts[s], trousers[t], null));
            continue;
          }
          for (var f = 0; f < footwear.length; f++) {
            pairs.push(makeCombo(shirts[s], trousers[t], footwear[f]));
          }
        }
      }
    } else {
      for (var a = 0; a < shirts.length; a++) {
        for (var b = 0; b < trousers.length; b++) {
          pairs.push(makeCombo(shirts[a], trousers[b], null));
        }
      }
    }

    var sort = state.sort;
    pairs.sort(function (x, y) {
      if (sort === 'newest') {
        var nx = Math.max(x.top.createdAt, x.bottom.createdAt, x.shoes ? x.shoes.createdAt : 0);
        var ny = Math.max(y.top.createdAt, y.bottom.createdAt, y.shoes ? y.shoes.createdAt : 0);
        if (ny !== nx) return ny - nx;
        return y.score - x.score;
      }
      if (sort === 'shared') {
        var sx = x.top.color === x.bottom.color ? 1 : 0;
        var sy = y.top.color === y.bottom.color ? 1 : 0;
        if (sy !== sx) return sy - sx;
        return y.score - x.score;
      }
      if (y.score !== x.score) return y.score - x.score;
      return x.key.localeCompare(y.key);
    });

    return pairs;
  }

  function makeCombo(top, bottom, shoe) {
    var score = shoe
      ? Store.lookScore(top, bottom, shoe)
      : Store.pairScore(top, bottom);
    return {
      key: [top.id, bottom.id, shoe ? shoe.id : 'x'].join('~'),
      top: top,
      bottom: bottom,
      shoes: shoe,
      score: score
    };
  }

  /* ---------------------------------------------------------------- */
  /* render                                                            */
  /* ---------------------------------------------------------------- */

  function figureHTML(item, caption) {
    var src = Store.imageOf(item);
    return '<figure>' +
      '<img src="' + Util.esc(src) + '" alt="' + Util.esc(item.name) + '" loading="lazy" data-fallback>' +
      '<figcaption>' + Util.esc(caption) + '</figcaption>' +
    '</figure>';
  }

  function cardHTML(combo) {
    var pct = Math.round(combo.score * 100);
    var tone = Store.scoreTone(combo.score);
    var pieces = [combo.top, combo.bottom].concat(combo.shoes ? [combo.shoes] : []);
    var title = combo.top.name + ' · ' + combo.bottom.name + (combo.shoes ? ' · ' + combo.shoes.name : '');
    var colors = Object.keys(pieces.reduce(function (acc, piece) {
      acc[piece.color] = true;
      return acc;
    }, {}));

    return '<article class="combo-card">' +
      '<div class="combo-strip">' +
        figureHTML(combo.top, 'Shirt') +
        figureHTML(combo.bottom, 'Trousers') +
        (combo.shoes ? figureHTML(combo.shoes, 'Shoes') : '') +
      '</div>' +
      '<div class="combo-body">' +
        '<h3 class="combo-title"><span title="' + Util.esc(title) + '">' + Util.esc(title) + '</span>' +
          '<span class="match ' + tone + '">' + pct + '%</span>' +
        '</h3>' +
        '<div class="combo-meta">' +
          colors.map(function (color) {
            return '<span class="dot" style="background:' + Store.colorHex(color) + '"></span>' +
              '<span>' + Util.esc(Store.colorLabel(color)) + '</span>';
          }).join('') +
        '</div>' +
        '<p class="combo-note">' + Util.esc(Store.scoreLabel(combo.score)) + '</p>' +
      '</div>' +
    '</article>';
  }

  function render() {
    var combos = buildCombos();
    var shirts = tops().length;
    var trousers = bottoms().length;

    if (!shirts || !trousers) {
      grid.innerHTML = '';
      emptyHost.hidden = false;
      emptyHost.innerHTML = emptyStateHTML(shirts, trousers);
      loadMoreBtn.hidden = true;
      $('#comboCount').textContent = '';
      $('#comboSub').textContent = 'We cross every shirt with every pair of trousers, then score the colour harmony.';
      return;
    }

    emptyHost.hidden = true;
    emptyHost.innerHTML = '';

    var slice = combos.slice(0, state.limit);
    grid.innerHTML = slice.map(cardHTML).join('');
    UI.hydrateImages(grid);

    var shoeCount = shoes().length;
    $('#comboSub').textContent = state.mode === 'look'
      ? shirts + ' shirts × ' + trousers + ' trousers × ' + Math.max(shoeCount, 1) + ' shoes, ranked by colour harmony.'
      : shirts + ' shirts × ' + trousers + ' trousers — ' + combos.length + ' pairings, ranked by colour harmony.';

    $('#comboCount').textContent = 'Showing ' + slice.length + ' of ' + combos.length;

    loadMoreBtn.hidden = slice.length >= combos.length;
    loadMoreBtn.textContent = 'Show ' + Math.min(PAGE_SIZE, combos.length - slice.length) + ' more';
  }

  function emptyStateHTML(shirtCount, trouserCount) {
    if (!shirtCount && !trouserCount) {
      return '<div class="empty">' +
        '<div class="empty-glyph" aria-hidden="true">◫</div>' +
        '<h3>Nothing to pair yet</h3>' +
        '<p>Add at least one shirt and one pair of trousers. Combinations build themselves from there.</p>' +
        '<a class="btn btn-primary" href="wardrobe.html">Add pieces</a>' +
      '</div>';
    }
    var missing = shirtCount ? 'trousers' : 'shirts';
    return '<div class="empty">' +
      '<div class="empty-glyph" aria-hidden="true">+</div>' +
      '<h3>One side of the outfit is missing</h3>' +
      '<p>You have ' + (shirtCount || trouserCount) + ' ' + (shirtCount ? 'shirt' : 'pair of trousers') +
        ' but no ' + missing + ' yet. Add ' + missing + ' to unlock the grid.</p>' +
      '<a class="btn btn-primary" href="wardrobe.html">Add ' + missing + '</a>' +
    '</div>';
  }

  /* ---------------------------------------------------------------- */
  /* controls                                                          */
  /* ---------------------------------------------------------------- */

  $('#modeTabs').addEventListener('click', function (event) {
    var tab = event.target.closest('[data-mode]');
    if (!tab || tab.dataset.mode === state.mode) return;
    state.mode = tab.dataset.mode;
    state.limit = PAGE_SIZE;
    UI.$$('#modeTabs [data-mode]').forEach(function (btn) {
      var active = btn.dataset.mode === state.mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    if (state.mode === 'look' && !shoes().length) {
      UI.toast('No shoes added yet — looks will rank shirt against trousers.', 'success');
    }
    render();
  });

  $('#comboSort').addEventListener('change', function (event) {
    state.sort = event.target.value;
    state.limit = PAGE_SIZE;
    render();
  });

  loadMoreBtn.addEventListener('click', function () {
    state.limit += PAGE_SIZE;
    render();
  });

  /* ---------------------------------------------------------------- */
  /* today's pick                                                      */
  /* ---------------------------------------------------------------- */

  function pickLook() {
    var combos = buildCombos();

    if (!combos.length) {
      UI.toast('Add at least one shirt and one pair of trousers first.', 'error');
      return;
    }

    var pool = combos.slice()
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, Math.min(12, combos.length));
    var chosen = pool[Math.floor(Math.random() * pool.length)];

    renderSpotlight(chosen);
    UI.toast('Today’s pick: ' + chosen.top.name + ' × ' + chosen.bottom.name + '.', 'success');
  }

  function renderSpotlight(combo) {
    var pct = Math.round(combo.score * 100);
    var tone = Store.scoreTone(combo.score);
    var title = combo.top.name + ' · ' + combo.bottom.name + (combo.shoes ? ' · ' + combo.shoes.name : '');

    spotlightHost.innerHTML = '<article class="spotlight">' +
      '<div class="spotlight-strip">' +
        figureHTML(combo.top, 'Shirt') +
        figureHTML(combo.bottom, 'Trousers') +
        (combo.shoes ? figureHTML(combo.shoes, 'Shoes') : '') +
      '</div>' +
      '<div class="spotlight-body">' +
        '<div>' +
          '<p class="spotlight-eyebrow">Today’s pick</p>' +
          '<h3>' + Util.esc(title) + '</h3>' +
          '<p class="combo-note">' + Util.esc(Store.scoreLabel(combo.score)) + '</p>' +
        '</div>' +
        '<div class="spotlight-actions">' +
          '<span class="match ' + tone + '">' + pct + '%</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-spotlight-clear>Dismiss</button>' +
        '</div>' +
      '</div>' +
    '</article>';

    UI.hydrateImages(spotlightHost);
  }

  $('#pickLookBtn').addEventListener('click', pickLook);
  spotlightHost.addEventListener('click', function (event) {
    if (event.target.closest('[data-spotlight-clear]')) spotlightHost.innerHTML = '';
  });

  window.addEventListener('storage', function (event) {
    if (!event.key || event.key.indexOf('ember.wardrobe.v1.items.' + account.id) !== 0) return;
    state.items = Store.listItems(account.id);
    render();
  });

  render();
  });
})();
