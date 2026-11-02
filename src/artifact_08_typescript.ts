import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VoliaStream } from "../target/types/volia_stream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";

describe("VoliaStream E2E Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VoliaStream as Program<VoliaStream>;

  let mint: anchor.web3.PublicKey;
  let senderTokenAccount: anchor.web3.PublicKey;
  let recipientTokenAccount: anchor.web3.PublicKey;
  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = anchor.web3.Keypair.generate();
  const attacker = anchor.web3.Keypair.generate();

  const streamId = new anchor.BN(Date.now());
  const totalDeposit = new anchor.BN(10_000_000); // 10 Tokens (6 decimals)
  const milestoneTranche = new anchor.BN(3_000_000); // 3 Tokens
  const preimage = crypto.randomBytes(32);
  const milestoneHash = crypto.createHash("sha256").update(preimage).digest();

  let streamPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to recipient and attacker
    const sig1 = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(attacker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Initialize Mint
    mint = await createMint(provider.connection, sender, sender.publicKey, null, 6);

    // Setup Token Accounts
    senderTokenAccount = await createAccount(provider.connection, sender, mint, sender.publicKey);
    recipientTokenAccount = await createAccount(provider.connection, recipient, mint, recipient.publicKey);

    // Mint funds to sender
    await mintTo(provider.connection, sender, mint, senderTokenAccount, sender.publicKey, 50_000_000);

    const streamIdBuf = streamId.toArrayLike(Buffer, "le", 8);
    [streamPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("volia_stream"), sender.publicKey.toBuffer(), streamIdBuf],
      program.programId
    );

    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stream_vault"), streamIdBuf],
      program.programId
    );
  });

  it("1. Initializes stream and locks funds in deterministic vault PDA", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const endTime = new anchor.BN(now + 10); // 10 second rapid window for testing

    await program.methods
      .initializeStream(
        streamId,
        totalDeposit,
        startTime,
        endTime,
        Array.from(milestoneHash),
        milestoneTranche
      )
      .accounts({
        streamAccount: streamPda,
        vaultTokenAccount: vaultPda,
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        tokenMint: mint,
        senderTokenAccount: senderTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const streamState = await program.account.streamState.fetch(streamPda);
    expect(streamState.streamId.toString()).to.equal(streamId.toString());
    expect(streamState.totalDeposit.toString()).to.equal(totalDeposit.toString());
    expect(streamState.milestoneUnlocked).to.be.false;

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(vaultBalance.amount.toString()).to.equal(totalDeposit.toString());
  });

  it("2. Rejects unauthorized milestone unlock attempt with counterfeit preimage", async () => {
    const bogusPreimage = crypto.randomBytes(32);

    try {
      await program.methods
        .unlockMilestone(bogusPreimage)
        .accounts({
          streamAccount: streamPda,
          sender: sender.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown InvalidMilestonePreimage error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidMilestonePreimage");
    }
  });

  it("3. Unlocks milestone tranche when authentic SHA-256 preimage is supplied", async () => {
    await program.methods
      .unlockMilestone(preimage)
      .accounts({
        streamAccount: streamPda,
        sender: sender.publicKey,
      })
      .rpc();

    const streamState = await program.account.streamState.fetch(streamPda);
    expect(streamState.milestoneUnlocked).to.be.true;
  });

  it("4. Rejects withdrawal when invoked by non-recipient attacker", async () => {
    const attackerTokenAccount = await createAccount(
      provider.connection,
      attacker,
      mint,
      attacker.publicKey
    );

    try {
      await program.methods
        .claim()
        .accounts({
          streamAccount: streamPda,
          vaultTokenAccount: vaultPda,
          recipient: attacker.publicKey,
          recipientTokenAccount: attackerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Attacker should not be able to claim recipient funds");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedRecipient");
    }
  });

  it("5. Allows recipient to claim unlocked milestone funds", async () => {
    await program.methods
      .claim()
      .accounts({
        streamAccount: streamPda,
        vaultTokenAccount: vaultPda,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const recipientBal = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientBal.amount)).to.be.greaterThanOrEqual(milestoneTranche.toNumber());
  });

  it("6. Executes emergency pause circuit breaker and prevents claims while halted", async () => {
    await program.methods
      .setEmergencyPause(true)
      .accounts({
        streamAccount: streamPda,
        sender: sender.publicKey,
      })
      .rpc();

    let state = await program.account.streamState.fetch(streamPda);
    expect(state.isPaused).to.be.true;

    try {
      await program.methods
        .claim()
        .accounts({
          streamAccount: streamPda,
          vaultTokenAccount: vaultPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Should have blocked claim due to pause state");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("StreamIsPaused");
    }

    // Unpause stream
    await program.methods
      .setEmergencyPause(false)
      .accounts({
        streamAccount: streamPda,
        sender: sender.publicKey,
      })
      .rpc();

    state = await program.account.streamState.fetch(streamPda);
    expect(state.isPaused).to.be.false;
  });
});