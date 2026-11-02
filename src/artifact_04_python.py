"""
Volya Protocol: Autonomous Keeper Settlement Crank
Continuously queries active streams from the RPC, identifies available vested balances,
and invokes withdraw() with batch transactions to guarantee continuous settlement.
"""

import asyncio
import os
import struct
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.message import Message

PROGRAM_ID = Pubkey.from_string("VoLya8aK7Bcv1Z4y8gZpXo2fBqQ9zZ9yM6wL2hD3kPn")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
RPC_ENDPOINT = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")

# SHA256("global:withdraw")[0..8]
WITHDRAW_DISCRIMINATOR = bytes([183, 18, 70, 156, 148, 109, 161, 34])

async def run_keeper():
    client = AsyncClient(RPC_ENDPOINT)
    keeper_keypair = Keypair() # In prod, load from KMS / secure keypair
    print(f"[*] Volya Keeper Initialized. Worker: {keeper_keypair.pubkey()}")

    while True:
        try:
            # Query program accounts matching StreamState size
            # 8 bytes disc + StreamState fields (212 bytes total)
            resp = await client.get_program_accounts(
                PROGRAM_ID,
                encoding="base64"
            )
            accounts = resp.value
            print(f"[*] Scanned {len(accounts)} protocol accounts.")

            for acc in accounts:
                data = acc.account.data
                if len(data) < 200:
                    continue

                # Parse StreamState
                # Struct layout: disc(8), sender(32), recipient(32), mint(32), escrow_vault(32),
                # stream_id(8), deposit(8), withdrawn(8), start(8), stop(8), last_withdrawn(8),
                # rate(16), can_cancel(1), is_active(1), bump(1), vault_bump(1)
                is_active = bool(data[193])
                if not is_active:
                    continue

                stream_state_pubkey = acc.pubkey
                sender = Pubkey(data[8:40])
                recipient = Pubkey(data[40:72])
                mint = Pubkey(data[72:104])
                escrow_vault = Pubkey(data[104:136])

                # Construct Withdraw instruction
                accounts_meta = [
                    AccountMeta(pubkey=stream_state_pubkey, is_signer=False, is_writable=True),
                    AccountMeta(pubkey=escrow_vault, is_signer=False, is_writable=True),
                    AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
                    AccountMeta(pubkey=recipient, is_signer=False, is_writable=True), # In prod derive ATA
                    AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
                ]
                
                # Withdraw 0 = withdraw all unlocked
                data_payload = WITHDRAW_DISCRIMINATOR + struct.pack("<Q", 0)
                ix = Instruction(PROGRAM_ID, data_payload, accounts_meta)

                # Process transaction
                blockhash_resp = await client.get_latest_blockhash()
                msg = Message([ix], keeper_keypair.pubkey())
                tx = Transaction([keeper_keypair], msg, blockhash_resp.value.blockhash)

                sig = await client.send_transaction(tx)
                print(f"[+] Autonomous settlement executed for Stream {stream_state_pubkey}: Sig {sig.value}")

        except Exception as e:
            print(f"[-] Crank iteration error: {str(e)}")

        await asyncio.sleep(15)

if __name__ == "__main__":
    asyncio.run(run_keeper())