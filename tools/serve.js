#!/usr/bin/env node
// A static file server for the browser demo, because ES module imports do not
// work over file://. No dependencies, no configuration, no caching.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const port = Number(process.argv[2]) || 8080;
const root = resolve(process.argv[3] || '.');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sid': 'application/octet-stream',
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  // Redirect rather than rewrite: the demo's relative URLs resolve against the
  // document's own address, so it has to actually live at /web/.
  if (path === '/' || path === '/web' || path === '/web/') {
    response.writeHead(302, { location: '/web/index.html' }).end();
    return;
  }

  // Resolve first, then confirm the result is still inside the root, so that
  // ".." segments cannot walk out of it.
  const target = resolve(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      response.writeHead(403).end('directory listing is not served');
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    response.writeHead(missing ? 404 : 500).end(missing ? 'not found' : 'server error');
  }
}).listen(port, () => {
  process.stdout.write(`serving ${root} at http://localhost:${port}/\n`);
});
