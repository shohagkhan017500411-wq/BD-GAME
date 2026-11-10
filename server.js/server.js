
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "BD GAME Multiplayer",
        status: "ready"
      });
    }

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const room = (url.searchParams.get("room") || "public").slice(0, 40);
      const mode = (url.searchParams.get("mode") || "SOLO").toUpperCase();

      if (!["SOLO", "DUO", "SQUAD"].includes(mode)) {
        return new Response("Invalid game mode", { status: 400 });
      }

      const id = env.GAME_ROOMS.idFromName(room + ":" + mode);
      return env.GAME_ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const url = new URL(request.url);
    const rawName = url.searchParams.get("name") || "Guest Player";
    const name = rawName.replace(/[<>\u0000-\u001f]/g, "").slice(0, 20) || "Guest Player";

    if (this.ctx.getWebSockets().length >= 50) {
      return new Response("Room is full", { status: 503 });
    }

    server.accept();

    server.serializeAttachment({
      id: crypto.randomUUID(),
      name,
      x: 0,
      z: 0
    });

    server.send(JSON.stringify({
      type: "welcome",
      count: this.ctx.getWebSockets().length,
      players: this.getPlayers()
    }));

    this.broadcast({
      type: "room_update",
      count: this.ctx.getWebSockets().length,
      players: this.getPlayers()
    });

    server.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 1000) return;

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type !== "player_update") return;

      const player = server.deserializeAttachment() || {};
      const x = Number(msg.x);
      const z = Number(msg.z);

      if (!Number.isFinite(x) || !Number.isFinite(z)) return;

      player.x = Math.max(-1000, Math.min(1000, x));
      player.z = Math.max(-1000, Math.min(1000, z));
      server.serializeAttachment(player);

      this.broadcast({
        type: "player_update",
        player
      }, server);
    });

    const updateRoom = () => {
      this.broadcast({
        type: "room_update",
        count: this.ctx.getWebSockets().length,
        players: this.getPlayers()
      });
    };

    server.addEventListener("close", updateRoom);
    server.addEventListener("error", updateRoom);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  getPlayers() {
    return this.ctx.getWebSockets().map(ws => {
      const p = ws.deserializeAttachment() || {};
      return {
        id: p.id,
        name: p.name,
        x: p.x || 0,
        z: p.z || 0
      };
    });
  }

  broadcast(message, except = null) {
    const payload = JSON.stringify(message);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }
}
