const program = anchor.workspace.Klystron;
const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
  program.programId
);
const marketState = await program.account.market.fetch(marketPda);
console.log("Total Klystron Market Volume:", marketState.totalVolume.toString());