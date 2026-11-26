// Precium — normalización de códigos de barras.
// Se guardan y se buscan SIN ceros a la izquierda, así un EAN-13 con cero inicial
// y su versión UPC-A de 12 dígitos quedan iguales. Los códigos de menos de 6 dígitos
// se descartan: suelen ser códigos internos de balanza (frutas, fiambres, pan), no EAN.

'use strict';

function normEan(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 6 ? digits : null;
}

module.exports = { normEan };
