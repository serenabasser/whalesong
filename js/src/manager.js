import {
  BaseError,
  ManagerNotFound,
  CommandNotFound,
  StopMonitor,
  StopIterator
} from './errors.js';

export const ResultTypes = {
  ERROR: 'ERROR',
  FINAL: 'FINAL',
  PARTIAL: 'PARTIAL'
}

export class ResultManager {

  constructor() {
    this._results = [];
  }

  setResult(exId, type, params) {
    this._results.push({
      'exId': exId,
      'type': type,
      'params': params || {}
    });
  }

  setFinalResult(exId, params) {
    this.setResult(exId, ResultTypes.FINAL, params);
  }

  setPartialResult(exId, params) {
    this.setResult(exId, ResultTypes.PARTIAL, params);
  }

  setErrorResult(exId, params) {
    this.setResult(exId, ResultTypes.ERROR, params);
  }

  getResults() {
    let results = this._results;
    this._results = [];

    return results;
  }
}

export class Monitor {
  constructor(obj, evt) {
    this.obj = obj;
    this.evt = evt;
    this.promise = new Promise(resolve => this._resolveFunc = resolve);
  }

  mapEventResult(...args) {
    return {
      'args': args
    };
  }

  async monit(partialResult) {
    let self = this;

    function handler(...args) {
      let result = self.mapEventResult(...args);

      if (result) {
        partialResult(result);
      }
    }
    this.obj.on(this.evt, handler, this);
    await this.promise;
    this.obj.off(this.evt, handler, this);
    throw new StopMonitor();
  }

  stopMonitor() {
    this._resolveFunc();
  }
}


export class MonitorManager {
  constructor() {
    this.monitors = {};
  }

  addMonitor(exId, monitor) {
    this.monitors[exId] = monitor;
  }

  removeMonitor(exId) {
    if (!(exId in this.monitors)) {
      return false;
    }

    this.monitors[exId].stopMonitor();
    delete this.monitors[exId];
    return true;
  }
}


export class Iterator {

  constructor(fn) {
    this.fn = fn;
  }

  async iter(partialResult) {
    await Promise.resolve(this.fn((item) => partialResult({
      'item': item
    })));
    throw new StopIterator();
  }
}


export function command(target, name, descriptor) {
  target.commands = Object.assign({}, target.commands || {});
  target.commands[name] = {
    'type': 'command'
  };
  return descriptor;
}

export function monitor(target, name, descriptor) {
  target.commands = Object.assign({}, target.commands || {});
  target.commands[name] = {
    'type': 'monitor'
  };
  return descriptor;
}


export class CommandManager {

  constructor() {
    this.commands = this.commands || {};
    this.submanagers = {};
  }

  addSubmanager(name, manager) {
    this.submanagers[name] = manager;
  }

  @command
  async getSubmanagers() {
    let submanagers = {};

    for (let sm in this.submanagers) {
      submanagers[sm] = {
        'class': this.submanagers[sm].constructor.name
      }
    }

    return submanagers;
  }

  @command
  async removeSubmanager(name) {
    delete this.submanagers[name]
  }

  async executeCommand(command, params) {

    if (command.indexOf('.') >= 0) {
      let deco = command.split('.');
      let manager = deco.shift(),
        cmd = deco.join('.');
      if (!(manager in this.submanagers)) {
        throw new ManagerNotFound(manager);
      }

      return await this.submanagers[manager].executeCommand(cmd, params);
    }

    if (!(command in this.commands)) {
      throw new CommandNotFound(command);
    }

    return await this[command](params);
  }

  @command
  async getCommands() {
    let commands = Object.assign({}, this.commands);

    for (let sm in this.submanagers) {
      let subcommands = await this.submanagers[sm].getCommands();
      for (let cm in subcommands) {
        commands[sm + '.' + cm] = subcommands[cm];
      }
    }

    return commands;
  }
}

export default class MainManager extends CommandManager {

  constructor() {
    super();
    this.resultManager = new ResultManager();
    this.monitorManager = new MonitorManager(this.resultManager);
  }

  poll(newExecutions) {
    let errors = [];
    if (newExecutions) {
      for (let idx in newExecutions) {
        let executionsObj = newExecutions[idx];

        if (!executionsObj['exId']) {
          errors.push({
            'name': 'RequiredExecutionId',
            'message': 'Execuction ID is required',
            'executionsObj': executionsObj
          });

          continue;
        }

        if (!executionsObj['command']) {
          errors.push({
            'name': 'RequiredCommandName',
            'message': 'Command name is required',
            'executionsObj': executionsObj
          });
          continue;
        }
        this.executeCommand(executionsObj['exId'], executionsObj['command'], executionsObj['params'] || {});
      }
    }

    return {
      'results': this.resultManager.getResults(),
      'errors': errors
    }
  }

  async executeCommand(exId, command, params) {
    try {
      let result = await super.executeCommand(
        command,
        params
      );
      if (result instanceof Monitor) {
        this.monitorManager.addMonitor(exId, result);
        await result.monit(
          (partial) => this.resultManager.setPartialResult(exId, partial)
        );
      } else if (result instanceof Iterator) {
        await result.iter(
          (partial) => this.resultManager.setPartialResult(exId, partial)
        );
      }
      this.resultManager.setFinalResult(exId, result);
    } catch (err) {
      if ((err instanceof Error) || (err instanceof BaseError)) {
        this.resultManager.setErrorResult(exId, {
          'name': err.name,
          'message': err.message,
          'params': err.params || {}
        });
      } else {
        this.resultManager.setErrorResult(exId, {
          'err': err
        });
      }
    }
  }

  @command
  async stopMonitor({
    monitorId
  }) {
    return this.monitorManager.removeMonitor(monitorId);
  }
}