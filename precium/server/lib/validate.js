// Precium — validaciones de entrada compartidas por las rutas.

'use strict';

const { HttpError } = require('./http');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);

function str(v, name, min, max) {
  if (typeof v !== 'string') throw bad('invalid_' + name, `Falta ${name}.`);
  const s = v.trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (s.length < min || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) throw bad('invalid_' + name, `Revisá ${name}.`);
  return s;
}

function email(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw bad('invalid_email', 'Revisá el correo: parece incompleto.');
  return e;
}

function password(v) {
  if (typeof v !== 'string' || v.length < 8) throw bad('weak_password', 'Usá al menos 8 caracteres.');
  if (v.length > 200) throw bad('invalid_password', 'La contraseña es demasiado larga.');
  return v;
}

function int(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad('invalid_' + name, `Revisá ${name}.`);
  return v;
}

function num(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad('invalid_' + name, `Revisá ${name}.`);
  return v;
}

// Coordenadas opcionales: si faltan, se usa la ubicación de referencia y se marca como aproximada.
function location(body, fallback) {
  if (body.lat === undefined && body.lng === undefined) return { ...fallback, approx: true };
  return { lat: num(body.lat, 'lat', -90, 90), lng: num(body.lng, 'lng', -180, 180), approx: false };
}

module.exports = { str, email, password, int, num, location, bad };
