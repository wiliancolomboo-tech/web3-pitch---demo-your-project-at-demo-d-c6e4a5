# 1. Build and verify the Anchor program
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy target/deploy/tryzub_stream.so \
  --program-id target/deploy/tryzub_stream-keypair.json \
  --url https://api.devnet.solana.com

# 3. Provision environment secrets
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=$(solana address -k target/deploy/tryzub_stream-keypair.json)
RESEND_API_KEY=re_test_000000000000000000000000
ENTERPRISE_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
AUDIT_EMAIL=treasury@kyiv.reconstruct.ua
EOF

# 4. Spin up the self-hosted daemon
docker compose up -d --build