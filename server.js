'use strict';
// IP Libres UGEL — escáner de red + panel web móvil. Sin dependencias (solo Node.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const crypto = require('crypto');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const DATA_FILE = path.join(DIR, 'data.json');
const INDEX = path.join(DIR, 'index.html');
const WIN = process.platform === 'win32';
const INTERVALO = (CFG.intervaloMinutos || 5) * 60000;
const DIAS_AUSENTE = CFG.diasAusente || 7;

let data = { ips: {}, ultimoEscaneo: null, duracionMs: 0 };
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* primer arranque */ }
let escaneando = false;
let proximo = null;
let timer = null;

const LISTA = [];
for (const s of CFG.segmentos) for (let i = s.desde; i <= s.hasta; i++) LISTA.push(`${s.red}.${i}`);
const VALIDAS = new Set(LISTA);

// ---------- Inventario (Google Sheet publicado o inventario.csv local) ----------
const INV_FILE = path.join(DIR, 'inventario.csv');
const INV_CFG = CFG.inventario || {};
let INV = { mapa: {}, sinIp: [], total: 0, ts: null, origen: null, error: null };

function csvFilas(txt) {
  const filas = []; let fila = [], campo = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += c; }
    else if (c === '"') q = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}
const limpio = s => String(s || '').replace(/\s+/g, ' ').trim();
const RE_IP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Formato de la hoja: AREA, FUNCIONARIO, IP, SWITCH. El área solo va en la primera fila de cada grupo.
// Filas como "WIFI,,IP," o "SERVIDORES,,IP," abren una sección donde el nombre va en la 1.ª columna.
function parsearInventario(txt) {
  const mapa = {}, sinIp = [];
  let area = '', sw = '', seccion = false, total = 0;
  for (const f of csvFilas(txt)) {
    const [c0, c1, c2, c3] = [0, 1, 2, 3].map(i => limpio(f[i]));
    if (!c0 && !c1 && !c2 && !c3) continue;
    if (c2.toUpperCase() === 'IP') { seccion = c1.toUpperCase() !== 'FUNCIONARIO'; area = seccion ? c0 : ''; sw = ''; continue; }
    let nombre;
    if (seccion) nombre = c0 || c1;
    else { if (c0) { area = c0; sw = ''; } nombre = c1; }
    if (c3) sw = c3;
    if (!nombre && !c2) continue;
    total++;
    const e = { area, nombre: nombre || '(sin nombre)', switch: sw || undefined };
    if (RE_IP.test(c2)) (mapa[c2] = mapa[c2] || []).push(e);
    else sinIp.push(Object.assign(e, { ip: c2 || '' }));
  }
  return { mapa, sinIp, total };
}

// Descarga con Node; si falla (p. ej. la red sale por un proxy de Windows), reintenta con PowerShell,
// que usa la configuración de proxy del sistema.
async function descargar(url) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    if (!WIN) throw e;
    const tmp = path.join(DIR, 'inventario.tmp');
    const ps = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; " +
      "[Net.WebRequest]::DefaultWebProxy.Credentials=[Net.CredentialCache]::DefaultNetworkCredentials; " +
      `Invoke-WebRequest -UseBasicParsing -TimeoutSec 40 -Uri '${url.replace(/'/g, "''")}' -OutFile '${tmp}'`;
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 60000);
    if (r.err || !fs.existsSync(tmp)) throw new Error(`Node: ${e.message}; PowerShell: ${r.err ? r.err.message.split('\n').pop() : 'sin archivo'}`);
    const txt = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    return txt;
  }
}
// ---------- Inventario editable: inventario.json es la fuente principal ----------
// El Google Sheet solo se usa para importar (botón en la app) y el Excel para exportar.
const INVJ_FILE = path.join(DIR, 'inventario.json');
const TIPOS = ['PC', 'Laptop', 'Impresora', 'Fotocopiadora', 'Servidor', 'Wi-Fi', 'Cámara', 'Televisor', 'Teléfono IP', 'Router', 'Switch', 'Otro'];
let INVD = { version: 1, equipos: [], historial: [] };
let invVer = Date.now();
const nuevoId = () => crypto.randomBytes(5).toString('hex');

function reindexar() {
  const mapa = {}, sinIp = [];
  for (const e of INVD.equipos) {
    const x = { id: e.id, area: e.area, nombre: e.nombre, tipo: e.tipo, switch: e.switch || undefined, puerto: e.puerto || undefined, rev: (e.revisar && e.revisar.length) || undefined };
    if (e.ip && RE_IP.test(e.ip)) (mapa[e.ip] = mapa[e.ip] || []).push(x);
    else if (e.tipo !== 'Switch') sinIp.push(Object.assign(x, { ip: '' }));
  }
  INV = { mapa, sinIp, total: INVD.equipos.length, ts: invVer, origen: 'inventario de la app', error: null };
}
function guardarInv() {
  if (INVD.historial.length > 2000) INVD.historial = INVD.historial.slice(-2000);
  const tmp = INVJ_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(INVD, null, 1));
  fs.renameSync(tmp, INVJ_FILE);
  invVer = Date.now();
  reindexar();
}
function registrar(accion, e, por, cambios) {
  INVD.historial.push({ ts: Date.now(), accion, id: e.id, ip: e.ip, nombre: e.nombre, por: por || undefined, cambios });
}
function cargarInv() {
  try {
    INVD = JSON.parse(fs.readFileSync(INVJ_FILE, 'utf8'));
  } catch (err) {
    // Primera vez sin inventario.json: se arma desde la última copia del Google Sheet
    INVD = { version: 1, equipos: [], historial: [] };
    try {
      const p = parsearInventario(fs.readFileSync(INV_FILE, 'utf8'));
      const add = (ip, e) => INVD.equipos.push({ id: nuevoId(), ip, area: e.area || '', nombre: e.nombre, tipo: 'PC', switch: e.switch || '', puerto: '', notas: '', revisar: [], origen: ['excel'], creado: Date.now(), editado: Date.now() });
      for (const [ip, l] of Object.entries(p.mapa)) l.forEach(e => add(ip, e));
      p.sinIp.forEach(e => add('', e));
    } catch (e2) { /* sin datos previos */ }
    if (INVD.equipos.length) guardarInv();
  }
  INVD.historial = INVD.historial || [];
  reindexar();
}
cargarInv();
const etiquetaInv = e => [e.area, e.nombre].filter(Boolean).join(' – ');

