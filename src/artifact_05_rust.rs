use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

declare_id!("Trid3ntKyivDem0Day11111111111111111111111111");

#[program]
pub mod trident_vault {
    use super::*;

    /// Initializes a new high-integrity grant vault with deterministic PDA escrow.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        grant_id: u64,
        total_amount: u64,
        milestone_count: u8,
        lockup_expiry: i64,
    ) -> Result<()> {
        require!(milestone_count > 0, TridentError::ZeroMilestones);
        require!(total_amount > 0, TridentError::ZeroAmount);
        
        let clock = Clock::get()?;
        require!(
            lockup_expiry > clock.unix_timestamp,
            TridentError::InvalidExpiry
        );

        let vault = &mut ctx.accounts.vault_state;
        vault.grantor = ctx.accounts.grantor.key();
        vault.auditor = ctx.accounts.auditor.key();
        vault.beneficiary = ctx.accounts.beneficiary.key();
        vault.grant_id = grant_id;
        vault.total_amount = total_amount;
        vault.remaining_amount = total_amount;
        vault.milestone_count = milestone_count;
        vault.milestones_completed = 0;
        vault.payout_per_milestone = total_amount
            .checked_div(milestone_count as u64)
            .ok_or(TridentError::MathOverflow)?;
        vault.lockup_expiry = lockup_expiry;
        vault.is_frozen = false;
        vault.bump = ctx.bumps.vault_state;
        vault.escrow_bump = ctx.bumps.escrow_wallet;

        emit!(VaultInitializedEvent {
            grant_id,
            grantor: vault.grantor,
            beneficiary: vault.beneficiary,
            total_amount,
            milestones: milestone_count,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits native SOL into the program's PDA escrow account.
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault_state;
        require!(!vault.is_frozen, TridentError::VaultIsFrozen);
        require!(amount > 0, TridentError::ZeroAmount);

        let ix = system_instruction::transfer(
            &ctx.accounts.grantor.key(),
            &ctx.accounts.escrow_wallet.key(),
            amount,
        );

        invoke(
            &ix,
            &[
                ctx.accounts.grantor.to_account_info(),
                ctx.accounts.escrow_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(VaultFundedEvent {
            grant_id: vault.grant_id,
            amount,
            funder: ctx.accounts.grantor.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Releases one deterministic milestone tranche upon dual-key attestation.
    pub fn release_milestone(
        ctx: Context<ReleaseMilestone>,
        milestone_index: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        require!(!vault.is_frozen, TridentError::VaultIsFrozen);
        require!(
            milestone_index == vault.milestones_completed + 1,
            TridentError::InvalidMilestoneSequence
        );
        require!(
            vault.milestones_completed < vault.milestone_count,
            TridentError::AllMilestonesCompleted
        );
        require!(
            vault.remaining_amount >= vault.payout_per_milestone,
            TridentError::InsufficientEscrowBalance
        );

        let disbursement_amount = if milestone_index == vault.milestone_count {
            // Sweep any division remainder on final milestone
            vault.remaining_amount
        } else {
            vault.payout_per_milestone
        };

        // Transfer SOL from escrow PDA to beneficiary using PDA seeds
        let grant_id_bytes = vault.grant_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            grant_id_bytes.as_ref(),
            &[vault.escrow_bump],
        ]];

        let escrow_balance = ctx.accounts.escrow_wallet.lamports();
        require!(
            escrow_balance >= disbursement_amount,
            TridentError::InsufficientEscrowBalance
        );

        **ctx.accounts.escrow_wallet.to_account_info().try_borrow_mut_lamports()? -= disbursement_amount;
        **ctx.accounts.beneficiary.to_account_info().try_borrow_mut_lamports()? += disbursement_amount;

        vault.remaining_amount = vault
            .remaining_amount
            .checked_sub(disbursement_amount)
            .ok_or(TridentError::MathOverflow)?;
        vault.milestones_completed += 1;

        emit!(MilestoneDisbursedEvent {
            grant_id: vault.grant_id,
            milestone_index,
            amount: disbursement_amount,
            beneficiary: vault.beneficiary,
            proof_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Circuit breaker: Toggles emergency state. Only the grantor can trigger.
    pub fn set_circuit_breaker(ctx: Context<ManageCircuitBreaker>, freeze_state: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.is_frozen = freeze_state;

        emit!(CircuitBreakerToggledEvent {
            grant_id: vault.grant_id,
            is_frozen: freeze_state,
            operator: ctx.accounts.grantor.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Recalls remaining funds to grantor if the vault has expired or is frozen due to breach.
    pub fn emergency_clawback(ctx: Context<EmergencyClawback>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        let clock = Clock::get()?;

        let can_clawback = vault.is_frozen || (clock.unix_timestamp >= vault.lockup_expiry);
        require!(can_clawback, TridentError::ConditionsNotMetForClawback);

        let remaining = ctx.accounts.escrow_wallet.lamports();
        require!(remaining > 0, TridentError::ZeroAmount);

        **ctx.accounts.escrow_wallet.to_account_info().try_borrow_mut_lamports()? -= remaining;
        **ctx.accounts.grantor.to_account_info().try_borrow_mut_lamports()? += remaining;

        vault.remaining_amount = 0;

        emit!(ClawbackExecutedEvent {
            grant_id: vault.grant_id,
            amount_reclaimed: remaining,
            grantor: vault.grantor,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(grant_id: u64)]
pubデス struct InitializeVault<'info> {
    #[account(
        init,
        payer = grantor,
        space = VaultState::LEN,
        seeds = [b"vault", grant_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// CHECK: PDA used solely as native SOL escrow container.
    #[account(
        mut,
        seeds = [b"escrow", grant_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_wallet: AccountInfo<'info>,

    #[account(mut)]
    pub grantor: Signer<'info>,

    /// CHECK: Validated public key for milestone co-attestation.
    pub auditor: AccountInfo<'info>,

    /// CHECK: Recipient of the milestone payouts.
    pub beneficiary: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// CHECK: Validated via seeds
    #[account(
        mut,
        seeds = [b"escrow", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.escrow_bump
    )]
    pub escrow_wallet: AccountInfo<'info>,

    #[account(mut, address = vault_state.grantor @ TridentError::Unauthorized)]
    pub grantor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// CHECK: Validated via seeds
    #[account(
        mut,
        seeds = [b"escrow", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.escrow_bump
    )]
    pub escrow_wallet: AccountInfo<'info>,

    #[account(address = vault_state.grantor @ TridentError::Unauthorized)]
    pub grantor: Signer<'info>,

    #[account(address = vault_state.auditor @ TridentError::InvalidAuditor)]
    pub auditor: Signer<'info>,

    /// CHECK: Target address receiving released funds
    #[account(mut, address = vault_state.beneficiary @ TridentError::InvalidBeneficiary)]
    pub beneficiary: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageCircuitBreaker<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(address = vault_state.grantor @ TridentError::Unauthorized)]
    pub grantor: Signer<'info>,
}

#[derive(Accounts)]
pub struct EmergencyClawback<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// CHECK: Validated via seeds
    #[account(
        mut,
        seeds = [b"escrow", vault_state.grant_id.to_le_bytes().as_ref()],
        bump = vault_state.escrow_bump
    )]
    pub escrow_wallet: AccountInfo<'info>,

    #[account(mut, address = vault_state.grantor @ TridentError::Unauthorized)]
    pub grantor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub grantor: Pubkey,            // 32
    pub auditor: Pubkey,            // 32
    pub beneficiary: Pubkey,        // 32
    pub grant_id: u64,              // 8
    pub total_amount: u64,          // 8
    pub remaining_amount: u64,      // 8
    pub payout_per_milestone: u64,  // 8
    pub lockup_expiry: i64,         // 8
    pub milestone_count: u8,        // 1
    pub milestones_completed: u8,   // 1
    pub is_frozen: bool,            // 1
    pub bump: u8,                   // 1
    pub escrow_bump: u8,            // 1
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 + 64;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub grant_id: u64,
    pub grantor: Pubkey,
    pub beneficiary: Pubkey,
    pub total_amount: u64,
    pub milestones: u8,
    pub timestamp: i64,
}

#[event]
pub struct VaultFundedEvent {
    pub grant_id: u64,
    pub amount: u64,
    pub funder: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneDisbursedEvent {
    pub grant_id: u64,
    pub milestone_index: u8,
    pub amount: u64,
    pub beneficiary: Pubkey,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct CircuitBreakerToggledEvent {
    pub grant_id: u64,
    pub is_frozen: bool,
    pub operator: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ClawbackExecutedEvent {
    pub grant_id: u64,
    pub amount_reclaimed: u64,
    pub grantor: Pubkey,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum TridentError {
    #[msg("Milestone count must be greater than zero.")]
    ZeroMilestones,
    #[msg("Total allocation amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Vault lockup expiration must be set in the future.")]
    InvalidExpiry,
    #[msg("Mathematical overflow occurred.")]
    MathOverflow,
    #[msg("Vault is currently frozen by emergency circuit breaker.")]
    VaultIsFrozen,
    #[msg("Milestone index out of sequence.")]
    InvalidMilestoneSequence,
    #[msg("All allocated milestones have already been claimed.")]
    AllMilestonesCompleted,
    #[msg("Insufficient lamport balance held in escrow.")]
    InsufficientEscrowBalance,
    #[msg("Caller lacks authorization for this instruction.")]
    Unauthorized,
    #[msg("Provided auditor does not match vault specifications.")]
    InvalidAuditor,
    #[msg("Provided beneficiary does not match vault specifications.")]
    InvalidBeneficiary,
    #[msg("Clawback conditions not met: vault must be frozen or expired.")]
    ConditionsNotMetForClawback,
}