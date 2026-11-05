# Export Enterprise API Keys
export RESEND_API_KEY="re_test_000000000000000000000000"
export SLACK_WEBHOOK_URL="https://api.example.com/webhooks/alerts/placeholder"

# Launch Turnkey Docker Service
docker-compose up -d --build

# Verify Container Logs
docker-compose logs -f kyivpay-telemetry-daemon