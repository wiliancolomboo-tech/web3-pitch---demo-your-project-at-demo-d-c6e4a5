#!/usr/bin/env python3
"""
AegisFlow Automated Keeper Daemon
Listens for liveness expiry and fires trigger_contingency() transactions.
"""

import asyncio
import logging
from typing import Optional
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
import anchorpy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (AegisKeeper) %(message)s"
)

PROGRAM_ID = Pubkey.from_string("Aegis111111111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

class AegisKeeper:
    def __init__(self, rpc_url: str, keeper_keypair: Keypair, treasury_pda: Pubkey):
        self.client = AsyncClient(rpc_url)
        self.keeper = keeper_keypair
        self.treasury = treasury_pda

    async def get_treasury_state(self):
        acc_info = await self.client.get_account_info(self.treasury)
        if not acc_info.value:
            raise ValueError("Treasury account not found on-chain")
        
        data = acc_info.value.data
        # Offset calculation: 8 (discriminator) + 32 (auth) + 32 (recip) + 32 (mint) + 32 (vault)
        last_hb = int.from_bytes(data[136:144], byteorder="little")
        grace = int.from_bytes(data[144:152], byteorder="little")
        is_triggered = bool(data[154])
        
        vault = Pubkey.from_bytes(data[104:136])
        contingency_recipient = Pubkey.from_bytes(data[40:72])
        
        return {
            "last_heartbeat": last_hb,
            "grace_period": grace,
            "is_triggered": is_triggered,
            "vault": vault,
            "contingency_recipient": contingency_recipient
        }

    async def run(self):
        logging.info(f"Keeper node online. Watching Treasury: {self.treasury}")
        while True:
            try:
                state = await self.get_treasury_state()
                if state["is_triggered"]:
                    logging.info("Treasury contingency already triggered. Exiting keeper loop.")
                    break

                current_slot_resp = await self.client.get_slot()
                current_slot = current_slot_resp.value
                deadline = state["last_heartbeat"] + state["grace_period"]

                logging.info(
                    f"Current Slot: {current_slot} | Deadline: {deadline} | "
                    f"Remaining: {deadline - current_slot} slots"
                )

                if current_slot > deadline:
                    logging.warning("LIVENESS BREACH DETECTED! Preparing contingency transaction...")
                    await self.execute_contingency(state)
                    break

                await asyncio.sleep(2.0)
            except Exception as e:
                logging.error(f"Keeper loop anomaly: {e}")
                await asyncio.sleep(5.0)

    async def execute_contingency(self, state):
        # Anchor discriminator for trigger_contingency: sha256("global:trigger_contingency")[0..8]
        discriminator = bytes([166, 140, 169, 137, 246, 218, 172, 192])

        # Resolve Associated Token Accounts for keeper and contingency recipient
        # Assumes ATA helper resolution logic
        keeper_ata = Pubkey.find_program_address(
            [bytes(self.keeper.pubkey()), bytes(TOKEN_PROGRAM_ID)],
            PROGRAM_ID
        )[0]
        
        contingency_ata = Pubkey.find_program_address(
            [bytes(state["contingency_recipient"]), bytes(TOKEN_PROGRAM_ID)],
            PROGRAM_ID
        )[0]

        accounts = [
            AccountMeta(pubkey=self.keeper.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=self.treasury, is_signer=False, is_writable=True),
            AccountMeta(pubkey=state["contingency_recipient"], is_signer=False, is_writable=True),
            AccountMeta(pubkey=state["vault"], is_signer=False, is_writable=True),
            AccountMeta(pubkey=contingency_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=keeper_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        ix = Instruction(PROGRAM_ID, discriminator, accounts)
        blockhash_resp = await self.client.get_latest_blockhash()
        
        msg = MessageV0.try_compile(
            payer=self.keeper.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash_resp.value.blockhash
        )
        tx = VersionedTransaction(msg, [self.keeper])
        
        tx_sig = await self.client.send_transaction(tx)
        logging.info(f"Contingency executed successfully! Signature: {tx_sig.value}")

if __name__ == "__main__":
    dummy_key = Keypair()
    dummy_treasury = Pubkey.from_string("11111111111111111111111111111111")
    keeper = AegisKeeper("http://127.0.0.1:8899", dummy_key, dummy_treasury)
    asyncio.run(keeper.run())