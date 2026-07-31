import http from 'node:http';
import net from 'node:net';

const listenHost = process.env.FLOCK_LAN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.FLOCK_LAN_PORT ?? 18090);
const upstreamHost = process.env.FLOCK_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.FLOCK_UPSTREAM_PORT ?? 8090);
const audioSeatLimit = Number(process.env.FLOCK_AUDIO_SEATS ?? 4);
const canonicalHost = process.env.FLOCK_CANONICAL_HOST ?? `localhost:${upstreamPort}`;
const canonicalOrigin = `http://${canonicalHost}`;

let activeAudioSeats = 0;

function projectedHeaders(headers) {
  const projected = { ...headers };
  for (const name of Object.keys(projected)) {
    if (name.toLowerCase().startsWith('x-forwarded-')) delete projected[name];
  }
  projected.host = canonicalHost;
  if (headers.origin) projected.origin = canonicalOrigin;
  if (headers['sec-fetch-site']) projected['sec-fetch-site'] = 'same-origin';
  return projected;
}

function debugProjection(request, headers) {
  if (process.env.FLOCK_PROXY_DEBUG !== '1') return;
  console.log(JSON.stringify({
    event: 'flock_lan_proxy_projection',
    path: request.url,
    host: headers.host,
    origin: headers.origin ?? null,
    fetchMode: headers['sec-fetch-mode'] ?? null,
    fetchDest: headers['sec-fetch-dest'] ?? null,
    fetchSite: headers['sec-fetch-site'] ?? null,
  }));
}

function projectNavigation(request, headers) {
  const pathname = new URL(request.url ?? '/', canonicalOrigin).pathname;
  if ((pathname !== '/' && pathname !== '/index.html') || request.method !== 'GET') return;
  headers['sec-fetch-mode'] = 'navigate';
  headers['sec-fetch-dest'] = 'document';
  headers['sec-fetch-site'] = 'same-origin';
}

function projectBrowserFetch(request, headers) {
  const pathname = new URL(request.url ?? '/', canonicalOrigin).pathname;
  if (!pathname.startsWith('/api/v1/')) return;
  headers.origin = canonicalOrigin;
  headers['sec-fetch-site'] = 'same-origin';
}

function projectOperationalRead(request, headers) {
  const pathname = new URL(request.url ?? '/', canonicalOrigin).pathname;
  if (pathname !== '/readyz') return;
  headers.host = `${upstreamHost}:${upstreamPort}`;
  delete headers.origin;
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  delete headers['sec-fetch-site'];
}

function rejectFull(socket) {
  const body = JSON.stringify({
    error: 'audio_capacity_full',
    capacity: audioSeatLimit,
    message: 'All audio seats are occupied. Please retry shortly.',
  });
  socket.end([
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
}

const server = http.createServer((request, response) => {
  const headers = projectedHeaders(request.headers);
  projectNavigation(request, headers);
  projectBrowserFetch(request, headers);
  projectOperationalRead(request, headers);
  debugProjection(request, headers);
  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    response.end(JSON.stringify({ error: 'upstream_unavailable', detail: error.message }));
  });
  request.pipe(upstream);
});

server.on('upgrade', (request, clientSocket, head) => {
  const isAudio = new URL(request.url ?? '/', canonicalOrigin).pathname === '/api/v1/audio';
  if (isAudio && activeAudioSeats >= audioSeatLimit) {
    rejectFull(clientSocket);
    return;
  }

  if (isAudio) activeAudioSeats += 1;
  let released = false;
  const releaseSeat = () => {
    if (!isAudio || released) return;
    released = true;
    activeAudioSeats -= 1;
  };

  const upstreamSocket = net.connect(upstreamPort, upstreamHost);
  upstreamSocket.once('connect', () => {
    const headers = projectedHeaders(request.headers);
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }
    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => clientSocket.destroy());
  upstreamSocket.on('close', releaseSeat);
  clientSocket.on('close', releaseSeat);
  clientSocket.on('error', () => upstreamSocket.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(JSON.stringify({
    event: 'flock_lan_proxy_ready',
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    audioSeatLimit,
  }));
});
