declare global {
  var wsClients: Map<string, WebSocketClient>;
}

export interface WebSocketClient extends WebSocket {
  id: string;
  code: string;
  role: "host" | "player";
}

if (!globalThis.wsClients) {
  globalThis.wsClients = new Map<string, WebSocketClient>();
}

export const createClient = (ws: WebSocket, id: string, code: string, role: "host" | "player"): WebSocketClient => {
  const client = Object.assign(ws, { id, code, role }) as WebSocketClient;
  globalThis.wsClients.set(id, client);
  console.log(`[quizpulse] ${role} client connected: ${id} - ${globalThis.wsClients.size} clients connected`);
  return client;
}

export const removeClient = (id: string): void => {
  globalThis.wsClients.delete(id);
  console.log(`[quizpulse] client disconnected: ${id} - ${globalThis.wsClients.size} clients connected`);
}

export const getClient = (id: string): WebSocketClient | undefined => {
  return globalThis.wsClients.get(id);
}

export const getClientCount = (): number => {
  return globalThis.wsClients.size;
}