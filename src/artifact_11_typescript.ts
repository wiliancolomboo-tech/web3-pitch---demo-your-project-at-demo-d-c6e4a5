import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "UP",
        service: "trident-settlement-daemon",
        solana_connection: "HEALTHY",
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080, () => console.log("[Telemetry] Healthcheck ready on :8080/health"));