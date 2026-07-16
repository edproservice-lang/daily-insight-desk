// ===== CONFIG (variáveis de ambiente na Vercel) =====
// JVZOO_SECRET_KEY     -> Senha inventada por você, mesma usada no parâmetro ?secret= da Postback URL
// GOOGLE_CLIENT_EMAIL  -> client_email do JSON da Service Account
// GOOGLE_PRIVATE_KEY   -> private_key do JSON da Service Account (com \n literais)
// GOOGLE_SHEET_ID      -> ID da planilha (trecho da URL entre /d/ e /edit)
// CONVERSION_NAME      -> Nome da conversão (ex: "Venda JVZoo")
//
// Postback URL a configurar no JVZoo (S2S Postbacks):
// https://SEU-PROJETO.vercel.app/api/jvzoo?secret=SUA_CHAVE&gclid={gclid}&transaction_id={transaction_id}&amount={transaction_amount}&currency={currency}&type={transaction_type}

import crypto from 'crypto';

export default async function handler(req, res) {
  try {
    // O JVZoo (sistema novo de S2S Postback) manda os dados via GET, na própria URL
    const params = req.method === 'GET' ? req.query : { ...req.query, ...req.body };

    // ---------- 1. Validar autenticidade (chave secreta compartilhada) ----------
    const expectedSecret = process.env.JVZOO_SECRET_KEY;
    if (!expectedSecret || params.secret !== expectedSecret) {
      return res.status(403).send('Invalid or missing secret');
    }

    // ---------- 2. Só processa vendas confirmadas ----------
    if (params.type !== 'SALE') {
      return res.status(200).send('Ignored (not a confirmed sale)');
    }

    // ---------- 3. Extrair GCLID, valor e ID da transação ----------
    const gclid = params.gclid;
    const value = parseFloat(params.amount || '0');
    const currency = params.currency || 'USD';
    const transactionId = params.transaction_id || '';

    if (!gclid) {
      return res.status(200).send('Ignored (no GCLID found)');
    }

    // ---------- 4. Escrever a linha na Google Sheet ----------
    await appendConversionToSheet({
      gclid,
      conversionName: 'facelessforge',
      value,
      currency,
      transactionId,
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no processamento do postback:', err);
    return res.status(500).send('Internal error: ' + err.message);
  }
}

// ===== Funções auxiliares =====

// Gera um access token usando o fluxo de Service Account (JWT assinado com a private key)
async function getAccessToken() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_CLIENT_EMAIL ou GOOGLE_PRIVATE_KEY não configurados');
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const base64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const unsignedToken = `${base64url(header)}.${base64url(payload)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  const jwt = `${unsignedToken}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Falha ao obter access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function appendConversionToSheet({ gclid, conversionName, value, currency, transactionId }) {
  const accessToken = await getAccessToken();
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // Formato de data: yyyy-mm-dd hh:mm:ss+00:00 (UTC)
  const now = new Date();
  const conversionTime =
    now.toISOString().replace('T', ' ').substring(0, 19) + '+00:00';

  const row = [[gclid, conversionName, conversionTime, value, currency, transactionId]];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:F:append?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: row }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Falha ao escrever na planilha: ' + errText);
  }
}
