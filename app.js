// Consola de JARVIS para el celular.
// Página estática: no tiene claves ni datos. El pase (URL de LiveKit + token firmado en la PC) llega en el
// fragmento "#u=…&t=…" del enlace del QR (el fragmento nunca se envía al servidor que aloja la página) y se
// guarda solo en este celular. Todo lo demás (voz, agentes, tareas) llega por la sala cifrada de LiveKit.
"use strict";

const $ = (id) => document.getElementById(id);
const LK = window.LivekitClient;
const PASE = "jarvis.pase";
const OFICIO = {investigador: "INVESTIGADOR", redactor: "REDACTOR", disenadora: "DISEÑADORA", seguridad: "SEGURIDAD", ingeniero: "INGENIERO", finanzas: "FINANZAS"};
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

let room = null, estado = null, turnos = [], agenteVoz = "desconectado", yoHablo = false, conectando = false;
let wakeLock = null, analizador = null, audioCtx = null, silenciado = false;
// Botones que manda JARVIS (Google Maps, WhatsApp...). Solo de estos sitios, por si un correo o una página
// intentara colar un enlace malicioso (mismo filtro que tools/enlace.py en la PC).
const SITIOS = ["www.google.com", "maps.google.com", "wa.me", "calendar.google.com", "docs.google.com",
                "drive.google.com", "mail.google.com", "www.openstreetmap.org"];
let enlaces = [];

// ---------- Pase ----------

function leerPase(texto) {
  const i = texto.indexOf("#");
  const p = new URLSearchParams(i >= 0 ? texto.slice(i + 1) : texto);
  const u = p.get("u") || p.get("liveKitUrl"), t = p.get("t") || p.get("token"), t2 = p.get("t2");
  if (!u || !t) return null;
  if (!/^wss:\/\/[a-z0-9-]+\.livekit\.cloud\/?$/i.test(u)) return null; // solo LiveKit Cloud, siempre cifrado
  return t2 ? {u, t, t2, sala: 0} : {u, t, sala: 0};
}

