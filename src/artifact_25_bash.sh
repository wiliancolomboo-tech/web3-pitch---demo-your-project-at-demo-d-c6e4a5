# 1. Switch to Solana Devnet
solana config set --url devnet

# 2. Fund your deployer wallet
solana airdrop 2

# 3. Deploy binary to Devnet
anchor deploy --provider.cluster devnet

# 4. Initialize protocol on devnet
anchor run init-devnet