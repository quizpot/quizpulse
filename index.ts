import { createLobby, getLobby } from "./lib/managers/LobbyManager.ts";
import { createClient, removeClient } from "./lib/managers/WSClientManager.ts";
import { LobbyActions, Lobby } from "@quizpot/quizcore";

const PORT = Number.parseInt(Deno.env.get("PORT") || "3001");

Deno.serve({ port: PORT }, async (req) => {
  const url: URL = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/createLobby") {
    try {
      const body = await req.json();
      const { id, quiz, settings } = body;
      
      const lobby = createLobby(id, quiz, settings);
      
      return new Response(JSON.stringify({ code: lobby.code }), { 
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    } catch (_) {
      return new Response("Invalid Quiz Data", { status: 400 });
    }
  }

  if (req.headers.get("upgrade") === "websocket") {
    const id: string | null = url.searchParams.get("id");
    const code: string | null = url.searchParams.get("code");
    const role: string | null = url.searchParams.get("role");
    const name: string | null = url.searchParams.get("name");

    if (!id || !code || !role) return new Response("Missing id or code or role", { status: 400 });
    if (role !== "host" && role !== "player") return new Response("Invalid role", { status: 400 });

    const lobby = getLobby(code);

    if (!lobby) return new Response("Lobby not found", { status: 404 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const client = createClient(socket, id, code, role);

    socket.onopen = () => {
      // Sync lobby with client
    };

    socket.onmessage = (e) => {
      // Handle incoming events
    };

    socket.onclose = () => {
      removeClient(client.id);
    };

    socket.onerror = (e: Event) => {
      console.error("[quizpulse] Socket error:", e);
    };

    return response;
  }

  return new Response("Quizpulse", { status: 200 });
});