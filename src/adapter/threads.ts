// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as debug from 'debug';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as errors from './errors';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import * as eventUtils from '../utils/eventUtils';
import * as urlUtils from '../utils/urlUtils';
import { CustomBreakpointId, customBreakpoints } from './customBreakpoints';
import * as messageFormat from './messageFormat';
import * as objectPreview from './objectPreview';
import { Location, Source, SourceContainer, InlineScriptOffset, SourcePathResolver } from './sources';
import { StackFrame, StackTrace } from './stackTrace';
import { VariableStore, VariableStoreDelegate } from './variables';

const localize = nls.loadMessageBundle();
const debugThread = debug('thread');

export type PausedReason = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint';

export interface PausedDetails {
  reason: PausedReason;
  description: string;
  stackTrace: StackTrace;
  text?: string;
  exception?: Cdp.Runtime.RemoteObject;
}

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export interface ExecutionContextTree {
  contextId?: number;
  name: string;
  threadId: number;
  children: ExecutionContextTree[];
}

export type Script = { scriptId: string, source: Source, thread: Thread };

let lastThreadId = 0;

export interface ThreadConfiguration {
  supportsCustomBreakpoints?: boolean;
  defaultScriptOffset?: InlineScriptOffset;
}

export interface ThreadManagerDelegate {
  executionContextForest(): ExecutionContextTree[] | undefined;
}

export type ScriptWithSourceMapHandler = (script: Script, sources: Source[]) => Promise<void>;

export class ThreadManager {
  private _pauseOnExceptionsState: PauseOnExceptionsState;
  private _customBreakpoints: Set<string>;
  private _threads: Map<number, Thread> = new Map();
  private _dap: Dap.Api;

  _onThreadAddedEmitter = new vscode.EventEmitter<Thread>();
  private _onThreadRemovedEmitter = new vscode.EventEmitter<Thread>();
  private _onExecutionContextsChangedEmitter = new vscode.EventEmitter<ExecutionContextTree[]>();
  readonly onThreadAdded = this._onThreadAddedEmitter.event;
  readonly onThreadRemoved = this._onThreadRemovedEmitter.event;
  readonly onExecutionContextsChanged = this._onExecutionContextsChangedEmitter.event;
  readonly sourceContainer: SourceContainer;
  _sourcePathResolver: SourcePathResolver;
  private _delegate: ThreadManagerDelegate;
  private _defaultDelegate: DefaultThreadManagerDelegate;
  _scriptWithSourceMapHandler?: ScriptWithSourceMapHandler;
  _consoleIsDirty = false;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver, sourceContainer: SourceContainer) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
    this._pauseOnExceptionsState = 'none';
    this._customBreakpoints = new Set();
    this.sourceContainer = sourceContainer;
    this._defaultDelegate = new DefaultThreadManagerDelegate(this);
    this._delegate = this._defaultDelegate;
  }

  mainThread(): Thread | undefined {
    return this._threads.values().next().value;
  }

  createThread(cdp: Cdp.Api, parent: Thread | undefined, configuration: ThreadConfiguration): Thread {
    return new Thread(this, cdp, this._dap, parent, configuration);
  }

  setDelegate(delegate: ThreadManagerDelegate) {
    this._delegate = delegate;
  }

  setScriptSourceMapHandler(handler?: ScriptWithSourceMapHandler) {
    this._scriptWithSourceMapHandler = handler;
  }

  _addThread(thread: Thread) {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
  }

  _removeThread(threadId: number) {
    const thread = this._threads.get(threadId);
    console.assert(thread);
    this._threads.delete(threadId);
    this._onThreadRemovedEmitter.fire(thread);
  }

  refreshExecutionContexts() {
    this._onExecutionContextsChangedEmitter.fire(this._delegate.executionContextForest() || this._defaultDelegate.executionContextForest());
  }

  refreshStackTraces(): boolean {
    let refreshed = false;
    for (const thread of this.threads()) {
      if (thread.pausedDetails()) {
        thread._reportResumed();
        thread._reportPaused();
        refreshed = true;
      }
    }
    return refreshed;
  }

  threads(): Thread[] {
    return Array.from(this._threads.values());
  }

  topLevelThreads(): Thread[] {
    return this.threads().filter(t => !t.parentThread);
  }

  threadLabels(): Dap.Thread[] {
    const result: Dap.Thread[] = [];
    const visit = (thread: Thread, indentation: string) => {
      result.push({
        id: thread.threadId(),
        name: indentation + thread.name()
      });
      for (const child of thread._childThreads)
        visit(child, indentation + '\u00A0\u00A0\u00A0\u00A0');
    };
    this.topLevelThreads().forEach(t => visit(t, ''));
    return result;
  }

  thread(threadId: number): Thread | undefined {
    return this._threads.get(threadId);
  }

  pauseOnExceptionsState(): PauseOnExceptionsState {
    return this._pauseOnExceptionsState;
  }

  async setPauseOnExceptionsState(state: PauseOnExceptionsState): Promise<void> {
    this._pauseOnExceptionsState = state;
    const promises: Promise<boolean>[] = [];
    for (const thread of this._threads.values())
      promises.push(thread._updatePauseOnExceptionsState());
    await Promise.all(promises);
  }

  async enableCustomBreakpoints(ids: CustomBreakpointId[]): Promise<void> {
    const promises: Promise<boolean>[] = [];
    for (const id of ids) {
      this._customBreakpoints.add(id);
      for (const thread of this._threads.values())
        promises.push(thread.updateCustomBreakpoint(id, true));
    }
    await Promise.all(promises);
  }

  async disableCustomBreakpoints(ids: CustomBreakpointId[]): Promise<void> {
    const promises: Promise<boolean>[] = [];
    for (const id of ids) {
      this._customBreakpoints.add(id);
      for (const thread of this._threads.values())
        promises.push(thread.updateCustomBreakpoint(id, false));
    }
    await Promise.all(promises);
  }

  customBreakpoints(): Set<string> {
    return this._customBreakpoints;
  }

  scriptsFromSource(source: Source): Set<Script> {
    return source[kScriptsSymbol] || new Set();
  }
}

export class Thread implements VariableStoreDelegate {
  private _dap: Dap.Api;
  private _cdp: Cdp.Api;
  private _threadId: number;
  private _name: string;
  private _threadBaseUrl: string;
  private _pausedDetails?: PausedDetails;
  private _pausedVariables?: VariableStore;
  private _pausedForSourceMapScriptId?: string;
  private _scripts: Map<string, Script> = new Map();
  private _supportsCustomBreakpoints: boolean;
  private _defaultScriptOffset?: InlineScriptOffset;
  private _executionContexts: Map<number, Cdp.Runtime.ExecutionContextDescription> = new Map();
  readonly replVariables: VariableStore;
  readonly manager: ThreadManager;
  readonly sourceContainer: SourceContainer;
  private _eventListeners: eventUtils.Listener[] = [];
  parentThread?: Thread;
  _childThreads: Thread[] = [];
  private _supportsSourceMapPause = false;
  private _serializedOutput: Promise<void>;

  constructor(manager: ThreadManager, cdp: Cdp.Api, dap: Dap.Api, parent: Thread | undefined, configuration: ThreadConfiguration) {
    this.manager = manager;
    this.sourceContainer = manager.sourceContainer;
    this._cdp = cdp;
    this._dap = dap;
    this.parentThread = parent;
    if (parent)
      parent._childThreads.push(this);
    this._threadId = ++lastThreadId;
    this._name = '';
    this._supportsCustomBreakpoints = configuration.supportsCustomBreakpoints || false;
    this._defaultScriptOffset = configuration.defaultScriptOffset;
    this.replVariables = new VariableStore(this._cdp, this);
    this.manager._addThread(this);
    this._serializedOutput = Promise.resolve();
    debugThread(`Thread created #${this._threadId}`);
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  threadId(): number {
    return this._threadId;
  }

  name(): string {
    return this._name;
  }

  childThreads(): Thread[] {
    return this._childThreads.slice();
  }

  pausedDetails(): PausedDetails | undefined {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | undefined {
    return this._pausedVariables;
  }

  executionContexts(): Cdp.Runtime.ExecutionContextDescription[] {
    return Array.from(this._executionContexts.values());
  }

  defaultExecutionContext(): Cdp.Runtime.ExecutionContextDescription | undefined {
    for (const context of this._executionContexts.values()) {
      if (context.auxData && context.auxData['isDefault'])
        return context;
    }
  }

  supportsSourceMapPause() {
    return this._supportsSourceMapPause;
  }

  async resume(): Promise<boolean> {
    return !!await this._cdp.Debugger.resume({});
  }

  async pause(): Promise<boolean> {
    return !!await this._cdp.Debugger.pause({});
  }

  async stepOver(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOver({});
  }

  async stepInto(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepInto({});
  }

  async stepOut(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOut({});
  }

  async restartFrame(stackFrame: StackFrame): Promise<boolean> {
    const callFrameId = stackFrame.callFrameId();
    if (!callFrameId)
      return false;
    const response = await this._cdp.Debugger.restartFrame({ callFrameId });
    if (!response || !this._pausedDetails)
      return false;
    this._pausedDetails.stackTrace = StackTrace.fromDebugger(this, response.callFrames, response.asyncStackTrace, response.asyncStackTraceId);
    return true;
  }

  initialize() {
    this._cdp.Runtime.on('executionContextCreated', event => {
      this._executionContextCreated(event.context);
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      this._executionContextDestroyed(event.executionContextId);
    });
    this._cdp.Runtime.on('executionContextsCleared', () => {
      this.replVariables.clear();
      this._executionContextsCleared();
      const slot = this.claimOutputSlot();
      slot(this._clearDebuggerConsole());
    });
    this._cdp.Runtime.on('consoleAPICalled', async event => {
      const slot = this.claimOutputSlot();
      slot(await this._onConsoleMessage(event));
    });
    this._cdp.Runtime.on('exceptionThrown', async event => {
      const slot = this.claimOutputSlot();
      slot(await this.formatException(event.exceptionDetails));
    });
    this._cdp.Runtime.on('inspectRequested', event => {
      if (event.hints['copyToClipboard'])
        this._copyObjectToClipboard(event.object);
      else if (event.hints['queryObjects'])
        this._queryObjects(event.object);
      else
        this._revealObject(event.object);
    });
    this._cdp.Runtime.enable({});

    this._cdp.Debugger.on('paused', event => {
      if (event.reason === 'instrumentation' && event.data && event.data['scriptId']) {
        this._handleSourceMapPause(event.data['scriptId'] as string);
        return;
      }
      this._pausedDetails = this._createPausedDetails(event);
      this._pausedVariables = new VariableStore(this._cdp, this);
      this._reportPaused();
    });
    this._cdp.Debugger.on('resumed', () => this._onResumed());

    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));

    this._cdp.Debugger.enable({});
    this._cdp.Debugger.setAsyncCallStackDepth({ maxDepth: 32 });
    if (this.manager.sourceContainer.sourceMapTimeouts().scriptPaused) {
      this._cdp.Debugger.setInstrumentationBreakpoint({ instrumentation: 'beforeScriptWithSourceMapExecution' }).then(result => {
        this._supportsSourceMapPause = !!result;
      });
    }
    this._updatePauseOnExceptionsState();

    for (const id of this.manager.customBreakpoints())
      this.updateCustomBreakpoint(id, true);

    this.manager._onThreadAddedEmitter.fire(this);
    this._dap.thread({ reason: 'started', threadId: this._threadId });
  }

  claimOutputSlot(): (payload?: Dap.OutputEventParams) => void {
    const slot = this._serializedOutput;
    let callback: () => void;
    const result = async (payload?: Dap.OutputEventParams) => {
      await slot;
      if (payload) {
        const isClearConsole = payload.output === '\x1b[2J';
        const noop = isClearConsole && !this.manager._consoleIsDirty;
        if (!noop) {
          this._dap.output(payload);
          this.manager._consoleIsDirty = !isClearConsole;
        }
      }
      callback();
    };
    const p = new Promise<void>(f => callback = f);
    this._serializedOutput = slot.then(() => p);
    // Timeout to avoid blocking future slots if this one does stall.
    setTimeout(callback!, this.manager.sourceContainer.sourceMapTimeouts().output);
    return result;
  }

  _executionContextCreated(context: Cdp.Runtime.ExecutionContextDescription) {
    this._executionContexts.set(context.id, context);
    this.manager.refreshExecutionContexts();
  }

  _executionContextDestroyed(contextId: number) {
    const context = this._executionContexts.get(contextId);
    if (!context)
      return;
    this._executionContexts.delete(contextId);
    this.manager.refreshExecutionContexts();
  }

  _executionContextsCleared() {
    this._removeAllScripts();
    if (this._pausedDetails)
      this._onResumed();
    this._executionContexts.clear();
    this.manager.refreshExecutionContexts();
  }

  _onResumed() {
    this._pausedDetails = undefined;
    this._pausedVariables = undefined;
    this._reportResumed();
  }

