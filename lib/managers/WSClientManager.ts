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
  wsClients.set(id, client);
  return client;
}

export const removeClient = (id: string): void => {
  wsClients.delete(id);
}
