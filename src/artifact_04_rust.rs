use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("VLiAXw7JbYkZgW8k9aV5vWz3hB6fJkM1dNuP8vQ2wEr");

pub const STREAM_SEED: &[u8] = b"volia_stream";
pub const VAULT_SEED: &[u8] = b"stream_vault";

#[program]
pub mod volia_stream {
    use super::*;

    pub fn initialize_stream(
        ctx: Context<InitializeStream>,
        stream_id: u64,
        total_deposit: u64,
        start_time: i64,
        end_time: i64,
        milestone_commitment_hash: [u8; 32],
        milestone_tranche_amount: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(total_deposit > 0, VoliaError::ZeroDeposit);
        require!(end_time > start_time, VoliaError::InvalidTimeWindow);
        require!(
            start_time >= clock.unix_timestamp - 300,
            VoliaError::StartTimeInPast
        );
        require!(
            milestone_tranche_amount <= total_deposit,
            VoliaError::InvalidTrancheAmount
        );

        let stream = &mut ctx.accounts.stream_account;
        stream.stream_id = stream_id;
        stream.sender = ctx.accounts.sender.key();
        stream.recipient = ctx.accounts.recipient.key();
        stream.token_mint = ctx.accounts.token_mint.key();
        stream.vault = ctx.accounts.vault_token_account.key();
        stream.total_deposit = total_deposit;
        stream.claimed_amount = 0;
        stream.start_time = start_time;
        stream.end_time = end_time;
        stream.milestone_commitment_hash = milestone_commitment_hash;
        stream.milestone_tranche_amount = milestone_tranche_amount;
        stream.milestone_unlocked = false;
        stream.is_paused = false;
        stream.bump = ctx.bumps.stream_account;
        stream.vault_bump = ctx.bumps.vault_token_account;

        // Transfer funds from sender to protocol escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, total_deposit)?;

        emit!(StreamCreatedEvent {
            stream_id,
            sender: stream.sender,
            recipient: stream.recipient,
            total_deposit,
            start_time,
            end_time,
            milestone_commitment_hash,
        });

        Ok(())
    }

