use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct StreamState {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub deposit_amount: u64,
    pub withdrawn_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub can_cancel: bool,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl StreamState {
    pub const LEN: usize = 8 +  // discriminator
        8 +                      // stream_id
        32 +                     // sender
        32 +                     // recipient
        32 +                     // mint
        32 +                     // vault
        8 +                      // deposit_amount
        8 +                      // withdrawn_amount
        8 +                      // start_time
        8 +                      // end_time
        1 +                      // can_cancel
        1 +                      // is_active
        1 +                      // bump
        1;                       // vault_bump
}