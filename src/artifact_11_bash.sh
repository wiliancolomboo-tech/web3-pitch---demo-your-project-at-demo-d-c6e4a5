#!/usr/bin/env bash
# runbook_healthcheck.sh - Checks Solana cluster sync and daemon logs

echo "=== [VOLYA PROTOCOL CLUSTER HEALTHCHECK] ==="
CLUSTER_SLOT=$(curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1, "method":"getSlot"}' https://api.devnet.solana.com | grep -o '"result":[0-9]*' | cut -d':' -f2)

if [ -n "$CLUSTER_SLOT" ]; then
    echo "✅ Solana RPC Responsive. Current Cluster Slot: $CLUSTER_SLOT"
else
    echo "❌ FATAL: Solana Devnet RPC Unreachable!"
    exit 1
fi

echo "Checking Docker Sentinel Daemon status..."
if docker ps | grep -q "volya-sentinel-service"; then
    echo "✅ Volya Sentinel container is running."
else
    echo "⚠️ Warning: Volya Sentinel container is not running! Starting with docker-compose..."
    docker-compose up -d
fi