/* ==========================================================================
   Hanging Clozet — closet page
   ========================================================================== */

(function () {
  'use strict';

  var $ = UI.$, $$ = UI.$$;
  var account = Store.requireSession('index.html');
  if (!account) return;

  var STORAGE_BUDGET = 5 * 1024 * 1024;

  var state = {
    items: Store.listItems(account.id),
    filter: 'all',
    query: '',
    sort: 'newest',
    editingId: null,
    image: null,
    color: 'grey',
    working: false,
    crop: null,
    cropRect: { x: 0, y: 0, w: 1, h: 1 }
  };

  var grid = $('#grid');
  var emptyHost = $('#emptyHost');
  var dialog = $('#itemDialog');
  var form = $('#itemForm');
  var nameInput = $('#itemName');
  var categorySelect = $('#itemCategory');
  var swatchHost = $('#swatches');
  var swatchName = $('#swatchName');
  var preview = $('#preview');
  var previewImg = $('#previewImg');
  var detectedBadge = $('#detectedBadge');
  var itemError = $('#itemError');
  var saveBtn = $('#itemSave');
  var fileInput = $('#fileInput');
  var dropzone = $('#dropzone');
  var urlInput = $('#imageUrl');
  var paneUpload = $('#paneUpload');
  var paneLink = $('#paneLink');
  var importFile = $('#importFile');
  var cropDialog = $('#cropDialog');
  var cropStage = $('#cropStage');
  var cropImageEl = $('#cropImage');
  var cropBox = $('#cropBox');
  var cropSize = $('#cropSize');
  var cropError = $('#cropError');
  var cropUseBtn = $('#cropUse');

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  UI.mountNav(account);
  $('#greetName').textContent = account.name;
  $('#greeting').textContent = UI.greeting();

  buildCategories();
  buildSwatches();
  buildFilters();
  render();

  Store.resolverAvailable().then(function (ready) {
    var status = $('#resolverStatus');
    if (!status) return;
    status.textContent = ready
      ? 'Link resolver ready — Google and page links work.'
      : 'Direct image links and uploads work. Page links need the resolver.';
    status.classList.add(ready ? 'is-ready' : 'is-off');
  });

  /* ---------------------------------------------------------------- */
  /* static builders                                                   */
  /* ---------------------------------------------------------------- */

  function buildCategories() {
    categorySelect.innerHTML = Store.CATEGORIES.map(function (cat) {
      return '<option value="' + cat.key + '">' + Util.esc(cat.label) + '</option>';
    }).join('');
    categorySelect.value = 'shirt';
  }

  function buildSwatches() {
    swatchHost.innerHTML = Store.COLORS.map(function (color) {
      return '<button type="button" class="swatch" role="radio" aria-checked="false" ' +
        'data-color="' + color.key + '" data-label="' + Util.esc(color.label) + '" ' +
        'style="background:' + color.hex + '" title="' + Util.esc(color.label) + '" ' +
        'aria-label="' + Util.esc(color.label) + '"></button>';
    }).join('');

    swatchHost.addEventListener('click', function (event) {
      var btn = event.target.closest('.swatch');
      if (!btn) return;
      setColor(btn.dataset.color);
    });
  }

  function buildFilters() {
    var host = $('#filters');
    var chips = [{ key: 'all', label: 'All' }].concat(
      Store.CATEGORIES.map(function (cat) { return { key: cat.key, label: cat.plural }; })
    ).concat([{ key: 'fav', label: 'Favourites' }]);

    host.innerHTML = chips.map(function (chip) {
      return '<button type="button" class="chip" role="tab" data-filter="' + chip.key + '" ' +
        'aria-selected="false">' + Util.esc(chip.label) +
        '<span class="count" data-count="' + chip.key + '"></span></button>';
    }).join('');

    host.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      render();
    });
  }

  function setColor(key) {
    if (!Store.COLOR_MAP[key]) return;
    state.color = key;
    $$('.swatch', swatchHost).forEach(function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.color === key));
    });
    swatchName.textContent = Store.colorLabel(key);
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  function visibleItems() {
    var query = state.query.trim().toLowerCase();

    var list = state.items.filter(function (item) {
      if (state.filter === 'fav') {
        if (!item.favorite) return false;
      } else if (state.filter !== 'all' && item.category !== state.filter) {
        return false;
      }
      if (!query) return true;
      var haystack = [item.name, Store.colorLabel(item.color), Store.categoryLabel(item.category)]
        .join(' ').toLowerCase();
      return haystack.indexOf(query) > -1;
    });

    var sort = state.sort;
    list.sort(function (a, b) {
      if (sort === 'oldest') return a.createdAt - b.createdAt;
      if (sort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (sort === 'color') {
        var byColor = Store.colorLabel(a.color).localeCompare(Store.colorLabel(b.color));
        if (byColor !== 0) return byColor;
        return a.name.localeCompare(b.name);
      }
      return b.createdAt - a.createdAt;
    });

    return list;
  }

  function cardHTML(item) {
    var src = Store.imageOf(item);
    var catLabel = Store.categoryLabel(item.category);
    var fav = !!item.favorite;

    return '<article class="item-card" data-id="' + item.id + '">' +
      '<div class="item-media">' +
        '<img src="' + Util.esc(src) + '" alt="' + Util.esc(item.name) + '" loading="lazy" data-fallback>' +
        '<span class="item-kind">' + Util.esc(catLabel) + '</span>' +
        '<button type="button" class="icon-btn item-fav' + (fav ? ' is-active' : '') + '" data-act="fav" ' +
          'aria-pressed="' + fav + '" title="' + (fav ? 'Remove from favourites' : 'Mark as favourite') + '" ' +
          'aria-label="' + (fav ? 'Remove from favourites' : 'Mark as favourite') + '">' + (fav ? '♥' : '♡') + '</button>' +
      '</div>' +
      '<div class="item-body">' +
        '<h3 class="item-name" title="' + Util.esc(item.name) + '">' + Util.esc(item.name) + '</h3>' +
        '<div class="item-meta">' +
          '<span class="swatch-dot" style="background:' + Store.colorHex(item.color) + '"></span>' +
          '<span>' + Util.esc(Store.colorLabel(item.color)) + '</span>' +
          '<span class="sep">·</span>' +
          '<span>' + Util.esc(Util.formatDate(item.createdAt)) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="item-actions">' +
        '<button type="button" class="btn btn-ghost" data-act="edit">Edit</button>' +
        '<button type="button" class="btn btn-ghost" data-act="delete">Remove</button>' +
      '</div>' +
    '</article>';
  }

  function render() {
    var list = visibleItems();

    if (!state.items.length) {
      grid.innerHTML = '';
      emptyHost.innerHTML =
        '<div class="empty">' +
          '<div class="empty-glyph" aria-hidden="true">+</div>' +
          '<h3>Your closet is empty</h3>' +
          '<p>Add your first shirt, pair of trousers or suit. Upload a photo or paste an image link — every piece stays on this device.</p>' +
          '<button type="button" class="btn btn-primary" data-empty="add">Add your first piece</button>' +
        '</div>';
      emptyHost.hidden = false;
    } else if (!list.length) {
      grid.innerHTML = '';
      emptyHost.innerHTML =
        '<div class="empty">' +
          '<div class="empty-glyph" aria-hidden="true">⌕</div>' +
          '<h3>Nothing here matches</h3>' +
          '<p>No pieces match this filter' + (state.query ? ' and search “' + Util.esc(state.query) + '”' : '') + '.</p>' +
          '<button type="button" class="btn btn-ghost" data-empty="reset">Clear filters</button>' +
        '</div>';
      emptyHost.hidden = false;
    } else {
      emptyHost.hidden = true;
      emptyHost.innerHTML = '';
      grid.innerHTML = list.map(cardHTML).join('');
      UI.hydrateImages(grid);
    }

    updateStats();
    updateFilterCounts();
    updateHeadline();
    updateMeter();
  }

  function updateStats() {
    var tops = state.items.filter(function (i) { return i.category === 'shirt'; }).length;
    var bottoms = state.items.filter(function (i) { return i.category === 'pants'; }).length;

    $('#statTotal').textContent = state.items.length;
    $('#statTops').textContent = tops;
    $('#statBottoms').textContent = bottoms;
    $('#statCombos').textContent = tops * bottoms;
  }

  function updateFilterCounts() {
    var counts = { all: state.items.length, fav: 0 };
    Store.CATEGORIES.forEach(function (cat) { counts[cat.key] = 0; });
    state.items.forEach(function (item) {
      if (counts[item.category] != null) counts[item.category] += 1;
      if (item.favorite) counts.fav += 1;
    });

    $$('.chip', $('#filters')).forEach(function (chip) {
      var key = chip.dataset.filter;
      var slot = chip.querySelector('[data-count="' + key + '"]');
      if (slot) slot.textContent = counts[key] ? ' ' + counts[key] : '';
      chip.classList.toggle('is-active', key === state.filter);
      chip.setAttribute('aria-selected', String(key === state.filter));
    });
  }

  function updateHeadline() {
    var tops = state.items.filter(function (i) { return i.category === 'shirt'; }).length;
    var bottoms = state.items.filter(function (i) { return i.category === 'pants'; }).length;
    var suits = state.items.filter(function (i) { return i.category === 'suit'; }).length;
    var sub = $('#headSub');

    if (!state.items.length) {
      sub.textContent = 'Everything you own, in one place. Add a piece and it becomes available for combinations.';
      return;
    }
    var bits = [];
    bits.push(state.items.length + (state.items.length === 1 ? ' piece' : ' pieces'));
    if (tops) bits.push(tops + (tops === 1 ? ' shirt' : ' shirts'));
    if (bottoms) bits.push(bottoms + ' trousers');
    if (suits) bits.push(suits + (suits === 1 ? ' suit' : ' suits'));
    var looks = tops * bottoms;
    sub.textContent = bits.join(' · ') + (looks ? ' · ' + looks + ' possible looks waiting in Combinations.' : '');
  }

  function updateMeter() {
    var bytes = Store.storageUsage(account.id);
    var pct = Math.min(100, Math.round((bytes / STORAGE_BUDGET) * 100));
    $('#storageLabel').textContent = UI.bytesLabel(bytes);
    var fill = $('#storageFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('is-high', pct >= 75);
    fill.parentElement.parentElement.title =
      'About ' + pct + '% of a typical 5 MB local storage budget used by ' + state.items.length + ' pieces.';
  }

  /* ---------------------------------------------------------------- */
  /* grid interactions                                                 */
  /* ---------------------------------------------------------------- */

  grid.addEventListener('click', function (event) {
    var actionBtn = event.target.closest('[data-act]');
    if (!actionBtn) return;

    var card = actionBtn.closest('.item-card');
    if (!card) return;
    var item = state.items.find(function (entry) { return entry.id === card.dataset.id; });
    if (!item) return;

    var action = actionBtn.dataset.act;
    if (action === 'fav') toggleFavorite(item);
    if (action === 'edit') openEdit(item);
    if (action === 'delete') confirmDelete(item);
  });

  emptyHost.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-empty]');
    if (!btn) return;
    if (btn.dataset.empty === 'add') openAdd();
    if (btn.dataset.empty === 'reset') {
      state.filter = 'all';
      state.query = '';
      $('#searchInput').value = '';
      render();
    }
  });

  function toggleFavorite(item) {
    var next = !item.favorite;
    try {
      Store.updateItem(account.id, item.id, { favorite: next });
    } catch (err) {
      UI.toast('Could not save that change — storage is full.', 'error');
      return;
    }
    item.favorite = next;

    var card = grid.querySelector('.item-card[data-id="' + item.id + '"]');
    var btn = card && card.querySelector('[data-act="fav"]');
    if (btn) {
      btn.classList.toggle('is-active', next);
      btn.setAttribute('aria-pressed', String(next));
      btn.textContent = next ? '♥' : '♡';
      btn.title = next ? 'Remove from favourites' : 'Mark as favourite';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function confirmDelete(item) {
    UI.confirmAction({
      title: 'Remove “' + item.name + '”?',
      message: 'It disappears from your closet and from every combination it was part of.',
      confirmLabel: 'Delete piece'
    }).then(function (confirmed) {
      if (!confirmed) return;
      try {
        state.items = Store.deleteItem(account.id, item.id);
      } catch (err) {
        UI.toast('Could not delete that piece. Try again.', 'error');
        return;
      }
      Store.logEvent('item.delete', 'Removed “' + item.name + '”', account.username);
      render();
      UI.toast('Removed “' + item.name + '”.', 'success');
    });
  }

  /* ---------------------------------------------------------------- */
  /* filter / search / sort                                            */
  /* ---------------------------------------------------------------- */

  $('#searchInput').addEventListener('input', UI.debounce(function (event) {
    state.query = event.target.value;
    render();
  }, 140));

  $('#searchInput').addEventListener('search', function (event) {
    state.query = event.target.value;
    render();
  });

  $('#sortSelect').addEventListener('change', function (event) {
    state.sort = event.target.value;
    render();
  });

  /* ---------------------------------------------------------------- */
  /* backup / restore                                                  */
  /* ---------------------------------------------------------------- */

  $('#exportBtn').addEventListener('click', function () {
    var payload = {
      app: 'hanging-clozet',
      version: 1,
      exportedAt: new Date().toISOString(),
      username: account.username,
      items: state.items
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'hanging-clozet-' + account.username + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    Store.logEvent('closet.export', 'Exported ' + state.items.length + ' piece(s)', account.username);
    UI.toast('Closet backup downloaded.', 'success');
  });

  $('#importBtn').addEventListener('click', function () { importFile.click(); });

  importFile.addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    importFile.value = '';
    if (!file) return;

    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      UI.toast('Choose a .json closet backup.', 'error');
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var added;
      try {
        added = Store.importItems(account.id, JSON.parse(String(reader.result || '')));
      } catch (err) {
        if (err && err.message === 'storage-full') {
          UI.toast('Not enough local storage to restore that backup.', 'error');
        } else {
          UI.toast('That file does not contain wardrobe pieces.', 'error');
        }
        return;
      }

      state.items = Store.listItems(account.id);
      render();
      Store.logEvent('closet.import', 'Restored ' + added + ' piece(s)', account.username);
      UI.toast('Restored ' + added + ' piece' + (added === 1 ? '' : 's') + '.', 'success');
    };
    reader.onerror = function () { UI.toast('Could not read that file.', 'error'); };
    reader.readAsText(file);
  });

  /* ---------------------------------------------------------------- */
  /* add / edit dialog                                                 */
  /* ---------------------------------------------------------------- */

  $('#addItemBtn').addEventListener('click', openAdd);
  $('#itemDialogClose').addEventListener('click', function () { dialog.close(); });
  $('#itemCancel').addEventListener('click', function () { dialog.close(); });
  UI.wireDialog(dialog);

  function resetDialog() {
    if (cropDialog.open) closeCropper();
    state.crop = null;
    state.cropRect = { x: 0, y: 0, w: 1, h: 1 };
    form.reset();
    categorySelect.value = 'shirt';
    state.image = null;
    state.editingId = null;
    state.working = false;
    preview.hidden = true;
    previewImg.removeAttribute('src');
    detectedBadge.hidden = true;
    itemError.hidden = true;
    itemError.textContent = '';
    urlInput.value = '';
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save piece';
    $('#itemDialogTitle').textContent = 'New piece';
    $('#itemDialogEyebrow').textContent = 'Add to wardrobe';
    setSource('upload');
    setColor('grey');
    setDropzoneLabel('Drop a photo here, or click to browse');
  }

  function openAdd() {
    resetDialog();
    UI.openDialog(dialog);
    setTimeout(function () { nameInput.focus(); }, 60);
  }

  function openEdit(item) {
    resetDialog();
    state.editingId = item.id;
    state.image = item.image;
    nameInput.value = item.name;
    categorySelect.value = item.category;
    setColor(item.color);

    preview.hidden = false;
    previewImg.src = Store.imageOf(item);
    detectedBadge.hidden = true;

    $('#itemDialogTitle').textContent = 'Edit piece';
    $('#itemDialogEyebrow').textContent = 'Update details';
    saveBtn.textContent = 'Save changes';

    UI.openDialog(dialog);
    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 60);
  }

  function setSource(source) {
    $$('.source-tab').forEach(function (tab) {
      var active = tab.dataset.source === source;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    paneUpload.hidden = source !== 'upload';
    paneLink.hidden = source !== 'link';
  }

  $('#sourceTabs').addEventListener('click', function (event) {
    var tab = event.target.closest('.source-tab');
    if (tab) setSource(tab.dataset.source);
  });

  /* ---- image intake ---- */

  function setDropzoneLabel(text) {
    var title = dropzone.querySelector('.dz-title');
    if (title) title.textContent = text;
  }

  function setWorking(working, label) {
    state.working = working;
    saveBtn.disabled = working;
    setDropzoneLabel(working ? (label || 'Working…') : 'Drop a photo here, or click to browse');
  }

  function showItemError(message) {
    itemError.textContent = message;
    itemError.hidden = false;
  }

  function applyImage(result) {
    state.image = result.image;

    if (result.color && Store.COLOR_MAP[result.color]) {
      setColor(result.color);
      detectedBadge.hidden = false;
      detectedBadge.textContent = 'Detected: ' + Store.colorLabel(result.color);
    } else {
      setColor(state.color || 'grey');
      detectedBadge.hidden = true;
      detectedBadge.textContent = '';
    }

    preview.hidden = false;
    previewImg.src = state.image.value;
    itemError.hidden = true;

    if (!nameInput.value.trim()) {
      nameInput.placeholder = Store.colorLabel(state.color) + ' ' + Store.categoryLabel(categorySelect.value).toLowerCase();
    }
    if (state.image.kind === 'url') {
      UI.toast('Linked — this host blocks copying, so the photo loads from its server.', 'success');
    }
  }

  /* ---- choose which piece to keep ---- */

  var PRESETS = {
    full: { x: 0, y: 0, w: 1, h: 1 },
    top: { x: 0, y: 0, w: 1, h: 0.5 },
    middle: { x: 0, y: 0.25, w: 1, h: 0.5 },
    bottom: { x: 0, y: 0.5, w: 1, h: 0.5 },
    left: { x: 0, y: 0, w: 0.5, h: 1 },
    right: { x: 0.5, y: 0, w: 0.5, h: 1 }
  };

  function openCropper(result) {
    if (!result || !result.image || !result.image.value) {
      showItemError('Could not read that image.');
      return;
    }

    state.crop = result;
    cropError.hidden = true;
    cropUseBtn.disabled = false;
    cropUseBtn.textContent = 'Keep this piece';
    cropImageEl.src = result.image.value;
    setPreset('full');
    UI.openDialog(cropDialog);

    setTimeout(function () { try { cropDialog.scrollTop = 0; } catch (e) { /* ignore */ } }, 30);
  }

  function closeCropper() {
    if (cropDialog.open) cropDialog.close();
    state.crop = null;
    state.cropRect = Object.assign({}, PRESETS.full);
    cropImageEl.removeAttribute('src');
    cropError.hidden = true;
    cropUseBtn.disabled = false;
    cropUseBtn.textContent = 'Keep this piece';
  }

  function setPreset(name) {
    var box = PRESETS[name] || PRESETS.full;
    state.cropRect = { x: box.x, y: box.y, w: box.w, h: box.h };
    $$('#cropPresets .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', chip.dataset.preset === name);
    });
    updateCropBox();
  }

  function clearPresetActive() {
    $$('#cropPresets .chip').forEach(function (chip) { chip.classList.remove('is-active'); });
  }

  function updateCropBox() {
    var r = state.cropRect;
    cropBox.style.left = (r.x * 100) + '%';
    cropBox.style.top = (r.y * 100) + '%';
    cropBox.style.width = (r.w * 100) + '%';
    cropBox.style.height = (r.h * 100) + '%';

    var full = r.x === 0 && r.y === 0 && r.w >= 1 && r.h >= 1;
    cropSize.textContent = full
      ? 'Whole image'
      : Math.round(r.w * 100) + '% × ' + Math.round(r.h * 100) + '% of the image';
  }

  var cropDrag = null;

  function stagePoint(event) {
    var rect = cropImageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  }

  cropStage.addEventListener('pointerdown', function (event) {
    if (!state.crop) return;
    var point = stagePoint(event);
    if (!point) return;

    cropDrag = point;
    state.cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
    clearPresetActive();
    updateCropBox();
    try { cropStage.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    event.preventDefault();
  });

  cropStage.addEventListener('pointermove', function (event) {
    if (!cropDrag) return;
    var point = stagePoint(event);
    if (!point) return;

    var x = Math.min(cropDrag.x, point.x);
    var y = Math.min(cropDrag.y, point.y);
    var w = Math.abs(point.x - cropDrag.x);
    var h = Math.abs(point.y - cropDrag.y);

    state.cropRect = {
      x: Math.max(0, Math.min(1 - w, x)),
      y: Math.max(0, Math.min(1 - h, y)),
      w: w,
      h: h
    };
    updateCropBox();
    event.preventDefault();
  });

  function endCropDrag(event) {
    if (!cropDrag) return;
    cropDrag = null;
    try { cropStage.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    if (state.cropRect.w < 0.04 && state.cropRect.h < 0.04) setPreset('full');
  }

  cropStage.addEventListener('pointerup', endCropDrag);
  cropStage.addEventListener('pointercancel', endCropDrag);

  $('#cropPresets').addEventListener('click', function (event) {
    var chip = event.target.closest('[data-preset]');
    if (chip) setPreset(chip.dataset.preset);
  });

  $('#cropClose').addEventListener('click', closeCropper);
  $('#cropCancel').addEventListener('click', closeCropper);
  UI.wireDialog(cropDialog);

  cropUseBtn.addEventListener('click', function () {
    var result = state.crop;
    if (!result) return;

    var r = state.cropRect;
    var full = r.x === 0 && r.y === 0 && r.w >= 1 && r.h >= 1;
    cropError.hidden = true;

    if (full) {
      closeCropper();
      applyImage(result);
      return;
    }

    cropUseBtn.disabled = true;
    cropUseBtn.textContent = 'Cutting…';

    Store.cropImage(result.image.value, r)
      .then(function (cropped) {
        closeCropper();
        applyImage(cropped);
        UI.toast('Piece kept — colour detected from the area you chose.', 'success');
      })
      .catch(function (err) {
        cropUseBtn.disabled = false;
        cropUseBtn.textContent = 'Keep this piece';
        cropError.textContent = err && err.message === 'crop-unavailable'
          ? 'This host blocks image cropping. Choose “Whole image”, or paste a direct image link.'
          : 'Could not prepare that area. Try a different selection.';
        cropError.hidden = false;
      });
  });

  function fileSelected(file) {
    if (!file || state.working) return;
    if (!/^image\//.test(file.type)) {
      showItemError('That file isn’t an image. Choose a JPG, PNG or WebP.');
      return;
    }

    setWorking(true, 'Optimising photo…');
    Store.prepareFile(file)
      .then(openCropper)
      .catch(function (err) {
        setWorking(false);
        var code = err && err.message;
        showItemError(code === 'file-too-large'
          ? 'That photo is over 25 MB. Try a smaller one.'
          : 'Could not read that photo. Try a different file.');
      })
      .then(function () { setWorking(false); });
  }

  fileInput.addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    fileSelected(file);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    dropzone.addEventListener(type, function (event) {
      event.preventDefault();
      dropzone.classList.add('is-drag');
    });
  });

  ['dragleave', 'dragend'].forEach(function (type) {
    dropzone.addEventListener(type, function () { dropzone.classList.remove('is-drag'); });
  });

  dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    dropzone.classList.remove('is-drag');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    fileSelected(file);
  });

  // Paste a screenshot or copied image straight into the dialog.
  dialog.addEventListener('paste', function (event) {
    if (state.working) return;
    var items = event.clipboardData && event.clipboardData.items;
    if (!items) return;

    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file' || items[i].type.indexOf('image/') !== 0) continue;
      var file = items[i].getAsFile();
      if (!file) continue;
      event.preventDefault();
      setSource('upload');
      fileSelected(file);
      return;
    }
  });

  // Dropping anywhere on the dialog also works, and stops the browser opening the file.
  roomForDrop();

  function roomForDrop() {
    dialog.addEventListener('dragover', function (event) { event.preventDefault(); });
    dialog.addEventListener('drop', function (event) {
      if (paneUpload.hidden) return;
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) fileSelected(file);
    });
  }

  function loadLink() {
    if (state.working) return;
    var raw = urlInput.value.trim();

    if (!raw) {
      showItemError('Paste an image URL first.');
      return;
    }
    if (!Util.safeSrc(raw) && !/^data:image\//i.test(raw)) {
      showItemError('That link isn’t a valid http(s) image URL.');
      return;
    }
    if (/(^https?:\/\/(?:[^/]+\.)?google\.[^/]+)\/(?:search|imgres)/i.test(raw) &&
        !/[?&](?:imgurl|mediaurl)=/i.test(raw)) {
      showItemError('That’s a Google Images results page, not a photo. Open a photo, then right-click and copy its image address.');
      return;
    }
    if (/(^https?:\/\/(?:[^/]+\.)?bing\.[^/]+)\/images\/search/i.test(raw) &&
        !/[?&]mediaurl=/i.test(raw)) {
      showItemError('That’s a Bing Images results page, not a photo. Open a photo, then right-click and copy its image address.');
      return;
    }

    setWorking(true, 'Fetching image…');
    Store.prepareLink(raw)
      .then(openCropper)
      .catch(function (err) {
        var code = err && err.message;
        if (code === 'invalid-url') {
          showItemError('That link isn’t a valid http(s) image URL.');
        } else if (code === 'page-link' || code === 'no-image') {
          showItemError('That page doesn’t expose a main photo. Open the image itself, copy its address, and paste that.');
        } else if (code === 'too-large') {
          showItemError('That image is larger than 12 MB. Try a smaller one.');
        } else if (code === 'blocked-host') {
          showItemError('That host can’t be reached from here. Try a public image address.');
        } else if (code === 'fetch-failed') {
          showItemError('The site refused to serve that image. Try uploading the file instead.');
        } else if (code === 'resolver-unavailable') {
          showItemError('Could not resolve that page here. Paste a direct image address or upload the photo.');
        } else {
          showItemError('Could not load that photo. The site may block hotlinking — try uploading the file instead.');
        }
      })
      .then(function () { setWorking(false); });
  }

  $('#useLinkBtn').addEventListener('click', loadLink);
  urlInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadLink();
    }
  });

  $('#clearImageBtn').addEventListener('click', function () {
    state.image = null;
    preview.hidden = true;
    previewImg.removeAttribute('src');
    detectedBadge.hidden = true;
    urlInput.value = '';
    setSource('upload');
  });

  /* ---- save ---- */

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    itemError.hidden = true;

    if (state.working) return;
    if (!state.image) {
      showItemError('Add a photo first — upload a file or paste an image link.');
      return;
    }

    var category = categorySelect.value;
    var typedName = nameInput.value.trim();
    var name = typedName || (Store.colorLabel(state.color) + ' ' + Store.categoryLabel(category));
    var color = Store.COLOR_MAP[state.color] ? state.color : 'grey';

    try {
      if (state.editingId) {
        var updated = Store.updateItem(account.id, state.editingId, {
          name: name,
          category: category,
          color: color
        });
        state.items = state.items.map(function (item) {
          return item.id === state.editingId ? updated : item;
        });
      } else {
        var created = Store.createItem(account.id, {
          name: name,
          category: category,
          color: color,
          image: state.image
        });
        state.items.unshift(created);
      }
    } catch (err) {
      if (err && err.message === 'storage-full') {
        showItemError('Local storage is full. Remove a few pieces, or use image links instead of uploads.');
      } else {
        showItemError('Could not save this piece. Please try again.');
      }
      return;
    }

    dialog.close();
    render();
    Store.logEvent(
      state.editingId ? 'item.update' : 'item.add',
      (state.editingId ? 'Updated “' : 'Added “') + name + '”',
      account.username
    );
    UI.toast(state.editingId ? 'Piece updated.' : '“' + name + '” added to your closet.', 'success');
  });

  /* ---------------------------------------------------------------- */
  /* housekeeping                                                      */
  /* ---------------------------------------------------------------- */

  // Keep multiple tabs in sync.
  window.addEventListener('storage', function (event) {
    if (!event.key || event.key.indexOf('ember.wardrobe.v1.items.' + account.id) !== 0) return;
    state.items = Store.listItems(account.id);
    render();
  });

  // Refresh relative dates if the tab sat open overnight.
  window.addEventListener('focus', function () { updateHeadline(); });
})();