const sinTilde = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
function tipoPorTexto(t) {
  const s = sinTilde(t);
  if (/CAMARA|HIKVISION|DVR|NVR/.test(s)) return 'Cámara';
  if (/FOTOCOP/.test(s)) return 'Fotocopiadora';
  if (/IMPRES/.test(s)) return 'Impresora';
  if (/WIFI|WI-FI|ACCESS POINT|\bAP\b/.test(s)) return 'Wi-Fi';
  if (/LAPTOP|PORTATIL/.test(s)) return 'Laptop';
  if (/SERVIDOR|\bSRV/.test(s)) return 'Servidor';
  if (/TELEVISOR|\bTV\b/.test(s)) return 'Televisor';
  if (/TELEFONO/.test(s)) return 'Teléfono IP';
  return null;
}
// Las notas que el equipo escribió en la app pasan al inventario una sola vez (así no hay datos duplicados)
function migrarNotas() {
  if (data.notasMigradas) return;
  const areas = [...new Set(INVD.equipos.map(e => e.area).filter(Boolean))];
  let movidas = 0;
  for (const [ip, r] of Object.entries(data.ips)) {
    if (!r.nota) continue;
    const nota = limpio(r.nota);
    const e = INVD.equipos.find(x => x.ip === ip);
    const t = tipoPorTexto(nota);
    if (e) {
      if (!sinTilde(e.notas).includes(sinTilde(nota))) e.notas = [e.notas, `Nota de la app: ${nota}`].filter(Boolean).join('. ');
      const compatible = !t || t === e.tipo || (t === 'Impresora' && e.tipo === 'Fotocopiadora') || (t === 'Fotocopiadora' && e.tipo === 'Impresora');
      if (!compatible) e.revisar = (e.revisar || []).concat(`Una nota de la app dice «${nota}», pero aquí figura como ${e.tipo} de ${e.nombre}. Confirma cuál es correcto`);
    } else {
      const area = areas.find(a => sinTilde(nota).includes(sinTilde(a))) || '';
      INVD.equipos.push({ id: nuevoId(), ip, area, nombre: nota, tipo: t || 'PC', switch: '', puerto: '', notas: '', origen: ['nota de la app'],
        revisar: [area ? 'Agregado desde una nota de la app. Revisa los datos' : 'Agregado desde una nota de la app: falta su área'],
        creado: r.fechaNota || Date.now(), editado: Date.now(), por: r.por || undefined });
    }
    delete r.nota; delete r.por; delete r.fechaNota;
    movidas++;
  }
  data.notasMigradas = Date.now();
  if (movidas) { INVD.historial.push({ ts: Date.now(), accion: 'migrar', nombre: `${movidas} notas de la app pasaron al inventario` }); guardarInv(); }
  guardar();
  console.log(`Notas migradas al inventario: ${movidas}`);
}
migrarNotas();

// Importa el Google Sheet y lo une con el inventario. No pisa fichas que ya se editaron en la app.
async function importarSheet(por) {
  if (!INV_CFG.url) throw new Error('No hay un Google Sheet configurado en config.json');
  const txt = await descargar(INV_CFG.url);
  if (/<html/i.test(txt.slice(0, 300))) throw new Error('El Google Sheet no respondió como CSV. Revisa que siga compartido con enlace');
  const p = parsearInventario(txt);
  if (!p.total) throw new Error('La hoja llegó vacía');
  fs.writeFileSync(INV_FILE, txt);
  const r = { nuevos: 0, actualizados: 0, protegidos: 0, iguales: 0 };
  const filas = Object.entries(p.mapa).flatMap(([ip, l]) => l.map(e => ({ ip, ...e }))).concat(p.sinIp.map(e => ({ ...e, ip: '' })));
  for (const f of filas) {
    const area = f.area || '', nombre = f.nombre;
    let e = f.ip ? INVD.equipos.find(x => x.ip === f.ip) : INVD.equipos.find(x => !x.ip && sinTilde(x.nombre) === sinTilde(nombre));
    if (!e) {
      e = { id: nuevoId(), ip: f.ip, area, nombre, tipo: tipoPorTexto(nombre) || 'PC', switch: f.switch || '', puerto: '', notas: '', origen: ['excel'],
        revisar: ['Agregado al importar el Google Sheet'], creado: Date.now(), editado: Date.now(), por };
      INVD.equipos.push(e); registrar('importar', e, por); r.nuevos++;
    } else if (sinTilde(e.nombre) === sinTilde(nombre) && sinTilde(e.area) === sinTilde(area)) r.iguales++;
    else if (e.editadoApp) r.protegidos++;
    else {
      const cambios = {};
      if (sinTilde(e.nombre) !== sinTilde(nombre)) { cambios.nombre = [e.nombre, nombre]; e.nombre = nombre; }
      if (area && sinTilde(e.area) !== sinTilde(area)) { cambios.area = [e.area, area]; e.area = area; }
      e.editado = Date.now(); registrar('importar', e, por, cambios); r.actualizados++;
    }
  }
  guardarInv();
  return r;
}
function csvCelda(v) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportarCsv() {
  const n = ip => ip ? ip.split('.').reduce((a, b) => a * 256 + +b, 0) : Infinity;
  const filas = INVD.equipos.slice().sort((a, b) => (!a.area - !b.area) || (a.area || '').localeCompare(b.area || '', 'es') || n(a.ip) - n(b.ip));
  const head = ['AREA', 'FUNCIONARIO / EQUIPO', 'IP', 'TIPO', 'SWITCH', 'PUERTO', 'NOTAS', 'POR REVISAR'];
  return '﻿' + [head].concat(filas.map(e => [e.area, e.nombre, e.ip, e.tipo, e.switch, e.puerto, e.notas, (e.revisar || []).join(' | ')]))
    .map(f => f.map(csvCelda).join(',')).join('\r\n');
}

