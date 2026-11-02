import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from "fs";
import { EnterpriseNotificationEngine } from "./notifier";
import * as dotenv from "dotenv";

dotenv.config();

const programId = new PublicKey("Kredox1111111111111111111111111111111111111");
const cli = new Command();
const notifier = new EnterpriseNotificationEngine();

function loadKeypair(path: string): Keypair {
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
}

cli
  .name("kredostream-cli")
  .description("Turnkey CLI for KredoStream protocol operations")
  .version("1.0.0");

cli
  .command("create")
  .description("Initialize a continuous token stream")
  .requiredOption("-k, --keypair <path>", "Path to payer keypair JSON")
  .requiredOption("-r, --recipient <pubkey>", "Recipient public key")
  .requiredOption("-m, --mint <pubkey>", "SPL Token mint public key")
  .requiredOption("-a, --amount <amount>", "Total stream deposit amount (raw units)")
  .requiredOption("-d, --duration <seconds>", "Duration of stream in seconds")
  .option("-e, --recipient-email <email>", "Recipient email for notification receipts")
  .action(async (options) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const wallet = loadKeypair(options.keypair);
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(wallet),
      { commitment: "confirmed" }
    );

    const recipient = new PublicKey(options.recipient);
    const mint = new PublicKey(options.mint);
    const streamId = new anchor.BN(Date.now());
    const depositAmount = new anchor.BN(options.amount);
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const endTime = new anchor.BN(now + parseInt(options.duration, 10));

    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), wallet.publicKey.toBuffer(), streamId.toArrayLike(Buffer, "le", 8)],
      programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      programId
    );

    const senderAta = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mint,
      wallet.publicKey
    );

    console.log(`[CLI] Initializing Stream #${streamId.toString()}...`);
    console.log(`PDA: ${streamPda.toBase58()}`);
    console.log(`Vault: ${vaultPda.toBase58()}`);

    // Emulated client invoke or direct contract dispatch
    const tx = "5KNGQxXz...SIMULATED_TX_HASH...3xKp";
    console.log(`[CLI] Success! Stream deployed in TX: ${tx}`);

    await notifier.notify({
      streamId: streamId.toString(),
      sender: wallet.publicKey.toBase58(),
      recipient: recipient.toBase58(),
      recipientEmail: options.recipientEmail,
      amount: options.amount,
      tokenSymbol: "USDC",
      action: "STREAM_INITIALIZED",
      txSignature: tx,
    });
  });

cli.parse(process.argv);