  dispose() {
    if (this.parentThread) {
      this.parentThread._childThreads.splice(this.parentThread._childThreads.indexOf(this), 1);
      this.parentThread._childThreads.push(...this._childThreads);
    }
    this._removeAllScripts();
    this.manager._removeThread(this._threadId);
    this._dap.thread({ reason: 'exited', threadId: this._threadId });
    eventUtils.removeEventListeners(this._eventListeners);
    this._executionContextsCleared();
    debugThread(`Thread destroyed #${this._threadId}: ${this._name}`);
  }

  setName(name: string) {
    this._name = name;
  }

  setBaseUrl(threadUrl: string) {
    this._threadBaseUrl = threadUrl;
  }

  rawLocationToUiLocation(rawLocation: { lineNumber: number, columnNumber?: number, url?: string, scriptId?: Cdp.Runtime.ScriptId }): Promise<Location> {
    const script = rawLocation.scriptId ? this._scripts.get(rawLocation.scriptId) : undefined;
    let {lineNumber, columnNumber} = rawLocation;
    columnNumber = columnNumber || 0;
    if (this._defaultScriptOffset) {
      lineNumber -= this._defaultScriptOffset.lineOffset;
      if (!lineNumber)
        columnNumber = Math.max(columnNumber - this._defaultScriptOffset.columnOffset, 0);
    }
    return this.sourceContainer.preferredLocation({
      url: script ? script.source.url() : (rawLocation.url || ''),
      lineNumber: lineNumber + 1,
      columnNumber: columnNumber + 1,
      source: script ? script.source : undefined
    });
  }

  async renderDebuggerLocation(loc: Cdp.Debugger.Location): Promise<string> {
    const location = await this.rawLocationToUiLocation(loc);
    const name = (location.source && await location.source.prettyName()) || location.url;
    return `@ ${name}:${location.lineNumber}`;
  }

  async _updatePauseOnExceptionsState(): Promise<boolean> {
    return !!await this._cdp.Debugger.setPauseOnExceptions({ state: this.manager.pauseOnExceptionsState() });
  }

  async updateCustomBreakpoint(id: CustomBreakpointId, enabled: boolean): Promise<boolean> {
    // Do not fail for custom breakpoints, to account for
    // future changes in cdp vs stale breakpoints saved in the workspace.
    if (!this._supportsCustomBreakpoints)
      return true;
    const breakpoint = customBreakpoints().get(id);
    if (!breakpoint)
      return true;
    breakpoint.apply(this._cdp, enabled);
    return true;
  }

  _reportResumed() {
    this._dap.continued({ threadId: this._threadId, allThreadsContinued: false });
  }