function datosPase(t) {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
function vence(t) { return (datosPase(t).exp || 0) * 1000; }
// Cuánto tarda en cerrarse una sala vacía (lo fija el pase); si una sala quedó sin JARVIS, hay que esperar esto.
function cierreSala() { const p = pase(); return ((p && datosPase(p.t).roomConfig?.departureTimeout) || 90) + 5; }

function guardarPase(p) {
  try { localStorage.setItem(PASE, JSON.stringify(p)); } catch {}
}

function pase() {
  try { const p = JSON.parse(localStorage.getItem(PASE) || "null"); return p && p.u && p.t ? p : null; } catch { return null; }
}

function tomarPaseDelEnlace() {
  if (!location.hash) return;
  const p = leerPase(location.hash);
  history.replaceState(null, "", location.pathname + location.search); // que el token no quede en el historial
  if (p) guardarPase(p);
}

// El pase trae dos salas: si LiveKit deja de llamar a JARVIS en una (ver enlace_celular.py), uso la otra.
function tokenActual(p) { return p.sala === 1 && p.t2 ? p.t2 : p.t; }
function cambiarSala() {
  const p = pase();
  if (!p || !p.t2) return false;
  p.sala = p.sala === 1 ? 0 : 1;
  guardarPase(p);
  return true;
}

function dias(ms) { return Math.max(0, Math.round((ms - Date.now()) / 86400000)); }

function nuevoEnlace(d) {
  let u;
  try { u = new URL(d.url); } catch { return; }
  if (u.protocol !== "https:" || !SITIOS.includes(u.hostname)) return;
  enlaces = [{url: u.href, titulo: String(d.titulo || "Abrir").slice(0, 80), t: Date.now()}, ...enlaces].slice(0, 3);
  try { navigator.vibrate?.(80); } catch {}
}

// ---------- Interfaz ----------

function aviso(texto) {
  $("aviso").textContent = texto || "";
  $("aviso").style.display = texto ? "block" : "none";
}

function claseEstado() {
  if (!room) return ["dormido", quiero ? "Reconectando…" : conectando ? "Conectando…" : "Desconectado"];
  if (reconectando) return ["dormido", "Reconectando…"];
  if (yoHablo) return ["tu", "Recibiendo voz"];
  if (agenteVoz === "thinking") return ["pensando", "Procesando"];
  if (agenteVoz === "speaking") return ["hablando", "Transmitiendo"];
  if (agenteVoz === "listening") return ["escuchando", "En línea · escuchando"];
  return ["dormido", "Despertando a JARVIS…"];
}

function paso(p) {
  if (!p) return "Iniciando…";
  switch (p.accion || p.paso) {
    case "buscar_web": return `Buscando «${p.consulta}»`;
    case "leer_pagina": try { return `Leyendo ${new URL(p.url).hostname}`; } catch { return "Leyendo página"; }
    case "entregar_informe": return "Entregando informe";
    case "recuerdos": return "Consultando memoria";
    case "redactar": return "Redactando";
    case "guardar": return "Guardando resultado";
    case "disenar": return `Diseñando ${p.formato || ""}: ${p.titulo || ""}`;
    case "renderizar": return `Dibujando ${p.tamano || ""}`;
    case "revisar": return p.aprobado ? "Revisión: aprobado" : `Revisión: ${p.problemas} detalle(s) por corregir`;
    case "corregir": return "Corrigiendo";
    case "planear": return p.subpreguntas ? `Plan: ${p.subpreguntas} subpreguntas` : "Planeando";
    case "buscar_foto": return `Buscando foto «${p.consulta || ""}»`;
    case "elegir_foto": return p.elegida ? "Foto elegida" : "Diseño tipográfico";
    case "reintentar": return `Google saturado · reintento en ${Math.round((p.en_s || 150) / 60 * 10) / 10} min`;
    case "verificar": return `Revisando ${p.area}${p.problemas ? ` · ${p.problemas} hallazgo(s)` : " · en orden"}`;
    default: return p.accion || p.paso || "Trabajando";
  }
}

// Solo toca la pantalla si algo cambió: reescribir un botón mientras lo tocas hace que el toque se pierda.
const ultimo = {};
function pon(id, prop, valor) {
  const clave = id + "." + prop;
  if (ultimo[clave] === valor) return;
  ultimo[clave] = valor;
  $(id)[prop] = valor;
}

function render() {
  const p = pase(), expira = p ? vence(p.t) : 0;
  document.body.classList.toggle("sin-pase", !p || expira < Date.now());
  const [cls, txt] = claseEstado();
  document.body.classList.remove("dormido", "tu", "pensando", "hablando", "escuchando");
  document.body.classList.add(cls);
  pon("estado", "textContent", !p ? "Sin vincular" : expira < Date.now() ? "Pase vencido" : txt);
  pon("meta", "innerHTML", p && expira > Date.now()
    ? `ENLACE <b>CIFRADO</b> · PASE <b>${dias(expira)} DÍA${dias(expira) === 1 ? "" : "S"}</b>` + (estado ? ` · NÚCLEO <b>${esc(estado.modelo)}</b>` : "")
    : p ? "Genera un QR nuevo en la PC: <b>scripts\\enlace_celular.py</b>" : "");

  pon("b-conectar", "innerHTML", room ? "■ COLGAR" : quiero ? "■ CANCELAR<small>dejar de reconectar</small>" : "● CONECTAR");
  pon("b-conectar", "className", "hud big" + (room || quiero ? " warn" : ""));
  $("b-micro").disabled = $("b-altavoz").disabled = !room;
  pon("b-pantalla", "innerHTML", pantallaFija ? "☀ PANTALLA<small>siempre encendida</small>" : "☾ PANTALLA<small>se apaga; JARVIS sigue</small>");
  pon("b-pantalla", "className", "hud" + (pantallaFija ? " on" : ""));
  pon("b-ubicacion", "innerHTML", ubicacionOn ? "📍 UBICACIÓN<small>JARVIS la ve al preguntarle</small>" : "📍 UBICACIÓN<small>no compartida</small>");
  pon("b-ubicacion", "className", "hud" + (ubicacionOn ? " on" : ""));
  sesionMultimedia();
  const micOn = room ? room.localParticipant.isMicrophoneEnabled : false;
  pon("b-micro", "innerHTML", micOn ? "🎙 MICRÓFONO<small>abierto · toca para silenciar</small>" : "🔇 MICRÓFONO<small>silenciado</small>");
  pon("b-micro", "className", "hud" + (room && !micOn ? " warn" : ""));
  pon("b-altavoz", "innerHTML", silenciado ? "🔈 VOZ<small>en silencio</small>" : "🔊 VOZ<small>se escucha</small>");
  pon("b-altavoz", "className", "hud" + (room && silenciado ? " warn" : ""));

  $("sec-enlaces").hidden = !enlaces.length;
  pon("enlaces", "innerHTML", enlaces.map((e) => {
    const icono = e.url.includes("wa.me") ? "💬" : e.url.includes("maps") ? "📍" : "↗";
    return `<a class="hud" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${icono} ${esc(e.titulo)}` +
           `<small>toca para abrir · ${new Date(e.t).toLocaleTimeString("es", {hour: "2-digit", minute: "2-digit"})}</small></a>`;
  }).join(""));

  if (estado) {
    pon("agentes", "innerHTML", estado.agentes.map((a) => `
      <div class="hud agent ${a.trabajando ? "work" : ""}">
        <div class="top"><div class="hex">${a.icono || "◆"}</div>
          <div style="min-width:0"><div class="name">${esc(a.apodo || a.nombre)}</div><span class="badge">${esc(OFICIO[a.nombre] || a.nombre)}</span></div>
          <div class="led"></div></div>
        <div class="status">${a.trabajando ? `TRABAJANDO · #${a.tarea.id} · PASO ${a.pasos}` : "EN ESPERA"}</div>
        ${a.trabajando ? `<div class="job">${esc(a.tarea.encargo)}</div><div class="step">${esc(paso(a.ultimo_paso))}</div>`
                       : `<div class="rol">${esc(a.rol)}</div>`}
        <div class="bar"></div>
        <div class="foot">${a.hechas} COMPLETADA${a.hechas === 1 ? "" : "S"}</div>
      </div>`).join(""));
    pon("tareas", "innerHTML", estado.tareas.length
      ? estado.tareas.map((t) => `<div class="row"><div><b>#${t.id}</b> ${esc(t.encargo)}<div class="muted">${esc((t.resumen || t.agente).slice(0, 220))}</div></div><span class="tag ${esc(t.estado)}">${esc(t.estado.replace("_", " "))}</span></div>`).join("")
      : '<div class="empty">// sin tareas · prueba "investiga…" o "redáctame…"</div>');
  }
  const quien = (estado?.usuario || "TÚ").toUpperCase();
  pon("chat", "innerHTML", turnos.length
    ? turnos.map((t) => `<div class="line ${t.rol}"><span class="who">${t.rol === "user" ? esc(quien) : "JARVIS"} ›</span>${esc(t.texto)}</div>`).join("")
    : '<div class="empty">// sin transmisiones</div>');
  $("chat").scrollTop = $("chat").scrollHeight;
  pon("sistema", "innerHTML", [
    ["Voz", room ? "LiveKit Cloud · cifrado" : "desconectado"],
    ["Pase", p ? `vence el ${new Date(expira).toLocaleDateString("es")}` : "sin vincular"],
    ["App", navigator.serviceWorker?.controller ? "instalable · lista sin conexión" : "web"],
  ].map(([k, v]) => `<div class="row"><span class="muted">${k}</span><span>${esc(v)}</span></div>`).join("")
    + (p ? '<div class="row"><span class="muted">¿Celular perdido o prestado?</span><button class="hud" id="b-olvidar" style="min-height:0;padding:6px 10px">BORRAR PASE</button></div>' : ""));
  const olvidar = $("b-olvidar");
  if (olvidar) olvidar.onclick = () => { if (confirm("¿Borrar el pase de este celular?")) { colgar(); try { localStorage.removeItem(PASE); } catch {} render(); } };
}

// ---------- Conexión ----------

// Si la señal se cae (pantalla apagada, ahorro de energía, túnel, wifi -> datos), la app vuelve a entrar sola
// mientras no hayas colgado. JARVIS te espera 5 minutos con la misma conversación.
let quiero = false, reintento = null, intentos = 0, micDeseado = true, reconectando = false, rechazos = 0, sinJarvis = 0, esperarSala = false;
const ESPERAS = [1, 2, 4, 8, 15, 30]; // s entre reintentos (el último se repite)
// Si LiveKit borra la sala, volver a entrar mientras se borra deja ese nombre sin JARVIS un rato: espero.
const ENFRIAR_MS = 10000;
let enfriarHasta = 0;
// Cuándo salí de la sala (colgué o se cortó). Si pasó más que la espera de JARVIS, él ya se fue y esa sala
// acaba de cerrarse (LiveKit tarda en poder llamarlo de nuevo ahí): la próxima llamada usa la otra sala.
let salidaEn = 0;
try { salidaEn = Number(localStorage.getItem("jarvis.salida")) || 0; } catch {}
function marcarSalida(t) { salidaEn = t; try { localStorage.setItem("jarvis.salida", String(t)); } catch {} }

async function conectar(automatico = false) {
  const p = pase();
  if (!p || conectando || room) return;
  if (vence(p.t) < Date.now()) { quiero = false; aviso("El pase venció: genera uno nuevo en la PC."); render(); return; }
  quiero = true; clearTimeout(reintento);
  const espera = enfriarHasta - Date.now();
  if (espera > 0) { // recién colgaste: dale unos segundos a JARVIS para cerrar la llamada anterior
    aviso(`La sala anterior se está cerrando… te conecto en ${Math.ceil(espera / 1000)} s`);
    reintento = setTimeout(() => conectar(true), espera);
    render();
    return;
  }
  if (salidaEn && Date.now() - salidaEn > (cierreSala() - 10) * 1000 && cambiarSala()) p.sala = pase().sala;
  conectando = true;
  if (!automatico) aviso("");
  render();
  const r = new LK.Room({adaptiveStream: false, dynacast: false,
                         audioCaptureDefaults: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
  r.on(LK.RoomEvent.TrackSubscribed, (track) => { if (track.kind === "audio") oirJarvis(track); });
  r.on(LK.RoomEvent.ParticipantAttributesChanged, (_c, part) => {
    if (part && part.attributes && part.attributes["lk.agent.state"]) { agenteVoz = part.attributes["lk.agent.state"]; render(); }
  });
  r.on(LK.RoomEvent.ParticipantConnected, (part) => {
    sinJarvis = 0;
    if (part.attributes?.["lk.agent.state"]) agenteVoz = part.attributes["lk.agent.state"];
    pedirEstado(r);
    render();
  });
  r.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => { yoHablo = speakers.some((s) => s.isLocal); render(); });
  r.on(LK.RoomEvent.DataReceived, (payload, _part, _kind, topic) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      if (topic === "jarvis.estado") estado = d;
      else if (topic === "jarvis.turno") { turnos.push(d); turnos = turnos.slice(-40); }
      else if (topic === "jarvis.enlace") nuevoEnlace(d);
      else if (topic === "jarvis.ubicacion.pedir") responderUbicacion(r);
      render();
    } catch {}
  });
  r.on(LK.RoomEvent.LocalTrackPublished, render);
  r.on(LK.RoomEvent.TrackMuted, render);
  r.on(LK.RoomEvent.TrackUnmuted, render);
  r.on(LK.RoomEvent.Reconnecting, () => { reconectando = true; render(); });   // la librería lo intenta primero
  r.on(LK.RoomEvent.Reconnected, () => { reconectando = false; pedirEstado(r); render(); });
  r.on(LK.RoomEvent.Disconnected, (razon) => {
    if (room !== r) return;
    room = null; reconectando = false; agenteVoz = "desconectado"; yoHablo = false;
    if (!salidaEn) marcarSalida(Date.now());
    // JARVIS borró la sala (colgó él o se cansó de esperar): entrar mientras se borra traba la sala; espero.
    if (razon === LK.DisconnectReason?.ROOM_DELETED) enfriarHasta = Date.now() + ENFRIAR_MS;
    if (quiero) programarReintento(); // no colgaste tú: vuelvo a entrar
    render();
  });
  try {
    await r.connect(p.u, tokenActual(p));
    room = r; intentos = 0; rechazos = 0; marcarSalida(0); aviso("");
    for (const part of r.remoteParticipants.values()) {  // JARVIS ya estaba en la sala (vuelta tras un corte)
      if (part.attributes?.["lk.agent.state"]) agenteVoz = part.attributes["lk.agent.state"];
    }
    pedirEstado(r);
    await r.startAudio().catch(() => {});
    if (pantallaFija) mantenerPantalla();
    setTimeout(() => { // JARVIS vive en la PC: si no llega, primero reintento solo (sala a medio cerrar)
      if (room !== r || r.remoteParticipants.size > 0) { sinJarvis = 0; return; }
      sinJarvis++;
      if (sinJarvis === 1) { r.disconnect(); return; }                      // 1.º: reintento enseguida
      if (sinJarvis === 2) {                                                  // 2.º: la sala está trabada
        if (cambiarSala()) aviso("Probando con la sala de repuesto…");      //     con repuesto: enseguida
        else esperarSala = true;                                            //     sin repuesto: esperar a que cierre
        r.disconnect();
        return;
      }
      sinJarvis = 0;
      colgar();
      aviso("Ninguna computadora respondió: enciende JARVIS en la PC o en la Mac y vuelve a intentar.");
    }, 15000);
    if (micDeseado) await activarMicro(r);
  } catch (e) {
    r.disconnect();
    room = null;
    // Un rechazo suelto puede ser la sala cerrándose tras un corte: solo 3 seguidos significan pase inválido.
    const rechazo = e && LK.ConnectionErrorReason && e.reason === LK.ConnectionErrorReason.NotAllowed;
    rechazos = rechazo ? rechazos + 1 : 0;
    if (rechazos >= 3) { quiero = false; rechazos = 0; aviso("El pase no es válido: genera uno nuevo en la PC."); }
    else if (quiero) programarReintento();
  } finally {
    conectando = false; render();
  }
}

function programarReintento() {
  clearTimeout(reintento);
  let s = ESPERAS[Math.min(intentos, ESPERAS.length - 1)];
  intentos++;
  if (esperarSala) { // la sala quedó sin JARVIS: hasta que LiveKit la cierre, no lo va a volver a llamar
    esperarSala = false; s = cierreSala();
    aviso(`JARVIS se está reiniciando. Vuelvo a llamarlo en ${s} s…`);
  } else aviso(navigator.onLine ? `Se cortó la señal. Reconectando en ${s} s…` : "Sin internet. Reconecto apenas vuelva la señal…");
  reintento = setTimeout(() => conectar(true), s * 1000);
}

function reintentarYa() { // al volver la señal o encender la pantalla, no esperes al temporizador
  if (quiero && !room && !conectando) { intentos = 0; conectar(true); }
  else if (room && micDeseado && !room.localParticipant.isMicrophoneEnabled) activarMicro(room);
}
addEventListener("online", reintentarYa);
addEventListener("pagehide", () => { if (room) marcarSalida(Date.now()); }); // cerraste la app en plena llamada
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  reintentarYa();
  if (room && pantallaFija) mantenerPantalla();
});

