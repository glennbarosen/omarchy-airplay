const fs = require("node:fs");
const net = require("node:net");

const socketPath = process.argv[2];
try {
  fs.unlinkSync(socketPath);
} catch {}

let requestCount = 0;
const server = net.createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (!buffer.includes("\n")) return;
    requestCount += 1;
    const request = JSON.parse(buffer.trim());
    if (requestCount === 1 && request.cmd === "status") {
      setTimeout(() => connection.end('{"ok":true,"state":"idle"}\n'), 200);
      return;
    }
    if (requestCount === 2
        && request.cmd === "connect"
        && request.target === "192.0.2.10"
        && request.pin === "1234") {
      connection.end('{"ok":true,"state":"streaming"}\n');
      return;
    }
    connection.end('{"ok":false,"state":"error"}\n');
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
