
const APPWRITE_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = "6af4c610002ee336af01";
const APPWRITE_DATABASE_ID = "6af4e97b0018132a174c";
const ADMIN_OWNER_ID = "3fcee17a-fd33-4d0e-97cf-7ae35c9eb820";

const SUPABASE_PROJECT_URL =
  "https://kvloogdidadztnpgcvqu.supabase.co";

let jwksCache = null;
let jwksCacheTime = 0;

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

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJwtPart(value) {
  return JSON.parse(
    new TextDecoder().decode(decodeBase64Url(value))
  );
}

async function getJWKS(forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    jwksCache &&
    now - jwksCacheTime < 5 * 60 * 1000
  ) {
    return jwksCache;
  }

  const response = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/.well-known/jwks.json`,
    {
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`JWKS request failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error("No public signing keys found in Supabase JWKS");
  }

  jwksCache = data;
  jwksCacheTime = now;

  return data;
}

async function verifyES256(token, forceRefresh = false) {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);

  if (header.alg !== "ES256") {
    throw new Error("Unsupported JWT algorithm");
  }

  if (!header.kid) {
    throw new Error("JWT signing key ID is missing");
  }

  const jwks = await getJWKS(forceRefresh);

  const jwk = jwks.keys.find(
    key => key.kid === header.kid &&
           key.alg === "ES256" &&
           key.kty === "EC" &&
           key.crv === "P-256"
  );

  if (!jwk) {
    if (!forceRefresh) {
      jwksCache = null;
      jwksCacheTime = 0;
      return verifyES256(token, true);
    }

    throw new Error(
      `JWT kid ${String(header.kid).slice(0, 40)} not found in Supabase JWKS`
    );
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256"
    },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: "SHA-256"
    },
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );

  if (!valid) {
    throw new Error("JWT signature verification failed");
  }

  validateClaims(claims);

  return claims;
}

function validateClaims(claims) {
  const now = Math.floor(Date.now() / 1000);

  if (!claims.sub || !claims.exp) {
    throw new Error("JWT missing required claims");
  }

  if (claims.exp <= now) {
    throw new Error("Admin session expired. Login again.");
  }

  if (claims.nbf && claims.nbf > now) {
    throw new Error("JWT is not active yet");
  }

  if (claims.iss !== `${SUPABASE_PROJECT_URL}/auth/v1`) {
    throw new Error("JWT belongs to a different Supabase project");
  }

  const validAudience =
    claims.aud === "authenticated" ||
    (
      Array.isArray(claims.aud) &&
      claims.aud.includes("authenticated")
    );

  if (!validAudience || claims.role !== "authenticated") {
    throw new Error("JWT is not an authenticated user token");
  }
}

async function verifyHS256WithSupabase(token, env) {
  if (!env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase API key configuration missing");
  }

  const response = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      String(
        data.msg ||
        data.message ||
        data.error_description ||
        data.error ||
        `Supabase Auth HTTP ${response.status}`
      ).slice(0, 160)
    );
  }

  return {
    sub: data.id,
    email: data.email || null
  };
}

async function verifyAdmin(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Missing admin login token"
    };
  }

  if (
    !env.SUPABASE_URL ||
    env.SUPABASE_URL.replace(/\/+$/, "") !== SUPABASE_PROJECT_URL
  ) {
    return {
      ok: false,
      status: 500,
      error: "Player Worker Supabase URL does not match BD GAME project"
    };
  }

  const token = authorization.slice(7);

  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }

    const header = decodeJwtPart(parts[0]);
    let claims;

    if (header.alg === "ES256") {
      claims = await verifyES256(token);
    } else if (header.alg === "HS256") {
      claims = await verifyHS256WithSupabase(token, env);
    } else {
      throw new Error(
        `Unsupported JWT algorithm: ${String(header.alg)}`
      );
    }

    if (claims.sub !== ADMIN_OWNER_ID) {
      return {
        ok: false,
        status: 403,
        error: "This account is not the Owner Admin"
      };
    }

    return {
      ok: true,
      user: {
        id: claims.sub,
        email: claims.email || null
      }
    };

  } catch (error) {
    const detail = String(
      error?.message || "JWT verification failed"
    ).replace(/[\r\n]+/g, " ").slice(0, 180);

    console.error("[BD GAME] Admin JWT error:", detail);

    return {
      ok: false,
      status: 401,
      error: `Admin token verification failed: ${detail}`
    };
  }
}

async function getAdminPlayers(env) {
  if (!env.APPWRITE_API_KEY) {
    throw new Error("APPWRITE_API_KEY is missing");
  }

  const endpoint =
    `${APPWRITE_ENDPOINT}/tablesdb/${APPWRITE_DATABASE_ID}` +
    `/tables/players/rows?limit=100&total=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  let response;

  try {
    response = await fetch(endpoint, {
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-Key": env.APPWRITE_API_KEY
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Appwrite request failed");
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

    if (url.pathname === "/api/admin/players") {
      if (request.method !== "GET") {
        return json({
          ok: false,
          error: "Method not allowed"
        }, 405);
      }

      const auth = await verifyAdmin(request, env);

      if (!auth.ok) {
        return json({
          ok: false,
          error: auth.error
        }, auth.status);
      }

      try {
        const data = await getAdminPlayers(env);

        return json({
          ok: true,
          service: "BD GAME Admin API",
          total: data.total,
          players: data.players
        });

      } catch (error) {
        console.error(
          "[BD GAME] Appwrite error:",
          error?.message || "Unknown error"
        );

        return json({
          ok: false,
          error: "Appwrite database connection failed"
        }, 502);
      }
    }

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket upgrade required", {
          status: 426
        });
      }

      const room = (
        url.searchParams.get("room") || "public"
      ).slice(0, 40);

      const mode = (
        url.searchParams.get("mode") || "SOLO"
      ).toUpperCase();

      if (!["SOLO", "DUO", "SQUAD"].includes(mode)) {
        return new Response("Invalid game mode", {
          status: 400
        });
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
      ) {
        return;
      }

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

      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        return;
      }

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
