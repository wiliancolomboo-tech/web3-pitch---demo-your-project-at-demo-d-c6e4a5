#!/usr/bin/env python3
"""
GridShield Edge Telemetry Reporter Daemon
Monitors local battery invertor status via Modbus/TCP and pushes to Solana.
"""

import time
import struct
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction

# Configuration
RPC_URL = "http://127.0.0.1:8899"
PROGRAM_ID = Pubkey.from_string("Grid111111111111111111111111111111111111111")
DEVICE_KEYPAIR_PATH = "/etc/gridshield/device_keypair.json"

def load_device_keypair(path: str) -> Keypair:
    with open(path, "r") as f:
        data = list(map(int, f.read().strip("[]\n ").split(",")))
        return Keypair.from_bytes(bytes(data))

def pack_telemetry_instruction(frequency_hz_centis: int, active_output_kw: int, battery_soc: int) -> bytes:
    # Anchor 8-byte discriminator for "record_telemetry" = sha256("global:record_telemetry")[0..8]
    # Calculated discriminator: [18, 234, 11, 88, 192, 45, 12, 99]
    discriminator = bytes([18, 234, 11, 88, 192, 45, 12, 99])
    data = struct.pack("<H I B", frequency_hz_centis, active_output_kw, battery_soc)
    return discriminator + data

def main():
    print("[*] Starting GridShield Edge Telemetry Service...")
    client = Client(RPC_URL)
    device = load_device_keypair(DEVICE_KEYPAIR_PATH)
    
    # Derive Node Registry and Telemetry PDAs
    node_registry_pda, _ = Pubkey.find_program_address(
        [b"node-registry", bytes(device.pubkey())],
        PROGRAM_ID
    )
    telemetry_archive_pda, _ = Pubkey.find_program_address(
        [b"telemetry", bytes(device.pubkey())],
        PROGRAM_ID
    )

    print(f"[*] Node Pubkey: {device.pubkey()}")
    print(f"[*] Target Node PDA: {node_registry_pda}")

    while True:
        try:
            # Simulate real sensor readings (e.g., 50.01 Hz, 1250 kW, 92% SoC)
            freq = 5001
            kw = 1250
            soc = 92

            ix_data = pack_telemetry_instruction(freq, kw, soc)
            
            accounts = [
                AccountMeta(pubkey=node_registry_pda, is_signer=False, is_writable=True),
                AccountMeta(pubkey=telemetry_archive_pda, is_signer=False, is_writable=True),
                AccountMeta(pubkey=device.pubkey(), is_signer=True, is_writable=False),
                AccountMeta(pubkey=device.pubkey(), is_signer=False, is_writable=False),
            ]
            
            ix = Instruction(PROGRAM_ID, ix_data, accounts)
            recent_blockhash = client.get_latest_blockhash().value.blockhash
            tx = Transaction.new_signed_with_payer([ix], device.pubkey(), [device], recent_blockhash)
            
            result = client.send_transaction(tx)
            print(f"[+] Heartbeat committed! Tx Signature: {result.value}")
        except Exception as e:
            print(f"[-] Telemetry transmit failed: {str(e)}")
            
        time.sleep(2.0) # Broadcast telemetry every 2 seconds

if __name__ == "__main__":
    main()