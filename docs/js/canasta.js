// Precium — pantalla "Armar canasta". Habla con la API (api.js); el ranking lo calcula el
// servidor y nunca manda precios individuales. Orden de carga: api.js, session.js, canasta.js.

(function () {
  'use strict';

  const API = window.PreciumAPI;
  const DRAFT_KEY = 'precium_draft';
  const FALLBACK_LABEL = 'una ubicación aproximada de Vicente López';

  // ---------- almacenamiento del borrador (puede fallar en modo privado) ----------
  let memDraft = [];
  const loadDraft = () => { try { return JSON.parse(window.localStorage.getItem(DRAFT_KEY)) || []; } catch (e) { return memDraft; } };
  const saveDraft = (v) => { memDraft = v; try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch (e) { /* solo memoria */ } };

  // ---------- estado ----------
  let basket = [];            // [{ productId, qty, name, unit }]
  let cachedLocation = null;  // solo si es la ubicación real del usuario
  let undoSnapshot = null;    // canasta anterior, por si reemplazó con una guardada
  let compareSeq = 0;         // descarta respuestas viejas si se compara dos veces seguidas

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const searchInput = $('search'), searchResults = $('search-results');
  const scanBtn = $('scan-btn'), scanNote = $('scan-note'), scanPreview = $('scan-preview');
  const freqChips = $('freq-chips');
  const basketList = $('basket-list'), basketEmpty = $('basket-empty'), basketCountLbl = $('basket-count-lbl');
  const compareBtn = $('compare-btn'), compareCount = $('compare-count');
  const resultBox = $('result-box'), resultTitle = $('result-title'), panel = $('panel');
  const mbar = $('mbar'), mbarBtn = $('mbar-btn');
  const clearBtn = $('clear-basket'), liveRegion = $('live-region');
  const savedBody = $('saved-body');

  // ---------- utilidades ----------
  const announce = (m) => { liveRegion.textContent = ''; liveRegion.textContent = m; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fmtQty = (q) => q.toLocaleString('es-AR', { maximumFractionDigits: 1 });
  const step = (it) => (it.unit === 'kg' ? 0.5 : 1);
  const unitLbl = (it) => (it.unit === 'kg' ? ' kg' : '');
  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
  const inBasket = (id) => basket.find((i) => i.productId === id);

  // "Leche entera 1 L" -> "Leche entera"; "Huevos, docena" -> "Huevos"
  const shortName = (name) => name.replace(/,.*$/, '').replace(/\s\d.*$/, '').replace(/\sx\d.*$/, '');

  function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
  }
  const mapsLink = (b) => `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`;
  const daysAgo = (n) => (n === null || n === undefined ? '' : n === 0 ? ' · actualizado hoy' : ` · actualizado hace ${plural(n, 'día', 'días')}`);

  // ---------- borrador (sobrevive a ir a "Sumar un precio" y volver) ----------
  function restore() {
    const d = loadDraft();
    if (!Array.isArray(d)) return;
    basket = d.filter((i) => i && Number.isInteger(i.productId) && typeof i.name === 'string' && Number(i.qty) > 0)
      .map((i) => ({ productId: i.productId, qty: Number(i.qty), name: i.name, unit: i.unit === 'kg' ? 'kg' : 'un' }));
  }
  function changed() { saveDraft(basket); renderBasket(); resetResult(); if (window.PreciumSession.user()) renderSaved(); } // la opción de guardar depende de que haya productos

  // ---------- canasta ----------
  function addProduct(p, quiet) {
    const it = inBasket(p.id);
    if (it) it.qty = Math.round((it.qty + step(it)) * 10) / 10;
    else basket.push({ productId: p.id, qty: 1, name: p.name, unit: p.unit });
    changed();
    if (!quiet) announce(`${p.name} agregado a la canasta`);
  }
  function changeQty(id, dir) {
    const it = inBasket(id);
    if (!it) return;
    it.qty = Math.round((it.qty + dir * step(it)) * 10) / 10;
    if (it.qty <= 0) basket = basket.filter((i) => i.productId !== id);
    changed();
  }
  const removeProduct = (id) => { basket = basket.filter((i) => i.productId !== id); changed(); };

  // ---------- búsqueda (con la API) ----------
  let searchSeq = 0, searchTimer = null;
  function showSearchMsg(text) {
    searchResults.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    searchResults.appendChild(li);
    searchResults.hidden = false;
  }
  async function runSearch(query) {
    const q = query.trim();
    const seq = ++searchSeq;
    if (!q) { searchResults.hidden = true; return; }
    let list;
    try { list = (await API.products(q, 8)).products; }
    catch (e) { if (seq === searchSeq) showSearchMsg(e.message); return; }
    if (seq !== searchSeq) return; // llegó tarde: ya se escribió otra cosa
    if (!list.length) { showSearchMsg('No encontramos ese producto en el catálogo todavía.'); return; }
    searchResults.innerHTML = '';
    list.forEach((p) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${esc(p.name)}<small>Agregar a la canasta</small>`;
      b.addEventListener('click', () => { addProduct(p); searchInput.value = ''; searchResults.hidden = true; searchInput.focus(); });
      li.appendChild(b);
      searchResults.appendChild(li);
    });
    searchResults.hidden = false;
  }
  searchInput.addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 180); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') searchResults.hidden = true; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.results-dropdown')) searchResults.hidden = true; });

  // ---------- frecuentes ----------
  async function renderFrequentChips() {
    let list = [];
    try { list = (await API.frequent()).products; } catch (e) { /* sin atajos: la búsqueda sigue andando */ }
    freqChips.innerHTML = '';
    list.forEach((p) => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'chip';
      c.textContent = shortName(p.name);
      c.setAttribute('aria-label', `Agregar ${p.name}`);
      c.addEventListener('click', () => addProduct(p));
      freqChips.appendChild(c);
    });
    freqChips.closest('.block').hidden = list.length === 0;
  }

  // ---------- lista ----------
  function renderBasket() {
    basketList.innerHTML = '';
    const n = basket.length;
    basketEmpty.hidden = n > 0;
    basketList.hidden = n === 0;
    clearBtn.hidden = n === 0;
    compareBtn.disabled = n === 0;
    compareBtn.classList.toggle('off', n === 0);
    mbar.hidden = n === 0;
    basketCountLbl.textContent = n ? `Tu canasta · ${plural(n, 'producto', 'productos')}` : 'Tu canasta';
    compareCount.textContent = n ? `(${n})` : '';

    basket.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div class="nm">${esc(item.name)}</div>
        <div class="qty">
          <button type="button" aria-label="Restar de ${esc(item.name)}" data-a="dec">−</button>
          <span class="qty-val" aria-live="polite">${fmtQty(item.qty)}${unitLbl(item)}</span>
          <button type="button" aria-label="Sumar a ${esc(item.name)}" data-a="inc">+</button>
        </div>
        <button type="button" class="rm" aria-label="Quitar ${esc(item.name)} de la canasta">✕</button>`;
      row.querySelector('[data-a="dec"]').addEventListener('click', () => changeQty(item.productId, -1));
      row.querySelector('[data-a="inc"]').addEventListener('click', () => changeQty(item.productId, 1));
      row.querySelector('.rm').addEventListener('click', () => removeProduct(item.productId));
      basketList.appendChild(row);
    });
  }
  clearBtn.addEventListener('click', () => { basket = []; changed(); announce('Canasta vacía'); });

  function resetResult() {
    compareSeq++;
    resultBox.innerHTML = '';
    panel.classList.remove('show');
    compareBtn.disabled = basket.length === 0;
    mbarBtn.disabled = false;
  }

  // ---------- canastas guardadas (solo con cuenta) ----------
  let saveOpen = false;
  let savedCache = null; // lista cargada de la API

  async function renderSaved() {
    const u = window.PreciumSession.user();
    savedBody.innerHTML = '';
    if (!u) {
      savedBody.innerHTML = '<p class="note">Guardá tus canastas para repetirlas con un toque. <a href="/registro.html?next=%2Fcanasta.html">Registrate</a> o <a href="/login.html?next=%2Fcanasta.html">iniciá sesión</a>.</p>';
      savedCache = null;
      return;
    }
    if (savedCache === null) {
      savedBody.innerHTML = '<p class="note">Cargando tus canastas…</p>';
      try { savedCache = (await API.baskets()).baskets; }
      catch (e) { savedBody.innerHTML = `<p class="note">${esc(e.message)}</p>`; savedCache = null; return; }
      savedBody.innerHTML = '';
    }
    const list = savedCache;
    const row = document.createElement('div');
    row.className = 'row';
    if (!list.length) row.innerHTML = '<p class="note">Todavía no guardaste ninguna. Armá una canasta y tocá “Guardar esta canasta”.</p>';
    list.forEach((b) => {
      const w = document.createElement('span');
      w.className = 'chip-wrap';
      w.innerHTML = `<button type="button" class="chip" data-use="${b.id}">${esc(b.name)}</button><button type="button" class="x" data-del="${b.id}" aria-label="Borrar la canasta ${esc(b.name)}">✕</button>`;
      row.appendChild(w);
    });
    savedBody.appendChild(row);

    row.querySelectorAll('[data-use]').forEach((el) => el.addEventListener('click', () => {
      const b = list.find((x) => String(x.id) === el.dataset.use);
      if (!b) return;
      undoSnapshot = basket.length ? basket.map((i) => ({ ...i })) : null;
      basket = b.items.map((i) => ({ productId: i.productId, qty: i.qty, name: i.name, unit: i.unit }));
      changed();
      announce(`Canasta ${b.name} cargada`);
      renderSaved();
    }));
    row.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async () => {
      el.disabled = true;
      try { await API.deleteBasket(el.dataset.del); savedCache = savedCache.filter((x) => String(x.id) !== el.dataset.del); }
      catch (e) { announce(e.message); }
      renderSaved();
    }));

    if (undoSnapshot) {
      const p = document.createElement('p');
      p.className = 'undo';
      p.innerHTML = 'Reemplazamos tu canasta anterior. <button type="button" class="link-btn accent" id="undo">Deshacer</button>';
      savedBody.appendChild(p);
      $('undo').addEventListener('click', () => { basket = undoSnapshot; undoSnapshot = null; changed(); renderSaved(); });
    }

    if (basket.length) {
      if (saveOpen) {
        const f = document.createElement('form');
        f.innerHTML = '<input type="text" id="save-name" maxlength="30" placeholder="Nombre (ej. Compra del mes)" aria-label="Nombre de la canasta"><button class="btn small" type="submit" style="padding:9px 20px;font-size:1rem">Guardar</button>';
        const err = document.createElement('p');
        err.className = 'undo'; err.setAttribute('role', 'alert'); err.hidden = true;
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = $('save-name').value.trim();
          if (!name) { $('save-name').focus(); return; }
          try {
            const r = await API.saveBasket(name, basket.map((i) => ({ productId: i.productId, qty: i.qty })));
            savedCache.push(r.basket);
            saveOpen = false; undoSnapshot = null;
            renderSaved();
            announce(`Canasta ${name} guardada`);
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        });
        savedBody.append(f, err);
        $('save-name').focus();
      } else {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link-btn accent'; b.textContent = 'Guardar esta canasta';
        b.addEventListener('click', () => { saveOpen = true; renderSaved(); });
        savedBody.appendChild(b);
      }
    }
  }

  // ---------- ubicación ----------
  function getLocation() {
    if (cachedLocation) return Promise.resolve(cachedLocation);
    return new Promise((resolve) => {
      const fallback = () => resolve({ approx: true });
      if (!('geolocation' in navigator)) return fallback();
      navigator.geolocation.getCurrentPosition(
        (pos) => { cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, approx: false }; resolve(cachedLocation); },
        fallback, { timeout: 6000 });
    });
  }

  // ---------- resultado ----------
  function renderResult(res) {
    const total = basket.length;
    const w = res.winner;
    const nameOf = (id) => { const i = inBasket(id); return i ? shortName(i.name) : 'producto'; };
    if (!w) {
      resultBox.innerHTML = `<div class="notice">${res.candidates === 0
        ? 'No hay comercios cargados cerca de tu ubicación todavía.'
        : 'Todavía no tenemos precios para estos productos. <b>Sumá uno</b> y ayudás a los demás.'}</div>`;
      return;
    }
    const cmpTotal = res.comparableCount;
    const chips = [`<span class="chip">${w.covered} de ${cmpTotal} con precio</span>`];
    if (res.savingsPct > 0) chips.push(`<span class="chip">Ahorro est. ${res.savingsPct}%</span>`);

    const parts = [];
    parts.push(`<div class="win">
      <div class="tiny">Más conveniente para tu canasta de ${plural(total, 'producto', 'productos')}</div>
      <b>${esc(w.business.name)}</b>
      <div class="tiny">${esc(typeLabel(w.business.type))} · a ${formatDistance(w.km)}</div>
      <div class="chips">${chips.join('')}</div>
      ${w.imputed ? `<small class="tag-est">${plural(w.imputed, 'producto estimado', 'productos estimados')} con el promedio de la zona.</small>` : ''}
      <small class="tiny">${plural(w.reports, 'reporte', 'reportes')}${daysAgo(w.updatedDaysAgo)}</small>
      <a class="btn" href="${mapsLink(w.business)}" target="_blank" rel="noopener">Cómo llegar</a>
    </div>`);

    if (res.lowConfidence) parts.push('<div class="notice"><b>Poca información.</b> Ningún comercio tiene precio de la mayoría de tu canasta; tomá este resultado como orientativo.</div>');

    if (res.others.length) {
      parts.push('<div class="alt-list">' + res.others.map((r) => `
        <div class="alt">
          <div class="nm">${esc(r.business.name)}<small>${formatDistance(r.km)} · ${r.covered} de ${cmpTotal} con precio</small></div>
          <a href="${mapsLink(r.business)}" target="_blank" rel="noopener" aria-label="Cómo llegar a ${esc(r.business.name)}">Cómo llegar</a>
        </div>`).join('') + '</div>');
    }

    const missing = res.missing.filter((id) => !res.unpriced.includes(id));
    if (missing.length) {
      parts.push(`<div class="missing">Sin precio en ${esc(w.business.name)}: <b>${missing.map((id) => esc(nameOf(id))).join(', ')}</b>
        <button type="button" id="contrib-link">Sumar un precio</button></div>`);
    }
    if (res.unpriced.length) {
      parts.push(`<div class="notice">Todavía no tenemos precio de <b>${res.unpriced.map((id) => esc(nameOf(id))).join(', ')}</b> en ningún comercio, así que no entran en la comparación.</div>`);
    }
    parts.push(res.location.approx
      ? `<div class="loc-note">Usando ${FALLBACK_LABEL}. <button type="button" id="retry-loc">Usar mi ubicación</button></div>`
      : '<div class="loc-note">Usando tu ubicación actual.</div>');

    resultBox.innerHTML = parts.join('');
    const cl = $('contrib-link');
    if (cl) cl.addEventListener('click', () => { window.location.href = `/contribuir.html?comercio=${encodeURIComponent(w.business.id)}&producto=${encodeURIComponent(missing[0])}`; });
    const rl = $('retry-loc');
    if (rl) rl.addEventListener('click', () => { cachedLocation = null; runCompare(); });
    announce(`Resultado: ${w.business.name}, a ${formatDistance(w.km)}`);
  }

  const TYPES = { supermercado: 'Supermercado', autoservicio: 'Autoservicio', almacen: 'Almacén', kiosco: 'Kiosco', despensa: 'Despensa', verduleria: 'Verdulería', carniceria: 'Carnicería', panaderia: 'Panadería', farmacia: 'Farmacia', comida_rapida: 'Comida rápida', restaurante: 'Restaurante' };
  const typeLabel = (t) => TYPES[t] || 'Comercio';

  async function runCompare() {
    if (!basket.length) return;
    const seq = ++compareSeq;
    compareBtn.disabled = true; mbarBtn.disabled = true;
    panel.classList.add('show');
    resultBox.innerHTML = '<p class="tiny" style="color:var(--muted)">Buscando el mejor precio cerca tuyo…</p>';
    try {
      const loc = await getLocation();
      const res = await API.compare(basket.map((i) => ({ productId: i.productId, qty: i.qty })), loc);
      if (seq !== compareSeq) return;
      renderResult(res);
    } catch (e) {
      if (seq !== compareSeq) return;
      if (e.code === 'unknown_product') {
        // El catálogo cambió y la canasta guardada en este navegador quedó vieja.
        basket = []; saveDraft(basket); renderBasket();
        resultBox.innerHTML = '<div class="notice">Algunos productos de tu canasta ya no están en el catálogo. Armá la canasta de nuevo.</div>';
      } else {
        resultBox.innerHTML = `<div class="notice" role="alert">${esc(e.message)}</div>`;
      }
    }
    compareBtn.disabled = basket.length === 0; mbarBtn.disabled = false;
    if (isMobile()) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    resultTitle.focus({ preventScroll: true });
  }
  compareBtn.addEventListener('click', runCompare);
  mbarBtn.addEventListener('click', runCompare);

  // ---------- escáner de códigos de barras ----------
  function scanSupport() {
    if (!window.matchMedia('(pointer: coarse)').matches) return 'desktop';
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return 'nocamera';
    if (!('BarcodeDetector' in window)) return 'nodetector';
    return 'ok';
  }
  function updateScan() {
    const s = scanSupport();
    scanBtn.classList.toggle('available', s === 'ok');
    const msg = { desktop: 'Escanear códigos de barras está disponible solo desde el celular.', nocamera: 'Este dispositivo no tiene cámara disponible.', nodetector: 'Tu navegador todavía no puede leer códigos de barras. Buscá el producto a mano.' }[s];
    scanNote.hidden = !msg;
    scanNote.textContent = msg || '';
  }
  updateScan();
  window.addEventListener('resize', updateScan);

  let scanning = null; // { stream, timer }
  function stopScan() {
    if (!scanning) return;
    clearInterval(scanning.timer);
    scanning.stream.getTracks().forEach((t) => t.stop());
    scanning = null;
  }
  function closeScan(msg) {
    stopScan();
    scanPreview.innerHTML = msg ? `<p class="msg">${msg}</p>` : '';
    scanPreview.hidden = !msg;
    if (msg) setTimeout(() => { if (!scanning) { scanPreview.hidden = true; scanPreview.innerHTML = ''; } }, 3500);
  }

  async function onCode(raw) {
    stopScan();
    scanPreview.innerHTML = '<p class="msg">Buscando el producto…</p>';
    const ean = String(raw).replace(/\D/g, '').replace(/^0+/, '');
    try {
      const r = await API.barcode(ean);
      addProduct(r.product);
      closeScan(`Agregamos: <b>${esc(r.product.name)}</b>`);
    } catch (e) {
      closeScan(e.code === 'unknown_barcode' ? 'No conocemos este código todavía. Buscá el producto a mano.' : esc(e.message));
    }
  }

  scanBtn.addEventListener('click', async () => {
    if (scanning) { closeScan(); return; }
    scanPreview.hidden = false;
    scanPreview.innerHTML = '<p class="msg">Pidiendo acceso a la cámara…</p>';
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
    catch (e) { closeScan('No pudimos acceder a la cámara. Buscá el producto a mano.'); return; }

    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.setAttribute('aria-label', 'Vista de la cámara');
    video.srcObject = stream;
    scanPreview.innerHTML = '<p class="msg">Apuntá al código de barras del producto. <button type="button" class="link-btn accent" id="scan-close">Cancelar</button></p>';
    scanPreview.appendChild(video);
    $('scan-close').addEventListener('click', () => closeScan());

    const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    let busy = false;
    scanning = { stream, timer: setInterval(async () => {
      if (busy || video.readyState < 2) return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        if (codes.length) { await onCode(codes[0].rawValue); return; }
      } catch (e) { /* cuadro sin imagen: reintenta */ }
      busy = false;
    }, 300) };
  });
  window.addEventListener('pagehide', stopScan);

  // ---------- inicio ----------
  restore();
  renderBasket();
  renderFrequentChips();
  window.PreciumSession.renderNav($('nav-auth'), () => { savedCache = null; undoSnapshot = null; saveOpen = false; renderSaved(); });
  window.PreciumSession.ready.then(async () => {
    await renderSaved();
    if (location.hash === '#guardadas') $('guardadas').scrollIntoView();
  });
})();
