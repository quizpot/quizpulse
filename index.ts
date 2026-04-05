import { createClient, removeClient } from "./lib/managers/WSClientManager.ts";
import {  } from "@quizpot/quizcore";

const PORT = Number.parseInt(Deno.env.get("PORT") || "3001");

Deno.serve({ port: PORT }, async (req) => {
  const url: URL = new URL(req.url);
  const id: string | null = url.searchParams.get("id");
  const code: string | null = url.searchParams.get("code");

  if (id === null) {
    return new Response("Missing client id", { status: 400 });
  }

  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Quizpulse server", { status: 200 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  const client = createClient(socket, id);

  socket.onopen = () => {
    if (code === null) {
      // Create lobby
    }
    
    // Send lobby status
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
});