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
//   Opcional: &date=20260724 (si no se envía, busca en el día de hoy)

exports.handler = async (event) => {
  const receipt = (event.queryStringParameters && event.queryStringParameters.receipt || '').trim();
  const dateParam = event.queryStringParameters && event.queryStringParameters.date;

  if (!receipt) {
    return jsonResponse(400, { ok: false, error: 'Falta el número de boleta (parámetro receipt).' });
  }

  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  // Por defecto buscamos en el día de hoy (hora de Chile). Se puede sobrescribir con ?date=YYYYMMDD
  const today = dateParam || formatDate(new Date());

  const url = new URL('https://api.toteat.com/mw/or/1.0/sales');
  url.searchParams.set('xir', TOTEAT_XIR);
  url.searchParams.set('xil', TOTEAT_XIL);
  url.searchParams.set('xiu', TOTEAT_XIU);
  url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);
  url.searchParams.set('ini', today);
  url.searchParams.set('end', today);
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

  const sales = (toteatData && toteatData.data) || [];

  // Buscamos todas las ventas que coincidan con esa boleta (puede haber más de una fila
  // si hubo una nota de crédito asociada).
  const matches = sales.filter(s => String(s.fiscalId).trim() === receipt);

  if (matches.length === 0) {
    return jsonResponse(404, { ok: false, error: 'No encontramos esa boleta en el turno de hoy.' });
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

  // Si hay varios cafés en la misma boleta, nos quedamos con el de mayor valor
  // como "el café" representativo de esta visita.
  const COFFEE_KEYWORDS = ['cafe', 'café', 'latte', 'capuccino', 'cappuccino', 'espresso', 'expreso', 'americano', 'macchiato', 'mocha', 'moka', 'flat white', 'cortado', 'cold brew'];
  const coffeeItems = rawProducts.filter(p => COFFEE_KEYWORDS.some(k => (p.name || '').toLowerCase().includes(k)));
  const mainCoffeeSource = coffeeItems.length > 0 ? coffeeItems : rawProducts;
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
