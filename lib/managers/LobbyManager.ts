import { Lobby, LobbyActions, QuizFile, LobbySettings } from "@quizpot/quizcore";

declare global {
  var lobbies: Map<string, Lobby>;
  var lobbyTimers: Map<string, ReturnType<typeof setTimeout>>;
}

if (!globalThis.lobbies) globalThis.lobbies = new Map<string, Lobby>();
if (!globalThis.lobbyTimers) globalThis.lobbyTimers = new Map<string, ReturnType<typeof setTimeout>>();

const HOST_CONNECT_TIMEOUT_MS = 60 * 1000;

export const getLobby = (code: string): Lobby | undefined => {
  return lobbies.get(code);
}

export const createLobby = (host: string, quiz: QuizFile, settings: LobbySettings): Lobby => {
  let code = LobbyActions.generateCode();
  let attempts = 0;
  const maxAttempts = 20;

  while (lobbies.has(code)) {
    code = LobbyActions.generateCode();
    if (++attempts >= maxAttempts) {
      throw new Error(`Server busy: Could not generate a unique lobby code after ${maxAttempts} attempts.`);
    }
  }

  const lobby = LobbyActions.create(code, host, quiz, settings);
  lobbies.set(code, lobby);
  scheduleHostTimeout(code);
  return lobby;
}

export const cancelHostTimeout = (code: string): void => {
  const timer = lobbyTimers.get(code);
  if (timer !== undefined) {
    clearTimeout(timer);
    lobbyTimers.delete(code);
  }
}

const scheduleHostTimeout = (code: string): void => {
  cancelHostTimeout(code);
  const timer = setTimeout(() => {
    lobbies.delete(code);
    lobbyTimers.delete(code);
  }, HOST_CONNECT_TIMEOUT_MS);
  lobbyTimers.set(code, timer);
}