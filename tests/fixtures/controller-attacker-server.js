const fs = require("node:fs");
const net = require("node:net");

const socketPath = "/tmp/doubletake.sock";
if (fs.existsSync(socketPath)) {
  process.stderr.write("SOCKET_EXISTS\n");
  process.exit(3);
}

const server = net.createServer((connection) => {
  connection.on("data", () => process.stdout.write("LEAK\n"));
});

server.listen(socketPath, () => process.stdout.write("READY\n"));

function shutdown() {
  server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
