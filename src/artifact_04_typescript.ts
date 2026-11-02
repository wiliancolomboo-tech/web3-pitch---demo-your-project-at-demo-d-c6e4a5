import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VoliaProtocol } from "../target/types/volia_protocol";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("Volia Protocol - Full QA & Deterministic Lifecycle Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VoliaProtocol as Program<VoliaProtocol>;

  let mint: PublicKey;
  let authority: Keypair;
  let beneficiary: Keypair;
  let contingencyRecovery: Keypair;
  let maliciousUser: Keypair;

  let depositorTokenAccount: PublicKey;
  let beneficiaryTokenAccount: PublicKey;
  let contingencyTokenAccount: PublicKey;

  const vaultId = new anchor.BN(42);
  const totalDepositAmount = new anchor.BN(10_000_000); // 10 USDC (6 decimals)
  const ratePerSecond = new anchor.BN(100_000); // 0.1 USDC per second
  const heartbeatTimeoutSeconds = new anchor.BN(300); // 5 minutes

  let vaultPda: PublicKey;
  let vaultBump: number;
  let vaultTokenAccountPda: PublicKey;

  before(async () => {
    authority = Keypair.generate();
    beneficiary = Keypair.generate();
    contingencyRecovery = Keypair.generate();
    maliciousUser = Keypair.generate();

    // Airdrop SOL to test participants
    for (const kp of [authority, beneficiary, contingencyRecovery, maliciousUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 20_000_000_000);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy test Mint
    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Token Accounts
    depositorTokenAccount = await createAccount(
      provider.connection,
      authority,
      mint,
      authority.publicKey
    );

    beneficiaryTokenAccount = await createAccount(
      provider.connection,
      beneficiary,
      mint,
      beneficiary.publicKey
    );

    contingencyTokenAccount = await createAccount(
      provider.connection,
      contingencyRecovery,
      mint,
      contingencyRecovery.publicKey
    );

    // Mint tokens to depositor
    await mintTo(
      provider.connection,
      authority,
      mint,
      depositorTokenAccount,
      authority,
      totalDepositAmount.toNumber()
    );

    // Derive PDA addresses
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("volia-vault"),
        authority.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultTokenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("volia-token-account"), vaultPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes a stream & contingency vault", async () => {
    await program.methods
      .initializeVault(
        vaultId,
        heartbeatTimeoutSeconds,
        totalDepositAmount,
        ratePerSecond
      )
      .accounts({
        vault: vaultPda,
        authority: authority.publicKey,
        contingencyRecovery: contingencyRecovery.publicKey,
        beneficiary: beneficiary.publicKey,
        tokenMint: mint,
        vaultTokenAccount: vaultTokenAccountPda,
        depositorTokenAccount: depositorTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await program.account.vaultAccount.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vaultAccount.beneficiary.toBase58()).to.equal(beneficiary.publicKey.toBase58());
    expect(vaultAccount.totalDepositAmount.toNumber()).to.equal(totalDepositAmount.toNumber());
    expect(vaultAccount.isContingencyActive).to.be.false;

    const vaultBalance = await getAccount(provider.connection, vaultTokenAccountPda);
    expect(Number(vaultBalance.amount)).to.equal(totalDepositAmount.toNumber());
  });

  it("2. Records an on-chain heartbeat by the primary authority", async () => {
    const priorState = await program.account.vaultAccount.fetch(vaultPda);
    
    // Wait 1 second to ensure timestamp strictly advances
    await new Promise((r) => setTimeout(r, 1100));

    await program.methods
      .recordHeartbeat()
      .accounts({
        vault: vaultPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const postState = await program.account.vaultAccount.fetch(vaultPda);
    expect(postState.lastHeartbeatTimestamp.toNumber()).to.be.greaterThan(
      priorState.lastHeartbeatTimestamp.toNumber()
    );
  });

  it("3. Prevents unauthorized actors from submitting a heartbeat", async () => {
    try {
      await program.methods
        .recordHeartbeat()
        .accounts({
          vault: vaultPda,
          authority: maliciousUser.publicKey,
        })
        .signers([maliciousUser])
        .rpc();
      expect.fail("Unauthorized heartbeat should have failed");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedAuthority");
    }
  });

  it("4. Allows beneficiary to claim vested stream tokens", async () => {
    // Wait 3 seconds to accumulate vested tokens (0.3 USDC)
    await new Promise((r) => setTimeout(r, 3000));

    await program.methods
      .claimStream()
      .accounts({
        vault: vaultPda,
        beneficiary: beneficiary.publicKey,
        vaultTokenAccount: vaultTokenAccountPda,
        beneficiaryTokenAccount: beneficiaryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([beneficiary])
      .rpc();

    const beneficiaryAccount = await getAccount(provider.connection, beneficiaryTokenAccount);
    expect(Number(beneficiaryAccount.amount)).to.be.greaterThan(0);
  });

  it("5. Rejects contingency evacuation before timeout expiry", async () => {
    try {
      await program.methods
        .triggerContingency()
        .accounts({
          vault: vaultPda,
          caller: maliciousUser.publicKey,
          contingencyRecovery: contingencyRecovery.publicKey,
          vaultTokenAccount: vaultTokenAccountPda,
          contingencyRecoveryTokenAccount: contingencyTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousUser])
        .rpc();
      expect.fail("Contingency trigger should have failed because timer is still active");
    } catch (err: any) {
      expect(err.toString()).to.include("HeartbeatStillActive");
    }
  });
});