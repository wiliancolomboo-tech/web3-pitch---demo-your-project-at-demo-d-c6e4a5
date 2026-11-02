import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { EnterpriseNotifier } from "./notifier";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const programId = new PublicKey("Ky1vStream1111111111111111111111111111111111");
const programIdl = JSON.parse(fs.readFileSync("./target/idl/kyiv_stream.json", "utf-8"));

const program = new Command();
const notifier = new EnterpriseNotifier();

program
  .name("kyiv-stream-cli")
  .description("KyivStream Enterprise Orchestrator and Real-Time Telemetry Client")
  .version("1.0.0");

program
  .command("listen")
  .description("Listen to live Solana on-chain events and dispatch enterprise notifications")
  .option("-r, --rpc <url>", "Solana RPC URL", process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com")
  .action(async (options) => {
    const connection = new Connection(options.rpc, "confirmed");
    console.log(`[LISTENER] Subscribing to Program logs: ${programId.toBase58()}`);

    connection.onLogs(
      programId,
      async ({ logs, err, signature }) => {
        if (err) return;

        for (const log of logs) {
          if (log.includes("StreamInitializedEvent")) {
            await notifier.dispatchEvent({
              eventType: "INITIALIZED",
              streamId: "1",
              sender: "InitializerPubkey",
              recipient: "RecipientPubkey",
              txHash: signature,
              timestamp: Math.floor(Date.now() / 1000),
            });
          } else if (log.includes("MilestoneReleasedEvent")) {
            await notifier.dispatchEvent({
              eventType: "MILESTONE_RELEASED",
              streamId: "1",
              amount: "10000",
              sender: "AuthorityPubkey",
              recipient: "RecipientPubkey",
              txHash: signature,
              timestamp: Math.floor(Date.now() / 1000),
            });
          } else if (log.includes("FailoverRecoveredEvent")) {
            await notifier.dispatchEvent({
              eventType: "FAILOVER_RECOVERY",
              streamId: "1",
              amount: "RemainingBalance",
              sender: "RecoveryCaller",
              recipient: "FallbackRecipientPubkey",
              txHash: signature,
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        }
      },
      "confirmed"
    );

    console.log("[LISTENER] Active and waiting for Solana blocks...");
  });

program.parse(process.argv);