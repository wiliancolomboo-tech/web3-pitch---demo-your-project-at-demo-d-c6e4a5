# Build Anchor binary
anchor build

# Generate program keypair (if not present)
solana-keygen new -o target/deploy/kredostream-keypair.json --no-bip39-passphrase

# Deploy to Solana Devnet
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json \
  target/deploy/kredostream.so