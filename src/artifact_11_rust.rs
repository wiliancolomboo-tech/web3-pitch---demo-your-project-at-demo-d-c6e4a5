use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::errors::KredoError;
use crate::events::StreamCanceledEvent;
use crate::state::StreamState;

#[derive(Accounts)]
pub struct CancelStream<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = stream_state.is_active @ KredoError::StreamNotActive,
        constraint = stream_state.can_cancel @ KredoError::CannotCancelStream,
        constraint = authority.key() == stream_state.sender || authority.key() == stream_state.recipient @ KredoError::UnauthorizedSigner,
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
        constraint = recipient_token_account.owner == stream_state.recipient @ KredoError::UnauthorizedSigner
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = sender_token_account.mint == mint.key() @ KredoError::InvalidMint,
        constraint = sender_token_account.owner == stream_state.sender @ KredoError::UnauthorizedSigner
    )]
    pub sender_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelStream>) -> Result<()> {
    let clock = Clock::get()?;
    let stream = &mut ctx.accounts.stream_state;

    // Calculate vested portion
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

    let recipient_due = total_vested
        .checked_sub(stream.withdrawn_amount)
        .ok_or(KredoError::MathOverflow)?;

    let sender_refund = stream
        .deposit_amount
        .checked_sub(total_vested)
        .ok_or(KredoError::MathOverflow)?;

    let stream_key = stream.key();
    let vault_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        stream_key.as_ref(),
        &[stream.vault_bump],
    ]];

    // Settle recipient's earned portion
    if recipient_due > 0 {
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
            recipient_due,
            ctx.accounts.mint.decimals,
        )?;
    }

    // Refund unvested portion to sender
    if sender_refund > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.sender_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_seeds,
            ),
            sender_refund,
            ctx.accounts.mint.decimals,
        )?;
    }

    stream.is_active = false;
    stream.withdrawn_amount = total_vested;

    emit!(StreamCanceledEvent {
        stream_id: stream.stream_id,
        sender: stream.sender,
        recipient: stream.recipient,
        recipient_settled_amount: recipient_due,
        sender_refund_amount: sender_refund,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}