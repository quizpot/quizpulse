import { Lobby, LobbyActions, QuizFile, LobbySettings } from "@quizpot/quizcore";

declare global {
  var lobbies: Map<string, Lobby>;
}

if (!globalThis.lobbies) {
  globalThis.lobbies = new Map<string, Lobby>();
}

export const getLobby = (code: string): Lobby | undefined => {
  return lobbies.get(code);
}

export const createLobby = (host: string, quiz: QuizFile, settings: LobbySettings): Lobby => {
  let code: string = LobbyActions.generateCode();
  let attempts: number = 0;
  const maxAttempts: number = 20;

  while (lobbies.has(code)) {
    code = LobbyActions.generateCode();
    attempts++;

    if (attempts >= maxAttempts) {
      throw new Error(`Server busy: Could not generate a unique lobby code after ${maxAttempts} attempts.`);
    }
  }

  const lobby = LobbyActions.create(code, host, quiz, settings);
  lobbies.set(code, lobby);
  return lobby;
}