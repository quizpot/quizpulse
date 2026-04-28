import { quiz } from "@quizpot/quizcore/db/schema";
import { db } from "./db/index.ts";
import {
  createLobby,
  getLobby,
  getLobbyCount,
  updateLobby,
  onHostConnected,
  deleteLobby,
} from "./managers/lobby-manager.ts";
import {
  createClient,
  removeClient,
  getClient,
  getClientCount,
} from "./managers/ws-client-manager.ts";
import { eq } from "drizzle-orm";
import {
  generateName,
  type AllClientEvents,
  type LobbySettings,
  LobbyManager,
  type TargetedEvent,
  isQuestion,
  LobbyStatus,
  type AllServerEvents,
} from "@quizpot/quizcore";
import type { Server } from "bun";

const PORT = Number.parseInt(process.env.PORT || "3001");

const deletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gameTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface WebSocketData {
  id: string;
  code: string;
  role: "host" | "player";
  name: string;
}

/** Routes events from the LobbyManager to the actual WebSocket clients. */
export function dispatchEvents(
  server: Server<WebSocketData>,
  lobbyCode: string,
  events: TargetedEvent[]
) {
  const lobby = getLobby(lobbyCode);
  if (!lobby) {
    console.warn(
      `[dispatchEvents] Lobby ${lobbyCode} not found when dispatching events`
    );
    return;
  }

  for (const targetedEvent of events) {
    const { target, event } = targetedEvent;

    try {
      const message = JSON.stringify(event);

      if (target === "all") {
        server.publish(lobbyCode, message);
      } else if (target === "host") {
        const hostClient = getClient(lobby.hostId);
        if (hostClient) hostClient.send(message);
      } else if (target === "players") {
        lobby.players.forEach((p) => {
          const client = getClient(p.id);
          if (client) {
            try {
              client.send(message);
            } catch (err) {
              console.error(
                `[dispatchEvents] Failed to send to player ${p.id}:`,
                err
              );
            }
          }
        });
      } else if (Array.isArray(target)) {
        dispatchEvents(
          server,
          lobbyCode,
          target.map((t) => ({ target: t, event }))
        );
      } else if (target.clientId) {
        const client = getClient(target.clientId);
        if (client) client.send(message);
      }
    } catch (err) {
      console.error(
        `[dispatchEvents] Failed to dispatch event to target ${JSON.stringify(target)}:`,
        err
      );
    }
  }
}

/**
 * Centralized handler for LobbyManager results.
 *
 * BUG FIX 1: LobbyManager methods (start, kick, nextStep, submitAnswer) can
 * return a native `Error` object on failure.  Previously these fell through
 * to `dispatchEvents(…, result.events)` where `result.events` is undefined
 * → runtime crash.  We now normalise Error instances to
 * `{ type: "ERROR", message }` and return early.
 *
 * BUG FIX 2: Removed the `else if (lobby.status === LobbyStatus.end)` auto-
 * advance timeout that was scheduling a second `LobbyManager.delete` call
 * (and re-broadcasting LOBBY_DELETED) after the lobby already ended.
 */
