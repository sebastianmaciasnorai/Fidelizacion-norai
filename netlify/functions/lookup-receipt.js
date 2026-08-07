// netlify/functions/lookup-receipt.js
//
// Recibe un N° de boleta (fiscalId) y lo valida contra la API de Toteat.
// Devuelve los productos de esa venta si está pagada y no tiene nota de crédito.
//
// Variables de entorno necesarias (configurar en Netlify -> Site settings -> Environment variables):
//   TOTEAT_API_TOKEN  -> el token que generaste en Toteat (API Config -> Token)
//   TOTEAT_XIR        -> ID Restaurant (ej: 1781640759948206)
//   TOTEAT_XIL        -> ID Local (ej: 1)
//   TOTEAT_XIU        -> ID de usuario API (ej: 1001)
//
// Uso desde la app:
//   GET /.netlify/functions/lookup-receipt?receipt=004582
//   Por defecto busca en los últimos 3 días (hoy + 2 días atrás), para darle margen
//   al cliente que vuelve con el ticket unos días después de la compra.
//   Opcional: &date=20260724 (busca SOLO ese día puntual, ignora la ventana de 3 días)
//   Opcional: &days=5 (cambia el ancho de la ventana, entre 1 y 30 días)
//   Opcional: &debug=ping (responde al toque, sin llamar a Toteat — para confirmar que
//             esta versión del archivo es la que está corriendo en Netlify)
//   Opcional: &debug=list (lista todas las boletas que Toteat devolvió en la ventana)
//   Opcional: &debug=raw (muestra la respuesta cruda de Toteat, sin procesar)

const FUNCTION_VERSION = 'lookup-receipt v4 (ventana 3 días + debug ping/list/raw)';