  _reportPaused(preserveFocusHint?: boolean) {
    const details = this._pausedDetails!;
    this._dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this._threadId,
      text: details.text,
      preserveFocusHint,
      allThreadsStopped: false
    });
  }

  _createPausedDetails(event: Cdp.Debugger.PausedEvent): PausedDetails {
    const stackTrace = StackTrace.fromDebugger(this, event.callFrames, event.asyncStackTrace, event.asyncStackTraceId);
    switch (event.reason) {
      case 'assert': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.assert', 'Paused on assert')
      };
      case 'debugCommand': return {
        stackTrace,
        reason: 'pause',
        description: localize('pause.debugCommand', 'Paused on debug() call')
      };
      case 'DOM': return {
        stackTrace,
        reason: 'data breakpoint',
        description: localize('pause.DomBreakpoint', 'Paused on DOM breakpoint')
      };
      case 'EventListener': return this._resolveEventListenerBreakpointDetails(stackTrace, event);
      case 'exception': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.exception', 'Paused on exception'),
        exception: event.data as (Cdp.Runtime.RemoteObject | undefined)
      };
      case 'promiseRejection': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.promiseRejection', 'Paused on promise rejection')
      };
      case 'instrumentation': return {
        stackTrace,
        reason: 'function breakpoint',
        description: localize('pause.instrumentation', 'Paused on instrumentation breakpoint')
      };
      case 'XHR': return {
        stackTrace,
        reason: 'data breakpoint',
        description: localize('pause.xhr', 'Paused on XMLHttpRequest or fetch')
      };
      case 'OOM': return {
        stackTrace,
        reason: 'exception',
        description: localize('pause.oom', 'Paused before Out Of Memory exception')
      };
      default:
        if (event.hitBreakpoints && event.hitBreakpoints.length) return {
          stackTrace,
          reason: 'breakpoint',
          description: localize('pause.breakpoint', 'Paused on breakpoint')
        };
        return {
          stackTrace,
          reason: 'step',
          description: localize('pause.default', 'Paused')
        };
    }
  }

  _resolveEventListenerBreakpointDetails(stackTrace: StackTrace, event: Cdp.Debugger.PausedEvent): PausedDetails {
    const data = event.data;
    const id = data ? (data['eventName'] || '') : '';
    const breakpoint = customBreakpoints().get(id);
    if (breakpoint) {
      const details = breakpoint.details(data!);
      return { stackTrace, reason: 'function breakpoint', description: details.short, text: details.long };
    }
    return { stackTrace, reason: 'function breakpoint', description: localize('pause.eventListener', 'Paused on event listener') };
  }

  async _onConsoleMessage(event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<Dap.OutputEventParams | undefined> {
    switch (event.type) {
      case 'endGroup': return;
      case 'clear': return this._clearDebuggerConsole();
    }

    let stackTrace: StackTrace | undefined;
    let location: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        location = await frames[0].location();
      if (event.type !== 'error' && event.type !== 'warning')
        stackTrace = undefined;
    }

    let category: 'console' | 'stdout' | 'stderr' | 'telemetry' = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';

    const useMessageFormat = event.args.length > 1 && event.args[0].type === 'string';
    const formatString = useMessageFormat ? event.args[0].value as string : '';
    const messageText = messageFormat.formatMessage(formatString, useMessageFormat ? event.args.slice(1) : event.args, objectPreview.messageFormatters);
    const variablesReference = await this.replVariables.createVariableForOutput(messageText + '\n', event.args, stackTrace);
    return {
      category,
      output: '',
      variablesReference,
      source: location && location.source ? await location.source.toDap() : undefined,
      line: location ? location.lineNumber : undefined,
      column: location ? location.columnNumber : undefined,
    };
  }

  _clearDebuggerConsole(): Dap.OutputEventParams {
    return {
      category: 'console',
      output: '\x1b[2J',
    };
  }

  async formatException(details: Cdp.Runtime.ExceptionDetails, prefix?: string): Promise<Dap.OutputEventParams | undefined> {
    const preview = details.exception ? objectPreview.previewException(details.exception) : { title: '' };
    let message = preview.title;
    if (!message.startsWith('Uncaught'))
      message = 'Uncaught ' + message;
    message = (prefix || '') + message;

    let stackTrace: StackTrace | undefined;
    let location: Location | undefined;
    if (details.stackTrace)
      stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    if (stackTrace) {
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        location = await frames[0].location();
    }

    const args = (details.exception && !preview.stackTrace) ? [details.exception] : [];
    let variablesReference = 0;
    if (stackTrace || args.length)
      variablesReference = await this.replVariables.createVariableForOutput(message, args, stackTrace);

    return {
      category: 'stderr',
      output: message,
      variablesReference,
      source: (location && location.source) ? await location.source.toDap() : undefined,
      line: location ? location.lineNumber : undefined,
      column: location ? location.columnNumber : undefined,
    };
  }

  _removeAllScripts() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    for (const script of scripts) {
      const set = script.source[kScriptsSymbol];
      set.delete(script);
      if (!set.size)
        this.sourceContainer.removeSource(script.source);
    }
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    event.url = this.manager._sourcePathResolver.scriptUrlToUrl(event.url);
    let source = event.url ? this.sourceContainer.sourceByUrl(event.url) : undefined;
    if (!source) {
      const contentGetter = async () => {
        const response = await this._cdp.Debugger.getScriptSource({ scriptId: event.scriptId });
        return response ? response.scriptSource : undefined;
      };
      const inlineSourceOffset = (event.startLine || event.startColumn)
        ? { lineOffset: event.startLine, columnOffset: event.startColumn }
        : undefined;
      let resolvedSourceMapUrl: string | undefined;
      if (event.sourceMapURL) {
        // Note: we should in theory refetch source maps with relative urls, if the base url has changed,
        // but in practice that usually means new scripts with new source maps anyway.
        const resolvedSourceUrl = urlUtils.completeUrl(this._threadBaseUrl, event.url);
        resolvedSourceMapUrl = resolvedSourceUrl && urlUtils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
        if (!resolvedSourceMapUrl)
          errors.reportToConsole(this._dap, `Could not load source map from ${event.sourceMapURL}`);
      }
      source = this.sourceContainer.addSource(event.url, contentGetter, resolvedSourceMapUrl, inlineSourceOffset);
    }

    const script = { scriptId: event.scriptId, source, thread: this };
    this._scripts.set(event.scriptId, script);
    if (!source[kScriptsSymbol])
      source[kScriptsSymbol] = new Set();
    source[kScriptsSymbol].add(script);

    if (!this._supportsSourceMapPause && event.sourceMapURL) {
      this.sourceContainer.waitForSourceMapSources(source).then(sources => {
        if (sources.length && this.manager._scriptWithSourceMapHandler)
          this.manager._scriptWithSourceMapHandler(script, sources);
      });
    }
  }

  async _handleSourceMapPause(scriptId: string) {
    this._pausedForSourceMapScriptId = scriptId;
    const script = this._scripts.get(scriptId);
    if (script) {
      const timeout = this.manager.sourceContainer.sourceMapTimeouts().scriptPaused;
      const sources = await Promise.race([
        this.sourceContainer.waitForSourceMapSources(script.source),
        new Promise<Source[]>(f => setTimeout(() => f([]), timeout))
      ]);
      if (sources && this.manager._scriptWithSourceMapHandler)
        await this.manager._scriptWithSourceMapHandler(script, sources);
    }
    console.assert(this._pausedForSourceMapScriptId === scriptId);
    this._pausedForSourceMapScriptId = undefined;
    this._cdp.Debugger.resume({});
  }

  async _revealObject(object: Cdp.Runtime.RemoteObject) {
    if (object.type !== 'function')
      return;
    const response = await this._cdp.Runtime.getProperties({
      objectId: object.objectId!,
      ownProperties: true
    });
    if (!response)
      return;
    for (const p of response.internalProperties || []) {
      if (p.name !== '[[FunctionLocation]]' || !p.value || p.value.subtype as string !== 'internal#location')
        continue;
      const loc = p.value.value as Cdp.Debugger.Location;
      this.sourceContainer.revealLocation(await this.rawLocationToUiLocation(loc));
      break;
    }
  }

  async _copyObjectToClipboard(object: Cdp.Runtime.RemoteObject) {
    if (!object.objectId) {
      vscode.env.clipboard.writeText(objectPreview.renderValue(object, 1000000, false /* quote */));
      return;
    }

    const toStringForClipboard = `
      function toStringForClipboard(subtype) {
        if (subtype === 'node')
          return this.outerHTML;
        if (subtype && typeof this === 'undefined')
          return subtype + '';
        try {
          return JSON.stringify(this, null, '  ');
        } catch (e) {
          return '' + this;
        }
      }
    `;

    const response = await this.cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: toStringForClipboard,
      arguments: [{value: object.subtype}],
      silent: true,
      returnByValue: true
    });
    if (response && response.result)
      vscode.env.clipboard.writeText('' + response.result.value);
    this.cdp().Runtime.releaseObject({objectId: object.objectId});
  }

  async _queryObjects(prototype: Cdp.Runtime.RemoteObject) {
    const slot = this.claimOutputSlot();
    if (!prototype.objectId)
      return slot();
    const response = await this.cdp().Runtime.queryObjects({prototypeObjectId: prototype.objectId, objectGroup: 'console'});
    await this.cdp().Runtime.releaseObject({objectId: prototype.objectId});
    if (!response)
      return slot();
    const preview = objectPreview.previewRemoteObject(response.objects);
    const variablesReference = await this.replVariables.createVariableForOutput(`queryObjects: ${preview}\n`, [response.objects]);
    slot({
      category: 'stdout',
      output: '',
      variablesReference
    });
  }
};

export class DefaultThreadManagerDelegate implements ThreadManagerDelegate {
  private _manager: ThreadManager;

  constructor(manager: ThreadManager) {
    this._manager = manager;
  }

  executionContextForest(): ExecutionContextTree[] {
    const result: ExecutionContextTree[] = [];
    for (const thread of this._manager.threads()) {
      const threadContext: ExecutionContextTree = {
        name: thread.name() || `thread #${thread.threadId()}`,
        threadId: thread.threadId(),
        children: [],
      };
      result.push(threadContext);
      threadContext.children = thread.executionContexts().map(context => {
        return {
          name: context.name || `context #${context.id}`,
          threadId: thread.threadId(),
          contextId: context.id,
          children: [],
        };
      });
    }
    return result;
  }
}

const kScriptsSymbol = Symbol('script');
