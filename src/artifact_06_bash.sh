# 1. Clone repository and install dependencies
git clone https://github.com/klyuch-protocol/klyuch-core.git
cd klyuch-core
yarn install

# 2. Build Anchor Rust artifacts
anchor build

# 3. Execute deterministic local tests
anchor test

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet