import * as net from 'net'
import { Logger } from '../TypeHelper'

export async function isPortFree(port: number) {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', (err) => {
      if (err.message.includes('EADDRINUSE')) {
        resolve(false)
      } else {
        reject(err)
      }
    })
    server.listen(port, 'localhost', () => {
      server.close(() => {
        resolve(true)
      })
    })
  })
}

export async function findFreePort(log: Logger) {
  if (process.env.PORT) return parseInt(process.env.PORT) || 3000
  const range = [20_000, 30_000]
  let port = 0
  let counter = 0
  do {
    counter++
    if (counter > 50) throw new Error('Could not find a free port')
    port = Math.floor(Math.random() * (range[1] - range[0])) + range[0]
    log.debug('Trying port ' + port)
  } while (!(await isPortFree(port)))
  return port
}
