import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import chokidar from 'chokidar';

import { Logger, SimpleEventBus } from './TypeHelper';
import { SimpleServerPlugin } from '@board-bound/sdk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerPlugin = SimpleServerPlugin<any>;

export interface LoadedPlugin {
  file: string;
  plugin: ServerPlugin;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export class PluginManager {
  private readonly configDir = path.resolve(process.env.CONFIG_DIR || './config');
  private readonly pluginDir = path.resolve(process.env.PLUGIN_DIR || './plugins');
  private readonly watchedFiles = new Set<string>();
  private plugins: LoadedPlugin[] = [];

  constructor(
    private readonly log: Logger,
    private readonly bus: SimpleEventBus,
    private readonly serverVersion: string,
  ) {
    log.debug('Started plugin manager');
    if (!fs.existsSync(this.pluginDir)) fs.mkdirSync(this.pluginDir);
    log.debug('Plugin directory is ' + this.pluginDir);
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir);
    log.debug('Config directory is ' + this.configDir);
  }

  async unloadPlugin(plugin: string|LoadedPlugin) {
    const p = typeof plugin === 'string' ? this.plugins.find((x) => x.plugin.name === plugin) : plugin;
    if (!p) {
      this.log.warn(`Cannot unload plugin ${plugin} because it is not loaded`);
      return;
    }
    this.log.debug('Unloading plugin ' + p.plugin.name);
    if (p.enabled) await this.disablePlugin(p);
    this.plugins = this.plugins.filter((x) => x.plugin.name !== p.plugin.name);
    this.log.info({
      tag: 'plugin-unloaded',
      plugin: p.plugin.name,
    }, 'Unloaded plugin ' + p.plugin.name);
  }

  async reloadPlugin(plugin: string|LoadedPlugin) {
    const p = typeof plugin === 'string' ? this.plugins.find((x) => x.plugin.name === plugin) : plugin;
    if (!p) {
      this.log.warn(`Cannot reload plugin ${plugin} because it is not loaded`);
      return;
    }
    this.log.debug('Reloading plugin ' + p.plugin.name);
    this.unloadPlugin(p);
    await this.loadPlugin(p.file);
    await this.enablePlugin(p.plugin.name);
  }

