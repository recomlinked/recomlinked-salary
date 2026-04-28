// api/raise-log.js
// Proxies RAISE_SESSION events from the chat page to Google Sheets webhook.
// This avoids exposing the webhook URL in frontend code.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const webhookUrl = process.env.CAREER_SHEET_WEBHOOK;
  if (!webhookUrl) {
    console.error('[raise-log] CAREER_SHEET_WEBHOOK not set');
    return res.status(200).json({ ok: true }); // fail silently — logging should never break the app
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    console.error('[raise-log] webhook error:', e.message);
  }

  return res.status(200).json({ ok: true });
};
