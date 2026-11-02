use anchor_lang::prelude::*;

#[event]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub deposit_amount: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub timestamp: i64,
}

#[event]
pub struct StreamWithdrawnEvent {
    pub stream_id: u64,
    pub recipient: Pubkey,
    pub amount_withdrawn: u64,
    pub remaining_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamCanceledEvent {
    pub stream_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub recipient_settled_amount: u64,
    pub sender_refund_amount: u64,
    pub timestamp: i64,
}