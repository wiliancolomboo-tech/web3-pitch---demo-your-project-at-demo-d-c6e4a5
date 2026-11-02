# 1. Build optimized BPF program
anchor build

# 2. Synchronize Program ID
solana address -k target/deploy/trembitapay-keypair.json

# 3. Deploy to Solana Devnet / Testnet
solana program deploy \
  --program-id target/deploy/trembitapay-keypair.json \
  target/deploy/trembitapay.so \
  --url https://api.devnet.solana.com

# 4. Launch Enterprise Bridge Daemon
docker compose up -d --build
docker compose logs -f