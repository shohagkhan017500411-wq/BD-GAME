
const APPWRITE_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = "6af4c610002ee336af01";
const APPWRITE_DATABASE_ID = "6af4e97b0018132a174c";
const ADMIN_OWNER_ID = "3fcee17a-fd33-4d0e-97cf-7ae35c9eb820";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Content-Type": "application/json"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

async function verifyAdmin(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);

  const response = await fetch(
    `${env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) return null;

  const user = await response.json();

  if (user.id !== ADMIN_OWNER_ID) return null;

  return user;
}

async function getAdminPlayers(env) {
  if (!env.APPWRITE_API_KEY) {
    throw new Error("APPWRITE_API_KEY is missing");
  }

  const endpoint =
    `${APPWRITE_ENDPOINT}/tablesdb/${APPWRITE_DATABASE_ID}` +
    `/tables/players/rows?limit=100&total=true`;

  const response = await fetch(endpoint, {
    headers: {
      "X-Appwrite-Project": APPWRITE_PROJECT_ID,
      "X-Appwrite-Key": env.APPWRITE_API_KEY
    }
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.message || "Appwrite request failed"
    );
  }

  return {
    total: result.total || 0,
    players: result.rows || []
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "BD GAME Multiplayer",
        status: "ready"
      });
    }

    // ADMIN PLAYER API
    if (url.pathname === "/api/admin/players") {
      if (request.method !== "GET") {
        return json({
          ok: false,
          error: "Method not allowed"
        }, 405);
      }

      try {
        const admin = await verifyAdmin(request, env);

        if (!admin) {
          return json({
            ok: false,
            error: "Unauthorized admin"
          }, 401);
        }

        const data = await getAdminPlayers(env);

        return json({
          ok: true,
          service: "BD GAME Admin API",
          total: data.total,
          players: data.players
        });
      } catch (error) {
        return json({
          ok: false,
          error: error.message || "Server error"
        }, 500);
      }
    }

    // MULTIPLAYER WEBSOCKET
    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response(
          "WebSocket upgrade required",
          { status: 426 }
        );
      }

      const room = (
        url.searchParams.get("room") || "public"
      ).slice(0, 40);

      const mode = (
        url.searchParams.get("mode") || "SOLO"
      ).toUpperCase();

      if (!["SOLO", "DUO", "SQUAD"].includes(mode)) {
        return new Response(
          "Invalid game mode",
          { status: 400 }
        );
      }

      const id = env.GAME_ROOMS.idFromName(
        room + ":" + mode
      );

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

    const rawName =
      url.searchParams.get("name") || "Guest Player";

    const name = rawName
      .replace(/[<>\u0000-\u001f]/g, "")
      .slice(0, 20) || "Guest Player";

    if (this.ctx.getWebSockets().length >= 50) {
      return new Response("Room is full", {
        status: 503
      });
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
      if (
        typeof event.data !== "string" ||
        event.data.length > 1000
      ) return;

      let msg;

      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type !== "player_update") return;

      const player =
        server.deserializeAttachment() || {};

      const x = Number(msg.x);
      const z = Number(msg.z);

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z)
      ) return;

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
