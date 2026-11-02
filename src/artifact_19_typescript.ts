import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TridentStream } from "../target/types/trident_stream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("trident_stream_tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TridentStream as Program<TridentStream>;

  let mint: PublicKey;
  let funderTokenAccount: PublicKey;
  let beneficiaryTokenAccount: PublicKey;
  let unauthorizedTokenAccount: PublicKey;

  const funder = Keypair.generate();
  const beneficiary = Keypair.generate();
  const auditor = Keypair.generate();
  const unauthorizedAuditor = Keypair.generate();

  const escrowId = new anchor.BN(88291);
  const totalAmount = new anchor.BN(10_000_000_000); // 10,000 tokens
  const totalMilestones = 4;
  const disputeTimelockSlots = new anchor.BN(100);

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to signers
    for (const kp of [funder, beneficiary, auditor, unauthorizedAuditor]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create test SPL Mint
    mint = await createMint(
      provider.connection,
      funder,
      funder.publicKey,
      null,
      6
    );

    // Create Token Accounts
    funderTokenAccount = await createAccount(
      provider.connection,
      funder,
      mint,
      funder.publicKey
    );

    beneficiaryTokenAccount = await createAccount(
      provider.connection,
      beneficiary,
      mint,
      beneficiary.publicKey
    );

    unauthorizedTokenAccount = await createAccount(
      provider.connection,
      unauthorizedAuditor,
      mint,
      unauthorizedAuditor.publicKey
    );

    // Fund the funder token account
    await mintTo(
      provider.connection,
      funder,
      mint,
      funderTokenAccount,
      funder,
      totalAmount.toNumber()
    );

    // Calculate PDAs
    const [calculatedEscrow] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("trident_escrow"),
        funder.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    escrowPda = calculatedEscrow;

    const [calculatedVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("trident_vault"), escrowPda.toBuffer()],
      program.programId
    );
    vaultPda = calculatedVault;
  });

  it("1. Successfully initializes an institutional escrow with vault funding", async () => {
    await program.methods
      .initializeEscrow(escrowId, totalAmount, totalMilestones, disputeTimelockSlots)
      .accountsStrict({
        funder: funder.publicKey,
        beneficiary: beneficiary.publicKey,
        auditor: auditor.publicKey,
        mint: mint,
        funderTokenAccount: funderTokenAccount,
        escrowState: escrowPda,
        vault: vaultPda,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([funder])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.funder.toBase58()).to.equal(funder.publicKey.toBase58());
    expect(escrowAccount.beneficiary.toBase58()).to.equal(beneficiary.publicKey.toBase58());
    expect(escrowAccount.auditor.toBase58()).to.equal(auditor.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(totalAmount.toNumber());
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(0);
    expect(escrowAccount.totalMilestones).to.equal(totalMilestones);
    expect(escrowAccount.currentMilestone).to.equal(0);
    expect(escrowAccount.isActive).to.be.true;

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(totalAmount.toNumber());
  });

  it("2. Rejects tranche release attempt by unauthorized auditor", async () => {
    const dummyProof = new Array(32).fill(1);
    try {
      await program.methods
        .releaseTranche(1, dummyProof)
        .accountsStrict({
          auditor: unauthorizedAuditor.publicKey,
          beneficiary: beneficiary.publicKey,
          beneficiaryTokenAccount: beneficiaryTokenAccount,
          escrowState: escrowPda,
          vault: vaultPda,
          tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedAuditor])
        .rpc();
      expect.fail("Should have thrown UnauthorizedAuditor error");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.include("UnauthorizedAuditor");
    }
  });

  it("3. Rejects out-of-order milestone release (e.g. milestone 2 before milestone 1)", async () => {
    const dummyProof = new Array(32).fill(2);
    try {
      await program.methods
        .releaseTranche(2, dummyProof)
        .accountsStrict({
          auditor: auditor.publicKey,
          beneficiary: beneficiary.publicKey,
          beneficiaryTokenAccount: beneficiaryTokenAccount,
          escrowState: escrowPda,
          vault: vaultPda,
          tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        })
        .signers([auditor])
        .rpc();
      expect.fail("Should have failed on invalid milestone index");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.include("InvalidMilestoneIndex");
    }
  });

  it("4. Releases Milestone #1 successfully to beneficiary", async () => {
    const dummyProof = new Array(32).fill(1);
    const expectedTranche = totalAmount.toNumber() / totalMilestones;

    await program.methods
      .releaseTranche(1, dummyProof)
      .accountsStrict({
        auditor: auditor.publicKey,
        beneficiary: beneficiary.publicKey,
        beneficiaryTokenAccount: beneficiaryTokenAccount,
        escrowState: escrowPda,
        vault: vaultPda,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
      })
      .signers([auditor])
      .rpc();

    const beneficiaryBalance = await getAccount(provider.connection, beneficiaryTokenAccount);
    expect(Number(beneficiaryBalance.amount)).to.equal(expectedTranche);

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.currentMilestone).to.equal(1);
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(expectedTranche);
    expect(escrowAccount.isActive).to.be.true;
  });

  it("5. Completes remaining milestones and marks escrow inactive", async () => {
    const dummyProof = new Array(32).fill(7);

    // Release Milestone 2, 3, and 4
    for (let m = 2; m <= totalMilestones; m++) {
      await program.methods
        .releaseTranche(m, dummyProof)
        .accountsStrict({
          auditor: auditor.publicKey,
          beneficiary: beneficiary.publicKey,
          beneficiaryTokenAccount: beneficiaryTokenAccount,
          escrowState: escrowPda,
          vault: vaultPda,
          tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        })
        .signers([auditor])
        .rpc();
    }

    const beneficiaryBalance = await getAccount(provider.connection, beneficiaryTokenAccount);
    expect(Number(beneficiaryBalance.amount)).to.equal(totalAmount.toNumber());

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.currentMilestone).to.equal(totalMilestones);
    expect(escrowAccount.isActive).to.be.false;

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(0);
  });
});