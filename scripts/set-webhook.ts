import "dotenv/config";
/**
 * Run once after deploying: `npm run set-webhook`
 * Tells Telegram where to send updates, and sets the secret token
 * Telegram will echo back on every request so our route can verify it.
 */
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.PUBLIC_APP_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !appUrl || !secret) {
    console.error("Missing TELEGRAM_BOT_TOKEN, PUBLIC_APP_URL, or TELEGRAM_WEBHOOK_SECRET in env.");
    process.exit(1);
  }

  const webhookUrl = `${appUrl}/api/telegram/webhook`;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
  });

  const data = await res.json();
  console.log("setWebhook response:", data);
}

main();
