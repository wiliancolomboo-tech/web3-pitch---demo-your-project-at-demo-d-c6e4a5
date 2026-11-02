use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::errors::KredoError;
use crate::events::StreamCreatedEvent;
use crate::state::StreamState;

#[derive(Accounts)]
#[instruction(stream_id: u64)]
pub struct CreateStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient is verified by business logic
    pub recipient: UncheckedAccount<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = sender_token_account.mint == mint.key() @ KredoError::InvalidMint,
        constraint = sender_token_account.owner == sender.key() @ KredoError::UnauthorizedSigner
    )]
    pub sender_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = sender,
        space = StreamState::LEN,
        seeds = [b"stream", sender.key().as_ref(), &stream_id.to_le_bytes()],
        bump
    )]
    pub stream_state: Box<Account<'info, StreamState>>,

    #[account(
        init,
        payer = sender,
        seeds = [b"vault", stream_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateStream>,
    stream_id: u64,
    deposit_amount: u64,
    start_time: i64,
    end_time: i64,
    can_cancel: bool,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(deposit_amount > 0, KredoError::ZeroDepositAmount);
    require!(start_time < end_time, KredoError::InvalidTimeframe);
    require!(start_time >= clock.unix_timestamp - (86400 * 30), KredoError::StartTimeTooOld);

    let stream = &mut ctx.accounts.stream_state;
    stream.stream_id = stream_id;
    stream.sender = ctx.accounts.sender.key();
    stream.recipient = ctx.accounts.recipient.key();
    stream.mint = ctx.accounts.mint.key();
    stream.vault = ctx.accounts.vault.key();
    stream.deposit_amount = deposit_amount;
    stream.withdrawn_amount = 0;
    stream.start_time = start_time;
    stream.end_time = end_time;
    stream.can_cancel = can_cancel;
    stream.is_active = true;
    stream.bump = ctx.bumps.stream_state;
    stream.vault_bump = ctx.bumps.vault;

    // Transfer tokens into Vault PDA
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.sender_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        deposit_amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(StreamCreatedEvent {
        stream_id,
        sender: stream.sender,
        recipient: stream.recipient,
        mint: stream.mint,
        deposit_amount,
        start_time,
        end_time,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}