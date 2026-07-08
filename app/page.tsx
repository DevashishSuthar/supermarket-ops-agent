export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 40 }}>
      <h1>Supermarket Ops Agent</h1>
      <p>
        There is no web UI here by design — the product is a Telegram bot.
        Message the configured bot to interact with the store.
      </p>
      <p>Webhook endpoint: <code>/api/telegram/webhook</code></p>
    </main>
  );
}