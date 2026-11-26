// Precium — formularios de inicio de sesión y registro. Valida en el navegador (comodidad) y
// llama a la API, que vuelve a validar todo. Requiere api.js y session.js.

(function () {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // A dónde volver después de entrar: ?next=/ruta, o la página de Precium de la que venís.
  // Solo se aceptan rutas del mismo sitio (nunca //otro.com ni http://...).
  function nextUrl() {
    const safe = (p) => (typeof p === 'string' && /^\/(?!\/)[^\s]*$/.test(p) && !/^\/(login|registro)\.html/.test(p)) ? p : null;
    const q = new URLSearchParams(location.search).get('next');
    if (safe(q)) return q;
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === location.origin && safe(ref.pathname)) return ref.pathname + ref.hash;
    } catch (e) { /* sin referrer */ }
    return '/canasta.html';
  }

  function fieldError(input, msg) {
    const err = document.getElementById(input.id + '-err');
    if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return !msg;
  }

  function validate(rules) {
    let first = null;
    rules.forEach(([input, msg]) => {
      if (!fieldError(input, msg) && !first) first = input;
    });
    if (first) first.focus();
    return !first;
  }

  async function init(mode) {
    // Si ya hay sesión, no tiene sentido mostrar el formulario.
    await window.PreciumSession.ready;
    if (window.PreciumSession.user()) { location.replace(nextUrl()); return; }

    const $ = (id) => document.getElementById(id);
    const next = nextUrl();
    ['to-reg', 'to-login'].forEach((id) => {
      const a = $(id);
      if (a) a.href = a.getAttribute('href').split('?')[0] + '?next=' + encodeURIComponent(next);
    });

    const form = $(mode === 'login' ? 'login-form' : 'reg-form');
    const formErr = $('form-err');
    const submit = form.querySelector('button[type=submit]');
    const clearForm = () => { formErr.hidden = true; };
    form.addEventListener('input', (e) => { if (e.target.id) fieldError(e.target, ''); clearForm(); });
    form.addEventListener('change', (e) => { if (e.target.id) fieldError(e.target, ''); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearForm();
      const email = $('email'), pass = $('pass');
      const emailMsg = !email.value.trim() ? 'Ingresá tu correo.' : (!EMAIL_RE.test(email.value.trim()) ? 'Revisá el correo: parece incompleto.' : '');
      let rules;
      if (mode === 'login') {
        rules = [[email, emailMsg], [pass, pass.value ? '' : 'Ingresá tu contraseña.']];
      } else {
        const nm = $('name'), pass2 = $('pass2'), terms = $('terms');
        rules = [
          [nm, nm.value.trim() ? '' : 'Contanos tu nombre.'],
          [email, emailMsg],
          [pass, pass.value.length >= 8 ? '' : 'Usá al menos 8 caracteres.'],
          [pass2, pass2.value && pass2.value === pass.value ? '' : (pass2.value ? 'Las contraseñas no coinciden.' : 'Repetí la contraseña.')],
          [terms, terms.checked ? '' : 'Para crear la cuenta tenés que aceptar los términos.'],
        ];
      }
      if (!validate(rules)) return;

      submit.disabled = true;
      try {
        const r = mode === 'login'
          ? await window.PreciumAPI.login(email.value.trim(), pass.value)
          : await window.PreciumAPI.register($('name').value.trim(), email.value.trim(), pass.value);
        window.PreciumSession.set(r.user);
        location.assign(next);
      } catch (err) {
        submit.disabled = false;
        if (err.code === 'email_taken' || err.code === 'invalid_email') { fieldError(email, err.message); email.focus(); }
        else if (err.code === 'weak_password') { fieldError(pass, err.message); pass.focus(); }
        else { formErr.textContent = err.message; formErr.hidden = false; }
      }
    });
  }

  window.PreciumAuth = { init, nextUrl };
})();
