# 1. Install prerequisites
npm install -g @coral-xyz/anchor-cli
solana-keygen new -o deployer-keypair.json --no-bip39-passphrase

# 2. Configure Solana devnet/testnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2 deployer-keypair.json

# 3. Build & Deploy Smart Contract
cd sova-core
anchor build
solana program deploy target/deploy/sova_core.so --program-id deployer-keypair.json

# 4. Copy the deployed Program ID into Anchor.toml and sova-relayer/.env