async function activarMicro(r) {
  try {
    await r.localParticipant.setMicrophoneEnabled(true);
    aviso("");
  } catch { // sin micrófono igual se ve y se escucha a JARVIS; se reintenta al encender la pantalla
    aviso("Sin micrófono: permítelo en los ajustes del navegador y toca MICRÓFONO.");
  }
  render();
}

function pedirEstado(r) {
  // Con el pedido va qué sabe hacer esta versión de la app (así JARVIS no espera en vano una ubicación)
  const yo = JSON.stringify({version: 6, ubicacion: ubicacionOn ? "activada" : "apagada"});
  r.localParticipant.publishData(new TextEncoder().encode(yo), {reliable: true, topic: "jarvis.pedir"}).catch(() => {});
}

function colgar() {
  quiero = false; clearTimeout(reintento); intentos = 0; sinJarvis = 0; esperarSala = false;
  if (room) { room.disconnect(); marcarSalida(Date.now()); } // JARVIS espera 90 s: si vuelves, contesta al instante
  room = null; reconectando = false; agenteVoz = "desconectado"; yoHablo = false; soltarPantalla(); render();
}

function oirJarvis(track) {
  document.querySelectorAll("audio[data-jarvis]").forEach((a) => a.remove()); // tras reconectar, un solo audio
  const el = track.attach();
  el.dataset.jarvis = "1";
  el.muted = silenciado;
  document.body.appendChild(el);
  try { // el núcleo sigue el volumen real de la voz que llega
    audioCtx = audioCtx || new AudioContext();
    audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    analizador = audioCtx.createAnalyser();
    analizador.fftSize = 1024;
    src.connect(analizador);
  } catch { analizador = null; }
}

