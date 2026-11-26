// Precium — lógica de "Sumá un precio". Los aportes se envían a la API (api.js); la cuenta y
// las reglas (confirmar precios raros, duplicados, límite diario) las hace cumplir el servidor.
// Reglas de producto que se cumplen acá:
//   - Solo usuarios con cuenta ven el formulario (los invitados ven una puerta de acceso).
//   - Nunca se muestran precios de otros: ni siquiera para avisar de un precio raro.
//   - La foto de un ticket no sale del dispositivo y se descarta al terminar (solo se envía su huella para evitar duplicados).
// Orden de carga: api.js, session.js, contribuir.js.

(function () {
  'use strict';

  const API = window.PreciumAPI;
  const NEAR_KM = 0.25;       // a menos de 250 m se considera "estás en el comercio"

  const $ = (id) => document.getElementById(id);
  const gate = $('gate');
  const flow = $('flow');
  const steps = { choose: $('step-choose'), entry: $('step-entry'), ticket: $('step-ticket'), done: $('step-done') };
  const headings = { choose: steps.choose.querySelector('h2'), entry: $('entry-title'), ticket: $('ticket-title'), done: $('done-title') };
  const live = $('live-region');

  // ---------------------------------------------------------------- estado
  let location = null;          // { lat, lng, approx }
  let businesses = [];          // comercios cercanos (de la API)
  let allProducts = [];         // catálogo para los desplegables del ticket
  let business = null;          // comercio elegido
  let method = null;            // 'barcode' | 'manual' | 'receipt'
  let scannedCode = null;
  let product = null;           // producto elegido en el formulario de un precio
  let pendingOutlier = null;    // precio (en centavos) que el servidor marcó como raro y la persona va a confirmar
  let ticketOutliers = new Set(); // productos del ticket que el servidor marcó como raros
  let wanted = null;            // producto que falta (viene desde la canasta)
  let photoHash = null;         // huella SHA-256 de la foto del ticket (si hay)
  let busy = false;             // hay un envío en curso
  let savedLines = [];          // lo sumado en esta visita, para la pantalla de cierre
  let stream = null;
  let scanTimer = null;
  let photoUrl = null;

  const params = new URLSearchParams(window.location.search);

  // ---------------------------------------------------------------- utilidades
  const products = new Map(); // id -> { id, name, unit }, se llena con lo que trae la API
  const remember = (list) => list.forEach((p) => products.set(p.id, p));
  const byId = (id) => products.get(Number(id));

  function announce(msg) { live.textContent = ''; live.textContent = msg; }

  function money(cents) {
    return (cents / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
  }

  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  function formatDistance(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace('.', ',')} km`;
  }

  // "1.250,50" · "1250,5" · "1.250" · "1250.50"  ->  centavos (o null si no es un precio válido)
  function parsePrice(text) {
    let s = String(text || '').replace(/[\s$]/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const cents = Math.round(parseFloat(s) * 100);
    return cents > 0 && cents < 100000000 ? cents : null;
  }

  function unitLabel(p) {
    return p.unit === 'kg' ? 'por kg' : p.unit === 'l' ? 'por litro' : 'por unidad';
  }

  // ---------------------------------------------------------------- navegación entre pasos
  function showStep(name, moveFocus = true) {
    Object.entries(steps).forEach(([key, el]) => { el.hidden = key !== name; });
    const h = headings[name];
    if (h && moveFocus) h.focus();
  }

  // ---------------------------------------------------------------- comercio y ubicación
  function getLocation() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) { resolve({ approx: true }); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, approx: false }),
        () => resolve({ approx: true }),
        { timeout: 6000 }
      );
    });
  }

  function fillBusinessSelect() {
    const sel = $('biz');
    const current = business ? business.id : '';
    const list = businesses.slice();
    sel.innerHTML = '<option value="">Elegí el comercio</option>';
    list.forEach((b) => {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = location && !location.approx ? `${b.name} · a ${formatDistance(distanceKm(location, b))}` : b.name;
      sel.appendChild(o);
    });
    sel.value = current;
  }

  function updateBusinessStatus() {
    const st = $('biz-status');
    if (!business) {
      st.textContent = location && !location.approx
        ? 'No estás cerca de ningún comercio conocido: elegí uno de la lista.'
        : 'Elegí el comercio donde viste el precio.';
    } else if (location && !location.approx) {
      const km = distanceKm(location, business);
      st.textContent = km <= NEAR_KM
        ? `Estás en este comercio (a ${formatDistance(km)}).`
        : `Estás a ${formatDistance(km)} de este comercio.`;
    } else {
      st.textContent = 'No pudimos confirmar tu ubicación. Elegí el comercio donde viste el precio.';
    }
    // Sin comercio no se puede elegir cómo sumar.
    document.querySelectorAll('.opt').forEach((b) => { if (b.id !== 'opt-barcode' || scanSupported()) b.disabled = !business; });
    $('choose-hint').hidden = Boolean(business);
  }

  function setBusiness(id) {
    business = businesses.find((b) => String(b.id) === String(id)) || null;
    pendingOutlier = null;
    updateBusinessStatus();
    updateMissingHint();
  }

  $('biz').addEventListener('change', (e) => setBusiness(e.target.value));

  // ---------------------------------------------------------------- "falta el precio de…" (viene desde la canasta)
  function updateMissingHint() {
    const show = Boolean(wanted && business);
    $('missing-hint').hidden = !show;
    if (show) $('missing-name').textContent = `${wanted.name} en ${business.name}`;
  }

  $('missing-go').addEventListener('click', () => { if (wanted) startMethod('manual', wanted); });

  // ---------------------------------------------------------------- elegir cómo sumar
  function scanSupported() {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const camera = 'mediaDevices' in navigator && typeof navigator.mediaDevices.getUserMedia === 'function';
    return touch && camera && 'BarcodeDetector' in window;
  }

  function setupScanOption() {
    const btn = $('opt-barcode');
    const note = $('barcode-note');
    if (scanSupported()) return;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    btn.disabled = true;
    note.textContent = touch
      ? 'Tu navegador no puede leer códigos de barras. Probá con el ticket o a mano.'
      : 'Disponible solo desde el celular.';
  }

  document.querySelectorAll('.opt').forEach((btn) => {
    btn.addEventListener('click', () => startMethod(btn.dataset.method));
  });

  function startMethod(m, preselected) {
    if (!business) { $('biz').focus(); return; }
    method = m;
    scannedCode = null;
    pendingOutlier = null;
    if (m === 'receipt') { openTicket(); return; }
    resetEntryForm(preselected || null);
    $('entry-title').textContent = m === 'barcode' ? 'Escanear código de barras' : 'Cargar a mano';
    showStep('entry');
    if (m === 'barcode') startScan();
    else { $('scan-area').hidden = true; $('entry-fields').hidden = false; }
  }

  // ---------------------------------------------------------------- un precio: formulario
  function resetEntryForm(preselected) {
    product = null;
    $('price').value = '';
    $('is-promo').checked = false;
    $('price-error').hidden = true;
    $('outlier-warn').hidden = true;
    $('product-search').value = '';
    $('product-results').hidden = true;
    $('code-line').hidden = true;
    setProduct(preselected || null);
  }

  function setProduct(p) {
    product = p;
    $('product-picker').hidden = Boolean(p);
    $('product-chosen').hidden = !p;
    if (p) {
      $('chosen-name').textContent = p.name;
      $('price-label').textContent = `Precio en góndola, ${unitLabel(p)}`;
    } else {
      $('price-label').textContent = 'Precio en góndola';
    }
    pendingOutlier = null;
    $('outlier-warn').hidden = true;
  }

  $('chosen-change').addEventListener('click', () => {
    setProduct(null);
    $('product-search').focus();
  });

  let searchSeq = 0, searchTimer = null;
  function showResults(list, msg) {
    const ul = $('product-results');
    ul.innerHTML = '';
    if (msg || !list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = msg || 'No encontramos ese producto en el catálogo todavía.';
      ul.appendChild(li);
    } else {
      list.forEach((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = p.name;
        b.addEventListener('click', () => { ul.hidden = true; remember([p]); setProduct(p); $('price').focus(); });
        li.appendChild(b);
        ul.appendChild(li);
      });
    }
    ul.hidden = false;
  }
  $('product-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const seq = ++searchSeq;
    clearTimeout(searchTimer);
    if (!q) { $('product-results').hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try { const r = await API.products(q, 8); if (seq === searchSeq) showResults(r.products); }
      catch (err) { if (seq === searchSeq) showResults([], err.message); }
    }, 180);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.results-dropdown')) $('product-results').hidden = true;
  });

  $('price').addEventListener('input', () => { $('price-error').hidden = true; $('outlier-warn').hidden = true; pendingOutlier = null; });

  function showPriceError(msg) {
    const el = $('price-error');
    el.textContent = msg;
    el.hidden = false;
  }

  // Si la sesión venció mientras cargaba, vuelve a la puerta de acceso.
  function sessionExpired() {
    window.PreciumSession.set(null);
    renderAuth();
  }

  // Devuelve true si guardó.
  async function submitEntry() {
    if (busy) return false;
    if (!product) { $('product-search').focus(); announce('Elegí un producto'); showPriceError('Elegí primero el producto.'); return false; }
    const cents = parsePrice($('price').value);
    if (cents === null) { showPriceError('Escribí un precio válido, por ejemplo 1.250,50.'); $('price').focus(); return false; }

    busy = true;
    $('save-one').disabled = true; $('save-another').disabled = true;
    try {
      const promo = $('is-promo').checked;
      await API.report({
        businessId: business.id,
        source: method === 'barcode' ? 'barcode' : 'manual',
        items: [{ productId: product.id, priceCents: cents, promo, confirmOutlier: pendingOutlier === cents }],
      });
      savedLines.push({ productId: product.id, name: product.name, priceCents: cents, promo, source: method });
      return true;
    } catch (e) {
      if (e.code === 'outlier') {
        // Precio muy lejano a lo que conocemos: se pide confirmar, sin revelar ese precio.
        pendingOutlier = cents;
        $('outlier-warn').hidden = false;
        $('outlier-warn').focus && $('outlier-warn').setAttribute('tabindex', '-1');
        announce('Revisá el precio y confirmá');
      } else if (e.code === 'login_required') sessionExpired();
      else showPriceError(e.message);
      return false;
    } finally {
      busy = false;
      $('save-one').disabled = false; $('save-another').disabled = false;
    }
  }

  $('step-entry').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await submitEntry()) finish();
  });

  $('save-another').addEventListener('click', async () => {
    if (!(await submitEntry())) return;
    announce('Precio guardado');
    resetEntryForm(null);
    if (method === 'barcode') { scannedCode = null; $('entry-fields').hidden = true; $('scan-area').hidden = false; startScan(); }
    else $('product-search').focus();
  });

  $('entry-back').addEventListener('click', () => { stopScan(); backToChoose(); });

  // ---------------------------------------------------------------- escaneo de código de barras
  function setScanStatus(msg) { $('scan-status').textContent = msg; }

  async function startScan() {
    $('scan-area').hidden = false;
    $('entry-fields').hidden = true;
    setScanStatus('Pidiendo acceso a la cámara…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    } catch (err) {
      setScanStatus('No pudimos usar la cámara. Podés cargar el precio a mano.');
      return;
    }
    const video = $('scan-video');
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* algunos navegadores arrancan solos */ }
    setScanStatus('Apuntá al código de barras del producto.');

    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    let busy = false;
    scanTimer = setInterval(async () => {
      if (busy || video.readyState < 2) return;
      busy = true;
      try {
        const found = await detector.detect(video);
        if (found.length) onCode(found[0].rawValue);
      } catch (e) { /* un cuadro que falla no corta el escaneo */ }
      busy = false;
    }, 350);
  }

  function stopScan() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $('scan-video').srcObject = null;
  }

  async function onCode(raw) {
    stopScan();
    // Mismo formato que guarda el servidor: solo dígitos y sin ceros a la izquierda.
    scannedCode = String(raw).replace(/\D/g, '').replace(/^0+/, '');
    $('scan-area').hidden = true;
    $('entry-fields').hidden = false;
    const line = $('code-line');
    line.hidden = false;
    line.textContent = `Código leído: ${scannedCode}. Buscando el producto…`;
    let found = null;
    try { found = (await API.barcode(scannedCode)).product; remember([found]); }
    catch (e) { if (e.code !== 'unknown_barcode') line.textContent = `Código leído: ${scannedCode}. ${e.message}`; }
    if (found) {
      line.textContent = `Código leído: ${scannedCode}.`;
      setProduct(found);
      announce(`Producto: ${found.name}`);
      $('price').focus();
    } else {
      if (!line.textContent.includes('.', 20) || line.textContent.endsWith('…')) line.textContent = `Código leído: ${scannedCode}. No lo conocemos todavía: elegí a qué producto corresponde.`;
      announce('Código leído');
      $('product-search').focus();
    }
  }

  $('scan-cancel').addEventListener('click', () => { stopScan(); backToChoose(); });
  window.addEventListener('pagehide', stopScan);

  // ---------------------------------------------------------------- ticket
  function openTicket() {
    $('ticket-rows').innerHTML = '';
    $('ticket-total').value = '';
    $('ticket-error').hidden = true;
    clearPhoto();
    addRow();
    updateSum();
    showStep('ticket');
  }

  function clearPhoto() {
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
    photoHash = null;
    $('ticket-img').removeAttribute('src');
    $('ticket-preview').hidden = true;
    $('ticket-photo').value = '';
  }

  $('ticket-photo').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file); // queda en el navegador: no se sube a ningún lado
    photoHash = null;
    hashFile(file).then((h) => { photoHash = h; });
    $('ticket-img').src = photoUrl;
    $('ticket-preview').hidden = false;
  });

  // Huella de la foto: se envía solo para detectar que el mismo ticket no se cargue dos veces.
  async function hashFile(file) {
    try {
      if (!(window.crypto && window.crypto.subtle)) return null;
      const buf = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }

  function addRow() {
    const row = document.createElement('div');
    row.className = 'trow';

    const sel = document.createElement('select');
    sel.className = 'select';
    sel.setAttribute('aria-label', 'Producto');
    sel.innerHTML = '<option value="">Producto…</option>' + allProducts.map((p) => `<option value="${p.id}">${p.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`).join('');

    const qty = document.createElement('input');
    qty.className = 'text';
    qty.type = 'number';
    qty.min = '0.001';
    qty.step = 'any';
    qty.value = '1';
    qty.setAttribute('aria-label', 'Cantidad');
    qty.inputMode = 'decimal';

    const price = document.createElement('input');
    price.className = 'text';
    price.setAttribute('aria-label', 'Precio unitario');
    price.placeholder = 'Precio $';
    price.inputMode = 'decimal';
    price.autocomplete = 'off';

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', 'Quitar línea');
    rm.addEventListener('click', () => {
      row.remove();
      if (!$('ticket-rows').children.length) addRow();
      updateSum();
    });

    [sel, qty, price].forEach((el) => el.addEventListener('input', updateSum));
    row.append(sel, qty, price, rm);
    $('ticket-rows').appendChild(row);
    return row;
  }

  $('add-row').addEventListener('click', () => { addRow().querySelector('select').focus(); });
  $('ticket-total').addEventListener('input', updateSum);

  function readRows() {
    return Array.from($('ticket-rows').children).map((row, i) => {
      const [sel, qty, price] = row.querySelectorAll('select, input');
      return {
        index: i + 1,
        productId: Number(sel.value) || 0,
        qty: parseFloat(String(qty.value).replace(',', '.')),
        cents: parsePrice(price.value),
        raw: price.value.trim(),
      };
    });
  }

  function sumCents(rows) {
    return rows.reduce((s, r) => (r.cents && r.qty > 0 ? s + Math.round(r.cents * r.qty) : s), 0);
  }

  function updateSum() {
    $('ticket-error').hidden = true; // el aviso de un intento anterior ya no corresponde
    ticketOutliers = new Set();
    const rows = readRows();
    const sum = sumCents(rows);
    const totalText = $('ticket-total').value.trim();
    const st = $('sum-status');
    if (!sum) { st.textContent = ''; return; }
    if (!totalText) { st.textContent = `Las líneas suman ${money(sum)}.`; return; }
    const total = parsePrice(totalText);
    if (total === null) { st.textContent = 'Escribí el total como número, por ejemplo 12.500,00.'; return; }
    if (Math.abs(sum - total) <= 100) st.textContent = 'La suma coincide con el total del ticket ✓';
    else st.textContent = `Las líneas suman ${money(sum)} y el total es ${money(total)}. Revisá precios y cantidades, o agregá las líneas que faltan.`;
  }

  function showTicketError(msg) { const el = $('ticket-error'); el.textContent = msg; el.hidden = false; }

  $('ticket-confirm').addEventListener('click', async () => {
    if (busy) return;
    $('ticket-error').hidden = true;
    const rows = readRows();
    const touched = rows.filter((r) => r.productId || r.raw);
    if (!touched.length) { showTicketError('Agregá al menos una línea con producto y precio.'); return; }
    const seen = new Set();
    for (const r of touched) {
      if (!r.productId) { showTicketError(`Línea ${r.index}: elegí el producto.`); return; }
      if (r.cents === null) { showTicketError(`Línea ${r.index}: escribí un precio válido.`); return; }
      if (!(r.qty > 0)) { showTicketError(`Línea ${r.index}: la cantidad debe ser mayor que cero.`); return; }
      if (seen.has(r.productId)) { showTicketError(`Línea ${r.index}: ese producto ya está en otra línea.`); return; }
      seen.add(r.productId);
    }
    const totalText = $('ticket-total').value.trim();
    const total = totalText ? parsePrice(totalText) : null;
    if (totalText && total === null) { showTicketError('El total del ticket no es un número válido.'); return; }

    busy = true;
    $('ticket-confirm').disabled = true;
    try {
      const payload = {
        businessId: business.id,
        source: 'receipt',
        items: touched.map((r) => ({ productId: r.productId, priceCents: r.cents, confirmOutlier: ticketOutliers.has(r.productId) })),
      };
      if (photoHash) payload.receipt = { hash: photoHash, totalCents: total };
      await API.report(payload);
      savedLines.push(...touched.map((r) => ({ productId: r.productId, name: (byId(r.productId) || {}).name || 'Producto', priceCents: r.cents, promo: false, source: 'receipt' })));
      clearPhoto(); // la foto se descarta al terminar
      finish();
    } catch (e) {
      if (e.code === 'outlier') {
        // Se marcan las líneas raras; si la persona vuelve a confirmar, se envían con confirmación.
        ticketOutliers = new Set(e.extra.productIds || []);
        const lines = touched.filter((r) => ticketOutliers.has(r.productId)).map((r) => r.index).join(', ');
        showTicketError(`Las líneas ${lines} tienen precios que se alejan mucho de lo que conocemos. Revisalas: si son correctas, tocá Confirmar precios otra vez.`);
      } else if (e.code === 'login_required') sessionExpired();
      else if (e.code === 'duplicate') showTicketError('Alguno de esos precios ya lo sumaste hoy. Quitá esa línea y probá de nuevo.');
      else showTicketError(e.message);
    } finally {
      busy = false;
      $('ticket-confirm').disabled = false;
    }
  });

  $('ticket-back').addEventListener('click', () => { clearPhoto(); backToChoose(); });

  // ---------------------------------------------------------------- cierre
  function finish() {
    stopScan();
    const n = savedLines.length;
    $('done-title').textContent = `¡Listo! Sumaste ${n} precio${n === 1 ? '' : 's'}`;
    $('done-sub').textContent = `Gracias por ayudar a tu barrio a decidir mejor. Los precios son de ${business.name}.`;
    const list = $('done-list');
    list.innerHTML = '';
    savedLines.forEach((r) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = r.name + (r.promo ? ' (oferta)' : '');
      const b = document.createElement('span');
      b.textContent = money(r.priceCents);
      li.append(a, b);
      list.appendChild(li);
    });
    $('done-note').hidden = true;
    showStep('done');
    announce(`Sumaste ${n} precios`);
  }

  $('done-again').addEventListener('click', () => { savedLines = []; backToChoose(); });

  function backToChoose(moveFocus = true) {
    method = null;
    showStep('choose', moveFocus);
  }

  // ---------------------------------------------------------------- inicio
  function renderAuth() {
    window.PreciumSession.renderNav($('nav-auth'), renderAuth);
    const logged = Boolean(window.PreciumSession.user());
    gate.hidden = logged;
    flow.hidden = !logged;
    if (!logged) { stopScan(); savedLines = []; flow.dataset.ready = ''; }
    if (logged && !flow.dataset.ready) startFlow();
  }

  async function startFlow() {
    flow.dataset.ready = '1';
    setupScanOption();
    backToChoose(false); // al cargar no se mueve el foco
    updateBusinessStatus();

    // El catálogo (para el desplegable del ticket) y el producto que viene desde la canasta.
    API.products('', 500).then((r) => { allProducts = r.products; remember(allProducts); }).catch(() => {});
    const wantedId = params.get('producto');
    if (wantedId) { try { wanted = (await API.product(wantedId)).product; remember([wanted]); } catch (e) { wanted = null; } }

    location = await getLocation();
    try { businesses = (await API.businesses(location, 5, 50)).businesses; } catch (e) { businesses = []; $('biz-status').textContent = e.message; }

    const wantedBiz = params.get('comercio');
    if (wantedBiz && !businesses.some((b) => String(b.id) === wantedBiz)) {
      try { businesses.push((await API.business(wantedBiz)).business); } catch (e) { /* comercio inexistente */ }
    }
    if (wantedBiz) business = businesses.find((b) => String(b.id) === wantedBiz) || null;
    else if (!location.approx && businesses.length && distanceKm(location, businesses[0]) <= NEAR_KM) business = businesses[0];
    fillBusinessSelect();
    updateBusinessStatus();
    updateMissingHint();
  }

  window.PreciumSession.ready.then(renderAuth);
})();
