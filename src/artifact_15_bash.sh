# Set Solana cluster configuration
solana config set --url https://api.devnet.solana.com

# Build program binary
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Devnet
solana airdrop 2
anchor deploy --provider.cluster devnet