// Pantalla: por defecto se apaga sola como siempre (la llamada sigue); "fija" la mantiene encendida.
// Ubicación: solo si Nico la activa. JARVIS la pide al momento ("¿dónde estoy?"); no hay rastreo continuo.
let ubicacionOn = false;
try { ubicacionOn = localStorage.getItem("jarvis.ubicacion") === "si"; } catch {}
function responderUbicacion(r) {
  const enviar = (d) => r.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(d)),
                                                        {reliable: true, topic: "jarvis.ubicacion"}).catch(() => {});
  if (!ubicacionOn) return enviar({error: "apagada"});
  if (!navigator.geolocation) return enviar({error: "sin_gps"});
  navigator.geolocation.getCurrentPosition(
    (p) => enviar({lat: p.coords.latitude, lon: p.coords.longitude, precision: Math.round(p.coords.accuracy), t: p.timestamp / 1000}),
    (e) => enviar({error: e.code === 1 ? "permiso" : e.code === 3 ? "tiempo" : "sin_senal"}),
    {enableHighAccuracy: true, timeout: 15000, maximumAge: 60000});
}

let pantallaFija = false;
try { pantallaFija = localStorage.getItem("jarvis.pantalla") === "fija"; } catch {}
async function mantenerPantalla() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function soltarPantalla() { try { wakeLock?.release(); } catch {} wakeLock = null; }

