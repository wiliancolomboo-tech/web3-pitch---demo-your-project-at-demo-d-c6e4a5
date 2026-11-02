import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), network: "solana" }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080, () => console.log("[Telemetry] Healthcheck active on :8080/health"));