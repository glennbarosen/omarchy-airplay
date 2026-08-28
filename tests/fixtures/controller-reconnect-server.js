const fs = require("node:fs");
const net = require("node:net");

const socketPath = process.argv[2];
try {
  fs.unlinkSync(socketPath);
} catch {}

const server = net.createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (!buffer.includes("\n")) return;
    connection.end('{"ok":true,"state":"idle"}\n');
  });
});

server.listen(socketPath, () => {
  process.stdout.write("READY\n");
});

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
