import { quiz } from "@quizpot/quizcore/db/schema";
import { db } from "./db/index.ts";
import { createLobby, getLobby, updateLobby } from "./managers/lobby-manager.ts";
import { createClient, removeClient, getClient } from "./managers/ws-client-manager.ts";
import { eq } from "drizzle-orm";
import { generateName, type AllClientEvents, type LobbySettings, LobbyManager, type TargetedEvent, isQuestion, LobbyStatus } from "@quizpot/quizcore";
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

/**
 * Routes events from the LobbyManager to the actual WebSocket clients.
 */
function dispatchEvents(server: Server<WebSocketData>, lobbyCode: string, events: TargetedEvent[]) {
  const lobby = getLobby(lobbyCode);
  if (!lobby) return;

  for (const targetedEvent of events) {
    const { target, event } = targetedEvent;
    const message = JSON.stringify(event);

    if (target === "all") {
      server.publish(lobbyCode, message);
    } else if (target === "host") {
      getClient(lobby.hostId)?.send(message);
    } else if (target === "players") {
      lobby.players.forEach(p => getClient(p.id)?.send(message));
    } else if (Array.isArray(target)) {
      dispatchEvents(server, lobbyCode, target.map(t => ({ target: t, event })));
    } else if (target.clientId) {
      getClient(target.clientId)?.send(message);
    }
  }
}

/**
 * Centralized handler for LobbyManager results. 
 * Updates state, dispatches events, and schedules automatic transitions (timeouts) 
 * to replicate the logic from the old GameHandler.ts.
 */
function handleLobbyResult(server: Server<WebSocketData>, code: string, result: any) {
  if (!result) return;
  
  if (result.type === "ERROR") {
    return result;
  }

  const state = result.state || result.nextState;
  if (state) updateLobby(code, state);

  dispatchEvents(server, code, result.events);

  const currentLobby = getLobby(code);
  if (currentLobby && currentLobby.status === "answer") {
    const connectedPlayers = currentLobby.players.filter(p => p.isConnected);
    if (connectedPlayers.length > 0 && currentLobby.currentAnswers.length >= connectedPlayers.length) {
      handleLobbyResult(server, code, LobbyManager.setStatus(currentLobby, LobbyStatus.answers));
      return;
    }
  }

  if (gameTimers.has(code)) {
    clearTimeout(gameTimers.get(code));
    gameTimers.delete(code);
  }

  const lobby = getLobby(code);
  if (!lobby || !lobby.quiz) return;

  const currentQuestion = lobby.quiz.steps[lobby.currentStep];
  if (!currentQuestion) return;

  let timeout = 0;
  let nextStatus: LobbyStatus | null = null;

  if (isQuestion(currentQuestion)) {
    if (lobby.status === "question") {
      timeout = (currentQuestion.data.displayTime || 5) * 1000;
      nextStatus = LobbyStatus.answer;
    } else if (lobby.status === "answer") {
      timeout = (currentQuestion.data.timeLimit || 5) * 1000;
      nextStatus = LobbyStatus.answers;
    }
  } else if (lobby.status === "end") {
    timeout = 3000;
  }

  if (timeout > 0) {
    const timer = setTimeout(() => {
      const autoResult = (lobby.status === "end") 
        ? LobbyManager.delete(lobby, "Lobby ended")
        : nextStatus 
        ? LobbyManager.setStatus(lobby, nextStatus, (nextStatus === LobbyStatus.answer && isQuestion(currentQuestion)) ? currentQuestion.data.timeLimit : undefined)
        : LobbyManager.nextStep(lobby, lobby.hostId);
      handleLobbyResult(server, code, autoResult);
    }, timeout);
    gameTimers.set(code, timer);
  }
}

const server = Bun.serve<WebSocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/create-lobby") {
      try {
        const { id, quizId, settings } = (await req.json()) as {
          id: string;
          quizId: string;
          settings: LobbySettings;
        };

        const quizObj = await db.select().from(quiz).where(eq(quiz.id, quizId));
        const q = quizObj[0]?.quiz;

        if (!q) throw new Error("Quiz not found");

        const lobby = createLobby(id, q, settings);
        
        return Response.json({ code: lobby.code }, { status: 201 });
      } catch (err) {
        console.log("[quizpulse] Something went wrong: ", err);
        return new Response("Something went wrong...", { status: 500 });
      }
    }

    if (url.pathname === "/ws") {
      const id = url.searchParams.get("id");
      const code = url.searchParams.get("code");
      const role = url.searchParams.get("role") as "host" | "player";
      const name = url.searchParams.get("name") || generateName();

      if (!id || !code || !role) return new Response("Missing params", { status: 400 });
      
      const lobby = getLobby(code);
      if (!lobby) return new Response("Lobby not found", { status: 404 });

      if (role === "host" && lobby.hostId !== id) {
        return new Response("Unauthorized host ID", { status: 403 });
      }

      const upgraded = server.upgrade(req, {
        data: { id, code, role, name },
      });

      return upgraded 
        ? undefined 
        : new Response("Upgrade failed", { status: 500 });
    }

    return new Response("Quizpulse", { status: 200 });
  },

  websocket: {
    data: {} as WebSocketData,

    open(ws) {
      const { id, code, role, name } = ws.data;

      const existing = getClient(id);
      if (existing) {
        existing.close(1001, "Connected from another location");
        removeClient(id);
      }

      if (role === "host") {
        const timer = deletionTimers.get(code);
        if (timer) {
          clearTimeout(timer);
          deletionTimers.delete(code);
        }
      }

      ws.subscribe(code);
      
      createClient(ws as any, id, code, role);

      const lobby = getLobby(code);
      if (lobby) {
        const result = LobbyManager.join(lobby, id, name);
        if (result.type === "ERROR") ws.close(4003, result.message);
        else handleLobbyResult(server, code, result);
      }

      console.log(`[quizpulse] ${name} joined ${code} as ${role}`);
    },

    message(ws, message) {
      try {
        const payload: AllClientEvents = JSON.parse(typeof message === "string" ? message : message.toString());
        const { code, id } = ws.data;
        const lobby = getLobby(code);

        if (!lobby) return;

        let result: any;

        switch (payload.event) {
          case "SUBMIT_ANSWER":
            result = LobbyManager.submitAnswer(lobby, id, payload.payload.submission);
            break;
          case "START_LOBBY":
            result = LobbyManager.start(lobby, id);
            break;
          case "NEXT_STEP":
            result = LobbyManager.nextStep(lobby, id);
            break;
          case "KICK_PLAYER":
            result = LobbyManager.kick(lobby, id, payload.payload.playerId);
            break;
        }

        const outcome = handleLobbyResult(server, code, result);
        
        if (outcome?.type === "ERROR") {
          ws.send(JSON.stringify({ event: "ERROR", message: outcome.message }));
        }
      } catch (err) {
        console.error("Parse error", err);
      }
    },

    close(ws) {
      const { id, code, role } = ws.data;
      const lobby = getLobby(code);

      if (lobby) {
        const result = LobbyManager.disconnect(lobby, id);

        if (role === "host") {
          const timer = setTimeout(() => {
            const currentLobby = getLobby(code);

            if (currentLobby && !currentLobby.hostConnected) {
              const cleanup = LobbyManager.delete(currentLobby, "Host timed out");
              handleLobbyResult(server, code, cleanup);
            }

            deletionTimers.delete(code);
          }, 30000);
          
          deletionTimers.set(code, timer);
        }
        handleLobbyResult(server, code, result);
      }

      removeClient(id);
    },
  },
});

console.log(`[quizpulse] Listening on ${server.hostname}:${server.port}`);
