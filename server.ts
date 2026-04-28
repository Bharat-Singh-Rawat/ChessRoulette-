import { createServer } from "http";
import next from "next";
import { Server as IOServer } from "socket.io";
import { getToken } from "next-auth/jwt";
import { handleConnection } from "./lib/games";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "localhost";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));

  const io = new IOServer(httpServer, {
    path: "/api/socket",
    cors: { origin: false },
  });

  io.use(async (socket, next) => {
    try {
      // Adapt Node IncomingMessage headers to the Request-shape getToken wants.
      const headersRecord: Record<string, string> = {};
      for (const [k, v] of Object.entries(socket.request.headers)) {
        if (typeof v === "string") headersRecord[k] = v;
        else if (Array.isArray(v)) headersRecord[k] = v.join(", ");
      }
      const token = await getToken({
        req: { headers: headersRecord },
        secret: process.env.AUTH_SECRET,
        salt: "authjs.session-token",
        secureCookie: false,
      });
      if (!token?.id) return next(new Error("unauthorized"));
      socket.data.user = {
        id: token.id as string,
        username: (token.username as string | undefined) ?? "player",
      };
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", (socket) => handleConnection(io, socket));

  httpServer.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
