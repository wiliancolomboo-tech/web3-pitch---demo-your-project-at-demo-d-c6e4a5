# 1. Install Anchor 0.30.1 & Build Smart Contract
avm use 0.30.1
anchor build

# 2. Synchronize Program ID and Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor keys sync
anchor deploy --provider.cluster devnet

# 3. Initialize Integration Node.js Dependencies
npm install
npm run build