/* ==========================================================================
   Hanging Clozet - theme switcher
   Applies the saved palette before first paint and mounts a picker.
   ========================================================================== */

(function () {
  'use strict';

  var KEY = 'ember.wardrobe.theme.v3';
  var THEMES = [
    { key: 'amber', label: 'Amber Day', color: '#f6efe4', scheme: 'light' },
    { key: 'sunset', label: 'Clay Sunset', color: '#fbf0e4', scheme: 'light' },
    { key: 'olive', label: 'Olive Grove', color: '#f2f1e6', scheme: 'light' },
    { key: 'sandal', label: 'Sandalwood', color: '#f3ecdf', scheme: 'light' },
    { key: 'espresso', label: 'Espresso Brass', color: '#120f0b', scheme: 'dark' },
    { key: 'forest', label: 'Forest Sage', color: '#0d120f', scheme: 'dark' }
  ];

  var MAP = {};
  THEMES.forEach(function (theme) { MAP[theme.key] = theme; });

  function saved() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function current() {
    var key = saved();
    return MAP[key] ? key : 'amber';
  }

  function apply(key) {
    var theme = MAP[key] ? key : 'amber';
    var scheme = MAP[theme].scheme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = scheme;

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', MAP[theme].color);

    var schemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (schemeMeta) schemeMeta.setAttribute('content', scheme);
  }

  apply(current());

  function buildSelect() {
    var select = document.createElement('select');
    select.className = 'theme-select';
    select.id = 'themeSelect';
    select.setAttribute('aria-label', 'Colour theme');

    THEMES.forEach(function (theme) {
      var option = document.createElement('option');
      option.value = theme.key;
      option.textContent = theme.label;
      select.appendChild(option);
    });

    select.value = current();
    select.addEventListener('change', function () {
      try { window.localStorage.setItem(KEY, select.value); } catch (e) { /* ignore */ }
      apply(select.value);
    });

    return select;
  }

  function mount() {
    var picker = document.createElement('label');
    picker.className = 'theme-pick';

    var label = document.createElement('span');
    label.textContent = 'Theme';

    picker.appendChild(label);
    picker.appendChild(buildSelect());

    var navRight = document.querySelector('.nav-right');
    if (navRight) {
      navRight.insertBefore(picker, navRight.firstChild);
      return;
    }

    var dock = document.createElement('div');
    dock.className = 'theme-dock';
    dock.appendChild(picker);
    document.body.appendChild(dock);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