function handleLobbyResult(
  server: Server<WebSocketData>,
  code: string,
  result: any
): { type: "ERROR"; message: string } | void {
  if (!result) return;

  // Normalise native Error objects returned by LobbyManager methods.
  if (result instanceof Error) {
    return { type: "ERROR", message: result.message };
  }

  if (result.type === "ERROR") {
    return result as { type: "ERROR"; message: string };
  }

  const state = result.state || result.nextState;
  if (state) {
    updateLobby(code, state);

    // If the lobby just ended, cancel any pending game timer immediately.
    if (state.status === LobbyStatus.end) {
      if (gameTimers.has(code)) {
        clearTimeout(gameTimers.get(code));
        gameTimers.delete(code);
      }
      console.log(`[game] Lobby ${code} ended`);
    }
  }

  dispatchEvents(server, code, result.events);

  // All-answered early advance: break the call stack with setTimeout to avoid
  // unbounded recursion if setStatus itself triggers further transitions.
  const currentLobby = getLobby(code);
  if (currentLobby && currentLobby.status === LobbyStatus.answer) {
    const connectedPlayers = currentLobby.players.filter((p) => p.isConnected);
    if (
      connectedPlayers.length > 0 &&
      currentLobby.currentAnswers.length >= connectedPlayers.length
    ) {
      console.log(
        `[game] Lobby ${code} all players answered, advancing to answers`
      );
      setTimeout(() => {
        const freshLobby = getLobby(code);
        if (!freshLobby) return;
        handleLobbyResult(
          server,
          code,
          LobbyManager.setStatus(freshLobby, LobbyStatus.answers)
        );
      }, 0);
      return;
    }
  }

  // Clear any existing game timer before scheduling a new one.
  if (gameTimers.has(code)) {
    clearTimeout(gameTimers.get(code));
    gameTimers.delete(code);
  }

  const lobby = getLobby(code);
  if (!lobby || !lobby.quiz) return;

  // Don't schedule auto-advance timers for a lobby that has already ended.
  if (lobby.status === LobbyStatus.end) return;

  const currentQuestion = lobby.quiz.steps[lobby.currentStep];
  if (!currentQuestion) {
    console.warn(
      `[game] Lobby ${code} step ${lobby.currentStep} not found in quiz`
    );
    return;
  }

  let timeout = 0;
  let nextStatus: LobbyStatus | null = null;

  if (isQuestion(currentQuestion)) {
    if (lobby.status === LobbyStatus.question) {
      timeout = (currentQuestion.data.displayTime || 5) * 1000;
      nextStatus = LobbyStatus.answer;
      console.log(
        `[game] Lobby ${code} question display timeout: ${timeout}ms`
      );
    } else if (lobby.status === LobbyStatus.answer) {
      timeout = (currentQuestion.data.timeLimit || 5) * 1000;
      nextStatus = LobbyStatus.answers;
      console.log(
        `[game] Lobby ${code} answer collection timeout: ${timeout}ms`
      );
    }
  }
  // NOTE: slides have no auto-advance timeout — the host advances manually.

  if (timeout > 0) {
    const timer = setTimeout(() => {
      // Always re-fetch lobby state to avoid stale closures.
      const freshLobby = getLobby(code);
      if (!freshLobby) {
        console.warn(`[game] Lobby ${code} disappeared before auto-advance`);
        return;
      }

      const freshQuestion = freshLobby.quiz.steps[freshLobby.currentStep];
      if (!freshQuestion) {
        console.warn(
          `[game] Lobby ${code} step ${freshLobby.currentStep} disappeared`
        );
        return;
      }

      const autoResult = nextStatus
        ? LobbyManager.setStatus(
            freshLobby,
            nextStatus,
            nextStatus === LobbyStatus.answer && isQuestion(freshQuestion)
              ? freshQuestion.data.timeLimit
              : undefined
          )
        : LobbyManager.nextStep(freshLobby, freshLobby.hostId);

      handleLobbyResult(server, code, autoResult);
    }, timeout);

    gameTimers.set(code, timer);
  }
}

