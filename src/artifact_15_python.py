import asyncio
import os
import sys
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from anchorpy import Provider, Wallet, Idl, Program

RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
PROGRAM_ID = Pubkey.from_string("VeLes99999999999999999999999999999999999999")

async def run_keeper_bot():
    print(f"[*] Initializing Veles Keeper Worker on: {RPC_URL}")
    connection = AsyncClient(RPC_URL)
    
    # Load keeper keypair from standard config
    wallet = Wallet.local()
    provider = Provider(connection, wallet)
    
    print(f"[*] Keeper Worker Public Key: {wallet.public_key}")

    try:
        while True:
            current_slot = (await connection.get_slot()).value
            print(f"[+] Current Solana Slot: {current_slot} | Scanning Order PDAs...")
            
            # Keeper polling logic:
            # 1. Fetch all program accounts initialized with OrderStream discriminator
            # 2. Filter streams where current_slot >= last_crank_slot + slot_interval
            # 3. Construct and submit `crank_slice` instruction batches
            
            await asyncio.sleep(0.8) # Poll every 2 Solana slots (~800ms)
    except asyncio.CancelledError:
        print("[-] Keeper shutting down...")
    finally:
        await connection.close()

if __name__ == "__main__":
    try:
        asyncio.run(run_keeper_bot())
    except KeyboardInterrupt:
        sys.exit(0)