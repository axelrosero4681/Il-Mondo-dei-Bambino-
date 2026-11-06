/**
 * IL MONDO DEI BAMBINO — Base de datos en Hoja de Google
 * ------------------------------------------------------
 * Recibe los pedidos del catálogo y las ventas del panel.
 * Guarda todo en dos pestañas: "Pedidos" y "Vendidos".
 * El catálogo le pregunta qué se vendió para no volver a ofrecerlo.
 *
 * Instalación: ver HOJA_GOOGLE.txt
 */

const ENC_PEDIDOS = ["Fecha", "Pedido", "Nombre", "WhatsApp", "Ciudad", "Entrega", "Forma de pago", "Productos", "Total", "Viene de", "Estado", "Datos (no tocar)"];
const ENC_VENDIDOS = ["Fecha", "Ref (no tocar)", "Código", "Talla", "Cantidad", "Origen"];

function hoja_(nombre, encabezado) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName(nombre);
  if (!h) {
    h = ss.insertSheet(nombre);
    h.appendRow(encabezado);
    h.setFrozenRows(1);
    h.getRange(1, 1, 1, encabezado.length).setFontWeight("bold").setBackground("#E9E3FF");
  }
  return h;
}
const hojaPedidos_ = () => hoja_("Pedidos", ENC_PEDIDOS);
const hojaVendidos_ = () => hoja_("Vendidos", ENC_VENDIDOS);

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || "");
}

/* ---------------- LECTURA ---------------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const accion = p.accion || "estado";
  if (accion === "vendidos") return json_({ ok: true, vendidos: leerVendidos_() });
  if (accion === "pedidos") return json_({ ok: true, pedidos: leerPedidos_(Number(p.desde || 0)) });
  if (accion === "fotos") return json_(listarFotos_(p.carpeta));
  return json_({ ok: true, negocio: "Il Mondo dei Bambino", pedidos: Math.max(0, hojaPedidos_().getLastRow() - 1), vendidos: Math.max(0, hojaVendidos_().getLastRow() - 1) });
}

function leerVendidos_() {
  const h = hojaVendidos_(), n = h.getLastRow();
  if (n < 2) return [];
  return h.getRange(2, 1, n - 1, 5).getValues()
    .filter(f => f[1])
    .map(f => ({ fecha: iso_(f[0]), ref: String(f[1]), codigo: String(f[2]), talla: String(f[3]), cantidad: Number(f[4]) || 0 }));
}

function leerPedidos_(desde) {
  const h = hojaPedidos_(), n = h.getLastRow();
  if (n < 2) return [];
  const filas = h.getRange(2, 1, n - 1, ENC_PEDIDOS.length).getValues();
  const out = [];
  filas.forEach((f, i) => {
    const fila = i + 2;
    if (fila <= desde) return;
    try { const d = JSON.parse(f[11]); d.fila = fila; out.push(d); } catch (err) { /* fila escrita a mano: se ignora */ }
  });
  return out;
}

// Fotos de una carpeta de Drive (nombradas con el código del producto: N3.jpg, T13 jirafa.jpg...)
function listarFotos_(carpetaId) {
  try {
    const carpeta = DriveApp.getFolderById(carpetaId);
    const archivos = carpeta.getFiles(), fotos = [];
    while (archivos.hasNext()) {
      const f = archivos.next();
      if (!/^image\//.test(f.getMimeType())) continue;
      fotos.push({ nombre: f.getName(), id: f.getId(), resourceKey: f.getResourceKey ? (f.getResourceKey() || "") : "" });
    }
    fotos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return { ok: true, fotos: fotos };
  } catch (err) {
    return { ok: false, error: "No pude abrir la carpeta: " + err };
  }
}

/* ---------------- ESCRITURA ---------------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // si dos clientas compran a la vez, se atienden en orden
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.tipo === "pedido") return json_(registrarPedido_(d));
    if (d.tipo === "venta") { agregarVenta_(d.ref, d.codigo, d.talla, d.cantidad, d.origen || "Live", d.fecha); return json_({ ok: true }); }
    if (d.tipo === "anular") { anularVenta_(d.ref); return json_({ ok: true }); }
    return json_({ ok: false, error: "Tipo desconocido" });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function vendidosDesde_(codigo, talla, desde) {
  return leerVendidos_()
    .filter(v => v.codigo === codigo && v.talla === talla && (!desde || v.fecha >= desde))
    .reduce((s, v) => s + v.cantidad, 0);
}

function registrarPedido_(d) {
  // ¿ya existe? (por si la clienta tocó dos veces)
  const yaEsta = leerPedidos_(0).some(p => p.id === d.id);
  if (yaEsta) return { ok: true, id: d.id, repetido: true };

  // ¿todavía hay de todo lo que pidió?
  const agotados = [];
  (d.items || []).forEach(x => {
    if (x.stock === null || x.stock === undefined || !x.codigo) return;
    const disponible = Number(x.stock) - vendidosDesde_(x.codigo, x.talla, d.stockDesde);
    if (Number(x.cantidad) > disponible) agotados.push({ codigo: x.codigo, talla: x.talla, disponible: Math.max(0, disponible) });
  });
  if (agotados.length) return { ok: false, agotados: agotados };

  const productos = (d.items || []).map(x => `${x.cantidad} × ${x.codigo ? "[" + x.codigo + "] " : ""}${x.nombre} (${x.talla})`).join("\n");
  const envio = d.envioDatos
    ? `${d.entrega} (${d.envioCosto === null || d.envioCosto === undefined ? "costo por confirmar" : "$" + d.envioCosto})\n${d.direccion}${d.referencia ? " · " + d.referencia : ""}\nCI: ${d.cedula}`
    : d.entrega;
  hojaPedidos_().appendRow([new Date(), d.id, d.nombre, "'" + (d.whatsapp || ""), d.ciudad, envio, d.pago, productos, Number(d.total) || 0, d.para ? "Selección para " + d.para : "Catálogo", "Nuevo", JSON.stringify(d)]);
  (d.items || []).forEach((x, i) => { if (x.codigo) agregarVenta_("web-" + d.id + "-" + i, x.codigo, x.talla, x.cantidad, "Catálogo web", d.fecha); });
  return { ok: true, id: d.id };
}

function agregarVenta_(ref, codigo, talla, cantidad, origen, fecha) {
  if (!ref || !codigo) return;
  const h = hojaVendidos_();
  const n = h.getLastRow();
  if (n >= 2) {
    const refs = h.getRange(2, 2, n - 1, 1).getValues().map(f => String(f[0]));
    if (refs.indexOf(String(ref)) >= 0) return; // ya estaba
  }
  h.appendRow([fecha ? new Date(fecha) : new Date(), ref, codigo, talla, Number(cantidad) || 1, origen]);
}

function anularVenta_(ref) {
  const h = hojaVendidos_(), n = h.getLastRow();
  if (n < 2) return;
  const refs = h.getRange(2, 2, n - 1, 1).getValues().map(f => String(f[0]));
  for (let i = refs.length - 1; i >= 0; i--) if (refs[i] === String(ref)) h.deleteRow(i + 2);
}

/* Para probar desde el editor: Ejecutar → probar */
function probar() {
  Logger.log(doGet({ parameter: { accion: "estado" } }).getContent());
}
