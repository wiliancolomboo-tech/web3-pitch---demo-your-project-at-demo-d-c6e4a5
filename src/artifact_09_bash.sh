# 1. Install prerequisites and build Anchor program
solana config set --url https://api.devnet.solana.com
anchor build

# 2. Deploy program to Solana devnet
anchor deploy --program-name kyiv_core --program-keypair target/deploy/kyiv_core-keypair.json

# 3. Initialize local environment variables
cat <<EOF > .env
SOLANA_RPC_URL="https://api.devnet.solana.com"
SOLANA_WSS_URL="wss://api.devnet.solana.com"
PROGRAM_ID="$(solana address -k target/deploy/kyiv_core-keypair.json)"
RESEND_API_KEY="re_123456789"
DISCORD_WEBHOOK_URL="https://api.example.com/webhooks/alerts/placeholder"
AUDIT_EMAIL_TO="cfo@kyiv-initiative.ua"
EOF

# 4. Run automated test suite verifying contract integrity
anchor test

# 5. Spin up containerized telemetry and bridge agent
docker-compose up -d --build
docker-compose logs -f