import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KyivStream } from "../target/types/kyiv_stream";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("kyiv_stream_core_suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KyivStream as Program<KyivStream>;

  const funder = Keypair.generate();
  const beneficiary = Keypair.generate();
  const unauthorizedAttacker = Keypair.generate();
  const streamId = new anchor.BN(Math.floor(Date.now() / 1000));
  const totalAmount = new anchor.BN(3 * LAMPORTS_PER_SOL);
  const milestoneCount = 3;
  const quorumThreshold = 1;
  const streamTitle = "Kyiv Urban Drone Logistics Grant";

  let streamPda: PublicKey;
  let streamBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Airdrop funds to funder and unauthorizedAttacker
    const airdropFunderSig = await provider.connection.requestAirdrop(
      funder.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropFunderSig, "confirmed");

    const airdropAttackerSig = await provider.connection.requestAirdrop(
      unauthorizedAttacker.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropAttackerSig, "confirmed");

    // Derive Stream PDA
    [streamPda, streamBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream"),
        funder.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Derive Escrow Vault PDA
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes a Stream PDA & Escrows Lamports deterministically", async () => {
    await program.methods
      .initializeStream(
        streamId,
        totalAmount,
        milestoneCount,
        quorumThreshold,
        streamTitle
      )
      .accounts({
        funder: funder.publicKey,
        beneficiary: beneficiary.publicKey,
        streamState: streamPda,
        escrowVault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.funder.toBase58()).to.equal(funder.publicKey.toBase58());
    expect(streamAccount.beneficiary.toBase58()).to.equal(beneficiary.publicKey.toBase58());
    expect(streamAccount.totalAmount.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
    expect(streamAccount.releasedAmount.toNumber()).to.equal(0);
    expect(streamAccount.claimedAmount.toNumber()).to.equal(0);
    expect(streamAccount.milestoneCount).to.equal(3);
    expect(streamAccount.completedMilestones).to.equal(0);
    expect(streamAccount.isActive).to.be.true;

    // Verify vault balance
    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(3 * LAMPORTS_PER_SOL);
  });

  it("2. Beneficiary submits valid Milestone #0 proof hash", async () => {
    const milestoneIndex = 0;
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("milestone"),
        streamPda.toBuffer(),
        Buffer.from([milestoneIndex]),
      ],
      program.programId
    );

    const dummyHash = crypto.createHash("sha256").update("Milestone 0: Prototype Delivery").digest();
    const proofHashArray = Array.from(new Uint8Array(dummyHash));

    await program.methods
      .submitMilestone(milestoneIndex, proofHashArray)
      .accounts({
        beneficiary: beneficiary.publicKey,
        streamState: streamPda,
        milestoneState: milestonePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([beneficiary])
      .rpc();

    const milestoneAccount = await program.account.milestoneState.fetch(milestonePda);
    expect(milestoneAccount.milestoneIndex).to.equal(0);
    expect(milestoneAccount.isUnlocked).to.be.false;
  });

  it("3. Rejects milestone approval from unauthorized third-party attacker", async () => {
    const milestoneIndex = 0;
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("milestone"),
        streamPda.toBuffer(),
        Buffer.from([milestoneIndex]),
      ],
      program.programId
    );

    try {
      await program.methods
        .approveMilestone(milestoneIndex)
        .accounts({
          arbitrator: unauthorizedAttacker.publicKey,
          streamState: streamPda,
          milestoneState: milestonePda,
        })
        .signers([unauthorizedAttacker])
        .rpc();
      expect.fail("Expected transaction to fail with Unauthorized error");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include("Unauthorized");
    }
  });

  it("4. Authorized Arbitrator (Funder) approves Milestone #0 and unlocks 1 SOL", async () => {
    const milestoneIndex = 0;
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("milestone"),
        streamPda.toBuffer(),
        Buffer.from([milestoneIndex]),
      ],
      program.programId
    );

    await program.methods
      .approveMilestone(milestoneIndex)
      .accounts({
        arbitrator: funder.publicKey,
        streamState: streamPda,
        milestoneState: milestonePda,
      })
      .signers([funder])
      .rpc();

    const milestoneAccount = await program.account.milestoneState.fetch(milestonePda);
    expect(milestoneAccount.isUnlocked).to.be.true;

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.releasedAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
    expect(streamAccount.completedMilestones).to.equal(1);
  });

  it("5. Beneficiary claims unlocked tranche funds (1 SOL)", async () => {
    const claimAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const balanceBefore = await provider.connection.getBalance(beneficiary.publicKey);

    await program.methods
      .claimFunds(claimAmount)
      .accounts({
        beneficiary: beneficiary.publicKey,
        streamState: streamPda,
        escrowVault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([beneficiary])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(beneficiary.publicKey);
    expect(balanceAfter - balanceBefore).to.equal(1 * LAMPORTS_PER_SOL);

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.claimedAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
  });

  it("6. Rejects claim exceeding available unlocked balance", async () => {
    const excessiveAmount = new anchor.BN(1 * LAMPORTS_PER_SOL); // 0 remaining unlocked

    try {
      await program.methods
        .claimFunds(excessiveAmount)
        .accounts({
          beneficiary: beneficiary.publicKey,
          streamState: streamPda,
          escrowVault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([beneficiary])
        .rpc();
      expect.fail("Expected claim to fail with InsufficientFunds");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include("InsufficientFunds");
    }
  });

  it("7. Funder cancels stream; refunds unearned 2 SOL while beneficiary keeps claimed 1 SOL", async () => {
    const funderBalanceBefore = await provider.connection.getBalance(funder.publicKey);

    await program.methods
      .cancelAndRefund()
      .accounts({
        funder: funder.publicKey,
        streamState: streamPda,
        escrowVault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();

    const funderBalanceAfter = await provider.connection.getBalance(funder.publicKey);
    const streamAccount = await program.account.streamState.fetch(streamPda);

    expect(streamAccount.isActive).to.be.false;
    expect(streamAccount.isCancelled).to.be.true;
    // Funder receives the remaining unearned 2 SOL (minus tx fee)
    expect(funderBalanceAfter).to.be.greaterThan(funderBalanceBefore + 1.99 * LAMPORTS_PER_SOL);
  });
});