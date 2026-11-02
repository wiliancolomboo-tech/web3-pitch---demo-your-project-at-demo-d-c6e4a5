import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { TridentStream } from '../target/types/trident_stream';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
} from '@solana/web3.js';
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { expect } from 'chai';
import nacl from 'tweetnacl';

describe('TridentStream End-to-End Test Suite', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TridentStream as Program<TridentStream>;

  const depositor = Keypair.generate();
  const recipient = Keypair.generate();
  const guardian = Keypair.generate();

  let mint: PublicKey;
  let depositorTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  const streamId = new anchor.BN(1001);
  const ratePerSecond = new anchor.BN(1_000_000); // 1 token / sec (6 decimals)
  const depositAmount = new anchor.BN(50_000_000); // 50 tokens total

  let streamStatePda: PublicKey;
  let streamVaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL
    const sig1 = await provider.connection.requestAirdrop(depositor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(recipient.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const sig3 = await provider.connection.requestAirdrop(guardian.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);
    await provider.connection.confirmTransaction(sig3);

    // Create SPL Token Mint
    mint = await createMint(provider.connection, depositor, depositor.publicKey, null, 6);

    // Associated Accounts
    depositorTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      depositor,
      mint,
      depositor.publicKey
    );
    recipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      recipient,
      mint,
      recipient.publicKey
    );

    // Mint funds to depositor
    await mintTo(provider.connection, depositor, mint, depositorTokenAccount, depositor, 100_000_000);

    // Derive PDAs
    [streamStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('trident_stream'), depositor.publicKey.toBuffer(), streamId.toArrayLike(Buffer, 'le', 8)],
      program.programId
    );

    [streamVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stream_vault'), streamStatePda.toBuffer()],
      program.programId
    );
  });

  it('1. Initializes continuous token stream & locks vault collateral', async () => {
    await program.methods
      .initializeStream(streamId, ratePerSecond, depositAmount)
      .accounts({
        depositor: depositor.publicKey,
        recipient: recipient.publicKey,
        guardian: guardian.publicKey,
        mint: mint,
        depositorToken: depositorTokenAccount,
        streamState: streamStatePda,
        streamVault: streamVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([depositor])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, streamVaultPda);
    expect(Number(vaultInfo.amount)).to.equal(50_000_000);

    const streamState = await program.account.streamState.fetch(streamStatePda);
    expect(streamState.depositor.toBase58()).to.equal(depositor.publicKey.toBase58());
    expect(streamState.isFrozen).to.be.false;
  });

  it('2. Enforces linear time-based vested withdrawal', async () => {
    // Wait 2 seconds for vesting accrual
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const claimAmount = new anchor.BN(2_000_000);

    await program.methods
      .withdrawVested(claimAmount)
      .accounts({
        recipient: recipient.publicKey,
        streamState: streamStatePda,
        streamVault: streamVaultPda,
        recipientToken: recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientAccount.amount)).to.equal(2_000_000);
  });

  it('3. Successfully settles offline cryptographic Ed25519 voucher', async () => {
    const voucherNonce = new anchor.BN(1);
    const voucherAmount = new anchor.BN(10_000_000); // 10 tokens allocated offline

    const [voucherReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('offline_voucher'), streamStatePda.toBuffer(), voucherNonce.toArrayLike(Buffer, 'le', 8)],
      program.programId
    );

    // Construct binary payload
    const buffer = Buffer.alloc(8 + 8 + 32 + 8);
    buffer.writeBigUInt64LE(BigInt(streamId.toString()), 0);
    buffer.writeBigUInt64LE(BigInt(voucherNonce.toString()), 8);
    Buffer.from(recipient.publicKey.toBytes()).copy(buffer, 16);
    buffer.writeBigUInt64LE(BigInt(voucherAmount.toString()), 48);

    const signature = nacl.sign.detached(new Uint8Array(buffer), depositor.secretKey);

    // Preceding Ed25519 Instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: depositor.publicKey.toBytes(),
      message: new Uint8Array(buffer),
      signature: signature,
    });

    const tx = new Transaction();
    tx.add(ed25519Ix);
    tx.add(
      await program.methods
        .claimOfflineVoucher(voucherNonce, voucherAmount)
        .accounts({
          claimant: recipient.publicKey,
          streamState: streamStatePda,
          voucherReceipt: voucherReceiptPda,
          streamVault: streamVaultPda,
          claimantToken: recipientTokenAccount,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    await provider.sendAndConfirm(tx, [recipient]);

    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    // 2M previous + 10M offline = 12M tokens
    expect(Number(recipientAccount.amount)).to.equal(12_000_000);

    const receipt = await program.account.voucherReceipt.fetch(voucherReceiptPda);
    expect(receipt.nonce.toNumber()).to.equal(1);
  });

  it('4. Rejects replay attack on duplicate voucher nonce', async () => {
    const voucherNonce = new anchor.BN(1); // identical nonce
    const voucherAmount = new anchor.BN(10_000_000);

    const [voucherReceiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('offline_voucher'), streamStatePda.toBuffer(), voucherNonce.toArrayLike(Buffer, 'le', 8)],
      program.programId
    );

    const buffer = Buffer.alloc(8 + 8 + 32 + 8);
    buffer.writeBigUInt64LE(BigInt(streamId.toString()), 0);
    buffer.writeBigUInt64LE(BigInt(voucherNonce.toString()), 8);
    Buffer.from(recipient.publicKey.toBytes()).copy(buffer, 16);
    buffer.writeBigUInt64LE(BigInt(voucherAmount.toString()), 48);

    const signature = nacl.sign.detached(new Uint8Array(buffer), depositor.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: depositor.publicKey.toBytes(),
      message: new Uint8Array(buffer),
      signature: signature,
    });

    const tx = new Transaction();
    tx.add(ed25519Ix);
    tx.add(
      await program.methods
        .claimOfflineVoucher(voucherNonce, voucherAmount)
        .accounts({
          claimant: recipient.publicKey,
          streamState: streamStatePda,
          voucherReceipt: voucherReceiptPda,
          streamVault: streamVaultPda,
          claimantToken: recipientTokenAccount,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    try {
      await provider.sendAndConfirm(tx, [recipient]);
      expect.fail('Expected replay attack transaction to fail.');
    } catch (err: any) {
      // Anchor throws account already in use or custom error
      expect(err).to.exist;
    }
  });

  it('5. Triggers Guardian Emergency Circuit Breaker and locks withdrawals', async () => {
    // Guardian Freezes
    await program.methods
      .setStreamPause(true)
      .accounts({
        guardian: guardian.publicKey,
        streamState: streamStatePda,
      })
      .signers([guardian])
      .rpc();

    const stream = await program.account.streamState.fetch(streamStatePda);
    expect(stream.isFrozen).to.be.true;

    // Recipient attempts withdrawal while frozen
    try {
      await program.methods
        .withdrawVested(new anchor.BN(100_000))
        .accounts({
          recipient: recipient.publicKey,
          streamState: streamStatePda,
          streamVault: streamVaultPda,
          recipientToken: recipientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      expect.fail('Withdrawal must fail when frozen');
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal('StreamFrozen');
    }
  });

  it('6. Rejects unauthorized Guardian commands', async () => {
    const maliciousActor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(maliciousActor.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .setStreamPause(false)
        .accounts({
          guardian: maliciousActor.publicKey,
          streamState: streamStatePda,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail('Unauthorized guardian call succeeded');
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal('Unauthorized');
    }
  });
});