module.exports = {
  apps: [{
    name: "whatsapp-checker",
    script: "wa-server.mjs",
    cwd: "/home/administrator/whatsapp-checker/artifacts/whatsapp-checker",
    interpreter: "node",
    env: {
      PORT: 3000,
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "8436003308:AAGe3QV6CDzq8rtzoUxTxhDQpCtRC4-P70A",
      TELEGRAM_CHAT_ID: "6728122351"
    },
    restart_delay: 3000,
    max_restarts: 10,
    watch: false
  }]
};
