// Precium — sesión de usuario. La verdad vive en el servidor (cookie HttpOnly): acá solo se
// guarda en memoria quién está dentro, para dibujar la interfaz. Requiere api.js.
//
//   await PreciumSession.ready      // espera a saber si hay sesión
//   PreciumSession.user()           // { id, name } o null (después de ready)
//   PreciumSession.renderNav(nav, onChange)

(function () {
  'use strict';
  let current = null;

  const ready = window.PreciumAPI.me().then((r) => { current = r.user; }).catch(() => { current = null; });

  function renderNav(nav, onChange) {
    return ready.then(() => {
      nav.innerHTML = '';
      if (current) {
        const hi = document.createElement('span');
        hi.textContent = current.name;
        hi.style.color = 'var(--muted)';
        const out = document.createElement('button');
        out.type = 'button';
        out.className = 'pill';
        out.textContent = 'Salir';
        out.style.cssText = 'background:none;font:inherit;color:var(--ink);cursor:pointer';
        out.addEventListener('click', async () => {
          out.disabled = true;
          try { await window.PreciumAPI.logout(); } catch (e) { /* si falla la red, igual se limpia la pantalla */ }
          current = null;
          renderNav(nav, onChange);
          if (onChange) onChange();
        });
        nav.append(hi, out);
      } else {
        nav.innerHTML = '<a href="/login.html">Iniciar sesión</a><a class="pill" href="/registro.html">Registrarse</a>';
      }
    });
  }

  window.PreciumSession = {
    ready,
    user: () => current,
    set(user) { current = user; },
    renderNav,
  };
})();
