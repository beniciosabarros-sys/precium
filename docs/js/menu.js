// Precium — comportamiento del menú lateral (hamburguesa).
// Se reutiliza en todas las páginas que incluyan #mb / #menu / #ov en su HTML.
// Al abrirse, el foco pasa al primer enlace y queda dentro del menú; al cerrarse, vuelve al botón.

(function () {
  'use strict';
  const btn = document.getElementById('mb');
  const menu = document.getElementById('menu');
  const overlay = document.getElementById('ov');
  if (!btn || !menu || !overlay) return;

  const isOpen = () => menu.classList.contains('open');
  const links = () => Array.from(menu.querySelectorAll('a'));

  function setOpen(open) {
    const was = isOpen();
    menu.classList.toggle('open', open);
    overlay.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
    if (open && !was) {
      const first = links()[0];
      // El menú pasa de visibility:hidden a visible; se enfoca en el cuadro siguiente.
      if (first) setTimeout(() => first.focus(), 50);
    } else if (!open && was) {
      btn.focus();
    }
  }

  btn.addEventListener('click', () => setOpen(!isOpen()));
  overlay.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Tab') {
      const list = links();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!menu.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
})();