    pub fn unlock_milestone(
        ctx: Context<UnlockMilestone>,
        preimage: Vec<u8>,
    ) -> Result<()> {
        let stream = &mut ctx.accounts.stream_account;
        require!(!stream.is_paused, VoliaError::StreamIsPaused);
        require!(!stream.milestone_unlocked, VoliaError::MilestoneAlreadyUnlocked);

        // Verify SHA256 preimage against committed hash
        let computed_hash = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
        require!(
            computed_hash == stream.milestone_commitment_hash,
            VoliaError::InvalidMilestonePreimage
        );

        stream.milestone_unlocked = true;

        emit!(MilestoneUnlockedEvent {
            stream_id: stream.stream_id,
            milestone_hash: stream.milestone_commitment_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn claim(ctx: Context<ClaimFunds>) -> Result<()> {
        let clock = Clock::get()?;
        let stream = &mut ctx.accounts.stream_account;

        require!(!stream.is_paused, VoliaError::StreamIsPaused);

        // Compute Linear Vesting
        let streaming_amount = stream.total_deposit - stream.milestone_tranche_amount;
        let elapsed_time = if clock.unix_timestamp < stream.start_time {
            0
        } else if clock.unix_timestamp >= stream.end_time {
            stream.end_time - stream.start_time
        } else {
            clock.unix_timestamp - stream.start_time
        };

        let duration = stream.end_time - stream.start_time;
        let vested_stream = (streaming_amount as u128)
            .checked_mul(elapsed_time as u128)
            .unwrap()
            .checked_div(duration as u128)
            .unwrap() as u64;

        let milestone_available = if stream.milestone_unlocked {
            stream.milestone_tranche_amount
        } else {
            0
        };

        let total_available = vested_stream
            .checked_add(milestone_available)
            .ok_or(VoliaError::MathOverflow)?;

        let claimable = total_available
            .checked_sub(stream.claimed_amount)
            .ok_or(VoliaError::NoClaimableFunds)?;

        require!(claimable > 0, VoliaError::NoClaimableFunds);

        stream.claimed_amount = stream
            .claimed_amount
            .checked_add(claimable)
            .ok_or(VoliaError::MathOverflow)?;

        // Execute CPI transfer from vault PDA to recipient
        let stream_id_bytes = stream.stream_id.to_le_bytes();
        let seeds = &[
            VAULT_SEED,
            stream_id_bytes.as_ref(),
            &[stream.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault_token_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, claimable)?;

        emit!(FundsClaimedEvent {
            stream_id: stream.stream_id,
            recipient: stream.recipient,
            amount_claimed: claimable,
            total_claimed: stream.claimed_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn set_emergency_pause(ctx: Context<EmergencyControl>, paused: bool) -> Result<()> {
        let stream = &mut ctx.accounts.stream_account;
        stream.is_paused = paused;

        emit!(StreamPauseToggledEvent {
            stream_id: stream.stream_id,
            is_paused: paused,
            authority: ctx.accounts.sender.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct InitializeStream<'info> {
    #[account(
        init,
        payer = sender,
        space = 8 + StreamState::MAX_SIZE,
        seeds = [STREAM_SEED, sender.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub stream_account: Account<'info, StreamState>,

    #[account(
        init,
        payer = sender,
        seeds = [VAULT_SEED, &stream_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = vault_token_account,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient pubkey verified at initial creation
    pub recipient: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token_account.mint == token_mint.key(),
        constraint = sender_token_account.owner == sender.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnlockMilestone<'info> {
    #[account(
        mut,
        has_one = sender @ VoliaError::UnauthorizedSender,
        seeds = [STREAM_SEED, sender.key().as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump
    )]
    pub stream_account: Account<'info, StreamState>,

    pub sender: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimFunds<'info> {
    #[account(
        mut,
        has_one = recipient @ VoliaError::UnauthorizedRecipient,
        seeds = [STREAM_SEED, stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump
    )]
    pub stream_account: Account<'info, StreamState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.vault_bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == stream_account.token_mint,
        constraint = recipient_token_account.owner == recipient.key()
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyControl<'info> {
    #[account(
        mut,
        has_one = sender @ VoliaError::UnauthorizedSender,
        seeds = [STREAM_SEED, sender.key().as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump
    )]
    pub stream_account: Account<'info, StreamState>,

    pub sender: Signer<'info>,
}

// -----------------------------------------------------------------------------
// State Definition
// -----------------------------------------------------------------------------

#[account]
pub struct StreamState {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub total_deposit: u64,
    pub claimed_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub milestone_commitment_hash: [u8; 32],
    pub milestone_tranche_amount: u64,
    pub milestone_unlocked: bool,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl StreamState {
    pub const MAX_SIZE: usize = 8   // stream_id
        + 32  // sender
        + 32  // recipient
        + 32  // token_mint
        + 32  // vault
        + 8   // total_deposit
        + 8   // claimed_amount
        + 8   // start_time
        + 8   // end_time
        + 32  // milestone_commitment_hash
        + 8   // milestone_tranche_amount
        + 1   // milestone_unlocked
        + 1   // is_paused
        + 1   // bump
        + 1;  // vault_bump
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

#[event]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub total_deposit: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub milestone_commitment_hash: [u8; 32],
}

#[event]
pub struct MilestoneUnlockedEvent {
    pub stream_id: u64,
    pub milestone_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct FundsClaimedEvent {
    pub stream_id: u64,
    pub recipient: Pubkey,
    pub amount_claimed: u64,
    pub total_claimed: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamPauseToggledEvent {
    pub stream_id: u64,
    pub is_paused: bool,
    pub authority: Pubkey,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

#[error_code]
pub enum VoliaError {
    #[msg("Initial deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Stream end time must strictly follow start time.")]
    InvalidTimeWindow,
    #[msg("Start time cannot be set in the past.")]
    StartTimeInPast,
    #[msg("Milestone tranche cannot exceed total deposit.")]
    InvalidTrancheAmount,
    #[msg("Milestone has already been unlocked for this stream.")]
    MilestoneAlreadyUnlocked,
    #[msg("Cryptographic milestone preimage mismatch.")]
    InvalidMilestonePreimage,
    #[msg("No accrued funds are currently available for withdrawal.")]
    NoClaimableFunds,
    #[msg("Arithmetic operation overflow.")]
    MathOverflow,
    #[msg("Stream is currently halted by emergency pause.")]
    StreamIsPaused,
    #[msg("Signer is not authorized as stream sender.")]
    UnauthorizedSender,
    #[msg("Signer is not authorized as stream recipient.")]
    UnauthorizedRecipient,
}