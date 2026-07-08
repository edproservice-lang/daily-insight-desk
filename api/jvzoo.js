// ===== CONFIG (variáveis de ambiente na Vercel) =====
// JVZOO_SECRET_KEY           -> Senha inventada por você, mesma usada no parâmetro ?secret= da Postback URL
// GOOGLE_CLIENT_ID           -> Client ID do Google Cloud Console
// GOOGLE_CLIENT_SECRET       -> Client Secret do Google Cloud Console
// GOOGLE_SHEETS_REFRESH_TOKEN-> Refresh Token gerado no OAuth Playground (escopo spreadsheets)
// GOOGLE_SHEET_ID            -> ID da planilha (trecho da URL entre /d/ e /edit)
// CONVERSION_NAME            -> Nome EXATO da ação de conversão criada no Google Ads (ex: "Venda JVZoo")
//
// Postback URL a configurar no JVZoo (S2S Postbacks):
// https://SEU-PROJETO.vercel.app/api/jvzoo?secret=SUA_CHAVE&gclid={gclid}&transaction_id={transaction_id}&amount={transaction_amount}&currency={currency}&type={transaction_type}

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

    // ---------- 3. Extrair GCLID e valor ----------
    const gclid = params.gclid;
    const value = parseFloat(params.amount || '0');
    const currency = params.currency || 'USD';

    if (!gclid) {
      return res.status(200).send('Ignored (no GCLID found)');
    }

    // ---------- 4. Escrever a linha na Google Sheet ----------
    await appendConversionToSheet({
      gclid,
      conversionName: process.env.CONVERSION_NAME || 'Venda JVZoo',
      value,
      currency,
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

async function appendConversionToSheet({ gclid, conversionName, value, currency }) {
  const accessToken = await getAccessToken();
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // Formato de data exigido pelo Google Ads: yyyy-mm-dd hh:mm:ss+00:00 (UTC)
  const now = new Date();
  const conversionTime =
    now.toISOString().replace('T', ' ').substring(0, 19) + '+00:00';

  const row = [[gclid, conversionName, conversionTime, value, currency]];

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
