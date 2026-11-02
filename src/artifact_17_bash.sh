# 1. Install prerequisites & configure Solana CLI
solana config set --url https://api.devnet.solana.com
solana-keygen new --no-bip39-passphrase -o ./deployer-keypair.json
solana airdrop 2 ./deployer-keypair.json

# 2. Build the Anchor verifiable binary
anchor build

# 3. Synchronize program keys and deploy
PROGRAM_ID=$(solana address -k target/deploy/volya_protocol-keypair.json)
sed -i "s/VoLyaG8zKevdC6qUvVz4n8k1yTqm2R9J5wE4VbKky1v/$PROGRAM_ID/g" programs/volya-protocol/src/lib.rs Anchor.toml
anchor build
anchor deploy --provider.cluster devnet --provider.wallet ./deployer-keypair.json