// Controles en la pantalla de bloqueo y en la notificación de Android.
function sesionMultimedia() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession, [, txt] = claseEstado();
  try {
    ms.metadata = room ? new MediaMetadata({
      title: "J.A.R.V.I.S.", artist: reconectando ? "Reconectando…" : txt,
      album: room.localParticipant.isMicrophoneEnabled ? "Micrófono abierto" : "Micrófono silenciado",
      artwork: [{src: "icon-192.png", sizes: "192x192", type: "image/png"}, {src: "icon-512.png", sizes: "512x512", type: "image/png"}],
    }) : null;
    ms.playbackState = room ? (room.localParticipant.isMicrophoneEnabled ? "playing" : "paused") : "none";
  } catch {}
}
if ("mediaSession" in navigator) {
  const accion = (nombre, fn) => { try { navigator.mediaSession.setActionHandler(nombre, fn); } catch {} };
  const micro = (on) => async () => { if (room) { micDeseado = on; await room.localParticipant.setMicrophoneEnabled(on).catch(() => {}); render(); } };
  accion("play", micro(true));       // ▶ en la pantalla de bloqueo = abrir micrófono
  accion("pause", micro(false));     // ⏸ = silenciar micrófono (JARVIS se sigue escuchando)
  accion("stop", () => colgar());
  accion("hangup", () => colgar());
  accion("togglemicrophone", () => room && micro(!room.localParticipant.isMicrophoneEnabled)());
}

