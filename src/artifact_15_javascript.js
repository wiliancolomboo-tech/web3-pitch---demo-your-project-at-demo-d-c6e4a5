const id = new anchor.BN(Date.now());
const tx = await pg.program.methods
  .initializeStream(
    id,
    new anchor.BN(10_000_000), // Total 10 tokens
    new anchor.BN(100_000),    // 0.1 tokens/sec
    new anchor.BN(Math.floor(Date.now() / 1000)),
    new anchor.BN(Math.floor(Date.now() / 1000) + 100),
    new anchor.BN(Math.floor(Date.now() / 1000)),
    new anchor.BN(10_000_000)  // 0.01 SOL crank bounty
  )
  .rpc();
console.log("Stream initialized on Devnet with tx:", tx);