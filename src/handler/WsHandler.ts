import type { Application } from "express-ws";
import type { WebSocket } from "ws";
import { GameServer } from "..";
import { SimpleEventBus } from "../TypeHelper";
import { LOGO } from "../tools/LogoProvider";

import { ConnectedUser, ModifiableData } from "@board-bound/sdk";

export class WsConnectedUser extends ConnectedUser {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly ip: string,
    private readonly server: GameServer,
    private readonly ws: WebSocket,
    private readonly bus: SimpleEventBus,
  ) {
    super(id, name, ip);
  }

  async sendMessage(message: Record<string, unknown>): Promise<void> {
    const data = new ModifiableData(message);
    const res = await this.bus.emit('serverUserRawOutput', this.server, { user: this, message: data });
    if (!res) return;
    this.server.getLogger().debug({ tag: 'ws-send', message: data.get(), id: this.id, ip: this.ip }, 'Sending message to user');
    this.ws.send(JSON.stringify(data.get()));
  }

  async disconnect(message: string, code?: number): Promise<void> {
    const msg = code ? { error: message, code } : { message };
    this.sendMessage(msg);
    this.ws.close(code ? 1008 : 1000);
    await this.bus.emit('serverUserDisconnect', this.server, { user: this, message, code });
  }
}

export function installWsHandler(app: Application, server: GameServer, bus: SimpleEventBus) {
  const maxConnectionsPerIp = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '10') || 10;
  const maxConnectionsDifIp = parseInt(process.env.MAX_CONNECTIONS_DIF_IP || '100') || 100;
  const connections = new Map<string, number>();
  app.ws("/play", async (ws, req) => {
    const ip = req.socket.remoteAddress;
    const id = server.getUuid();
    const log = server.getLogger().child({tag: 'ws', ip, id});
    const send = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));

    if (connections.has(ip)) {
      const count = connections.get(ip) + 1;
      if (count > maxConnectionsPerIp) {
        log.warn('Too many connections from this IP');
        send({error: 'Too many connections from this IP', code: 429});
        ws.close(1008);
        return;
      }
      connections.set(ip, count);
    } else {
      if (connections.size > maxConnectionsDifIp) {
        log.warn('Too many different IPs connected');
        send({error: 'Too many different IPs connected', code: 429});
        ws.close(1008);
        return;
      }
      connections.set(ip, 1);
    }

    log.info('Received connection, awaiting login payload');
    const loginTimeout = setTimeout(() => {
      log.warn('Login timeout reached, closing connection');
      send({ error: 'Login timeout reached', code: 408 });
      ws.close(1008);
    }, 5000);
    let loggedIn = false;

    // We send the logo to the client to display it.
    // This is simple way to ensure the server protocol isn't
    // reverse-engineered to publish it with a different license,
    // as the logo is a trademark and copyrighted.
    // Don't tamper with the logo, or clients will refuse to connect.
    send({ message: 'Please login', code: 401, logo: LOGO });

    ws.on('close', async () => {
      const user = server.getConnectedUsers().find(u => u.id === id);
      if (user) server.removeConnectedUser(user);
      if (!loggedIn) clearTimeout(loginTimeout);
      const count = connections.get(ip) - 1;
      if (count <= 0) connections.delete(ip);
      else connections.set(ip, count);
      log.info('Websocket connection closed');
    });

    ws.on('message', async (msg) => {
      log.debug({ tag: 'ws-message', message: msg }, 'Received message from client');
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(msg.toString());
      } catch {
        log.warn('Invalid JSON payload received');
        send({ error: 'Invalid JSON payload', code: 400 });
        return;
      }
      if (!loggedIn) {
        clearTimeout(loginTimeout);
        const name = new ModifiableData<string>('');
        loggedIn = await bus.emit('serverUserPreConnect', server, {
          ip: req.socket.remoteAddress,
          headers: req.headers as Record<string, string|string[]>,
          payload,
          name,
        });
        if (!loggedIn) {
          log.warn('Preconnect event canceled connection');
          send({ error: 'Connection denied', code: 403 });
          ws.close(1008);
        } else {
          send({ message: 'Connected', code: 200 });
          const user = new WsConnectedUser(id, name.get(), ip, server, ws, bus);
          server.addConnectedUser(user);
          await bus.emit('serverUserConnect', server, user);
          log.info('User connected successfully');
        }
        return;
      }
      const user = server.getConnectedUsers().find(u => u.id === id);
      const result = await bus.emit('serverUserRawInput', server, {user, payload});
      if (!result) send({error: 'Invalid input', code: 400});
    });
  });
}