// ---------- Núcleo (mismo diseño que el panel de la PC) ----------

const voz = [];
const muestras = new Float32Array(1024);
setInterval(() => { // un nivel cada 25 ms, como el medidor de la PC (-50 dB = 0, -12 dB = 1)
  if (!analizador || silenciado) return;
  analizador.getFloatTimeDomainData(muestras);
  let s = 0; for (const x of muestras) s += x * x;
  const db = 20 * Math.log10(Math.sqrt(s / muestras.length) + 1e-9);
  voz.push(Math.min(1, Math.max(0, (db + 50) / 38)));
}, 25);

function nucleo() {
  const c = $("nucleo"), ctx = c.getContext("2d"), calma = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TICKS = 72, hist = Array(TICKS).fill(0);
  const chispas = Array.from({length: 36}, () => ({a: Math.random() * 6.283, r: .55 + Math.random() * .4, v: .2 + Math.random() * .6, s: .6 + Math.random() * 1.4}));
  let v = 0, reloj = 0, giro = 0, last = performance.now(), W = 0;
  const fit = () => { const d = devicePixelRatio || 1; W = c.clientWidth; c.width = W * d; c.height = W * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
  fit(); addEventListener("resize", fit);

  function frame(now) {
    const dt = Math.min(.1, (now - last) / 1000); last = now;
    const clase = ["tu", "pensando", "hablando", "escuchando"].find((k) => document.body.classList.contains(k)) || "dormido";
    const dormido = clase === "dormido";
    if (voz.length > 12) voz.splice(0, voz.length - 4);
    reloj += dt;
    let objetivo = null;
    while (reloj >= .025) { reloj -= .025; objetivo = voz.length ? voz.shift() : 0; hist.push(objetivo); hist.shift(); }
    if (objetivo !== null) v += (objetivo - v) * (objetivo > v ? .6 : .18);
    if (clase === "tu") v = Math.max(v, .18 + .12 * Math.sin(now / 90) * Math.sin(now / 410));
    const vel = {dormido: .05, pensando: 1.6, hablando: .5, tu: .45}[clase] ?? .25;
    if (!calma) giro += dt * vel * (1 + v * 2);

    const [r, g, b] = (getComputedStyle(c).color.match(/\d+/g) || [0, 255, 65]).map(Number);
    const col = (a) => `rgba(${r},${g},${b},${a})`;
    const cx = W / 2, R = W / 2 * .96, t = now / 1000;
    ctx.clearRect(0, 0, W, W);
    ctx.globalAlpha = dormido ? .45 : 1;

    let grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, R);
    grad.addColorStop(0, col(.28 + v * .35)); grad.addColorStop(.45, col(.08 + v * .1)); grad.addColorStop(1, col(0));
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, W);

    ctx.save(); ctx.translate(cx, cx); ctx.rotate(giro * .35);
    for (let i = 0; i < TICKS; i++) {
      const h = hist[(i * 5) % TICKS], a = i / TICKS * 6.283, largo = R * (.035 + h * .13), r0 = R * .84;
      ctx.strokeStyle = col(.25 + h * .75); ctx.lineWidth = i % 6 ? 1.2 : 2.4;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * (r0 + largo), Math.sin(a) * (r0 + largo)); ctx.stroke();
    }
    ctx.restore();

    const arcos = (rad, n, hueco, ancho, alfa, ang) => {
      ctx.lineWidth = ancho; ctx.strokeStyle = col(alfa);
      for (let i = 0; i < n; i++) { const a0 = ang + i / n * 6.283; ctx.beginPath(); ctx.arc(cx, cx, rad, a0, a0 + 6.283 / n - hueco); ctx.stroke(); }
    };
    arcos(R * .76, 3, .5, 2, .8, giro);
    arcos(R * .7, 12, .14, 5, .35 + v * .4, -giro * 1.4);
    ctx.lineWidth = 1; ctx.strokeStyle = col(.35); ctx.beginPath(); ctx.arc(cx, cx, R * .64, 0, 6.283); ctx.stroke();

    if (!calma) for (const p of chispas) {
      p.a += dt * p.v * vel * (1 + v * 5);
      const rr = R * (p.r * .62 + v * .18 * p.s);
      ctx.fillStyle = col(.4 + v * .6); ctx.beginPath(); ctx.arc(cx + Math.cos(p.a) * rr, cx + Math.sin(p.a) * rr, p.s * (1 + v), 0, 6.283); ctx.fill();
    }

    ctx.shadowColor = col(1); ctx.shadowBlur = 12 + v * 22;
    for (let k = 0; k < 3; k++) {
      const base = R * (.36 + k * .045), amp = (.035 + v * (calma ? .12 : .32)) * (1 - k * .2);
      ctx.strokeStyle = col(.9 - k * .25); ctx.lineWidth = 2.2 - k * .5; ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = i / 120 * 6.283, f = t * (1.2 + k * .5) * (dormido ? .3 : 1);
        const n = Math.sin(3 * a + f * 2.1 + k) * .5 + Math.sin(5 * a - f * 3.3 + k * 2) * .3 + Math.sin(8 * a + f * 5.2) * .2;
        const rad = base * (1 + amp * n), x = cx + Math.cos(a) * rad, y = cx + Math.sin(a) * rad;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }

    const rc = R * .2 * (1 + v * .45 + (calma ? 0 : .04 * Math.sin(t * (dormido ? .8 : 2))));
    grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, rc);
    grad.addColorStop(0, "rgba(255,255,255,.95)"); grad.addColorStop(.35, col(.95)); grad.addColorStop(1, col(0));
    ctx.fillStyle = grad; ctx.shadowBlur = 30 + v * 40; ctx.beginPath(); ctx.arc(cx, cx, rc, 0, 6.283); ctx.fill();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function lluvia() {
  const c = $("rain"), ctx = c.getContext("2d"), chars = "アイウエオカキクケコサシスセソタチツテト0123456789JARVIS";
  const size = 14; let drops = [];
  const fit = () => { c.width = innerWidth; c.height = innerHeight; drops = Array(Math.ceil(c.width / size)).fill(0).map(() => Math.random() * -50); };
  fit(); addEventListener("resize", fit);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  setInterval(() => {
    if (document.hidden) return;
    ctx.fillStyle = "rgba(0, 0, 0, .12)"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#00ff41"; ctx.font = `${size}px monospace`;
    drops.forEach((y, i) => {
      ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * size, y * size);
      drops[i] = y * size > c.height && Math.random() > .975 ? 0 : y + 1;
    });
  }, 60);
}