function guardar() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
function run(cmd, args, timeout) {
  return new Promise(res => execFile(cmd, args, { timeout, windowsHide: true },
    (err, stdout) => res({ err, out: String(stdout || '') })));
}
async function enParalelo(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function ping(ip) {
  if (WIN) {
    // En Windows el código de salida no es fiable ("Host de destino inaccesible" devuelve 0): se busca TTL=
    const { out } = await run('ping', ['-n', '1', '-w', '700', ip], 3500);
    return /TTL=/i.test(out);
  }
  const { err } = await run('ping', ['-c', '1', '-W', '1', ip], 3500);
  return !err;
}

const RE_MAC = /(\d+\.\d+\.\d+\.\d+)\s+.*?([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i;
function parsearVecinos(out) {
  const mapa = {};
  for (const linea of out.split(/\r?\n/)) {
    const m = linea.match(RE_MAC);
    if (!m) continue;
    const mac = m[2].toLowerCase().replace(/-/g, ':');
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5e')) continue;
    mapa[m[1]] = mac;
  }
  return mapa;
}
// Equipos que respondieron a ARP (detecta PCs con el ping bloqueado por firewall; solo en la misma subred del servidor)
async function vecinosAlcanzables() {
  if (WIN) {
    const ps = "Get-NetNeighbor -AddressFamily IPv4 -State Reachable -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress + ' ' + $_.LinkLayerAddress }";
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 20000);
    if (!r.err) return parsearVecinos(r.out);
    return parsearVecinos((await run('arp', ['-a'], 8000)).out); // respaldo para Windows antiguos
  }
  return parsearVecinos((await run('ip', ['neigh', 'show', 'nud', 'reachable'], 8000)).out);
}

async function nombreDe(ip) {
  try {
    const r = await Promise.race([dns.reverse(ip), esperar(1500).then(() => [])]);
    if (r && r[0]) return r[0].split('.')[0].toUpperCase();
  } catch (e) { /* sin PTR */ }
  if (WIN) { // NetBIOS, como hace Advanced IP Scanner
    const { out } = await run('nbtstat', ['-A', ip], 5000);
    const re = /^\s*([^\s<]+)\s*<00>\s+(\S+)/gm;
    let m;
    while ((m = re.exec(out))) if (!/^gru|^group/i.test(m[2])) return m[1].toUpperCase();
  } else { // En Ubuntu: nmblookup (paquete samba-common-bin), si está instalado
    const { err, out } = await run('nmblookup', ['-A', ip], 5000);
    if (!err) { const m = out.match(/^\s*([^\s<]+)\s*<00>\s+-\s+(?!<GROUP>)/m); if (m) return m[1].toUpperCase(); }
  }
  return null;
}

async function escanear() {
  if (escaneando) return;
  escaneando = true;
  clearTimeout(timer);
  const t0 = Date.now();
  try {
    const vivos = new Set();
    await enParalelo(LISTA, CFG.concurrencia || 100, async ip => { if (await ping(ip)) vivos.add(ip); });
    await esperar(7000); // deja que la tabla de vecinos termine de confirmar/descartar entradas
    const arp = await vecinosAlcanzables();
    const ahora = Date.now();
    const porNombrar = [];
    const cambios = [];
    for (const ip of LISTA) {
      const activo = vivos.has(ip) || !!arp[ip];
      let r = data.ips[ip];
      if (!activo) { if (r) r.activo = false; continue; }
      if (!r) r = data.ips[ip] = {};
      r.activo = true;
      r.visto = ahora;
      r.via = vivos.has(ip) ? 'ping' : 'arp';
      if (arp[ip]) {
        const nueva = arp[ip];
        r.macs = r.macs || {};
        if (r.mac && !r.macs[r.mac]) r.macs[r.mac] = { primero: r.visto, ultimo: r.visto, host: r.host || null };
        if (r.mac && r.mac !== nueva) {
          // Otra tarjeta de red respondió por esta IP. Si esa MAC ya se había visto aquí antes,
          // la IP está alternando entre dos equipos: señal fuerte de IP duplicada.
          const previa = r.macs[nueva];
          const alterna = previa && ahora - previa.ultimo < 30 * 864e5;
          cambios.push({ ip, antes: { mac: r.mac, host: r.host || null }, tipo: alterna ? 'duplicada' : 'cambio' });
          r.host = null;
        }
        r.mac = nueva;
        const m = r.macs[nueva] || (r.macs[nueva] = { primero: ahora, host: null });
        m.ultimo = ahora;
        const ks = Object.keys(r.macs).sort((a, b) => r.macs[b].ultimo - r.macs[a].ultimo);
        for (const k of ks.slice(5)) delete r.macs[k];
      }
      if (!r.host || !r.hostTs || ahora - r.hostTs > 864e5) porNombrar.push(ip);
    }
    await enParalelo(porNombrar, 16, async ip => {
      const n = await nombreDe(ip);
      const r = data.ips[ip];
      if (n) r.host = n;
      r.hostTs = Date.now();
      if (r.mac && r.macs && r.macs[r.mac] && r.host) r.macs[r.mac].host = r.host;
    });
    registrarAlertas(cambios, ahora);
    try { aprenderMacs(); } catch (e) { console.error('Error al aprender MACs:', e); }
    data.ultimoEscaneo = ahora;
    data.duracionMs = Date.now() - t0;
    guardar();
    console.log(new Date().toLocaleString(), `Escaneo: ${vivos.size} por ping, ${Object.keys(arp).length} por ARP, ${Math.round(data.duracionMs / 1000)} s`);
  } catch (e) {
    console.error('Error en escaneo:', e);
  } finally {
    escaneando = false;
    proximo = Date.now() + INTERVALO;
    timer = setTimeout(escanear, INTERVALO);
  }
}

function registrarAlertas(cambios, ahora) {
  data.alertas = data.alertas || [];
  for (const c of cambios) {
    const r = data.ips[c.ip];
    const actual = { mac: r.mac, host: r.host || null };
    // No es conflicto: celulares del Wi-Fi (MAC privada) ni la misma PC con otra tarjeta (mismo nombre)
    if (macAleatoria(actual.mac) || macAleatoria(c.antes.mac)) continue;
    if (actual.host && c.antes.host && actual.host === c.antes.host) continue;
    let a = data.alertas.find(x => !x.revisada && x.ip === c.ip);
    if (a) {
      if (c.tipo === 'duplicada') a.tipo = 'duplicada';
      a.veces = (a.veces || 1) + 1;
      a.ts = ahora;
    } else {
      a = { id: ahora.toString(36) + Math.random().toString(36).slice(2, 6), ip: c.ip, tipo: c.tipo, equipos: [], inicio: ahora, ts: ahora, veces: 1 };
      data.alertas.push(a);
    }
    for (const e of [c.antes, actual]) {
      const prev = a.equipos.find(x => x.mac === e.mac);
      if (prev) { if (e.host) prev.host = e.host; } else a.equipos.push(e);
    }
    console.log(new Date().toLocaleString(), `ALERTA ${a.tipo} ${c.ip}:`, a.equipos.map(e => `${e.host || '?'} ${e.mac}`).join(' / '));
  }
  cerrarAlertasViejas(ahora);
  // Conserva todas las pendientes y solo las 50 revisadas más recientes
  const rev = data.alertas.filter(a => a.revisada).sort((a, b) => b.ts - a.ts).slice(0, 50);
  data.alertas = data.alertas.filter(a => !a.revisada).concat(rev);
}

// Una alerta de red se muestra solo si es un conflicto real y reciente: dos equipos distintos (sin MAC
// privada, con nombre distinto) alternando en la misma IP en los últimos 7 días. El resto se cierra solo.
function alertaVigente(a, ahora) {
  if (a.revisada || a.tipo !== 'duplicada') return false;
  if (ahora - a.ts > 7 * 864e5) return false;
  const reales = a.equipos.filter(e => !macAleatoria(e.mac));
  if (reales.length < 2) return false;
  const nombres = new Set(reales.map(e => e.host).filter(Boolean));
  return !(nombres.size === 1 && reales.every(e => e.host));
}
function cerrarAlertasViejas(ahora) {
  let n = 0;
  for (const a of data.alertas || []) if (!a.revisada && !alertaVigente(a, ahora)) { a.revisada = ahora; a.resolucion = 'Cerrada sola: no era un conflicto real o no se repitió en 7 días'; n++; }
  return n;
}

// ---------- DHCP: reconocer cada equipo del inventario por su MAC, aunque el DHCP le dé otra IP ----------
const normMac = m => { const h = String(m || '').toLowerCase().replace(/[^0-9a-f]/g, ''); return h.length === 12 ? h.match(/../g).join(':') : null; };
// La MAC de cada ficha se aprende del historial de su IP: la tarjeta de red real (no privada) que más tiempo
// la usó. Cada MAC va a una sola ficha y nunca se pisa una MAC escrita a mano (macAuto = false).
function aprenderMacs() {
  const usadas = new Set(INVD.equipos.filter(e => e.mac && !e.macAuto).map(e => e.mac));
  const pares = [], hosts = hostsPorMac();
  const noPC = e => !['PC', 'Laptop', 'Servidor', 'Otro', ''].includes(e.tipo || '');
  for (const e of INVD.equipos) {
    if (e.macAuto === false) continue; // escrita a mano (o borrada a propósito)
    const no = new Set(e.macNo || []);
    const r = e.ip && data.ips[e.ip];
    for (const [m, v] of Object.entries((r && r.macs) || {})) {
      if (macAleatoria(m) || usadas.has(m) || no.has(m)) continue;
      // Una impresora, cámara, etc. no puede ser una PC con Windows
      if (noPC(e) && (hosts[m] || []).some(h => /^(DESKTOP|LAPTOP)-/i.test(h))) continue;
      // Si el DHCP le prestó esta IP a esa MAC con otro nombre de equipo, solo cuenta si no hay nada mejor
      const dl = data.dhcp && data.dhcp.L && data.dhcp.L[e.ip];
      const prestada = dl && dl.est === 'prestada' && dl.mac === m;
      pares.push({ e, m, s: (v.ultimo - v.primero) + (r.activo && r.mac === m ? 30 * 864e5 : 0) + 1 - (prestada ? 1e12 : 0) });
    }
    if (e.mac && !usadas.has(e.mac) && !no.has(e.mac) && !(noPC(e) && (hosts[e.mac] || []).some(h => /^(DESKTOP|LAPTOP)-/i.test(h))))
      pares.push({ e, m: e.mac, s: -1.5e12 }); // la ya aprendida se conserva si no hay nada mejor
  }
  pares.sort((a, b) => b.s - a.s);
  const hecho = new Set(), nuevas = new Map();
  for (const p of pares) {
    if (hecho.has(p.e.id) || usadas.has(p.m)) continue;
    hecho.add(p.e.id); usadas.add(p.m); nuevas.set(p.e.id, p.m);
  }
  let cambio = false;
  for (const e of INVD.equipos) {
    if (e.macAuto === false) continue;
    const m = nuevas.get(e.id) || '';
    if ((e.mac || '') !== m) { e.mac = m || undefined; e.macAuto = m ? true : undefined; cambio = true; }
  }
  if (cambio) guardarInv();
}
// Nombres de equipo vistos por MAC (escaneo + DHCP)
function hostsPorMac() {
  const h = {};
  const add = (m, n) => { if (m && n && !(h[m] = h[m] || []).includes(n)) h[m].push(n); };
  for (const r of Object.values(data.ips)) for (const [m, v] of Object.entries(r.macs || {})) add(m, v.host);
  for (const v of Object.values((data.dhcp && data.dhcp.L) || {})) add(v.mac, v.host);
  return h;
}
// Índice MAC -> IPs donde se ha visto (la más reciente primero)
function indiceMacs() {
  const idx = {};
  for (const [ip, r] of Object.entries(data.ips)) {
    for (const [m, v] of Object.entries(r.macs || {})) (idx[m] = idx[m] || []).push({ ip, ultimo: v.ultimo, on: !!(r.activo && r.mac === m) });
    if (r.mac && !(r.macs && r.macs[r.mac]) && r.visto) (idx[r.mac] = idx[r.mac] || []).push({ ip, ultimo: r.visto, on: !!r.activo });
  }
  for (const l of Object.values(idx)) l.sort((a, b) => (b.on - a.on) || (b.ultimo - a.ultimo));
  return idx;
}
// Por ficha: su MAC, si está encendida (en su IP o en otra) y las IPs que ha usado
function equiposEnRed() {
  const idx = indiceMacs(), out = {}, porMac = {}, hosts = hostsPorMac();
  for (const e of INVD.equipos) {
    if (!e.mac) continue;
    const l = idx[e.mac] || [];
    const act = l.find(x => x.on);
    out[e.id] = { mac: e.mac, auto: !!e.macAuto, hosts: hosts[e.mac], on: !!act || undefined, ipActual: act ? act.ip : undefined,
      dhcp: (act && act.ip !== e.ip) || undefined, ips: l.slice(0, 6).map(x => ({ ip: x.ip, ultimo: x.ultimo })) };
    porMac[e.mac] = e;
  }
  return { out, porMac };
}

// ---------- Préstamos del servidor DHCP (Windows Server), enviados por el script dhcp-a-iplibres.ps1 ----------
const DHCP_CFG = CFG.dhcp || {};
const ipN = ip => ip.split('.').reduce((a, b) => a * 256 + (+b || 0), 0);
function recibirDhcp(b) {
  const L = {};
  for (const x of Array.isArray(b.prestamos) ? b.prestamos : []) {
    const ip = String(x.ip || '').trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const host = String(x.host || '').replace(/\.[a-z0-9.-]+$/i, '').slice(0, 60);
    const est = String(x.estado || '');
    L[ip] = { mac: normMac(x.mac) || undefined, host: host && host !== 'BAD_ADDRESS' ? host : undefined,
      est: /Reservation/i.test(est) ? (/Inactive/i.test(est) ? 'reservaInactiva' : 'reserva') : (host === 'BAD_ADDRESS' || /Declined/i.test(est)) ? 'rechazada' : 'prestada',
      vence: x.vence ? String(x.vence).slice(0, 25) : undefined };
  }
  const a = b.ambito || {};
  data.dhcp = { ts: Date.now(), scope: String(a.scope || ''), inicio: String(a.inicio || ''), fin: String(a.fin || ''), duracion: String(a.duracion || ''), L };
  guardar();
  return Object.keys(L).length;
}
// Comandos de PowerShell para reservar en el DHCP la IP de cada ficha con MAC conocida
function reservasPs1() {
  const d = data.dhcp || { L: {} }, L = d.L || {}, scope = d.scope || '172.16.14.0';
  const red = scope.split('.').slice(0, 3).join('.') + '.';
  const yaRes = new Set(Object.entries(L).filter(([, v]) => /reserva/.test(v.est)).map(([ip, v]) => ip + '|' + v.mac));
  const lin = [], ocupadas = [], sinVerificar = [];
  const ini = d.inicio ? ipN(d.inicio) : 0, fin = d.fin ? ipN(d.fin) : Infinity;
  const hostDe = {}; for (const v of Object.values(L)) if (v.mac && v.host) hostDe[v.mac] = v.host;
  const q = t => String(t || '').replace(/["`$]/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const e of INVD.equipos.slice().sort((a, b) => ipN(a.ip || '0.0.0.0') - ipN(b.ip || '0.0.0.0'))) {
    // Solo hace falta reservar las IPs fijas que caen dentro del rango que reparte el DHCP
    if (!e.ip || !e.mac || !e.ip.startsWith(red) || macAleatoria(e.mac) || ['Switch', 'Router'].includes(e.tipo) || ipN(e.ip) < ini || ipN(e.ip) > fin) continue;
    if (yaRes.has(e.ip + '|' + e.mac)) continue;
    const cid = e.mac.replace(/:/g, '-'), otro = L[e.ip];
    const cmd = `R "${e.ip}" "${cid}" "${q(e.nombre).slice(0, 40)}" "${q([e.area, e.tipo].filter(Boolean).join(' - ')).slice(0, 60)}"` +
      `   # ${e.macAuto ? 'MAC aprendida sola, verifica' : 'MAC escrita a mano'}${hostDe[e.mac] ? '; en el DHCP se llama ' + hostDe[e.mac] : ''}`;
    if (e.macAuto) sinVerificar.push(`# ${cmd}`);
    else if (otro && otro.est === 'prestada' && otro.mac !== e.mac) ocupadas.push(`# ${cmd}   # hoy prestada a ${otro.host || otro.mac}: Remove-DhcpServerv4Lease -IPAddress ${e.ip}`);
    else lin.push(cmd);
  }
  return [
    '# Reservas DHCP generadas por IP Libres (' + new Date().toLocaleString('es-PE') + ')',
    '# Ejecutar en el servidor DHCP, en PowerShell como administrador. Solo AGREGA reservas; no borra nada.',
    `# Solo IPs fijas del inventario dentro del rango ${d.inicio || '?'} - ${d.fin || '?'}, para que el DHCP no se las dé a otro equipo.`,
    '# Antes de ejecutar, crea un respaldo:  Export-DhcpServer -File C:\\respaldo-dhcp.xml -Leases',
    `$scope = "${scope}"`,
    'function R($ip, $mac, $nombre, $desc) {',
    '  try { Add-DhcpServerv4Reservation -ScopeId $scope -IPAddress $ip -ClientId $mac -Name $nombre -Description $desc -ErrorAction Stop; Write-Host "OK    $ip  $nombre" -ForegroundColor Green }',
    '  catch { Write-Host "ERROR $ip  $nombre : $($_.Exception.Message)" -ForegroundColor Red }',
    '}',
    `# ${lin.length} reservas`,
    ...lin,
    '',
    `# ${sinVerificar.length} con MAC aprendida sola y SIN VERIFICAR (confírmalas en la app y vuelve a descargar este archivo)`,
    ...sinVerificar,
    '',
    `# ${ocupadas.length} IPs que hoy el DHCP tiene prestadas a OTRO equipo (decide tú: libera el préstamo y luego reserva)`,
    ...ocupadas,
    ''
  ].join('\r\n');
}

// Estado de una IP según el inventario (Drive + Packet Tracer):
// asignada (está en el inventario) > ocupada (encendida sin registrar) > ausente (se vio hace poco) > libre
function estadoDe(ip, fija, lim) {
  const r = data.ips[ip] || {};
  if (INV.mapa[ip] || r.reservada || fija) return 'asignada';
  if (r.activo) return 'ocupada';
  if (r.visto && r.visto > lim) return 'ausente';
  return 'libre';
}
// MAC "privada" (bit de administración local): la usan los celulares y laptops por Wi-Fi
const macAleatoria = m => !!m && (parseInt(m.slice(0, 2), 16) & 2) === 2;
function segmentoDe(ip) {
  return CFG.segmentos.find(s => ip.startsWith(s.red + '.') && +ip.split('.')[3] >= s.desde && +ip.split('.')[3] <= s.hasta);
}
// IPs repetidas en el Excel: se calculan en cada consulta y desaparecen solas cuando se corrige la hoja
const firmaInv = lista => lista.map(etiquetaInv).sort().join('|');
function alertasInventario() {
  data.invOk = data.invOk || {};
  const out = [];
  for (const [ip, lista] of Object.entries(INV.mapa)) {
    if (lista.length < 2) { delete data.invOk[ip]; continue; }
    if (data.invOk[ip] === firmaInv(lista)) continue;
    out.push({ id: 'inv:' + ip, ip, tipo: 'inventario', equipos: lista.map(e => ({ host: etiquetaInv(e), inv: true, id: e.id })), ts: INV.ts });
  }
  return out;
}

function estadoPublico() {
  const lim = Date.now() - DIAS_AUSENTE * 864e5;
  const alertas = alertasInventario().concat((data.alertas || []).filter(a => alertaVigente(a, Date.now())).sort((a, b) => b.ts - a.ts));
  const conAlerta = new Set(alertas.map(a => a.ip));
  const { out: equiposRed, porMac } = equiposEnRed();
  const DL = (data.dhcp && data.dhcp.L) || {};
  return {
    equiposRed,
    dhcp: data.dhcp ? { ts: data.dhcp.ts, scope: data.dhcp.scope, inicio: data.dhcp.inicio, fin: data.dhcp.fin, duracion: data.dhcp.duracion } : undefined,
    ahora: Date.now(), ultimoEscaneo: data.ultimoEscaneo, duracionMs: data.duracionMs,
    escaneando, proximo, intervaloMin: INTERVALO / 60000, diasAusente: DIAS_AUSENTE, pin: !!CFG.pin,
    alertas,
    inventario: { origen: INV.origen, ts: INV.ts, error: INV.error, total: INV.total, sinIp: INV.sinIp, version: invVer, revisar: INVD.equipos.filter(e => e.revisar && e.revisar.length).length, sheet: !!INV_CFG.url },
    segmentos: CFG.segmentos.map(s => {
      const ips = [];
      for (let i = s.desde; i <= s.hasta; i++) {
        const ip = `${s.red}.${i}`;
        const r = data.ips[ip] || {};
        const fija = (s.fijas || {})[i];
        let e = estadoDe(ip, fija, lim);
        // Equipo del inventario que el DHCP puso en esta IP
        const dueno = r.activo && r.mac && porMac[r.mac];
        const de = dueno && dueno.ip !== ip ? { id: dueno.id, nombre: dueno.nombre, area: dueno.area, ip: dueno.ip } : undefined;
        if (de && e === 'ocupada') e = 'dhcp';
        // Ficha de esta IP encendida en otra IP por DHCP
        let dhcpEn;
        for (const f of INV.mapa[ip] || []) { const q = equiposRed[f.id]; if (q && q.dhcp && !r.activo) dhcpEn = q.ipActual; }
        ips.push({ ip, n: i, e, de, dhcpEn, on:!!r.activo || undefined, movil: (r.activo && macAleatoria(r.mac)) || undefined, host: r.host || (DL[ip] && DL[ip].host) || undefined, mac: r.mac, dh: DL[ip], visto: r.visto, inv: INV.mapa[ip],
          via: r.activo ? r.via : undefined, nota: r.nota || fija, reservada: !!r.reservada || undefined,
          fija: fija ? true : undefined, por: r.por, fechaNota: r.fechaNota, alerta: conAlerta.has(ip) || undefined });
      }
      return { nombre: s.nombre, red: s.red, sugerirDesde: s.sugerirDesde || s.desde, mascara: s.mascara || '255.255.255.0', gateway: s.gateway || `${s.red}.1`, ips };
    })
  };
}

// Topología del Packet Tracer (topologia.json) unida al inventario: el nombre y el área del inventario mandan
const VENDOR = new Set(['/vendor/three.module.min.js', '/vendor/OrbitControls.js', '/vendor/CSS2DRenderer.js']);
let TOPO = null, topoMtime = 0;
function topologiaPublica() {
  const f = path.join(DIR, 'topologia.json');
  try { const m = fs.statSync(f).mtimeMs; if (!TOPO || m !== topoMtime) { TOPO = JSON.parse(fs.readFileSync(f, 'utf8')); topoMtime = m; } }
  catch (e) { return { error: 'No se encontró topologia.json', pisos: [], areas: [], equipos: [], enlaces: [] }; }
  // Se une por IP; si la ficha ya no tiene esa IP (p. ej. se la quitaron porque trabaja por DHCP), por su nombre en el Packet Tracer
  const porPT = new Map();
  for (const e of INVD.equipos) if (e.nombrePT && !porPT.has(sinTilde(e.nombrePT))) porPT.set(sinTilde(e.nombrePT), e);
  const equipos = TOPO.equipos.map(d => {
    let ip = d.ips.find(i => INV.mapa[i]) || '';
    let inv = ip ? INV.mapa[ip][0] : null;
    const f = !inv && porPT.get(sinTilde(d.nombre));
    if (f && !(f.ip && TOPO.equipos.some(o => o !== d && o.ips.includes(f.ip)))) { inv = f; ip = f.ip || ''; }
    else if (!inv) ip = d.ips[0] || '';
    return Object.assign({}, d, { ip, nombrePT: d.nombre, nombre: inv ? inv.nombre : d.nombre, areaInv: inv ? inv.area : '', tipoInv: inv ? inv.tipo : '', invId: inv ? inv.id : '' });
  });
  return { version: topoMtime, pisos: TOPO.pisos, areas: TOPO.areas, equipos, enlaces: TOPO.enlaces };
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function leerBody(req, max = 16384) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { rej(new Error('Petición demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { rej(new Error('JSON inválido')); } });
  });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (req.method === 'GET' && url === '/api/estado') return json(res, 200, estadoPublico());
    // ---------- DHCP ----------
    if (req.method === 'POST' && url === '/api/dhcp') {
      if (!DHCP_CFG.token || req.headers['x-token'] !== DHCP_CFG.token) return json(res, 403, { error: 'Token inválido' });
      const n = recibirDhcp(await leerBody(req, 2e6));
      return json(res, 200, { ok: true, prestamos: n });
    }
    if (req.method === 'GET' && url === '/api/dhcp/reservas.ps1') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="reservas-dhcp.ps1"', 'Cache-Control': 'no-store' });
      return res.end('\ufeff' + reservasPs1());
    }
    // ---------- Mapa 3D de la red ----------
    if (req.method === 'GET' && (url === '/mapa' || url === '/mapa/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(DIR, 'mapa.html')).pipe(res);
    }
    if (req.method === 'GET' && VENDOR.has(url)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(DIR, url)).pipe(res);
    }
    if (req.method === 'GET' && url === '/api/topologia') return json(res, 200, topologiaPublica());
    if (req.method === 'GET' && url === '/fondo/persona') {
      const f = ['fondo-persona.jpg', 'fondo-persona.png', 'fondo-persona.webp'].map(n => path.join(DIR, n)).find(n => fs.existsSync(n));
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(f)], 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'POST' && url === '/api/escanear') {
      if (escaneando) return json(res, 200, { ok: false, msg: 'Ya hay un escaneo en curso' });
      if (Date.now() - (data.ultimoEscaneo || 0) < 30000) return json(res, 200, { ok: false, msg: 'Se escaneó hace menos de 30 s' });
      escanear();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/nota') {
      if (CFG.pin && req.headers['x-pin'] !== String(CFG.pin)) return json(res, 401, { error: 'PIN incorrecto' });
      const b = await leerBody(req);
      if (!VALIDAS.has(b.ip)) return json(res, 400, { error: 'IP fuera de los segmentos configurados' });
      const r = data.ips[b.ip] || (data.ips[b.ip] = {});
      const nota = String(b.nota || '').trim().slice(0, 120);
      if (nota) r.nota = nota; else delete r.nota;
      if (b.reservada) r.reservada = true; else delete r.reservada;
      if (nota || r.reservada) { r.por = String(b.por || '').trim().slice(0, 40) || undefined; r.fechaNota = Date.now(); }
      else { delete r.por; delete r.fechaNota; }
      guardar();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/reasignar') {
      if (CFG.pin && req.headers['x-pin'] !== String(CFG.pin)) return json(res, 401, { error: 'PIN incorrecto' });
      const b = await leerBody(req);
      const vieja = String(b.ip || ''), nueva = String(b.nueva || ''), quien = limpio(b.quien).slice(0, 80);
      if (!VALIDAS.has(vieja) || !VALIDAS.has(nueva)) return json(res, 400, { error: 'IP fuera de los segmentos configurados' });
      if (!quien) return json(res, 400, { error: 'Elige qué equipo se va a mover' });
      const s = segmentoDe(nueva);
      const e = estadoDe(nueva, (s.fijas || {})[+nueva.split('.')[3]], Date.now() - DIAS_AUSENTE * 864e5);
      if (e !== 'libre') return json(res, 409, { error: `La ${nueva} ya no está libre (${e}). Elige otra.` });
      const por = limpio(b.por).slice(0, 40) || undefined;
      const eq = b.equipoId && INVD.equipos.find(x => x.id === b.equipoId);
      if (eq) { // Ficha del inventario: se le cambia la IP directamente
        registrar('reasignar', eq, por, { ip: [eq.ip, nueva] });
        eq.ip = nueva; eq.editado = Date.now(); eq.editadoApp = true; eq.por = por;
        guardarInv();
      } else { // Equipo que no está en el inventario: se aparta la IP con una nota
        const r = data.ips[nueva] || (data.ips[nueva] = {});
        r.reservada = true;
        r.nota = `${quien} (antes ${vieja})`.slice(0, 120);
        r.por = por; r.fechaNota = Date.now();
      }
      if (String(b.alerta || '').startsWith('inv:')) {
        const lista = INV.mapa[vieja];
        if (lista && lista.length > 1) (data.invOk = data.invOk || {})[vieja] = firmaInv(lista);
      } else {
        const a = (data.alertas || []).find(x => x.id === b.alerta);
        if (a) { a.revisada = Date.now(); a.por = por; a.resolucion = resol; }
      }
      guardar();
      console.log(new Date().toLocaleString(), `REASIGNACIÓN ${vieja} → ${nueva}: ${quien}${por ? ' (por ' + por + ')' : ''}`);
      return json(res, 200, { ok: true, nueva, mascara: s.mascara || '255.255.255.0', gateway: s.gateway || `${s.red}.1` });
    }
    if (req.method === 'POST' && url === '/api/alerta/revisar') {
      if (CFG.pin && req.headers['x-pin'] !== String(CFG.pin)) return json(res, 401, { error: 'PIN incorrecto' });
      const b = await leerBody(req);
      if (String(b.id || '').startsWith('inv:')) {
        const ip = b.id.slice(4), lista = INV.mapa[ip];
        if (!lista) return json(res, 404, { error: 'Alerta no encontrada' });
        (data.invOk = data.invOk || {})[ip] = firmaInv(lista);
        guardar();
        return json(res, 200, { ok: true });
      }
      const a = (data.alertas || []).find(x => x.id === b.id);
      if (!a) return json(res, 404, { error: 'Alerta no encontrada' });
      a.revisada = Date.now();
      a.por = String(b.por || '').trim().slice(0, 40) || undefined;
      guardar();
      return json(res, 200, { ok: true });
    }
    // ---------- Inventario ----------
    if (req.method === 'GET' && url === '/api/inventario') {
      return json(res, 200, { version: invVer, tipos: TIPOS, equipos: INVD.equipos, historial: INVD.historial.slice(-400) });
    }
    if (req.method === 'GET' && url === '/api/inventario/exportar.csv') {
      const f = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inventario-ip-ugel-${f}.csv"`, 'Cache-Control': 'no-store' });
      return res.end(exportarCsv());
    }
    if (req.method === 'POST' && url.startsWith('/api/inventario/')) {
      if (CFG.pin && req.headers['x-pin'] !== String(CFG.pin)) return json(res, 401, { error: 'PIN incorrecto' });
      const b = await leerBody(req);
      const por = limpio(b.por).slice(0, 40) || undefined;
      if (url === '/api/inventario/mac') { // confirmar o descartar una MAC aprendida sola
        const e = INVD.equipos.find(x => x.id === b.id);
        if (!e || !e.mac) return json(res, 404, { error: 'Esa ficha no tiene MAC' });
        const m = e.mac;
        if (b.ok) e.macAuto = false;
        else { e.macNo = [...new Set([...(e.macNo || []), m])].slice(-10); e.mac = undefined; e.macAuto = undefined; }
        registrar(b.ok ? 'MAC confirmada' : 'MAC descartada', e, por, { mac: b.ok ? [m, m] : [m, ''] });
        guardarInv(); aprenderMacs();
        return json(res, 200, { ok: true, equipo: e });
      }
      if (url === '/api/inventario/guardar') {
        const ip = limpio(b.ip), nombre = limpio(b.nombre).slice(0, 80);
        if (!nombre) return json(res, 400, { error: 'Escribe el nombre del funcionario o del equipo' });
        if (ip && !RE_IP.test(ip)) return json(res, 400, { error: `«${ip}» no es una IP válida. Usa el formato 172.16.14.25` });
        const previo = b.id && INVD.equipos.find(x => x.id === b.id);
        const otro = ip && INVD.equipos.find(x => x.ip === ip && x.id !== b.id);
        if (otro && !(previo && previo.ip === ip)) return json(res, 409, { error: `La ${ip} ya es de ${etiquetaInv(otro)}. Elige otra IP o reasigna esa ficha primero` });
        const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'Otro';
        const campos = { ip, area: limpio(b.area).slice(0, 60), nombre, tipo, switch: limpio(b.switch).slice(0, 60), puerto: limpio(b.puerto).slice(0, 20), notas: limpio(b.notas).slice(0, 300) };
        let e = b.id && INVD.equipos.find(x => x.id === b.id);
        if (b.id && !e) return json(res, 404, { error: 'Esa ficha ya no existe. Recarga la página' });
        // MAC: solo cuenta como escrita a mano si cambió respecto de la que ya tenía
        if (b.mac !== undefined) {
          const t = limpio(b.mac), m = t ? normMac(t) : '';
          if (m === null) return json(res, 400, { error: `«${t}» no es una MAC válida. Usa el formato 80:b6:55:b6:69:4e` });
          if (m && INVD.equipos.find(x => x.mac === m && !x.macAuto && x.id !== b.id)) return json(res, 409, { error: `La MAC ${m} ya está en otra ficha` });
          if (m !== ((e && e.mac) || '')) { campos.mac = m; campos.macAuto = false; }
        }
        if (e) {
          const cambios = {};
          for (const k of Object.keys(campos)) if (k !== 'macAuto' && (e[k] || '') !== campos[k]) cambios[k] = [e[k] || '', campos[k]];
          if (b.revisado && e.revisar && e.revisar.length) cambios.revisado = [e.revisar.join(' | '), ''];
          Object.assign(e, campos, { editado: Date.now(), editadoApp: true, por });
          if (b.revisado) e.revisar = [];
          if (Object.keys(cambios).length) registrar('editar', e, por, cambios);
        } else {
          e = Object.assign({ id: nuevoId() }, campos, { revisar: [], origen: ['app'], creado: Date.now(), editado: Date.now(), editadoApp: true, por });
          INVD.equipos.push(e);
          registrar('crear', e, por);
        }
        guardarInv();
        if (campos.macAuto === false) aprenderMacs();
        return json(res, 200, { ok: true, equipo: e });
      }
      if (url === '/api/inventario/borrar') {
        const i = INVD.equipos.findIndex(x => x.id === b.id);
        if (i < 0) return json(res, 404, { error: 'Esa ficha ya no existe' });
        const [e] = INVD.equipos.splice(i, 1);
        registrar('borrar', e, por, { ficha: [JSON.stringify({ ip: e.ip, area: e.area, nombre: e.nombre, tipo: e.tipo }), ''] });
        guardarInv();
        return json(res, 200, { ok: true });
      }
      if (url === '/api/inventario/importar') {
        try { return json(res, 200, Object.assign({ ok: true }, await importarSheet(por))); }
        catch (e) { return json(res, 502, { error: 'No se pudo importar el Google Sheet: ' + e.message }); }
      }
    }
    json(res, 404, { error: 'No encontrado' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(CFG.puerto, () => {
  console.log(`IP Libres escuchando en http://0.0.0.0:${CFG.puerto} — ${LISTA.length} IPs, cada ${INTERVALO / 60000} min`);
  try { aprenderMacs(); } catch (e) { console.error('Error al aprender MACs:', e); }
  { const n = cerrarAlertasViejas(Date.now()); if (n) { guardar(); console.log(`Alertas cerradas (no eran conflictos reales): ${n}`); } }
  // El escaneo lanzado en el mismo instante del arranque salía incompleto; se espera a que el sistema se asiente.
  proximo = Date.now() + 20000;
  timer = setTimeout(escanear, 20000);
});
