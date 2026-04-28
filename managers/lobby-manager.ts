import { LobbyManager, type Lobby, type LobbySettings, type Quiz } from "@quizpot/quizcore";
import { dispatchEvents } from "..";

declare global {
  var lobbies: Map<string, Lobby>;
  var lobbyTimers: Map<string, ReturnType<typeof setTimeout>>;
}

if (!globalThis.lobbies) globalThis.lobbies = new Map<string, Lobby>();
if (!globalThis.lobbyTimers) globalThis.lobbyTimers = new Map<string, ReturnType<typeof setTimeout>>();

const HOST_CONNECT_TIMEOUT_MS = 60 * 1000;

export const getLobby = (code: string): Lobby | undefined => {
  return lobbies.get(code);
};

export const updateLobby = (code: string, state: Lobby): void => {
  lobbies.set(code, state);
};

export const deleteLobby = (code: string): void => {
  cancelHostTimeout(code);
  lobbies.delete(code);
};

export const getLobbyCount = (): number => {
  return lobbies.size;
};

export const createLobby = (host: string, quiz: Quiz, settings: LobbySettings): Lobby => {
  let code = LobbyManager.generateCode();
  let attempts = 0;
  const maxAttempts = 20;

  while (lobbies.has(code)) {
    code = LobbyManager.generateCode();
    if (++attempts >= maxAttempts) {
      throw new Error(
        `Server busy: Could not generate a unique lobby code after ${maxAttempts} attempts.`
      );
    }
  }

  const lobby = LobbyManager.create(code, host, quiz, settings);
  lobbies.set(code, lobby);

  // If the host never connects within 60s, clean up the lobby automatically.
  scheduleHostTimeout(code);

  return lobby;
};

/**
 * Called when the host WebSocket connects. Cancels the initial connect timeout
 * so the lobby isn't deleted out from under an active host.
 */
export const onHostConnected = (code: string): void => {
  cancelHostTimeout(code);
};

export const cancelHostTimeout = (code: string): void => {
  const timer = lobbyTimers.get(code);
  if (timer !== undefined) {
    clearTimeout(timer);
    lobbyTimers.delete(code);
  }
};

const scheduleHostTimeout = (code: string): void => {
  cancelHostTimeout(code);
  const timer = setTimeout(() => {
    const lobby = lobbies.get(code);
    if (!lobby) return;

    const res = LobbyManager.delete(lobby, 'Host disconnected');
    
    // Access the server from globalThis
    const serverInstance = (globalThis as any).server;
    
    if (serverInstance) {
      res.events.forEach(event => dispatchEvents(serverInstance, code, [event]));
    } else {
      console.warn("[lobby-manager] Could not dispatch timeout: server instance not found");
    }

    lobbies.delete(code);
    lobbyTimers.delete(code);
    console.log(`[lobby-manager] Lobby ${code} expired (host never connected)`);
  }, HOST_CONNECT_TIMEOUT_MS);
  
  lobbyTimers.set(code, timer);
};