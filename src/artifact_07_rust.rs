use anchor_lang::prelude::*;

#[error_code]
pub mod KredoError {
    #[msg("Calculation overflow occurred during vested balance calculation.")]
    MathOverflow,
    #[msg("Start time must be strictly before end time.")]
    InvalidTimeframe,
    #[msg("Start time cannot be set more than 30 days in the past.")]
    StartTimeTooOld,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("This stream is configured as non-cancellable.")]
    CannotCancelStream,
    #[msg("Stream is no longer active.")]
    StreamNotActive,
    #[msg("Requested withdrawal amount exceeds vested balance available.")]
    InsufficientVestedFunds,
    #[msg("Only the designated stream sender or recipient can perform this action.")]
    UnauthorizedSigner,
    #[msg("Invalid token mint account supplied.")]
    InvalidMint,
}