use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::errors::KredoError;
use crate::events::StreamWithdrawnEvent;
use crate::state::StreamState;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        constraint = stream_state.is_active @ KredoError::StreamNotActive,
        constraint = stream_state.recipient == recipient.key() @ KredoError::UnauthorizedSigner,
        seeds = [b"stream", stream_state.sender.as_ref(), &stream_state.stream_id.to_le_bytes()],
        bump = stream_state.bump
    )]
    pub stream_state: Box<Account<'info, StreamState>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"vault", stream_state.key().as_ref()],
        bump = stream_state.vault_bump,
        constraint = vault.mint == mint.key() @ KredoError::InvalidMint,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == mint.key() @ KredoError::InvalidMint,
        constraint = recipient_token_account.owner == recipient.key() @ KredoError::UnauthorizedSigner
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount_to_withdraw: u64) -> Result<()> {
    let clock = Clock::get()?;
    let stream = &mut ctx.accounts.stream_state;

    // Calculate vested balance deterministically
    let total_vested: u64 = if clock.unix_timestamp <= stream.start_time {
        0
    } else if clock.unix_timestamp >= stream.end_time {
        stream.deposit_amount
    } else {
        let elapsed = (clock.unix_timestamp - stream.start_time) as u128;
        let duration = (stream.end_time - stream.start_time) as u128;
        let total = stream.deposit_amount as u128;

        let vested = total
            .checked_mul(elapsed)
            .ok_or(KredoError::MathOverflow)?
            .checked_div(duration)
            .ok_or(KredoError::MathOverflow)?;

        vested as u64
    };

    let available_to_withdraw = total_vested
        .checked_sub(stream.withdrawn_amount)
        .ok_or(KredoError::MathOverflow)?;

    require!(
        amount_to_withdraw <= available_to_withdraw,
        KredoError::InsufficientVestedFunds
    );
    require!(amount_to_withdraw > 0, KredoError::ZeroDepositAmount);

    stream.withdrawn_amount = stream
        .withdrawn_amount
        .checked_add(amount_to_withdraw)
        .ok_or(KredoError::MathOverflow)?;

    // Sign with PDA seeds
    let stream_key = stream.key();
    let vault_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        stream_key.as_ref(),
        &[stream.vault_bump],
    ]];

    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_seeds,
        ),
        amount_to_withdraw,
        ctx.accounts.mint.decimals,
    )?;

    let remaining_unclaimed = stream
        .deposit_amount
        .checked_sub(stream.withdrawn_amount)
        .ok_or(KredoError::MathOverflow)?;

    if remaining_unclaimed == 0 {
        stream.is_active = false;
    }

    emit!(StreamWithdrawnEvent {
        stream_id: stream.stream_id,
        recipient: ctx.accounts.recipient.key(),
        amount_withdrawn: amount_to_withdraw,
        remaining_balance: remaining_unclaimed,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}