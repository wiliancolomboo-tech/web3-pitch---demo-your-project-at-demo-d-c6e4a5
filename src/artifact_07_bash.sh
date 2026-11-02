solana config set --url https://api.devnet.solana.com
solana airdrop 5

# Synchronize declared Program ID with compiled binary
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet