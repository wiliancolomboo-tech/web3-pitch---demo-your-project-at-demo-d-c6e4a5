import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KyivCore } from "../target/types/kyiv_core";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("kyiv_core end-to-end test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KyivCore as Program<KyivCore>;

  let mint: anchor.web3.PublicKey;
  let senderTokenAccount: anchor.web3.PublicKey;
  let recipientTokenAccount: anchor.web3.PublicKey;
  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = anchor.web3.Keypair.generate();
  const arbiter = anchor.web3.Keypair.generate();

  const streamId = new anchor.BN(Date.now());
  const totalDeposit = new anchor.BN(10_000_000_000); // 10,000 tokens (decimals = 6)
  const milestoneCount = 4; // 4 milestones -> 2,500 tokens unlocked per milestone

  let streamPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    // 1. Airdrop SOL to recipient
    const sig = await provider.connection.requestAirdrop(
      recipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // 2. Create SPL Mint
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    // 3. Create Token Accounts
    senderTokenAccount = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      sender,
      mint,
      recipient.publicKey
    );

    // 4. Mint tokens into sender account
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderTokenAccount,
      sender,
      20_000_000_000
    );

    // 5. Derive PDAs
    const streamIdBuffer = streamId.toArrayLike(Buffer, "le", 8);

    [streamPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamIdBuffer],
      program.programId
    );

    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), sender.publicKey.toBuffer(), streamIdBuffer],
      program.programId
    );
  });

  it("1. Successfully initializes continuous milestone escrow stream", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const stopTime = new anchor.BN(now + 100); // 100 seconds streaming window

    await program.methods
      .initializeStream(
        streamId,
        totalDeposit,
        startTime,
        stopTime,
        milestoneCount
      )
      .accounts({
        streamAccount: streamPda,
        escrowVault: vaultPda,
        sender: sender.publicKey,
        arbiter: arbiter.publicKey,
        recipient: recipient.publicKey,
        senderTokenAccount: senderTokenAccount,
        tokenMint: mint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const streamAccount = await program.account.streamAccount.fetch(streamPda);
    expect(streamAccount.streamId.toString()).to.equal(streamId.toString());
    expect(streamAccount.totalDepositAmount.toString()).to.equal(totalDeposit.toString());
    expect(streamAccount.milestoneCount).to.equal(milestoneCount);
    expect(streamAccount.completedMilestones).to.equal(0);

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(vaultBalance.amount.toString()).to.equal(totalDeposit.toString());
  });

  it("2. Fails withdrawal when 0 milestones completed (milestone gate holds)", async () => {
    try {
      await program.methods
        .withdrawVested(new anchor.BN(100_000))
        .accounts({
          streamAccount: streamPda,
          escrowVault: vaultPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Withdrawal should have failed with NoFundsAvailable");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NoFundsAvailable");
    }
  });

  it("3. Arbiter settles milestone 1, enabling tranche unlock", async () => {
    await program.methods
      .settleMilestone()
      .accounts({
        streamAccount: streamPda,
        authority: sender.publicKey, // sender is authorized co-sign
      })
      .rpc();

    const streamAccount = await program.account.streamAccount.fetch(streamPda);
    expect(streamAccount.completedMilestones).to.equal(1);
  });

  it("4. Recipient withdraws vested tokens within unlocked milestone cap", async () => {
    // Wait 2 seconds for linear time accumulation
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const withdrawAmount = new anchor.BN(500_000); // 0.5 tokens
    await program.methods
      .withdrawVested(withdrawAmount)
      .accounts({
        streamAccount: streamPda,
        escrowVault: vaultPda,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const recipientBal = await getAccount(provider.connection, recipientTokenAccount);
    expect(recipientBal.amount.toString()).to.equal(withdrawAmount.toString());
  });

  it("5. Cancels stream: claws back unvested collateral to sender", async () => {
    const senderBalBefore = await getAccount(provider.connection, senderTokenAccount);

    await program.methods
      .cancelStream()
      .accounts({
        streamAccount: streamPda,
        escrowVault: vaultPda,
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        senderTokenAccount: senderTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const streamAccount = await program.account.streamAccount.fetch(streamPda);
    expect(streamAccount.isCanceled).to.be.true;

    const senderBalAfter = await getAccount(provider.connection, senderTokenAccount);
    expect(BigInt(senderBalAfter.amount)).to.be.greaterThan(BigInt(senderBalBefore.amount));
  });
});