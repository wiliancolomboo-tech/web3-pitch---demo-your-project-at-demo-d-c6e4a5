import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Kredostream } from "../target/types/kredostream";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("KredoStream Integration Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Kredostream as Program<Kredostream>;

  let mint: PublicKey;
  let senderAta: PublicKey;
  let recipientAta: PublicKey;

  const sender = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();
  const unauthorizedParty = Keypair.generate();

  const streamId = new anchor.BN(42069);
  const depositAmount = new anchor.BN(10_000_000); // 10 USDC (6 decimals)
  let streamPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // 1. Airdrop SOL to test accounts
    const sig1 = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);

    const sig2 = await provider.connection.requestAirdrop(unauthorizedParty.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig2);

    // 2. Setup SPL Token
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    senderAta = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey
    );

    recipientAta = await createAccount(
      provider.connection,
      sender,
      mint,
      recipient.publicKey
    );

    await mintTo(
      provider.connection,
      sender,
      mint,
      senderAta,
      sender.publicKey,
      50_000_000
    );

    [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), sender.publicKey.toBuffer(), streamId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully creates a streaming agreement", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10); // started 10s ago
    const endTime = new anchor.BN(now + 100);  // 110s total duration

    await program.methods
      .createStream(streamId, depositAmount, startTime, endTime, true)
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint: mint,
        senderTokenAccount: senderAta,
        streamState: streamPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([sender])
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.streamId.toNumber()).to.equal(42069);
    expect(streamAccount.sender.toBase58()).to.equal(sender.publicKey.toBase58());
    expect(streamAccount.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
    expect(streamAccount.depositAmount.toNumber()).to.equal(10_000_000);
    expect(streamAccount.withdrawnAmount.toNumber()).to.equal(0);
    expect(streamAccount.isActive).to.be.true;

    const vaultTokenAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultTokenAccount.amount)).to.equal(10_000_000);
  });

  it("2. Rejects unauthorized withdrawal caller", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(100_000))
        .accounts({
          recipient: unauthorizedParty.publicKey,
          streamState: streamPda,
          mint: mint,
          vault: vaultPda,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedParty])
        .rpc();
      expect.fail("Should have failed with unauthorized signer error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedSigner");
    }
  });

  it("3. Executes partial withdrawal of vested funds", async () => {
    // Wait for at least 2 seconds of vesting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const withdrawAmount = new anchor.BN(500_000); // 0.5 USDC
    await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        recipient: recipient.publicKey,
        streamState: streamPda,
        mint: mint,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.withdrawnAmount.toNumber()).to.equal(500_000);

    const recipientToken = await getAccount(provider.connection, recipientAta);
    expect(Number(recipientToken.amount)).to.equal(500_000);
  });

  it("4. Prevents withdrawal exceeding current vested calculation", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(9_999_999)) // Exceeds vested delta
        .accounts({
          recipient: recipient.publicKey,
          streamState: streamPda,
          mint: mint,
          vault: vaultPda,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail("Should have thrown InsufficientVestedFunds");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientVestedFunds");
    }
  });

  it("5. Cancels stream cleanly: refunds unvested to sender, vested to recipient", async () => {
    await program.methods
      .cancelStream()
      .accounts({
        authority: sender.publicKey,
        streamState: streamPda,
        mint: mint,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        senderTokenAccount: senderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.isActive).to.be.false;

    const vaultTokenAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultTokenAccount.amount)).to.equal(0);
  });
});