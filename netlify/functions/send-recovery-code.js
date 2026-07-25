// netlify/functions/send-recovery-code.js
//
// Manda un código de verificación de 6 dígitos por correo, para confirmar
// que quien está recuperando una tarjeta es realmente su dueño antes de
// mostrarle sus sellos e historial.
//
// Usa Resend (https://resend.com) porque tiene un nivel gratuito generoso
// y no exige verificar un dominio propio para empezar a probar: se puede
// mandar desde "onboarding@resend.dev" mientras no configures tu propio
// dominio verificado en Resend.
//
// Variable de entorno necesaria en Netlify:
//   RESEND_API_KEY  → la creás gratis en https://resend.com/api-keys

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Método no permitido' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Body inválido' }) };
  }

  const { email, code, name } = payload;

  if (!email || !code) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Falta email o código' }) };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('Falta configurar RESEND_API_KEY en las variables de entorno de Netlify');
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'El envío de correos no está configurado todavía. Avisá al administrador.' }) };
  }

  const firstName = (name || '').split(' ')[0] || '';

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">
      <p style="font-size: 15px; color:#211F1A;">Hola${firstName ? ' ' + firstName : ''},</p>
      <p style="font-size: 15px; color:#211F1A;">Este es tu código para recuperar tu tarjeta de <b>Norāi Café Club</b>:</p>
      <div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; background:#F2EEE3; color:#211F1A; padding: 16px 20px; border-radius: 12px; text-align:center; margin: 20px 0;">
        ${code}
      </div>
      <p style="font-size: 13px; color:#8C8676;">Este código vence en 10 minutos. Si no fuiste vos quien pidió recuperar la tarjeta, podés ignorar este correo.</p>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Norāi Café Club <onboarding@resend.dev>',
        to: [email],
        subject: 'Tu código para recuperar tu tarjeta Norāi',
        html
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Error de Resend:', data);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'No se pudo enviar el correo. Probá de nuevo.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'No se pudo conectar con el servicio de correo.' }) };
  }
};
