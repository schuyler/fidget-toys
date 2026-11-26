// The room relay as a Cloudflare Worker: one Durable Object per room, using
// the WebSocket Hibernation API so an idle room costs nothing.
//
//   npx wrangler@4.158.0 dev       # ws://localhost:8787
//   npx wrangler@4.158.0 deploy

import { DurableObject } from 'cloudflare:workers';
import { createRoom, parseRequest, originAllowed, parseOrigins } from './room.js';

export default {
  /** @param {Request} request @param {{ ROOMS: any, ALLOWED_ORIGINS?: string }} env */
  async fetch(request, env) {
    const r = parseRequest(new URL(request.url));
    if (!r) return new Response(null, { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    if (!originAllowed(request.headers.get('Origin'), parseOrigins(env.ALLOWED_ORIGINS))) return new Response(null, { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(`${r.game}/${r.code}`)).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = createRoom();
    // Runs again on every wake from hibernation: rebuild the seats from the sockets.
    for (const ws of ctx.getWebSockets()) this.room.join(Number(ctx.getTags(ws)[0]), ws);
  }

  /** @param {Request} request */
  async fetch(request) {
    const r = /** @type {{ seat: number }} */ (parseRequest(new URL(request.url)));
    const tag = String(r.seat);
    // Either can hold the seat: a CLOSING socket stays in getWebSockets(), and a seat freed by
    // getWebSockets() may still be in the room until its close event arrives.
    if (this.ctx.getWebSockets(tag).length || this.room.has(r.seat)) return new Response(null, { status: 409 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [tag]);
    this.room.join(r.seat, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    this.room.message(ws, typeof data === 'string' ? data : null);
  }

  webSocketClose(ws) { this.room.leave(ws); }

  webSocketError(ws) { this.room.leave(ws); }
}
