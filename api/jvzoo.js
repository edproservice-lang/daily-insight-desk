import { GoogleAdsApi } from 'google-ads-api';

export default async function handler(req, res) {
  // O JVZoo manda os dados via GET (parâmetros na própria URL do postback)
  const { gclid, value, currency, transaction_id, type } = req.query;

  console.log('Postback recebido:', { gclid, value, currency, transaction_id, type });

  // Sem gclid não tem o que enviar pro Google Ads (venda não veio de anúncio, ou perdeu o parâmetro)
  if (!gclid) {
    console.log('Sem gclid — ignorando conversão.');
    return res.status(200).send('No gclid, ignored');
  }

  try {
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_DEV_TOKEN,
    });

    const customer = client.Customer({
      customer_id: process.env.GOOGLE_CUSTOMER_ID,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const now = new Date();
    const conversionDateTime =
      now.toISOString().slice(0, 19).replace('T', ' ') + '+00:00';

    await customer.conversionUploads.uploadClickConversions({
      conversions: [
        {
          gclid,
          conversion_action: `customers/${process.env.GOOGLE_CUSTOMER_ID}/conversionActions/${process.env.CONVERSION_ACTION_ID}`,
          conversion_date_time: conversionDateTime,
          conversion_value: parseFloat(value) || 0,
          currency_code: currency || 'USD',
          order_id: transaction_id || undefined,
        },
      ],
      partial_failure: true,
    });

    console.log('Conversão enviada com sucesso pro Google Ads.');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro ao enviar conversão pro Google Ads:', err);
    // Retorna 200 mesmo assim, pra não fazer o JVZoo ficar reenviando o mesmo postback
    return res.status(200).send('Error logged');
  }
}
