"use strict";
// Container health probe shared by the Docker HEALTHCHECK and the ECS task definition
// (distroless images have no shell or curl). Exits 0 when
// GET http://127.0.0.1:$PORT$HEALTHCHECK_PATH answers 2xx within 3 seconds, 1 otherwise.
const http = require("node:http");

const port = Number(process.env.PORT || 8080);
const path = process.env.HEALTHCHECK_PATH || "/healthz";

const req = http.get({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
