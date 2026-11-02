import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KyivStream } from "../target/types/kyiv_stream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("kyiv_stream end-to-end operational suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KyivStream as Program<KyivStream>;

  const initializer = Keypair.generate();
  const recipient = Keypair.generate();
  const fallbackRecipient = Keypair.generate();
  const unauthorizedAttacker = Keypair.generate();

  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let fallbackTokenAccount: PublicKey;

  const streamId = new anchor.BN(42);
  const totalAmount = new anchor.BN(1_000_000_000); // 1,000 Tokens (6 decimals)
  const milestoneAmount = new anchor.BN(400_000_000); // 400 Tokens
  const heartbeatTimeout = new anchor.BN(2); // 2-second timeout for testing failover

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [initializer, recipient, fallbackRecipient, unauthorizedAttacker]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create SPL Token Mint
    mint = await createMint(
      provider.connection,
      initializer,
      initializer.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    initializerTokenAccount = await createAccount(
      provider.connection,
      initializer,
      mint,
      initializer.publicKey
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      recipient,
      mint,
      recipient.publicKey
    );

    fallbackTokenAccount = await createAccount(
      provider.connection,
      fallbackRecipient,
      mint,
      fallbackRecipient.publicKey
    );

    // Mint tokens to Initializer
    await mintTo(
      provider.connection,
      initializer,
      mint,
      initializerTokenAccount,
      initializer.publicKey,
      2_000_000_000
    );

    // Derive PDAs
    const streamIdBuffer = streamId.toArrayLike(Buffer, "le", 8);
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kyiv_stream_escrow"), initializer.publicKey.toBuffer(), streamIdBuffer],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kyiv_stream_vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Stream Escrow and locks funds into PDA Vault", async () => {
    await program.methods
      .initializeStream(streamId, totalAmount, heartbeatTimeout)
      .accounts({
        initializer: initializer.publicKey,
        recipient: recipient.publicKey,
        fallbackRecipient: fallbackRecipient.publicKey,
        mint: mint,
        initializerTokenAccount: initializerTokenAccount,
        escrowState: escrowPda,
        tokenVault: vaultPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([initializer])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultInfo.amount)).to.equal(totalAmount.toNumber());

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.initializer.toBase58()).to.equal(initializer.publicKey.toBase58());
    expect(escrowAccount.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(totalAmount.toNumber());
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(0);
    expect(escrowAccount.status).to.equal(0); // Active
  });

  it("2. Operator updates dead-man heartbeat timestamp successfully", async () => {
    const beforeState = await program.account.escrowState.fetch(escrowPda);
    
    // Artificial 1 sec pause
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await program.methods
      .sendHeartbeat(streamId)
      .accounts({
        initializer: initializer.publicKey,
        escrowState: escrowPda,
      })
      .signers([initializer])
      .rpc();

    const afterState = await program.account.escrowState.fetch(escrowPda);
    expect(afterState.lastHeartbeatTimestamp.toNumber()).to.be.greaterThan(
      beforeState.lastHeartbeatTimestamp.toNumber()
    );
  });

  it("3. Releases milestone payout to recipient", async () => {
    await program.methods
      .releaseMilestone(streamId, milestoneAmount)
      .accounts({
        authority: initializer.publicKey,
        escrowState: escrowPda,
        initializer: initializer.publicKey,
        recipient: recipient.publicKey,
        tokenVault: vaultPda,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([initializer])
      .rpc();

    const recipientBalance = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientBalance.amount)).to.equal(milestoneAmount.toNumber());

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(milestoneAmount.toNumber());
  });

  it("4. Blocks premature failover before heartbeat expires", async () => {
    try {
      await program.methods
        .triggerFailoverRecovery(streamId)
        .accounts({
          caller: fallbackRecipient.publicKey,
          escrowState: escrowPda,
          fallbackRecipient: fallbackRecipient.publicKey,
          tokenVault: vaultPda,
          fallbackTokenAccount: fallbackTokenAccount,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([fallbackRecipient])
        .rpc();
      expect.fail("Premature failover should have been rejected.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("HeartbeatStillValid");
    }
  });

  it("5. Triggers failover recovery after heartbeat timeout elapses", async () => {
    // Wait out the 2-second timeout window
    await new Promise((resolve) => setTimeout(resolve, 2500));

    await program.methods
      .triggerFailoverRecovery(streamId)
      .accounts({
        caller: fallbackRecipient.publicKey,
        escrowState: escrowPda,
        fallbackRecipient: fallbackRecipient.publicKey,
        tokenVault: vaultPda,
        fallbackTokenAccount: fallbackTokenAccount,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([fallbackRecipient])
      .rpc();

    const remainingExpected = totalAmount.sub(milestoneAmount).toNumber();
    const fallbackBalance = await getAccount(provider.connection, fallbackTokenAccount);
    expect(Number(fallbackBalance.amount)).to.equal(remainingExpected);

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.status).to.equal(2); // Recovered
  });

  it("6. Rejects malicious unauthorized attempts on settled escrow", async () => {
    try {
      await program.methods
        .releaseMilestone(streamId, milestoneAmount)
        .accounts({
          authority: unauthorizedAttacker.publicKey,
          escrowState: escrowPda,
          initializer: initializer.publicKey,
          recipient: recipient.publicKey,
          tokenVault: vaultPda,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedAttacker])
        .rpc();
      expect.fail("Unauthorized call should have failed.");
    } catch (err: any) {
      expect(err.toString()).to.include("StreamInactive");
    }
  });
});