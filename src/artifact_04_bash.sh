# 1. Clone repository & enter workspace
git clone https://github.com/aegis-stream/aegis-protocol.git
cd aegis-protocol

# 2. Install TypeScript testing dependencies
yarn install

# 3. Generate keypair if not already present
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json

# 4. Synchronize Program ID with the declared ID in lib.rs
anchor build