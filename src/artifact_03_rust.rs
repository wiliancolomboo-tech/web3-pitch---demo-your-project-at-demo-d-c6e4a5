use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Ky1vCore11111111111111111111111111111111111");

#[program]
pub mod kyiv_core {
    use super::*;

    /// Initializes a new linear streaming escrow between sender and recipient.
    pub fn initialize_stream(
        ctx: Context<InitializeStream>,
        stream_id: u64,
        total_deposit_amount: u64,
        start_time: i64,
        stop_time: i64,
        milestone_count: u8,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        require!(
            start_time >= current_time - 300,
            KyivCoreError::InvalidStartTime
        );
        require!(stop_time > start_time, KyivCoreError::InvalidStopTime);
        require!(total_deposit_amount > 0, KyivCoreError::ZeroDeposit);
        require!(milestone_count > 0, KyivCoreError::ZeroMilestones);

        let stream = &mut ctx.accounts.stream_account;
        stream.stream_id = stream_id;
        stream.sender = ctx.accounts.sender.key();
        stream.recipient = ctx.accounts.recipient.key();
        stream.arbiter = ctx.accounts.arbiter.key();
        stream.token_mint = ctx.accounts.token_mint.key();
        stream.vault = ctx.accounts.escrow_vault.key();
        stream.total_deposit_amount = total_deposit_amount;
        stream.withdrawn_amount = 0;
        stream.start_time = start_time;
        stream.stop_time = stop_time;
        stream.milestone_count = milestone_count;
        stream.completed_milestones = 0;
        stream.is_canceled = false;
        stream.bump = ctx.bumps.stream_account;
        stream.vault_bump = ctx.bumps.escrow_vault;

        // Transfer funds from sender to PDA escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, total_deposit_amount)?;

        emit!(StreamInitializedEvent {
            stream_id,
            sender: stream.sender,
            recipient: stream.recipient,
            total_amount: total_deposit_amount,
            start_time,
            stop_time,
        });

        Ok(())
    }

    /// Allows the recipient to withdraw unlocked tokens based on linear vesting and milestone state.
    pub fn withdraw_vested(ctx: Context<WithdrawVested>, amount_to_withdraw: u64) -> Result<()> {
        let stream = &mut ctx.accounts.stream_account;
        require!(!stream.is_canceled, KyivCoreError::StreamAlreadyCanceled);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        // Calculate total vested amount based on linear time and milestones
        let available_vested = compute_available_funds(stream, current_time)?;
        let claimable = available_vested
            .checked_sub(stream.withdrawn_amount)
            .ok_or(KyivCoreError::CalculationOverflow)?;

        require!(claimable > 0, KyivCoreError::NoFundsAvailable);
        require!(
            amount_to_withdraw <= claimable,
            KyivCoreError::ExceedsClaimableAmount
        );

        stream.withdrawn_amount = stream
            .withdrawn_amount
            .checked_add(amount_to_withdraw)
            .ok_or(KyivCoreError::CalculationOverflow)?;

        let stream_id_bytes = stream.stream_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault",
            stream.sender.as_ref(),
            stream_id_bytes.as_ref(),
            &[stream.vault_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds);
        token::transfer(cpi_ctx, amount_to_withdraw)?;

        emit!(WithdrawalEvent {
            stream_id: stream.stream_id,
            recipient: stream.recipient,
            amount_withdrawn: amount_to_withdraw,
            remaining_balance: stream
                .total_deposit_amount
                .saturating_sub(stream.withdrawn_amount),
        });

        Ok(())
    }

    /// Arbiter or Sender attests and completes a milestone, unlocking the corresponding tranche.
    pub fn settle_milestone(ctx: Context<SettleMilestone>) -> Result<()> {
        let stream = &mut ctx.accounts.stream_account;
        require!(!stream.is_canceled, KyivCoreError::StreamAlreadyCanceled);
        require!(
            stream.completed_milestones < stream.milestone_count,
            KyivCoreError::AllMilestonesCompleted
        );

        stream.completed_milestones = stream
            .completed_milestones
            .checked_add(1)
            .ok_or(KyivCoreError::CalculationOverflow)?;

        emit!(MilestoneSettledEvent {
            stream_id: stream.stream_id,
            completed_milestones: stream.completed_milestones,
            total_milestones: stream.milestone_count,
        });

        Ok(())
    }

    /// Cancels the stream: vests funds up to the current timestamp to the recipient,
    /// and refunds remaining non-vested collateral to the sender.
    pub fn cancel_stream(ctx: Context<CancelStream>) -> Result<()> {
        let stream = &mut ctx.accounts.stream_account;
        require!(!stream.is_canceled, KyivCoreError::StreamAlreadyCanceled);

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        let total_vested = compute_available_funds(stream, current_time)?;
        let recipient_owed = total_vested.saturating_sub(stream.withdrawn_amount);
        let sender_clawback = stream.total_deposit_amount.saturating_sub(total_vested);

        stream.is_canceled = true;

        let stream_id_bytes = stream.stream_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault",
            stream.sender.as_ref(),
            stream_id_bytes.as_ref(),
            &[stream.vault_bump],
        ]];

        // 1. Pay out remaining claimable amount to recipient
        if recipient_owed > 0 {
            let cpi_accounts_recipient = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx =
                CpiContext::new_with_signer(cpi_program, cpi_accounts_recipient, seeds);
            token::transfer(cpi_ctx, recipient_owed)?;
        }

        // 2. Clawback unvested balance to sender
        if sender_clawback > 0 {
            let cpi_accounts_sender = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.sender_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts_sender, seeds);
            token::transfer(cpi_ctx, sender_clawback)?;
        }

        emit!(StreamCanceledEvent {
            stream_id: stream.stream_id,
            clawback_sender: sender_clawback,
            paid_to_recipient: recipient_owed,
        });

        Ok(())
    }
}

