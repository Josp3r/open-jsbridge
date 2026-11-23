import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";

const host = "127.0.0.1";
const portArgument = process.argv[2] ?? "4173";
const port = Number(portArgument);

if (!/^[0-9]+$/.test(portArgument) || port > 65_535) {
  console.error("Choose a port from 0 to 65535.");
  process.exit(1);
}

const project = new URL("../../", import.meta.url);
const assets = new Map([
  ["/", "examples/web-demo/index.html"],
  ["/styles.css", "examples/web-demo/styles.css"],
  ["/tokens.css", "examples/web-demo/tokens.css"],
  ["/demo.js", "examples/web-demo/demo.js"],
  ...[
    "dist/packages/protocol/src/index.js",
    "dist/packages/web-sdk/src/index.js",
    "dist/packages/web-sdk/src/session.js",
    "dist/packages/web-sdk/src/transport.js",
    "dist/packages/web-mock/src/index.js",
  ].map((path) => [`/${path}`, path]),
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const path = assets.get(request.url?.split("?", 1)[0]);
  if (path === undefined) {
    response.writeHead(404).end();
    return;
  }

  let body;
  try {
    body = await readFile(new URL(path, project));
  } catch (error) {
    console.error(error.message);
    response.writeHead(500).end();
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": contentTypes[extname(path)],
  }).end(request.method === "HEAD" ? undefined : body);
});

server.on("error", (error) => {
  console.error(`Could not start the Web quickstart. ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Open the Web quickstart at http://${host}:${server.address().port}/`);
});