exports.handler = async (event) => {
  const receipt = (event.queryStringParameters && event.queryStringParameters.receipt || '').trim();
  const dateParam = event.queryStringParameters && event.queryStringParameters.date;
  const daysParam = event.queryStringParameters && event.queryStringParameters.days;
  const debugParam = event.queryStringParameters && event.queryStringParameters.debug;

  // Chequeo instantáneo: NO llama a Toteat, solo confirma que esta versión del archivo
  // está desplegada. Si esto no responde "version: lookup-receipt v3...", Netlify
  // todavía está sirviendo una versión anterior del archivo.
  if (debugParam === 'ping') {
    return jsonResponse(200, { ok: true, version: FUNCTION_VERSION, receivedAt: new Date().toISOString() });
  }

  // Modo diagnóstico: ?debug=list muestra TODAS las boletas que Toteat devolvió en la
  // ventana de fechas, sin filtrar por ningún número puntual. Sirve para ver el formato
  // real de los números (con ceros a la izquierda, sin ellos, etc.) mientras probamos.
  const debugMode = debugParam === 'list';
  const isDebugRequest = debugMode || debugParam === 'raw';

  if (!receipt && !isDebugRequest) {
    return jsonResponse(400, { ok: false, error: 'Falta el número de boleta (parámetro receipt).' });
  }

  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  // Por defecto buscamos en una ventana de los últimos N días (hora de Chile), para que
  // el cliente pueda sumar el sello aunque no venga el mismo día de la compra.
  // Si viene ?date=YYYYMMDD, buscamos SOLO ese día puntual (útil para pruebas).
  let ini, end;
  if (dateParam) {
    ini = dateParam;
    end = dateParam;
  } else {
    const daysWindow = Math.max(1, Math.min(30, parseInt(daysParam, 10) || 3));
    const now = new Date();
    end = formatDate(now);
    const iniDate = new Date(now);
    iniDate.setDate(iniDate.getDate() - (daysWindow - 1));
    ini = formatDate(iniDate);
  }

  const url = new URL('https://api.toteat.com/mw/or/1.0/sales');
  url.searchParams.set('xir', TOTEAT_XIR);
  url.searchParams.set('xil', TOTEAT_XIL);
  url.searchParams.set('xiu', TOTEAT_XIU);
  url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);
  url.searchParams.set('ini', ini);
  url.searchParams.set('end', end);
  url.searchParams.set('detail_cancel_order', 'true');

  let toteatData;
  try {
    const res = await fetch(url.toString());
    toteatData = await res.json();
    if (!res.ok || toteatData.ok === false) {
      return jsonResponse(502, { ok: false, error: 'Toteat rechazó la consulta.', detail: toteatData });
    }
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo conectar con Toteat.', detail: String(e) });
  }

  // ?debug=raw devuelve exactamente lo que Toteat contestó, sin que nosotros lo toquemos.
  // Sirve para descartar que estemos leyendo mal la respuesta (por ejemplo, si los datos
  // vinieran en otro campo que no sea "data", o si Toteat mandara un mensaje de error
  // que no estamos mostrando).
  if (debugParam === 'raw') {
    return jsonResponse(200, { ok: true, debugRaw: true, requestUrl: url.toString().replace(TOTEAT_API_TOKEN, '***'), rangeIni: ini, rangeEnd: end, toteatResponseStatus: 'ver toteatData', toteatData });
  }

  const sales = (toteatData && toteatData.data) || [];

  if (debugMode) {
    const list = sales
      .map(s => ({ fiscalId: s.fiscalId, fiscalType: s.fiscalType, dateClosed: s.dateClosed, payed: s.payed }))
      .sort((a, b) => String(b.dateClosed).localeCompare(String(a.dateClosed)))
      .slice(0, 60);
    return jsonResponse(200, { ok: true, debug: true, rangeIni: ini, rangeEnd: end, count: sales.length, sales: list });
  }

  // Buscamos todas las ventas que coincidan con esa boleta (puede haber más de una fila
  // si hubo una nota de crédito asociada).
  const matches = sales.filter(s => String(s.fiscalId).trim() === receipt);

  if (matches.length === 0) {
    return jsonResponse(404, { ok: false, error: 'No encontramos esa boleta en los últimos días.' });
  }

  const hasCreditNote = matches.some(s => s.fiscalType === 'NC');
  if (hasCreditNote) {
    return jsonResponse(409, { ok: false, error: 'Esa boleta tiene una nota de crédito asociada (fue anulada). No se puede usar para sumar sello ni descuento.' });
  }

  // Tomamos la venta original (no NC) para extraer los productos y el monto.
  const sale = matches.find(s => s.fiscalType !== 'NC') || matches[0];
  const rawProducts = sale.products || [];

  const products = rawProducts.map(p => `${p.name}${p.quantity > 1 ? ' x' + p.quantity : ''}`);
  const productDetails = rawProducts.map(p => ({
    name: p.name,
    quantity: p.quantity,
    amount: p.payed,
    category: p.hierarchyName || null,
  }));

  // --- Detección de café por jerarquía Toteat (AB.120 Café) ---
  // Toteat clasifica cada producto en una jerarquía interna (ver panel de Productos).
  // El café vive bajo el código "AB.120". Ese código llega en el campo de jerarquía
  // del producto (probamos varios nombres posibles porque no hay una boleta real
  // todavía para confirmar el nombre exacto del campo que usa la API de ventas).
  const HIERARCHY_CODE = 'AB.120';

  function getHierarchyText(p) {
    return String(
      p.hierarchyName || p.hierarchy || p.hierarchyCode || p.hierarchyId ||
      p.categoryName || p.category || ''
    );
  }

  function isCoffeeByHierarchy(p) {
    return getHierarchyText(p).toUpperCase().includes(HIERARCHY_CODE);
  }

  // Respaldo por nombre, solo para productos que no traigan el campo de jerarquía
  // (o mientras confirmamos el nombre exacto del campo con una boleta real).
  const COFFEE_KEYWORDS = ['cafe', 'café', 'latte', 'capuccino', 'cappuccino', 'espresso', 'expreso', 'americano', 'macchiato', 'mocha', 'moka', 'flat white', 'cortado', 'cold brew'];
  function isCoffeeByName(p) {
    return COFFEE_KEYWORDS.some(k => (p.name || '').toLowerCase().includes(k));
  }

  const coffeeItems = rawProducts.filter(p => isCoffeeByHierarchy(p) || (!getHierarchyText(p) && isCoffeeByName(p)));

  // Si hay varios cafés en la misma boleta, nos quedamos con el de mayor valor
  // como "el café" representativo de esta visita.
  const mainCoffeeSource = coffeeItems.length > 0 ? coffeeItems : rawProducts.filter(isCoffeeByName);
  const mainCoffee = mainCoffeeSource.length > 0
    ? mainCoffeeSource.reduce((max, p) => (p.payed > (max ? max.payed : -1) ? p : max), null)
    : null;

  return jsonResponse(200, {
    ok: true,
    receipt,
    amount: sale.payed,
    products,
    productDetails,
    mainCoffee: mainCoffee ? { name: mainCoffee.name, amount: mainCoffee.payed } : null,
    fiscalType: sale.fiscalType,
    dateClosed: sale.dateClosed,
  });
};

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