const server = Bun.serve<WebSocketData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // ── POST /create-lobby ─────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/create-lobby") {
      try {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { quizId, settings } = body as {
          quizId?: string;
          settings?: LobbySettings;
        };

        if (!quizId || typeof quizId !== "string" || quizId.trim() === "") {
          return new Response(JSON.stringify({ error: "Invalid quizId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!settings || typeof settings !== "object") {
          return new Response(JSON.stringify({ error: "Invalid settings" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const quizObj = await db.select().from(quiz).where(eq(quiz.id, quizId));
        const q = quizObj[0]?.quiz;
        if (!q) {
          return new Response(JSON.stringify({ error: "Quiz not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!q.steps || q.steps.length === 0) {
          return new Response(
            JSON.stringify({ error: "Quiz has no steps" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const hostId = crypto.randomUUID();
        const lobby = createLobby(hostId, q, settings);

        console.log(`[lobby] Created lobby ${lobby.code} for quiz ${quizId}`);

        return Response.json({ code: lobby.code, hostId }, { status: 201 });
      } catch (err) {
        console.error("[lobby] Failed to create lobby:", err);
        return new Response(
          JSON.stringify({ error: "Failed to create lobby" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ── GET /ws (WebSocket upgrade) ────────────────────────────────────────
    if (url.pathname === "/ws") {
      const id = url.searchParams.get("id");
      const code = url.searchParams.get("code");
      const role = url.searchParams.get("role") as "host" | "player" | null;
      const name = url.searchParams.get("name") || generateName();

      if (!id || !code || !role || (role !== "host" && role !== "player")) {
        return new Response(
          JSON.stringify({ error: "Missing or invalid params" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const lobby = getLobby(code);
      if (!lobby) {
        return new Response(JSON.stringify({ error: "Lobby not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (role === "host" && lobby.hostId !== id) {
        console.warn(
          `[auth] Unauthorized host connection attempt for lobby ${code}`
        );
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const upgraded = server.upgrade(req, {
        data: { id, code, role, name },
      });

      return upgraded
        ? undefined
        : new Response(JSON.stringify({ error: "Upgrade failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
    }

    return new Response(
      JSON.stringify({ message: "Quizpulse WebSocket Server" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },

  websocket: {
    data: {} as WebSocketData,

    open(ws) {
      const { id, code, role, name } = ws.data;

      // Kick any existing connection for this client (e.g. duplicate tab)
      const existing = getClient(id);
      if (existing) {
        console.log(`[ws] Closing duplicate connection for ${id}`);
        existing.close(1001, "Connected from another location");
        removeClient(id);
      }

      if (role === "host") {
        onHostConnected(code);

        const timer = deletionTimers.get(code);
        if (timer) {
          clearTimeout(timer);
          deletionTimers.delete(code);
        }
        console.log(`[ws] Host ${id} connected to lobby ${code}`);
      } else {
        console.log(`[ws] Player ${name} (${id}) connected to lobby ${code}`);
      }

      ws.subscribe(code);
      createClient(ws as any, id, code, role);

      const lobby = getLobby(code);
      if (!lobby) {
        console.error(`[ws] Lobby ${code} disappeared during open handler`);
        ws.close(1011, "Lobby error");
        return;
      }

      const result = LobbyManager.join(lobby, id, name);
      if (result.type === "ERROR") {
        console.log(`[ws] Join error for ${id}: ${result.message}`);
        ws.close(4003, result.message);
      } else {
        setTimeout(() => {
          handleLobbyResult(server, code, result);
        }, 300);
      }
    },

    message(ws, message) {
      try {
        const { code, id } = ws.data;

        let payload: AllClientEvents;
        try {
          payload = JSON.parse(
            typeof message === "string" ? message : message.toString()
          );
        } catch (parseErr) {
          console.error(`[ws] Message parse error from ${id}:`, parseErr);
          ws.send(
            JSON.stringify({ event: "ERROR", message: "Invalid message format" })
          );
          return;
        }

        if (!payload || !payload.event) {
          console.error(
            `[ws] Message missing event property from ${id}`
          );
          ws.send(
            JSON.stringify({
              event: "ERROR",
              message: "Message missing event property",
            })
          );
          return;
        }

        const lobby = getLobby(code);
        if (!lobby) {
          console.error(
            `[ws] Lobby ${code} not found during message from ${id}`
          );
          ws.send(JSON.stringify({ event: "ERROR", message: "Lobby not found" }));
          return;
        }

        let result: any;

        switch (payload.event) {
          case "SUBMIT_ANSWER":
            if (!payload.payload?.submission) {
              ws.send(
                JSON.stringify({
                  event: "ERROR",
                  message: "Invalid answer submission",
                })
              );
              return;
            }
            result = LobbyManager.submitAnswer(
              lobby,
              id,
              payload.payload.submission
            );
            break;

          case "START_LOBBY":
            result = LobbyManager.start(lobby, id);
            break;

          case "NEXT_STEP":
            result = LobbyManager.nextStep(lobby, id);
            break;

          case "KICK_PLAYER":
            if (!payload.payload?.playerId) {
              ws.send(
                JSON.stringify({
                  event: "ERROR",
                  message: "Invalid kick request",
                })
              );
              return;
            }
            result = LobbyManager.kick(lobby, id, payload.payload.playerId);
            break;

          default:
            console.warn(`[ws] Unknown event from ${id}: ${payload}`);
            return;
        }

        const outcome = handleLobbyResult(server, code, result);
        if (outcome?.type === "ERROR") {
          console.log(
            `[game] Error handling ${payload.event} from ${id}: ${outcome.message}`
          );
          ws.send(
            JSON.stringify({ event: "SERVER_ERROR", payload: { message: outcome.message } })
          );
        }
      } catch (err) {
        console.error("[ws] Unexpected error in message handler:", err);
        try {
          ws.send(JSON.stringify({ event: "SERVER_ERROR", payload: { message: "Server error" } }));
        } catch {
          // swallow — client is likely gone
        }
      }
    },

    close(ws) {
      const { id, code, role } = ws.data;
      const lobby = getLobby(code);

      if (lobby) {
        const result = LobbyManager.disconnect(lobby, id);

        if (role === "host") {
          console.log(
            `[ws] Host ${id} disconnected from lobby ${code}, starting 30s grace period`
          );
          const timer = setTimeout(() => {
            const currentLobby = getLobby(code);
            if (currentLobby && !currentLobby.hostConnected) {
              console.log(`[lobby] Deleting lobby ${code} (host timeout)`);
              const cleanup = LobbyManager.delete(currentLobby, "Host timed out");
              deleteLobby(code);
              handleLobbyResult(server, code, cleanup);
            }
            deletionTimers.delete(code);
          }, 30_000);

          deletionTimers.set(code, timer);
        } else {
          console.log(`[ws] Player ${id} disconnected from lobby ${code}`);
        }

        handleLobbyResult(server, code, result);
      }

      removeClient(id);
    },
  },
});

console.log(`[server] Listening on ${server.hostname}:${server.port}`);

setInterval(() => {
  try {
    console.log(
      `[monitor] ${new Date().toLocaleTimeString()} - Lobbies: ${getLobbyCount()} | Clients: ${getClientCount()}`
    );
  } catch (err) {
    console.error("[monitor] Error collecting stats:", err);
  }
}, 5_000);

process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT received, shutting down gracefully");
  process.exit(0);
});

(globalThis as any).server = server;

export { server };