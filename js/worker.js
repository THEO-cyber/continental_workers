/* Continental — workers app: record sales, live stock */
(function () {
  'use strict';

  var TOKEN_KEY = 'continental_worker_token';
  var token = localStorage.getItem(TOKEN_KEY);
  // Set in index.html — points at the backend when this app is hosted
  // separately; empty string falls back to same-origin (local/monorepo dev).
  var API_BASE = (typeof window !== 'undefined' && window.API_BASE) || '';
  var user = null;
  var socket = null;
  var products = [];
  var refreshTimer = null;
  var LOW_STOCK = 5;
  var filters = { cat: '', stock: '', sort: 'name', branch: '' };
  var branches = [];
  var myBranchId = null;

  // Populated from the API — superadmin can add categories, so this is
  // never a fixed list. CATEGORIES[key] -> display name.
  var CATEGORIES = {};
  function loadCategories() {
    return api('/api/admin/categories').then(function (res) {
      CATEGORIES = {};
      res.categories.forEach(function (c) { CATEGORIES[c.key] = c.name_en; });
    }).catch(function () {});
  }

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return Number(n || 0).toLocaleString('fr-FR') + ' FCFA'; }
  function partNumbersText(p) {
    return (p.part_numbers || []).map(function (pn) { return pn.part_number; }).join(', ');
  }
  function priceRangeText(p) {
    if (p.price_min == null) return '';
    return p.price_min === p.price_max ? money(p.price_min) : money(p.price_min) + ' – ' + money(p.price_max);
  }
  function timeOf(createdAt) {
    try {
      return new Date(String(createdAt).replace(' ', 'T') + 'Z')
        .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  var toastEl = $('#toast'), toastTimer;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 3000);
  }

  // Swaps a button's contents for a spinner + label while an async action is
  // in flight, then restores it — so tapping a button doesn't look like
  // nothing happened.
  function withSpinner(btn, label, task) {
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span>' + label;
    return task().finally(function () {
      btn.disabled = false;
      btn.innerHTML = original;
    });
  }

  // Downscales + re-compresses a photo in the browser before it ever hits
  // the network — a full-res phone photo (often 3-8MB) is far more data
  // than a product-catalog image needs, and every byte crosses two hops
  // (browser -> backend -> Cloudinary). PNG stays PNG (lossless — only
  // dimension downscaling helps there); everything else becomes JPEG.
  function compressImage(file, maxDim, quality) {
    if (!/^image\//.test(file.type)) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale) || 1;
        var h = Math.round(img.height * scale) || 1;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob(
          function (blob) { resolve(blob || file); },
          outType,
          outType === 'image/jpeg' ? quality : undefined,
        );
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.form ? {} : { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.form ? opts.form : (opts.body ? JSON.stringify(opts.body) : undefined),
    }).then(function (res) {
      // A 401 from the login endpoint itself just means wrong credentials —
      // only treat 401 elsewhere as an expired session and force re-login.
      if (res.status === 401 && path !== '/api/auth/login') { logout(); throw new Error('Session expired sign in again'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  var modalRoot = $('#modal-root');
  function openModal(html, extraClass) {
    modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal' + (extraClass ? ' ' + extraClass : '') + '">' + html + '</div></div>';
    var backdrop = modalRoot.firstChild;
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) closeModal(); });
    return backdrop.firstChild;
  }
  function closeModal() { modalRoot.innerHTML = ''; }

  // ---------- auth ----------
  function showLogin() {
    $('#login-screen').hidden = false;
    $('#app').hidden = true;
  }
  function logout() {
    token = null;
    user = null;
    localStorage.removeItem(TOKEN_KEY);
    if (socket) { socket.disconnect(); socket = null; }
    showLogin();
  }

  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var errEl = $('#login-error');
    errEl.hidden = true;
    withSpinner(f.querySelector('button[type="submit"]'), 'Signing in…', function () {
      return api('/api/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    })
      .then(function (data) {
        token = data.token;
        user = data.user;
        localStorage.setItem(TOKEN_KEY, token);
        f.reset();
        enterApp();
      })
      .catch(function (err) { errEl.textContent = err.message; errEl.hidden = false; });
  });

  $('#logout-btn').addEventListener('click', logout);

  function enterApp() {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    $('#worker-name').textContent = user ? user.name : '';
    if (socket) socket.disconnect();
    socket = API_BASE
      ? io(API_BASE, { auth: { token: token } })
      : io({ auth: { token: token } });
    socket.on('catalog:changed', function () {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        loadProducts();
        loadBranches();
        loadCategories();
      }, 350);
    });
    loadBranches();
    loadCategories().then(loadProducts);
    loadToday();
  }

  // ---------- branches ----------
  function loadBranches() {
    api('/api/admin/branches').then(function (res) {
      branches = res.branches;
      renderBranchSelect();
    }).catch(function () {});
  }

  function renderBranchSelect() {
    var sel = $('#branch-select');
    if (!sel || branches.length < 2) {
      var row = document.querySelector('.branch-row');
      if (row) row.hidden = branches.length < 2;
      return;
    }
    sel.innerHTML =
      '<option value="">My branch</option>' +
      branches.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + '</option>'; }).join('') +
      '<option value="all">All branches</option>';
    sel.value = filters.branch;
  }

  // ---------- products ----------
  function loadProducts() {
    var qs = filters.branch ? '?branchId=' + encodeURIComponent(filters.branch) : '';
    api('/api/staff/products' + qs).then(function (res) {
      products = res.products;
      if (!myBranchId && filters.branch === '' && products.length) myBranchId = products[0].branch_id;
      renderStats();
      renderChips();
      renderList();
    }).catch(function (err) { toast(err.message, true); });
  }

  function renderStats() {
    var inStock = 0, low = 0, out = 0;
    products.forEach(function (p) {
      if (p.quantity === 0) out++;
      else if (p.quantity <= LOW_STOCK) low++;
      else inStock++;
    });
    var statsDef = [
      ['', products.length, 'Products'],
      ['in', inStock, 'In stock'],
      ['low', low, 'Low stock'],
      ['out', out, 'Out'],
    ];
    $('#inv-stats').innerHTML = statsDef.map(function (s) {
      var active = filters.stock === s[0] && s[0] !== '' ? ' active' : '';
      return '<button class="inv-stat s-' + (s[0] || 'all') + active + '" data-stock="' + s[0] + '">' +
        '<strong>' + s[1] + '</strong><span>' + s[2] + '</span></button>';
    }).join('');
  }

  function renderChips() {
    var counts = {};
    products.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; });
    var cats = Object.keys(counts).sort();
    if (filters.cat && !counts[filters.cat]) filters.cat = '';
    var html = '<button class="chip' + (!filters.cat ? ' active' : '') + '" data-cat="">All (' + products.length + ')</button>';
    cats.forEach(function (c) {
      html += '<button class="chip' + (filters.cat === c ? ' active' : '') + '" data-cat="' + esc(c) + '">' +
        esc(CATEGORIES[c] || c) + ' (' + counts[c] + ')</button>';
    });
    $('#cat-chips').innerHTML = html;
  }

  function renderList() {
    var q = ($('#search').value || '').trim().toLowerCase();
    var list = products.filter(function (p) {
      if (filters.cat && p.category !== filters.cat) return false;
      if (filters.stock === 'in' && p.quantity <= LOW_STOCK) return false;
      if (filters.stock === 'low' && (p.quantity === 0 || p.quantity > LOW_STOCK)) return false;
      if (filters.stock === 'out' && p.quantity !== 0) return false;
      if (!q) return true;
      return (p.name_en + ' ' + (p.name_fr || '') + ' ' + (p.brand || '') + ' ' + partNumbersText(p)).toLowerCase().indexOf(q) !== -1;
    });
    var sorters = {
      'name': function (a, b) { return a.name_en.localeCompare(b.name_en); },
      'price-low': function (a, b) { return a.price_min - b.price_min; },
      'price-high': function (a, b) { return b.price_max - a.price_max; },
      'stock-low': function (a, b) { return a.quantity - b.quantity; },
      'stock-high': function (a, b) { return b.quantity - a.quantity; },
    };
    list.sort(sorters[filters.sort] || sorters.name);

    var showBranch = filters.branch !== '' && branches.length > 1;
    $('#product-list').innerHTML = list.length ? list.map(function (p) {
      var stockCls = p.quantity === 0 ? 'zero' : (p.quantity <= LOW_STOCK ? 'low' : 'ok');
      var stockTxt = p.quantity === 0 ? 'Out of stock' : p.quantity + ' left';
      var otherBranch = showBranch && p.branch_id !== myBranchId;
      return '<div class="p-item' + (p.quantity === 0 ? ' p-out' : '') + '" data-id="' + p.id + '">' +
        '<img class="p-thumb" src="' + esc(p.image || '/assets/img/part-placeholder.svg') + '" alt="" loading="lazy">' +
        '<div class="p-info">' +
        '<div class="p-name">' + esc(p.name_en) + '</div>' +
        '<div class="p-sub">' + esc(CATEGORIES[p.category] || p.category) +
        (p.brand ? ' · ' + esc(p.brand) : '') + (partNumbersText(p) ? ' · ' + esc(partNumbersText(p)) : '') + '</div>' +
        '<div class="p-price">' + priceRangeText(p) + '</div>' +
        (showBranch ? '<div class="branch-badge">' + esc(p.branch_name) + '</div>' : '') +
        '</div>' +
        '<div class="p-right">' +
        '<span class="p-stock ' + stockCls + '">' + esc(stockTxt) + '</span>' +
        (otherBranch
          ? '<span class="cell-muted" style="font-size:.7rem;text-align:right">View only <br>visit that branch to sell</span>'
          : '<button class="btn btn-xs sell-btn"' + (p.quantity === 0 ? ' disabled' : '') + '>Sell</button>') +
        '</div></div>';
    }).join('') : '<p class="list-empty">No products match these filters.</p>';
  }

  $('#search').addEventListener('input', renderList);
  $('#inv-stats').addEventListener('click', function (e) {
    var btn = e.target.closest('.inv-stat');
    if (!btn) return;
    var val = btn.getAttribute('data-stock');
    filters.stock = (filters.stock === val) ? '' : val;
    $('#stock-filter').value = filters.stock;
    renderStats();
    renderList();
  });
  $('#cat-chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    filters.cat = chip.getAttribute('data-cat') || '';
    renderChips();
    renderList();
  });
  $('#stock-filter').addEventListener('change', function (e) {
    filters.stock = e.target.value;
    renderStats();
    renderList();
  });
  $('#sort-by').addEventListener('change', function (e) {
    filters.sort = e.target.value;
    renderList();
  });
  $('#branch-select').addEventListener('change', function (e) {
    filters.branch = e.target.value;
    loadProducts();
  });

  $('#product-list').addEventListener('click', function (e) {
    var btn = e.target.closest('.sell-btn');
    if (!btn || btn.disabled) return;
    var id = btn.closest('.p-item').getAttribute('data-id');
    var product = products.find(function (p) { return p.id === id; });
    if (product) openSellModal(product);
  });

  // ---------- sell ----------
  // Price is not fixed per product — parts prices are negotiated/vary, so the
  // worker enters the actual price sold at (pre-filled from the reference price).
  function openSellModal(product) {
    var pns = product.part_numbers || [];
    var firstPn = pns[0] || { part_number: '', quantity: 0, price: 0 };

    var modal = openModal(
      '<h2>Record sale</h2>' +
      '<div class="sale-summary" style="margin-bottom:.9rem">' +
      esc(product.name_en) + (product.brand ? ' · ' + esc(product.brand) : '') +
      '</div>' +
      '<form id="sell-form" class="form-grid">' +
      (pns.length > 1
        ? '<label>Part number<select name="part_number">' +
          pns.map(function (pn) {
            return '<option value="' + esc(pn.part_number) + '" data-price="' + pn.price + '">' +
              esc(pn.part_number) + ' (' + pn.quantity + ' in stock, ' + money(pn.price) + ')</option>';
          }).join('') +
          '</select></label>'
        : '<p class="cell-muted">Part number: <b>' + esc(firstPn.part_number) + '</b> · In stock: <b>' + firstPn.quantity + '</b> · Reference price: <b>' + money(firstPn.price) + '</b></p>') +
      '<label>Quantity sold' +
      '<div class="qty-row">' +
      '<button type="button" class="qty-btn" id="qty-minus">−</button>' +
      '<input name="quantity" type="number" min="1" max="' + firstPn.quantity + '" step="1" value="1" required>' +
      '<button type="button" class="qty-btn" id="qty-plus">＋</button>' +
      '</div></label>' +
      '<label>Price sold at (FCFA)<input name="unit_price" type="number" min="0" step="1" value="' + firstPn.price + '" required></label>' +
      '<div class="sale-summary">Total: <strong id="sale-total">' + money(firstPn.price) + '</strong></div>' +
      '<p class="form-error" id="sell-error" hidden></p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-outline" id="cancel-sell">Cancel</button>' +
      '<button type="submit" class="btn btn-primary btn-big" style="width:auto">Confirm sale</button>' +
      '</div></form>'
    );

    var qtyInput = modal.querySelector('input[name="quantity"]');
    var priceInput = modal.querySelector('input[name="unit_price"]');
    var pnSelect = modal.querySelector('select[name="part_number"]');
    function currentPartNumber() {
      var wanted = pnSelect ? pnSelect.value : firstPn.part_number;
      return pns.filter(function (pn) { return pn.part_number === wanted; })[0] || firstPn;
    }
    function currentAvailable() {
      return currentPartNumber().quantity;
    }
    function updateTotal() {
      var available = currentAvailable();
      var q = Math.max(1, Math.min(available || 1, Math.round(Number(qtyInput.value) || 1)));
      var price = Math.max(0, Number(priceInput.value) || 0);
      $('#sale-total', modal).textContent = money(price * q);
    }
    if (pnSelect) {
      pnSelect.addEventListener('change', function () {
        var chosen = currentPartNumber();
        qtyInput.max = chosen.quantity;
        qtyInput.value = Math.min(Number(qtyInput.value) || 1, chosen.quantity || 1);
        priceInput.value = chosen.price; // pre-fill from the newly-selected part number's own price
        updateTotal();
      });
    }
    $('#qty-minus', modal).addEventListener('click', function () {
      qtyInput.value = Math.max(1, (Number(qtyInput.value) || 1) - 1);
      updateTotal();
    });
    $('#qty-plus', modal).addEventListener('click', function () {
      qtyInput.value = Math.min(currentAvailable(), (Number(qtyInput.value) || 0) + 1);
      updateTotal();
    });
    qtyInput.addEventListener('input', updateTotal);
    priceInput.addEventListener('input', updateTotal);
    $('#cancel-sell', modal).addEventListener('click', closeModal);

    $('#sell-form', modal).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var partNumber = pnSelect ? pnSelect.value : firstPn.part_number;
      var quantity = Math.round(Number(qtyInput.value));
      var unitPrice = Math.round(Number(priceInput.value));
      withSpinner(f.querySelector('button[type="submit"]'), 'Recording…', function () {
        return api('/api/sales', { method: 'POST', body: { product_id: product.id, part_number: partNumber, quantity: quantity, unit_price: unitPrice } });
      })
        .then(function (res) {
          closeModal();
          toast('✓ Sale recorded: ' + res.sale.quantity + ' × ' + res.sale.product_name + ' — ' + money(res.sale.total));
          loadProducts();
          loadToday();
        })
        .catch(function (err) {
          var el = $('#sell-error', modal);
          el.textContent = err.message;
          el.hidden = false;
          loadProducts();
        });
    });
  }

  // ---------- add product (create-only: workers can add inventory, never edit/delete) ----------
  function langFieldsWorker(label, prefix) {
    return '<fieldset class="lang-set"><legend>' + label + '</legend>' +
      '<label>Name' + (prefix === 'en' ? ' *' : '') + '<input name="name_' + prefix + '"' + (prefix === 'en' ? ' required' : '') + '></label>' +
      '<label>Description<textarea name="desc_' + prefix + '" maxlength="4000"></textarea></label>' +
      '</fieldset>';
  }

  function openAddProductModal() {
    var modal = openModal(
      '<h2>Add new product</h2>' +
      '<p class="cell-muted" style="margin:-.4rem 0 .8rem">Added to your branch\'s inventory. Your superadmin reviews it before it appears anywhere you\'ll see it drop off "Pending" once approved.</p>' +
      '<form id="add-product-form" class="form-grid">' +
      langFieldsWorker('English', 'en') +
      langFieldsWorker('Français', 'fr') +
      langFieldsWorker('中文', 'zh') +
      '<label>Category<select name="category">' +
      Object.keys(CATEGORIES).map(function (k) { return '<option value="' + k + '">' + CATEGORIES[k] + '</option>'; }).join('') +
      '</select></label>' +
      '<label>Brand<input name="brand"></label>' +
      '<div><span style="display:block;font-size:.84rem;font-weight:700;color:var(--muted);margin-bottom:.3rem">Part Numbers, Quantity &amp; Price (FCFA) *</span>' +
      '<div id="part-number-rows"></div>' +
      '<button type="button" class="btn btn-outline btn-xs" id="add-part-number" style="margin-top:.4rem">＋ Add part number</button></div>' +
      '<label>Photo<input name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<p class="form-error" id="add-product-error" hidden></p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-outline" id="cancel-add-product">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">Add product</button>' +
      '</div></form>',
      'modal-lg'
    );
    $('#cancel-add-product', modal).addEventListener('click', closeModal);

    var pnWrap = $('#part-number-rows', modal);
    function addPartNumberRow() {
      var row = document.createElement('div');
      row.className = 'part-number-row';
      row.innerHTML =
        '<input type="text" class="pn-number" placeholder="Part number" required>' +
        '<input type="number" class="pn-quantity" min="0" step="1" placeholder="Qty" value="1" required>' +
        '<input type="number" class="pn-price" min="0" step="1" placeholder="Price" required>' +
        '<button type="button" class="btn btn-outline btn-xs" data-remove-pn>✕</button>';
      row.querySelector('[data-remove-pn]').addEventListener('click', function () {
        if (pnWrap.children.length > 1) row.remove();
      });
      pnWrap.appendChild(row);
    }
    addPartNumberRow();
    $('#add-part-number', modal).addEventListener('click', addPartNumberRow);

    $('#add-product-form', modal).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var partNumbers = Array.prototype.map
        .call(pnWrap.querySelectorAll('.part-number-row'), function (row) {
          return {
            part_number: row.querySelector('.pn-number').value.trim(),
            quantity: Number(row.querySelector('.pn-quantity').value) || 0,
            price: Number(row.querySelector('.pn-price').value) || 0,
          };
        })
        .filter(function (pn) { return pn.part_number; });
      if (!partNumbers.length) {
        var errEl = $('#add-product-error', modal);
        errEl.textContent = 'At least one part number is required';
        errEl.hidden = false;
        return;
      }
      withSpinner(f.querySelector('button[type="submit"]'), 'Adding…', function () {
        return Promise.resolve(
          f.image.files[0] ? compressImage(f.image.files[0], 1600, 0.82) : null,
        ).then(function (image) {
          var form = new FormData();
          ['name_en', 'name_fr', 'name_zh', 'desc_en', 'desc_fr', 'desc_zh', 'category', 'brand'].forEach(function (k) {
            form.append(k, f[k].value);
          });
          form.append('part_numbers', JSON.stringify(partNumbers));
          form.append('published', '1');
          if (image) form.append('image', image, f.image.files[0].name);
          return api('/api/admin/products', { method: 'POST', form: form });
        });
      })
        .then(function () {
          closeModal();
          toast('Submitted waiting for superadmin approval');
          loadProducts();
        })
        .catch(function (err) {
          var el = $('#add-product-error', modal);
          el.textContent = err.message;
          el.hidden = false;
        });
    });
  }

  $('#add-product-btn').addEventListener('click', openAddProductModal);

  // ---------- my sales today ----------
  function loadToday() {
    api('/api/sales/mine/today').then(function (res) {
      $('#today-total').textContent = money(res.total);
      loadToday.cache = res;
    }).catch(function () {});
  }

  $('#show-mine').addEventListener('click', function () {
    var data = loadToday.cache;
    var body = (data && data.sales.length)
      ? '<div class="mine-list">' + data.sales.map(function (s) {
          return '<div class="mine-item"><div>' +
            '<div>' + s.quantity + ' × ' + esc(s.product_name) + '</div>' +
            '<div class="t">' + timeOf(s.created_at) + '</div></div>' +
            '<div class="a">' + money(s.total) + '</div></div>';
        }).join('') +
        '<div class="mine-total">Total: ' + money(data.total) + '</div></div>'
      : '<p class="list-empty">No sales recorded today yet.</p>';
    var modal = openModal(
      '<h2>My sales today' + (data ? ' — ' + esc(data.date) : '') + '</h2>' + body +
      '<div class="modal-actions"><button class="btn btn-outline" id="close-mine">Close</button></div>'
    );
    $('#close-mine', modal).addEventListener('click', closeModal);
    loadToday();
  });

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // ---------- boot ----------
  if (token) {
    api('/api/auth/me').then(function (data) {
      user = data.user;
      enterApp();
    }).catch(function () { /* logout() already ran on 401 */ });
  } else {
    showLogin();
  }
})();
