import express from 'express';
import expressWs from 'express-ws';
import semver from 'semver';
import pino from 'pino';
import axios from 'axios';

import { ServerBase, BaseGameState, BaseGameStateTypes } from '@board-bound/sdk';
import { v4 as uuidV4 } from 'uuid';

import { version as pVersion } from '../package.json';

import { getNewEventBus } from './TypeHelper';
import { findFreePort } from './tools/PortFinder';
import { installStatusHandler } from './handler/StatusHandler';
import { installWsHandler } from './handler/WsHandler';
import { PluginManager } from './PluginManager';
import { getLocalIPAddress, getAllLocalIPAddresses, getPublicIPAddress } from './tools/IpFinder';

export class GameServer extends ServerBase<BaseGameState<BaseGameStateTypes>> {
  readonly version = pVersion;
  private readonly ws = expressWs(express());
  private readonly bus = getNewEventBus();
  private readonly plugins: PluginManager;
  protected readonly logger = pino();
  protected readonly uuid = uuidV4;
  protected readonly semver = semver;
  protected readonly axios = axios;

  constructor() {
    super();
    this.logger.level = process.env.LOG_LEVEL || 'info';
    this.logger.info('Starting server with version ' + this.version);
    this.plugins = new PluginManager(this.logger, this.bus, this.version);
    this.start();
  }

  async start() {
    await this.plugins.loadPlugins();
    await this.plugins.enablePlugins();
    this.logger.debug('Installing status handler');
    installStatusHandler(this.ws.app, this, this.bus);
    this.logger.debug('Installing ws handler');
    installWsHandler(this.ws.app, this, this.bus);
    this.logger.debug('Finding free port');
    const port = await findFreePort(this.logger);
    this.logger.debug('Starting server on port ' + port);
    this.ws.app.listen(port, '0.0.0.0', async () => {
      const ips = getAllLocalIPAddresses();
      const publicIp = await getPublicIPAddress();
      const localIp = getLocalIPAddress();
      const data = { ips, localIp, publicIp, port };
      this.logger.info(`Server listening on port ${port}`);
      this.logger.debug(data, 'IP information');
      this.bus.emit('serverAcceptingConnections', this, data);
    });
  }

  async setGameState(gameState: BaseGameState<BaseGameStateTypes>): Promise<void> {
    super.setGameState(gameState);
    await this.bus.emit('serverGameStateUpdate', this, null);
  }
}

new GameServer();
