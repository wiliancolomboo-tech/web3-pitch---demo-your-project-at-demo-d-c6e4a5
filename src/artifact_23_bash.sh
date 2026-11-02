# 1. Set network to devnet
solana config set --url devnet

# 2. Fund deployment wallet
solana airdrop 2

# 3. Deploy the compiled binary
anchor deploy --provider.cluster devnet

# 4. Verify deployment state
solana program show $(solana address -k target/deploy/volya-keypair.json)