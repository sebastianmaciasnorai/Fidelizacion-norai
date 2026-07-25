// netlify/functions/create-wallet-pass.js
//
// Genera el link firmado para que un cliente guarde su tarjeta en Google Wallet.
//
// Variables de entorno necesarias:
//   GOOGLE_WALLET_KEY_JSON   -> el contenido completo del archivo .json de la cuenta de servicio
//   GOOGLE_WALLET_ISSUER_ID  -> tu ID de entidad emisora (ej: 3388000000023163819)
//   GOOGLE_WALLET_CLASS_ID   -> el ID completo de la clase (ej: 3388000000023163819.norai_loyalti)
//
// Uso desde la app:
//   GET /.netlify/functions/create-wallet-pass?customerId=159540&name=Rommy&stamps=2&goal=5

const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const customerId = params.customerId;
  const name = params.name || 'Cliente Norāi';
  const stamps = parseInt(params.stamps || '0', 10);
  const goal = parseInt(params.goal || '5', 10);

  if (!customerId) {
    return jsonResponse(400, { ok: false, error: 'Falta el ID del cliente.' });
  }

  const { GOOGLE_WALLET_KEY_JSON, GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_CLASS_ID } = process.env;
  if (!GOOGLE_WALLET_KEY_JSON || !GOOGLE_WALLET_ISSUER_ID || !GOOGLE_WALLET_CLASS_ID) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Google Wallet en el servidor.' });
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(GOOGLE_WALLET_KEY_JSON);
  } catch (e) {
    return jsonResponse(500, { ok: false, error: 'La clave de servicio de Google no tiene un formato JSON válido.' });
  }

  const objectId = `${GOOGLE_WALLET_ISSUER_ID}.${customerId}`;

  const loyaltyObject = {
    id: objectId,
    classId: GOOGLE_WALLET_CLASS_ID,
    state: 'ACTIVE',
    accountId: customerId,
    accountName: name,
    loyaltyPoints: {
      label: 'Sellos',
      balance: { string: `${stamps}/${goal}` },
    },
    barcode: {
      type: 'QR_CODE',
      value: 'NORAI:' + customerId,
    },
  };

  const claims = {
    iss: serviceAccount.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: {
      loyaltyObjects: [loyaltyObject],
    },
  };

  let token;
  try {
    token = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });
  } catch (e) {
    return jsonResponse(500, { ok: false, error: 'No se pudo firmar el pase.', detail: String(e) });
  }

  return jsonResponse(200, {
    ok: true,
    saveUrl: `https://pay.google.com/gp/v/save/${token}`,
  });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
