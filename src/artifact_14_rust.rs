use anchor_lang::prelude::*;
use crate::state::{EscrowAccount, EscrowState};
use crate::errors::SichError;
use crate::events::EscrowRefunded;

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    #[account(
        mut,
        address = escrow.grantor @ SichError::Unauthorized
    )]
    pub grantor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.grantor.as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
        close = grantor
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RefundEscrow>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let clock = Clock::get()?;

    let is_deadman_expired = clock.slot >= escrow.funded_at_slot.saturating_add(escrow.deadman_timeout_slots);
    require!(is_deadman_expired, SichError::DeadmanNotExpired);
    require!(escrow.state != EscrowState::Completed, SichError::AlreadyCompleted);

    let vault_balance = ctx.accounts.vault.lamports();
    if vault_balance > 0 {
        let escrow_key = escrow.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            escrow_key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer = &[vault_seeds];

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
                ctx.accounts.vault.key,
                ctx.accounts.grantor.key,
                vault_balance,
            ),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.grantor.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
    }

    emit!(EscrowRefunded {
        escrow_id: escrow.escrow_id,
        grantor: ctx.accounts.grantor.key(),
        amount_refunded: vault_balance,
    });

    Ok(())
}