// ---------- Arranque ----------

$("b-conectar").onclick = () => (room || quiero ? colgar() : conectar());
$("b-ubicacion").onclick = () => {
  ubicacionOn = !ubicacionOn;
  try { localStorage.setItem("jarvis.ubicacion", ubicacionOn ? "si" : "no"); } catch {}
  if (room) pedirEstado(room); // JARVIS se entera al momento de si la activaste o la apagaste
  if (ubicacionOn && navigator.geolocation) // pide el permiso ahora, con tu toque (el navegador lo exige así)
    navigator.geolocation.getCurrentPosition(() => aviso(""), (e) => {
      if (e.code === 1) { ubicacionOn = false; try { localStorage.setItem("jarvis.ubicacion", "no"); } catch {}
                          aviso("El navegador no dio permiso de ubicación: actívalo en los ajustes del sitio."); render(); }
    }, {enableHighAccuracy: true, timeout: 15000});
  render();
};
$("b-pantalla").onclick = () => {
  pantallaFija = !pantallaFija;
  try { localStorage.setItem("jarvis.pantalla", pantallaFija ? "fija" : "normal"); } catch {}
  if (pantallaFija && room) mantenerPantalla(); else soltarPantalla();
  render();
};
$("b-micro").onclick = async () => {
  if (!room) return;
  try {
    micDeseado = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(micDeseado);
    aviso("");
  } catch { aviso("El navegador no deja usar el micrófono: permítelo en sus ajustes."); }
  render();
};
$("b-altavoz").onclick = () => {
  silenciado = !silenciado;
  document.querySelectorAll("audio").forEach((a) => { a.muted = silenciado; });
  render();
};
$("b-portapapeles").onclick = async () => {
  try { $("pegado").value = await navigator.clipboard.readText(); } catch { aviso("No pude leer el portapapeles: pega el enlace a mano."); }
};
$("b-guardar").onclick = () => {
  const p = leerPase($("pegado").value.trim());
  if (!p) { aviso("Ese enlace no es un pase de JARVIS."); return; }
  if (vence(p.t) < Date.now()) { aviso("Ese pase ya venció: genera uno nuevo en la PC."); return; }
  guardarPase(p); $("pegado").value = ""; aviso(""); render();
};

if (!LK) aviso("No pude cargar la librería de voz. Revisa tu conexión a internet.");
tomarPaseDelEnlace();
addEventListener("hashchange", () => { tomarPaseDelEnlace(); render(); }); // enlace abierto con la app ya abierta
nucleo();
lluvia();
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then(() => setTimeout(render, 1500)).catch(() => {});
