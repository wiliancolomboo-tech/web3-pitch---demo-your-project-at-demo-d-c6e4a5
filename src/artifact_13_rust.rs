use anchor_lang::prelude::*;
use crate::state::StreamState;
use crate::errors::KyivStreamError;

#[derive(Accounts)]
pub struct CancelAndRefund<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        has_one = funder @ KyivStreamError::Unauthorized,
        constraint = stream_state.is_active @ KyivStreamError::StreamInactive,
        constraint = !stream_state.is_cancelled @ KyivStreamError::StreamCancelled,
    )]
    pub stream_state: Account<'info, StreamState>,

    /// CHECK: Escrow Vault PDA
    #[account(
        mut,
        seeds = [b"vault", stream_state.key().as_ref()],
        bump = stream_state.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct StreamCancelledEvent {
    pub stream: Pubkey,
    pub funder: Pubkey,
    pub refund_amount: u64,
}

pub fn handler(ctx: Context<CancelAndRefund>) -> Result<()> {
    let stream = &mut ctx.accounts.stream_state;

    // Refundable amount = total - released (beneficiary keeps unlocked earnings)
    let refund_amount = stream
        .total_amount
        .checked_sub(stream.released_amount)
        .ok_or(KyivStreamError::MathOverflow)?;

    stream.is_active = false;
    stream.is_cancelled = true;

    if refund_amount > 0 {
        **ctx.accounts.escrow_vault.try_borrow_mut_lamports()? = ctx
            .accounts
            .escrow_vault
            .lamports()
            .checked_sub(refund_amount)
            .ok_or(KyivStreamError::MathOverflow)?;

        **ctx.accounts.funder.try_borrow_mut_lamports()? = ctx
            .accounts
            .funder
            .lamports()
            .checked_add(refund_amount)
            .ok_or(KyivStreamError::MathOverflow)?;
    }

    emit!(StreamCancelledEvent {
        stream: stream.key(),
        funder: stream.funder,
        refund_amount,
    });

    Ok(())
}