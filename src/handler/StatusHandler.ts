import type { Application } from 'express-ws'
import { GameServer } from '..'
import { SimpleEventBus } from '../TypeHelper'
import { ModifiableData } from '@board-bound/sdk'

export function installStatusHandler(
  app: Application,
  server: GameServer,
  bus: SimpleEventBus
) {
  app.get('/status', async (req, res) => {
    server.getLogger().info('Status check from ' + req.ip)
    const response = new ModifiableData({ status: 'ok' })
    const success = await bus.emit('serverStatusRequest', server, {
      ip: req.ip,
      response,
    })
    if (!success) res.status(560).json({ error: 'Request canceled' })
    else res.json(response.get())
  })
}
