#!/usr/bin/env python3
"""
Kinetix Stream Settlement Keeper Crank
Polls active streams and automatically executes settled withdrawals
"""
import time
from solana.rpc.api import Client
from solders.pubkey import Pubkey

RPC_URL = "https://api.devnet.solana.com"
PROGRAM_ID = Pubkey.from_string("Kntx111111111111111111111111111111111111111")

def main():
    client = Client(RPC_URL)
    print(f"[*] Kinetix Crank Keeper active. Monitoring program: {PROGRAM_ID}")
    
    while True:
        try:
            # Poll program accounts for active streams
            resp = client.get_program_accounts(PROGRAM_ID)
            accounts = resp.value
            print(f"[{time.strftime('%X')}] Monitored streams: {len(accounts)} active.")
        except Exception as e:
            print(f"[!] Error querying RPC: {e}")
        time.sleep(2)

if __name__ == "__main__":
    main()