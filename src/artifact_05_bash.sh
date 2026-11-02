# 1. Install Solana CLI & Anchor 0.30+
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked

# 2. Build smart contract binary
cd volia_protocol
anchor build

# 3. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Verify Program ID match in lib.rs and Anchor.toml
anchor test --skip-deploy