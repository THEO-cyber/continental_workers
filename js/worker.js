/* Continental — workers app: record sales, live stock */
(function () {
  'use strict';

  var TOKEN_KEY = 'continental_worker_token';
  var token = localStorage.getItem(TOKEN_KEY);
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

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.form ? {} : { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.form ? opts.form : (opts.body ? JSON.stringify(opts.body) : undefined),
    }).then(function (res) {
      // A 401 from the login endpoint itself just means wrong credentials —
      // only treat 401 elsewhere as an expired session and force re-login.
      if (res.status === 401 && path !== '/api/auth/login') { logout(); throw new Error('Session expired — sign in again'); }
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
    api('/api/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } })
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
    socket = io({ auth: { token: token } });
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
      return (p.name_en + ' ' + (p.name_fr || '') + ' ' + (p.brand || '') + ' ' + (p.sku || '')).toLowerCase().indexOf(q) !== -1;
    });
    var sorters = {
      'name': function (a, b) { return a.name_en.localeCompare(b.name_en); },
      'price-low': function (a, b) { return a.price - b.price; },
      'price-high': function (a, b) { return b.price - a.price; },
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
        (p.brand ? ' · ' + esc(p.brand) : '') + (p.sku ? ' · ' + esc(p.sku) : '') + '</div>' +
        '<div class="p-price">' + money(p.price) + '</div>' +
        (showBranch ? '<div class="branch-badge">' + esc(p.branch_name) + '</div>' : '') +
        '</div>' +
        '<div class="p-right">' +
        '<span class="p-stock ' + stockCls + '">' + esc(stockTxt) + '</span>' +
        (otherBranch
          ? '<span class="cell-muted" style="font-size:.7rem;text-align:right">View only —<br>visit that branch to sell</span>'
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
    var id = Number(btn.closest('.p-item').getAttribute('data-id'));
    var product = products.find(function (p) { return p.id === id; });
    if (product) openSellModal(product);
  });

  // ---------- sell ----------
  // Price is not fixed per product — parts prices are negotiated/vary, so the
  // worker enters the actual price sold at (pre-filled from the reference price).
  function openSellModal(product) {
    var modal = openModal(
      '<h2>Record sale</h2>' +
      '<div class="sale-summary" style="margin-bottom:.9rem">' +
      esc(product.name_en) + (product.brand ? ' · ' + esc(product.brand) : '') + '<br>' +
      'Reference price: <b>' + money(product.price) + '</b> · In stock: <b>' + product.quantity + '</b></div>' +
      '<form id="sell-form" class="form-grid">' +
      '<label>Quantity sold' +
      '<div class="qty-row">' +
      '<button type="button" class="qty-btn" id="qty-minus">−</button>' +
      '<input name="quantity" type="number" min="1" max="' + product.quantity + '" step="1" value="1" required>' +
      '<button type="button" class="qty-btn" id="qty-plus">＋</button>' +
      '</div></label>' +
      '<label>Price sold at (FCFA)<input name="unit_price" type="number" min="0" step="1" value="' + product.price + '" required></label>' +
      '<div class="sale-summary">Total: <strong id="sale-total">' + money(product.price) + '</strong></div>' +
      '<p class="form-error" id="sell-error" hidden></p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-outline" id="cancel-sell">Cancel</button>' +
      '<button type="submit" class="btn btn-primary btn-big" style="width:auto">Confirm sale</button>' +
      '</div></form>'
    );

    var qtyInput = modal.querySelector('input[name="quantity"]');
    var priceInput = modal.querySelector('input[name="unit_price"]');
    function updateTotal() {
      var q = Math.max(1, Math.min(product.quantity, Math.round(Number(qtyInput.value) || 1)));
      var price = Math.max(0, Number(priceInput.value) || 0);
      $('#sale-total', modal).textContent = money(price * q);
    }
    $('#qty-minus', modal).addEventListener('click', function () {
      qtyInput.value = Math.max(1, (Number(qtyInput.value) || 1) - 1);
      updateTotal();
    });
    $('#qty-plus', modal).addEventListener('click', function () {
      qtyInput.value = Math.min(product.quantity, (Number(qtyInput.value) || 0) + 1);
      updateTotal();
    });
    qtyInput.addEventListener('input', updateTotal);
    priceInput.addEventListener('input', updateTotal);
    $('#cancel-sell', modal).addEventListener('click', closeModal);

    $('#sell-form', modal).addEventListener('submit', function (e) {
      e.preventDefault();
      var quantity = Math.round(Number(qtyInput.value));
      var unitPrice = Math.round(Number(priceInput.value));
      api('/api/sales', { method: 'POST', body: { product_id: product.id, quantity: quantity, unit_price: unitPrice } })
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
      '<label>Description<textarea name="desc_' + prefix + '"></textarea></label>' +
      '</fieldset>';
  }

  function openAddProductModal() {
    var modal = openModal(
      '<h2>Add new product</h2>' +
      '<p class="cell-muted" style="margin:-.4rem 0 .8rem">Added to your branch\'s inventory. Your superadmin reviews it before it appears anywhere — you\'ll see it drop off "Pending" once approved.</p>' +
      '<form id="add-product-form" class="form-grid">' +
      langFieldsWorker('English', 'en') +
      langFieldsWorker('Français', 'fr') +
      langFieldsWorker('中文', 'zh') +
      '<label>Category<select name="category">' +
      Object.keys(CATEGORIES).map(function (k) { return '<option value="' + k + '">' + CATEGORIES[k] + '</option>'; }).join('') +
      '</select></label>' +
      '<div class="qty-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem">' +
      '<label>Brand<input name="brand"></label>' +
      '<label>SKU / Part No.<input name="sku"></label>' +
      '</div>' +
      '<div class="qty-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem">' +
      '<label>Price (FCFA) *<input name="price" type="number" min="0" step="1" required></label>' +
      '<label>Quantity in stock *<input name="quantity" type="number" min="0" step="1" required value="1"></label>' +
      '</div>' +
      '<label>Photo<input name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
      '<p class="form-error" id="add-product-error" hidden></p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-outline" id="cancel-add-product">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">Add product</button>' +
      '</div></form>',
      'modal-lg'
    );
    $('#cancel-add-product', modal).addEventListener('click', closeModal);
    $('#add-product-form', modal).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var form = new FormData();
      ['name_en', 'name_fr', 'name_zh', 'desc_en', 'desc_fr', 'desc_zh', 'category', 'brand', 'sku'].forEach(function (k) {
        form.append(k, f[k].value);
      });
      form.append('price', f.price.value);
      form.append('quantity', f.quantity.value);
      form.append('published', '1');
      if (f.image.files[0]) form.append('image', f.image.files[0]);
      api('/api/admin/products', { method: 'POST', form: form })
        .then(function () {
          closeModal();
          toast('Submitted — waiting for superadmin approval');
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
