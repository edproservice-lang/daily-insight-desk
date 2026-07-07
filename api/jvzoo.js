import crypto from 'crypto';

// ===== CONFIG (variáveis de ambiente na Vercel) =====
// JVZOO_SECRET_KEY           -> Chave secreta do JVZoo (Settings > Secret Key)
// GOOGLE_CLIENT_ID           -> Client ID do Google Cloud Console
// GOOGLE_CLIENT_SECRET       -> Client Secret do Google Cloud Console
// GOOGLE_SHEETS_REFRESH_TOKEN-> Refresh Token gerado no OAuth Playground (escopo spreadsheets)
// GOOGLE_SHEET_ID            -> ID da planilha (trecho da URL entre /d/ e /edit)
// CONVERSION_NAME            -> Nome EXATO da ação de conversão criada no Google Ads (ex: "Venda JVZoo")

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const body = req.body;
    const secretKey = process.env.JVZOO_SECRET_KEY;

    // ---------- 1. Validar autenticidade do postback (checksum SHA) ----------
    const fields = Object.keys(body).sort();
    let concatenated = secretKey;
    fields.forEach((key) => {
      if (key !== 'cverify') concatenated += body[key];
    });
    const hash = crypto
      .createHash('sha256')
      .update(concatenated)
      .digest('hex')
      .substring(0, 8)
      .toUpperCase();

    if (hash !== body.cverify) {
      return res.status(403).send('Invalid IPN signature');
    }

    // ---------- 2. Só processa vendas confirmadas ----------
    if (body.ctransaction !== 'SALE') {
      return res.status(200).send('Ignored (not a confirmed sale)');
    }

    // ---------- 3. Extrair GCLID e valor ----------
    // Ajuste o campo abaixo conforme o placeholder que o JVZoo está te devolvendo
    // (pode ser body.tid, body.cvar2, body.ccustom, etc — confirme no seu IPN log)
    const gclid = body.tid || body.cvar2 || body.ccustom;
    const value = parseFloat(body.ctransamount || '0');

    if (!gclid) {
      return res.status(200).send('Ignored (no GCLID found)');
    }

    // ---------- 4. Escrever a linha na Google Sheet ----------
    await appendConversionToSheet({
      gclid,
      conversionName: process.env.CONVERSION_NAME || 'Venda JVZoo',
      value,
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no processamento do postback:', err);
    return res.status(500).send('Internal error');
  }
}

// ===== Funções auxiliares =====

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_SHEETS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Falha ao obter access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function appendConversionToSheet({ gclid, conversionName, value }) {
  const accessToken = await getAccessToken();
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // Formato de data exigido pelo Google Ads: yyyy-mm-dd hh:mm:ss+00:00 (UTC)
  const now = new Date();
  const conversionTime =
    now.toISOString().replace('T', ' ').substring(0, 19) + '+00:00';

  const row = [[gclid, conversionName, conversionTime, value, 'USD']];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:E:append?valueInputOption=USER_ENTERED`;

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
