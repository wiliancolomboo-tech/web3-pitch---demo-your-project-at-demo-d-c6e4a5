import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BN } from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

interface VaultState {
  authority: PublicKey;
  contingencyRecovery: PublicKey;
  beneficiary: PublicKey;
  tokenMint: PublicKey;
  vaultTokenAccount: PublicKey;
  vaultId: BN;
  heartbeatTimeoutSeconds: BN;
  lastHeartbeatTimestamp: BN;
  startTimestamp: BN;
  totalDepositAmount: BN;
  ratePerSecond: BN;
  withdrawnAmount: BN;
  isContingencyActive: boolean;
  isHalted: boolean;
}

export class VoliaKeeperService {
  private connection: Connection;
  private provider: AnchorProvider;
  private program: Program;
  private resendApiKey: string;
  private alertWebhookUrl: string;
  private isRunning: boolean = false;

  constructor(
    rpcUrl: string,
    keypair: Keypair,
    idl: Idl,
    programId: PublicKey,
    resendApiKey: string,
    alertWebhookUrl: string
  ) {
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
    const wallet = new Wallet(keypair);
    this.provider = new AnchorProvider(this.connection, wallet, {
      preflightCommitment: "confirmed",
    });
    this.program = new Program(idl, programId, this.provider);
    this.resendApiKey = resendApiKey;
    this.alertWebhookUrl = alertWebhookUrl;
  }

  public async evaluateVault(vaultPubkey: PublicKey): Promise<void> {
    try {
      const vaultData = (await this.program.account.vaultAccount.fetch(
        vaultPubkey
      )) as unknown as VaultState;

      const currentUnix = Math.floor(Date.now() / 1000);
      const lastHeartbeat = vaultData.lastHeartbeatTimestamp.toNumber();
      const timeoutSec = vaultData.heartbeatTimeoutSeconds.toNumber();
      const timeRemaining = lastHeartbeat + timeoutSec - currentUnix;

      console.log(
        `[VOLIA AGENT] Vault: ${vaultPubkey.toBase58()} | Elapsed: ${
          currentUnix - lastHeartbeat
        }s / Timeout: ${timeoutSec}s | Status: ${
          vaultData.isContingencyActive ? "FAILOVER TRIGGERED" : "HEALTHY"
        }`
      );

      // Warning Threshold: If 80% of window has elapsed and failover has not been tripped
      if (timeRemaining < timeoutSec * 0.2 && timeRemaining > 0 && !vaultData.isContingencyActive) {
        await this.dispatchAlert(
          "URGENT: Heartbeat Degradation Detected",
          `Vault ${vaultPubkey.toBase58()} will trigger contingency failover in ${timeRemaining} seconds! Please submit heartbeat immediately.`
        );
      }

      // Expired: Automatically trip contingency recovery if lapsed
      if (timeRemaining <= 0 && !vaultData.isContingencyActive) {
        console.warn(`[VOLIA ALARM] Heartbeat lapsed for ${vaultPubkey.toBase58()}. Executing failover...`);
        
        await this.dispatchAlert(
          "CRITICAL: Triggering Emergency Treasury Evacuation",
          `Heartbeat timeout exceeded by ${Math.abs(timeRemaining)}s. Dispatching on-chain evacuation instruction.`
        );

        const txSig = await this.program.methods
          .triggerContingency()
          .accounts({
            vault: vaultPubkey,
            caller: this.provider.wallet.publicKey,
            contingencyRecovery: vaultData.contingencyRecovery,
            vaultTokenAccount: vaultData.vaultTokenAccount,
            contingencyRecoveryTokenAccount: vaultData.contingencyRecovery, // Target ATA
            tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          })
          .rpc();

        console.log(`[FAILOVER TX CONFIRMED]: ${txSig}`);
        await this.dispatchAlert(
          "SUCCESS: Vault Funds Evacuated to Backup Multi-Sig",
          `Transaction confirmed: https://solscan.io/tx/${txSig}?cluster=custom`
        );
      }
    } catch (err: any) {
      console.error(`[AGENT ERROR]: Failed checking vault ${vaultPubkey.toBase58()}:`, err.message);
    }
  }

  public async dispatchAlert(subject: string, message: string): Promise<void> {
    // 1. Resend Transactional Email dispatch
    if (this.resendApiKey) {
      try {
        await axios.post(
          "https://api.resend.com/emails",
          {
            from: "Volia Security Monitor <alerts@volia-kyiv.internal>",
            to: ["ops-lead@volia-kyiv.internal", "treasury-admin@kyiv-builder.ua"],
            subject: `[VOLIA INCIDENT ALERT] ${subject}`,
            html: `<h3>Volia Autonomous Protocol Sentinel</h3><p>${message}</p><p>Timestamp: ${new Date().toISOString()}</p>`,
          },
          {
            headers: {
              Authorization: `Bearer ${this.resendApiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
      } catch (e: any) {
        console.error("[RESEND HTTP ERROR]:", e?.response?.data || e.message);
      }
    }

    // 2. Incident Webhook dispatch (Slack/Discord)
    if (this.alertWebhookUrl) {
      try {
        await axios.post(this.alertWebhookUrl, {
          username: "Volia Protocol Sentinel",
          content: `🚨 **${subject}**\n${message}\n*Timestamp: ${new Date().toISOString()}*`,
        });
      } catch (e: any) {
        console.error("[WEBHOOK HTTP ERROR]:", e?.response?.data || e.message);
      }
    }
  }

  public async startLoop(vaults: PublicKey[], intervalMs: number = 10000): Promise<void> {
    this.isRunning = true;
    console.log(`[VOLIA AGENT] Started autonomous monitoring across ${vaults.length} vaults.`);
    while (this.isRunning) {
      for (const v of vaults) {
        await this.evaluateVault(v);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  public stop(): void {
    this.isRunning = false;
  }
}