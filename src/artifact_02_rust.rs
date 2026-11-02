use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("VoL1aSHieLdKyivDemoDayProtocoL11111111111111");

#[program]
pub mod volia_protocol {
    use super::*;

    /// Initializes a new high-assurance Stream & Contingency Vault.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_id: u64,
        heartbeat_timeout_seconds: i64,
        total_deposit_amount: u64,
        rate_per_second: u64,
    ) -> Result<()> {
        require!(heartbeat_timeout_seconds >= 300, VoliaError::InvalidTimeoutWindow);
        require!(total_deposit_amount > 0, VoliaError::ZeroDepositAmount);
        require!(rate_per_second > 0, VoliaError::ZeroStreamingRate);

        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        vault.authority = ctx.accounts.authority.key();
        vault.contingency_recovery = ctx.accounts.contingency_recovery.key();
        vault.beneficiary = ctx.accounts.beneficiary.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.vault_id = vault_id;
        vault.bump = ctx.bumps.vault;
        vault.heartbeat_timeout_seconds = heartbeat_timeout_seconds;
        vault.last_heartbeat_timestamp = clock.unix_timestamp;
        vault.start_timestamp = clock.unix_timestamp;
        vault.total_deposit_amount = total_deposit_amount;
        vault.rate_per_second = rate_per_second;
        vault.withdrawn_amount = 0;
        vault.is_contingency_active = false;
        vault.is_halted = false;

        // Transfer initial treasury allocation into PDA Token Account
        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, total_deposit_amount)?;

        emit!(VaultInitializedEvent {
            vault_id,
            authority: vault.authority,
            beneficiary: vault.beneficiary,
            total_deposit_amount,
            start_timestamp: vault.start_timestamp,
        });

        Ok(())
    }

    /// Admin Heartbeat submission to reset the dead-man timer.
    pub fn record_heartbeat(ctx: Context<RecordHeartbeat>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_halted, VoliaError::VaultHalted);
        require!(!vault.is_contingency_active, VoliaError::ContingencyAlreadyActive);

        let clock = Clock::get()?;
        vault.last_heartbeat_timestamp = clock.unix_timestamp;

        emit!(HeartbeatRecordedEvent {
            vault_id: vault.vault_id,
            authority: ctx.accounts.authority.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Beneficiary stream claim function based on linear elapsed seconds.
    pub fn claim_stream(ctx: Context<ClaimStream>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_halted, VoliaError::VaultHalted);

        let clock = Clock::get()?;
        let elapsed_seconds = clock
            .unix_timestamp
            .checked_sub(vault.start_timestamp)
            .ok_or(VoliaError::MathOverflow)?;

        if elapsed_seconds <= 0 {
            return Err(VoliaError::StreamingNotStarted.into());
        }

        // Vested amount calculation: rate_per_second * elapsed_seconds
        let total_vested = (vault.rate_per_second as u128)
            .checked_mul(elapsed_seconds as u128)
            .ok_or(VoliaError::MathOverflow)?;

        let capped_vested = std::cmp::min(total_vested, vault.total_deposit_amount as u128) as u64;

        let claimable = capped_vested
            .checked_sub(vault.withdrawn_amount)
            .ok_or(VoliaError::MathOverflow)?;

        require!(claimable > 0, VoliaError::NoClaimableBalance);

        vault.withdrawn_amount = vault
            .withdrawn_amount
            .checked_add(claimable)
            .ok_or(VoliaError::MathOverflow)?;

        let auth_key = vault.authority;
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds = &[
            b"volia-vault".as_ref(),
            auth_key.as_ref(),
            vault_id_bytes.as_ref(),
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, claimable)?;

        emit!(StreamClaimedEvent {
            vault_id: vault.vault_id,
            beneficiary: ctx.accounts.beneficiary.key(),
            amount: claimable,
            total_withdrawn: vault.withdrawn_amount,
        });

        Ok(())
    }

    /// Triggers contingency failover when heartbeat timer lapses past timeout window.
    pub fn trigger_contingency(ctx: Context<TriggerContingency>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_contingency_active, VoliaError::ContingencyAlreadyActive);

        let clock = Clock::get()?;
        let time_since_last_heartbeat = clock
            .unix_timestamp
            .checked_sub(vault.last_heartbeat_timestamp)
            .ok_or(VoliaError::MathOverflow)?;

        require!(
            time_since_last_heartbeat > vault.heartbeat_timeout_seconds,
            VoliaError::HeartbeatStillActive
        );

        vault.is_contingency_active = true;

        // Drain remainder to contingency recovery address
        let remaining_balance = ctx.accounts.vault_token_account.amount;
        require!(remaining_balance > 0, VoliaError::NoResidualBalanceToEvacuate);

        let auth_key = vault.authority;
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds = &[
            b"volia-vault".as_ref(),
            auth_key.as_ref(),
            vault_id_bytes.as_ref(),
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.contingency_recovery_token_account.to_account_info(),
            authority: vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, remaining_balance)?;

        emit!(ContingencyTriggeredEvent {
            vault_id: vault.vault_id,
            evacuated_amount: remaining_balance,
            recovery_target: ctx.accounts.contingency_recovery_token_account.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultAccount::INIT_SPACE,
        seeds = [b"volia-vault", authority.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Audited emergency multi-sig address
    pub contingency_recovery: AccountInfo<'info>,

    /// CHECK: Contributor or team streaming beneficiary
    pub beneficiary: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = vault,
        seeds = [b"volia-token-account", vault.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == authority.key() @ VoliaError::InvalidTokenOwner,
        constraint = depositor_token_account.mint == token_mint.key() @ VoliaError::InvalidTokenMint
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RecordHeartbeat<'info> {
    #[account(
        mut,
        has_one = authority @ VoliaError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, VaultAccount>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimStream<'info> {
    #[account(
        mut,
        has_one = beneficiary @ VoliaError::UnauthorizedBeneficiary,
        has_one = vault_token_account @ VoliaError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, VaultAccount>,

    pub beneficiary: Signer<'info>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = beneficiary_token_account.owner == beneficiary.key() @ VoliaError::InvalidTokenOwner,
        constraint = beneficiary_token_account.mint == vault.token_mint @ VoliaError::InvalidTokenMint
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TriggerContingency<'info> {
    #[account(
        mut,
        has_one = contingency_recovery @ VoliaError::InvalidRecoveryAddress,
        has_one = vault_token_account @ VoliaError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Any caller (permissionless keeper / backup authority) can trigger if timeout elapsed
    pub caller: Signer<'info>,

    /// CHECK: Validated against vault.contingency_recovery
    pub contingency_recovery: AccountInfo<'info>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = contingency_recovery_token_account.owner == contingency_recovery.key() @ VoliaError::InvalidTokenOwner,
        constraint = contingency_recovery_token_account.mint == vault.token_mint @ VoliaError::InvalidTokenMint
    )]
    pub contingency_recovery_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE REPRESENTATION
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VaultAccount {
    pub authority: Pubkey,
    pub contingency_recovery: Pubkey,
    pub beneficiary: Pubkey,
    pub token_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub vault_id: u64,
    pub heartbeat_timeout_seconds: i64,
    pub last_heartbeat_timestamp: i64,
    pub start_timestamp: i64,
    pub total_deposit_amount: u64,
    pub rate_per_second: u64,
    pub withdrawn_amount: u64,
    pub is_contingency_active: bool,
    pub is_halted: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct VaultInitializedEvent {
    pub vault_id: u64,
    pub authority: Pubkey,
    pub beneficiary: Pubkey,
    pub total_deposit_amount: u64,
    pub start_timestamp: i64,
}

#[event]
pub struct HeartbeatRecordedEvent {
    pub vault_id: u64,
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StreamClaimedEvent {
    pub vault_id: u64,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub total_withdrawn: u64,
}

#[event]
pub struct ContingencyTriggeredEvent {
    pub vault_id: u64,
    pub evacuated_amount: u64,
    pub recovery_target: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum VoliaError {
    #[msg("Heartbeat timeout window must be at least 300 seconds.")]
    InvalidTimeoutWindow,
    #[msg("Initial vault deposit must be greater than zero.")]
    ZeroDepositAmount,
    #[msg("Streaming rate per second must be greater than zero.")]
    ZeroStreamingRate,
    #[msg("Signer does not match the designated authority.")]
    UnauthorizedAuthority,
    #[msg("Signer does not match the designated beneficiary.")]
    UnauthorizedBeneficiary,
    #[msg("Token account owner does not match specified identity.")]
    InvalidTokenOwner,
    #[msg("Token mint mismatch.")]
    InvalidTokenMint,
    #[msg("Mismatch in vault PDA token account.")]
    InvalidVaultTokenAccount,
    #[msg("Mismatch in emergency contingency recovery address.")]
    InvalidRecoveryAddress,
    #[msg("Mathematical overflow occurred during fixed-point calculation.")]
    MathOverflow,
    #[msg("Streaming has not started yet.")]
    StreamingNotStarted,
    #[msg("No tokens available to claim at this timestamp.")]
    NoClaimableBalance,
    #[msg("Vault is currently in administrative halted state.")]
    VaultHalted,
    #[msg("Contingency failover is already active.")]
    ContingencyAlreadyActive,
    #[msg("Heartbeat timer is still active. Contingency conditions have not been met.")]
    HeartbeatStillActive,
    #[msg("No residual tokens remain in vault to evacuate.")]
    NoResidualBalanceToEvacuate,
}