  private watchFile(file: string) {
    if ((process.env.PLUGIN_WATCH || '').toLowerCase() !== 'true') return;
    if (this.watchedFiles.has(file)) return;
    this.watchedFiles.add(file);
    const watcher = chokidar.watch(file);
    let timeout: NodeJS.Timeout;
    watcher.on('change', async () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(async () => {
        this.log.info(`Plugin ${file} changed, reloading`);
        const p = this.plugins.find((x) => x.file === file);
        if (p) this.reloadPlugin(p);
        else this.loadPlugin(file);
      }, 2500);
    });
  }

  async loadPlugin(file: string) {
    if (!file.endsWith('.js') && !file.endsWith('.cjs')) {
      this.log.warn('Skipping ' + file + ' because it is not a .js or .cjs file');
    }
    this.log.debug('Loading plugin ' + file);
    this.watchFile(file);
    const plugin = (await import(file)).default.default as ServerPlugin;
    let invalid = false;
    for (const k of ['name', 'version', 'author', 'serverVersion']) {
      if (!plugin[k]) {
        this.log.error('Plugin ' + file + ' is missing ' + k);
        invalid = true;
      }
    }
    if (invalid) return;
    if (this.plugins.find((x) => x.plugin.name === plugin.name)) {
      this.log.warn('Plugin ' + plugin.name + ' is already loaded, are there duplicates?');
      return;
    }
    this.log.info({
      tag: 'plugin-loaded',
      plugin: plugin.name,
      version: plugin.version,
    }, 'Loaded plugin ' + plugin.name + ' v' + plugin.version + ' by ' + plugin.author);
    const configFile = path.join(this.configDir, plugin.name + '.json');
    let config = plugin.defaultConfig;
    if (fs.existsSync(configFile)) {
      try {
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        this.log.debug('Loaded config for ' + plugin.name);
      } catch (e: unknown) {
        this.log.warn('Failed to load config for ' + plugin.name);
        this.log.error(e);
      }
    } else if (config) {
      this.log.info('Writing default config for ' + plugin.name);
      fs.writeFileSync(configFile, JSON.stringify(plugin.defaultConfig, null, 2) + '\n');
    }
    this.plugins.push({ file, plugin, config, enabled: false });
  }

  async loadPlugins() {
    this.log.debug('Reading plugin directory');
    const files = fs.readdirSync(this.pluginDir).map((f) => path.join(this.pluginDir, f));
    files.push(...(process.env.PLUGIN_LOAD_DIRECT || '').split(',').map((f) => path.resolve(f)));
    this.log.info('Found ' + files.length + ' plugins');
    for (const f of files) {
      await this.loadPlugin(f);
    }
  }

  async enablePlugin(plugin: string|LoadedPlugin) {
    const p = typeof plugin === 'string' ? this.plugins.find((x) => x.plugin.name === plugin) : plugin;
    if (!p) {
      this.log.warn(`Cannot enable plugin ${plugin} because it is not loaded`);
      return;
    }
    if (p.enabled) {
      this.log.warn(`Plugin ${p.plugin.name} is already enabled`);
      return;
    }
    this.log.debug('Enabling plugin ' + p.plugin.name);
    if (this.serverVersion !== 'IN-DEV' && !semver.satisfies(this.serverVersion, p.plugin.serverVersion)) {
      this.log.warn('Plugin ' + p.plugin.name + ' requires server version ' + p.plugin.serverVersion);
      return;
    }
    let unmetDependencies = false;
    if (p.plugin.dependencies) for (const d of Object.keys(p.plugin.dependencies)) {
      const target = this.plugins.find((x) => x.plugin.name === d);
      const data = {
        tag: 'incompatible-dependency',
        plugin: p.plugin.name,
        required: d,
        requiredVersion: p.plugin.dependencies[d],
        targetVersion: (target ? target.plugin : {}).version,
      };
      if (!target) {
        this.log.warn(data, `Plugin ${data.plugin} requires ${data.required} but it is not loaded`);
        unmetDependencies = true;
        continue;
      }
      if (!semver.satisfies(target.plugin.version, p.plugin.dependencies[d])) {
        this.log.warn(data, `Plugin ${data.plugin} requires ${data.required} ${data.requiredVersion} but ${data.targetVersion} is loaded`);
        unmetDependencies = true;
        continue;
      }
      if (!target.enabled) {
        this.log.warn(data, `Plugin ${data.plugin} requires ${data.required} but it is not enabled`);
        unmetDependencies = true;
        continue;
      }
    }
    if (unmetDependencies) return;
    for (const e of p.plugin.events) this.bus.on(e.eventName, e.listener, e.priority);
    if (p.plugin.onEnable) await p.plugin.onEnable(p.config, this.bus, this.log.child({ plugin: p.plugin.name }));
    this.plugins = this.plugins.map((x) => x.file === p.file ? { ...x, enabled: true } : x);
    this.log.info({
      tag: 'plugin-enabled',
      plugin: p.plugin.name,
    }, `Enabled plugin ${p.plugin.name} successfully`);
  }

  async enablePlugins() {
    const plugins = Array.of(...this.plugins).sort((a, b) => {
      if (a.plugin.dependencies && a.plugin.dependencies[b.plugin.name]) return -1;
      if (b.plugin.dependencies && b.plugin.dependencies[a.plugin.name]) return 1;
      return 0;
    });
    for (const p of plugins) {
      if (p.enabled) continue;
      await this.enablePlugin(p);
    }
  }

  async disablePlugin(plugin: string|LoadedPlugin) {
    const p = typeof plugin === 'string' ? this.plugins.find((x) => x.plugin.name === plugin) : plugin;
    if (!p) {
      this.log.warn(`Cannot disable plugin ${plugin} because it is not loaded`);
      return;
    }
    if (!p.enabled) {
      this.log.warn(`Plugin ${p.plugin.name} is already disabled`);
      return;
    }
    this.log.debug('Disabling plugin ' + p.plugin.name);
    for (const e of p.plugin.events) this.bus.off(e.eventName, e.listener);
    if (p.plugin.onDisable) await p.plugin.onDisable(this.bus, this.log.child({ plugin: p.plugin.name }));
    this.plugins = this.plugins.map((x) => x.file === p.file ? { ...x, enabled: false } : x);
    this.log.info({
      tag: 'plugin-disabled',
      plugin: p.plugin.name,
    }, 'Disabled plugin ' + p.plugin.name);
  }

  async disablePlugins() {
    const plugins = Array.of(...this.plugins).reverse();
    for (const p of plugins) {
      if (!p.enabled) continue;
      await this.disablePlugin(p);
    }
  }
}
