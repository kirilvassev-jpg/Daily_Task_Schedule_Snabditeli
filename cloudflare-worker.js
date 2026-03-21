/**
 * Cloudflare Worker — FCM Push Notification Proxy
 *
 * Разгръща се на Cloudflare Workers (безплатен план).
 * Power Automate извиква този worker при създаване на нова задача.
 * Worker-ът взима всички FCM токени от Firestore и изпраща push до всички устройства.
 *
 * ── Environment Variables (задай в Cloudflare Dashboard → Workers → Settings → Variables) ──
 *   PUSH_SECRET          = произволен таен стринг (напр. "moqTaenParola2026!")
 *   SERVICE_ACCOUNT_JSON = цялото съдържание на firebase service account JSON файла
 *   PROJECT_ID           = snabditeli-daily-tasks
 */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Push-Secret'
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    // Проверка на тайния ключ
    const secret = request.headers.get('X-Push-Secret');
    if (!secret || secret !== env.PUSH_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: responseHeaders });
    }

    const title   = body.title || '📦 Нова задача!';
    const message = body.body  || 'Натисни за преглед';

    try {
      const accessToken = await getGoogleAccessToken(env.SERVICE_ACCOUNT_JSON);
      const tokens      = await getTokensFromFirestore(accessToken, env.PROJECT_ID);

      if (tokens.length === 0) {
        return new Response(
          JSON.stringify({ sent: 0, total: 0, message: 'No registered devices' }),
          { status: 200, headers: responseHeaders }
        );
      }

      const results   = await Promise.allSettled(
        tokens.map(token => sendFCMPush(accessToken, env.PROJECT_ID, token, title, message))
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed    = results.filter(r => r.status === 'rejected').length;

      return new Response(
        JSON.stringify({ sent: succeeded, failed, total: tokens.length }),
        { status: 200, headers: responseHeaders }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: responseHeaders });
    }
  }
};

// ── Генерира Google OAuth2 access token от Service Account (JWT) ──
async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);

  const b64u = (obj) => {
    const str   = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str);
    let binary  = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };

  const now     = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  };

  const sigInput = `${b64u(header)}.${b64u(payload)}`;

  // PEM → DER
  const pem    = sa.private_key.replace(/\\n/g, '\n');
  const pemBody = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der     = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${sigInput}.${sig}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error('Google token error: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ── Взима всички FCM токени от Firestore ──
async function getTokensFromFirestore(accessToken, projectId) {
  const url  = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/fcm_tokens`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  if (!data.documents) return [];
  return data.documents
    .map(doc => doc.fields && doc.fields.token && doc.fields.token.stringValue)
    .filter(Boolean);
}

// ── Изпраща FCM push до един токен ──
async function sendFCMPush(accessToken, projectId, token, title, body) {
  const url  = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        webpush: {
          notification: {
            title, body,
            icon:               'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
            badge:              'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
            tag:                'new-task',
            renotify:           true,
            requireInteraction: true,
            vibrate:            [300, 100, 300, 100, 300]
          }
        }
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(JSON.stringify(err));
  }
  return resp.json();
}
