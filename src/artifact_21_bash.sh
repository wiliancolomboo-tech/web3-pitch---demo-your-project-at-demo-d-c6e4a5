# Launch containerized notification engine
docker compose up -d --build

# Inspect real-time audit logs
docker logs -f kredostream-daemon