/// Computes total available tokens taking into account linear time progression and milestone caps.
fn compute_available_funds(stream: &StreamAccount, current_time: i64) -> Result<u64> {
    if current_time <= stream.start_time {
        return Ok(0);
    }

    let duration = stream
        .stop_time
        .checked_sub(stream.start_time)
        .ok_or(KyivCoreError::CalculationOverflow)?;

    let elapsed = if current_time >= stream.stop_time {
        duration
    } else {
        current_time
            .checked_sub(stream.start_time)
            .ok_or(KyivCoreError::CalculationOverflow)?
    };

    // Calculate pure linear time share
    let time_vested = (stream.total_deposit_amount as u128)
        .checked_mul(elapsed as u128)
        .ok_or(KyivCoreError::CalculationOverflow)?
        .checked_div(duration as u128)
        .ok_or(KyivCoreError::CalculationOverflow)? as u64;

    // Check milestone ceiling (each completed milestone unlocks an equal tranche cap)
    let milestone_cap = if stream.milestone_count > 0 {
        let tranche_size = (stream.total_deposit_amount as u128)
            .checked_div(stream.milestone_count as u128)
            .ok_or(KyivCoreError::CalculationOverflow)?;
        let unlocked = tranche_size
            .checked_mul(stream.completed_milestones as u128)
            .ok_or(KyivCoreError::CalculationOverflow)? as u64;
        unlocked
    } else {
        stream.total_deposit_amount
    };

    // The vested funds cannot exceed the current milestone-unlocked cap
    let effective_vested = std::cmp::min(time_vested, milestone_cap);
    Ok(effective_vested)
}

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct InitializeStream<'info> {
    #[account(
        init,
        payer = sender,
        space = 8 + StreamAccount::INIT_SPACE,
        seeds = [b"stream", sender.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        init,
        payer = sender,
        seeds = [b"escrow_vault", sender.key().as_ref(), &stream_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Arbiter can be any authorized validator, DAO council multisig, or emergency officer.
    pub arbiter: AccountInfo<'info>,

    /// CHECK: Recipient of the streaming payment.
    pub recipient: AccountInfo<'info>,

    #[account(mut)]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawVested<'info> {
    #[account(
        mut,
        seeds = [b"stream", stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump,
        has_one = recipient,
        has_one = vault @ KyivCoreError::InvalidVaultAccount,
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        mut,
        seeds = [b"escrow_vault", stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ KyivCoreError::InvalidTokenOwner,
        constraint = recipient_token_account.mint == stream_account.token_mint @ KyivCoreError::InvalidTokenMint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleMilestone<'info> {
    #[account(
        mut,
        seeds = [b"stream", stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump,
    )]
    pub stream_account: Account<'info, StreamAccount>,

    /// The arbiter or the original sender must sign to approve milestone completion
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelStream<'info> {
    #[account(
        mut,
        seeds = [b"stream", stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.bump,
        has_one = sender,
        has_one = recipient,
        has_one = vault @ KyivCoreError::InvalidVaultAccount,
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        mut,
        seeds = [b"escrow_vault", stream_account.sender.as_ref(), &stream_account.stream_id.to_le_bytes()],
        bump = stream_account.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Stream recipient account
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        constraint = sender_token_account.mint == stream_account.token_mint
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == stream_account.token_mint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct StreamAccount {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub arbiter: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub total_deposit_amount: u64,
    pub withdrawn_amount: u64,
    pub start_time: i64,
    pub stop_time: i64,
    pub milestone_count: u8,
    pub completed_milestones: u8,
    pub is_canceled: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct StreamInitializedEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub total_amount: u64,
    pub start_time: i64,
    pub stop_time: i64,
}

#[event]
pub struct WithdrawalEvent {
    pub stream_id: u64,
    pub recipient: Pubkey,
    pub amount_withdrawn: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct MilestoneSettledEvent {
    pub stream_id: u64,
    pub completed_milestones: u8,
    pub total_milestones: u8,
}

#[event]
pub struct StreamCanceledEvent {
    pub stream_id: u64,
    pub clawback_sender: u64,
    pub paid_to_recipient: u64,
}

#[error_code]
pub mod KyivCoreError {
    #[msg("Invalid stream start time: must not be in the deep past.")]
    InvalidStartTime,
    #[msg("Invalid stream stop time: must be strictly greater than start time.")]
    InvalidStopTime,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDeposit,
    #[msg("Milestone count must be greater than zero.")]
    ZeroMilestones,
    #[msg("Stream is already canceled.")]
    StreamAlreadyCanceled,
    #[msg("No funds currently available for withdrawal.")]
    NoFundsAvailable,
    #[msg("Requested amount exceeds currently unlocked claimable balance.")]
    ExceedsClaimableAmount,
    #[msg("All designated milestones have already been attested and unlocked.")]
    AllMilestonesCompleted,
    #[msg("PDA Escrow vault mismatch.")]
    InvalidVaultAccount,
    #[msg("Token account owner does not match recipient signer.")]
    InvalidTokenOwner,
    #[msg("Token account mint mismatch with escrow configuration.")]
    InvalidTokenMint,
    #[msg("Mathematical calculation overflow.")]
    CalculationOverflow,
}