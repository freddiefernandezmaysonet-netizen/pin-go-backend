import { Router } from "express";

export const eventsRouter = Router();

const clients: any[] = [];

eventsRouter.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const clientId = Date.now();
  const client = { id: clientId, res };

  clients.push(client);

  req.on("close", () => {
    const index = clients.findIndex(c => c.id === clientId);
    if (index !== -1) clients.splice(index, 1);
  });
});

export function broadcastEvent(event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    client.res.write(data);
  }
}