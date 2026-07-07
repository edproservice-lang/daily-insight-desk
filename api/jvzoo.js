export default async function handler(req, res) {
  const { gclid, value, currency, transaction_id, type } = req.query;

  console.log('Postback recebido:', { gclid, value, currency, transaction_id, type });

  if (!gclid) {
    console.log('Sem gclid — ignorando conversão.');
    return res.status(200).send('No gclid, ignored');
  }

  try {
    // 1. Pega um access token novo usando o refresh token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('Erro ao renovar o access token:', tokenData);
      return res.status(200).send('Token error logged');
    }

    const accessToken = tokenData.access_token;

    // 2. Monta o payload da Data Manager API
    const now = new Date();

    const body = {
      destinations: [
        {
          operatingAccount: {
            accountType: 'GOOGLE_ADS',
            accountId: process.env.GOOGLE_CUSTOMER_ID,
          },
          productDestinationId: process.env.CONVERSION_ACTION_ID,
        },
      ],
      encoding: 'HEX',
      events: [
        {
          adIdentifiers: { gclid },
          conversionValue: parseFloat(value) || 0,
          currency: currency || 'USD',
          eventTimestamp: now.toISOString(),
          transactionId: transaction_id || undefined,
          eventSource: 'WEB',
        },
      ],
      validateOnly: false,
      consent: {
        adUserData: 'GRANTED',
        adPersonalization: 'GRANTED',
      },
    };

    // 3. Envia pra Data Manager API
    const dmResponse = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const dmData = await dmResponse.json();

    if (!dmResponse.ok) {
      console.error('Erro da Data Manager API:', dmData);
      return res.status(200).send('Data Manager API error logged');
    }

    console.log('Conversão enviada com sucesso:', dmData);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(200).send('Error logged');
  }
}
