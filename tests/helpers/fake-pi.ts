import type { ExtensionAPI, ExtensionContext, SessionEntry, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model as PiModel, Api, TextContent, Usage } from "@earendil-works/pi-ai";

interface FakePiOptions {
  cwd?: string;
  hasUI?: boolean;
  branch?: SessionEntry[];
  selectResult?: string;
  completeText?: string;
  completeError?: Error;
  getContextUsage?: () => unknown;
  compact?: (options: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => void;
  settings?: unknown;
  notify?: (message: string, level?: string) => void;
}

interface FakePi {
  api: ExtensionAPI;
  emit: <T, R>(event: string, payload: T) => Promise<R | undefined>;
  emitStrict: <T>(event: string, payload: T) => Promise<void>;
  emitBus: (channel: string, data: unknown) => void;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>;
  context: ExtensionContext;
  setBranch: (entries: SessionEntry[]) => void;
}

const CONFIG_DIR_NAME = "pi";

function createFakeModelRegistry(options: FakePiOptions): ModelRegistry {
  const testModel = {
    id: "test-model",
    provider: "test",
    contextWindow: 200000,
    maxTokens: 4096,
  } as unknown as PiModel<Api>;

  return {
    getAvailable: () => [testModel],
    find: (provider: string, id: string) => {
      if (provider === "test" && id === "test-model") {
        return testModel as unknown as PiModel<Api>;
      }
      return undefined;
    },
    complete: async (model: PiModel<Api>, messages: Array<{ role: string; content: unknown; timestamp: number }>, opts?: unknown) => {
      if (options.completeError) {
        throw options.completeError;
      }
      return {
        content: [
          {
            type: "text",
            text: options.completeText ?? "## Goal\nship it\nExpand for details about: commands",
          } as TextContent,
        ],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } as Usage,
        stopReason: "end",
        stopSequence: null,
        finishReason: "stop",
      } as unknown as { content: TextContent[]; usage: Usage };
    },
  } as unknown as ModelRegistry;
}

function createFakeSessionManager(cwd: string, branch: SessionEntry[]): SessionManager {
  let currentBranch = branch;

  return {
    getCwd: () => cwd,
    getSessionId: () => "s1",
    getSessionFile: () => undefined,
    getBranch: () => currentBranch,
    getEntries: () => currentBranch,
    getTree: () => [],
    getSessionInfo: () => ({ id: "s1", projectId: "", cwd, sessionFile: undefined, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    setBranch: (entries: SessionEntry[]) => { currentBranch = entries; },
  } as unknown as SessionManager;
}

function createFakeUIContext(fakeOptions: FakePiOptions): unknown {
  return {
    select: async (title: string, selectOptions: string[]) => fakeOptions.selectResult,
    confirm: async () => true,
    input: async () => undefined,
    notify: (message: string, level?: string) => fakeOptions.notify?.(message, level),
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    onTerminalInput: () => () => {},
    theme: {} as unknown,
    getThemes: () => [],
    getActiveTheme: () => undefined,
    setActiveTheme: () => {},
    getKeybindingHints: () => ({ keyText: () => "", keyHint: () => "" }),
  } as unknown;
}

function createFakeContext(cwd: string, branch: SessionEntry[], options: FakePiOptions): ExtensionContext {
  const modelRegistry = createFakeModelRegistry(options);
  const sessionManager = createFakeSessionManager(cwd, branch);
  const ui = createFakeUIContext(options);

  return {
    cwd,
    hasUI: options.hasUI ?? false,
    mode: "interactive",
    model: {
      provider: "test",
      id: "test-model",
      contextWindow: 200000,
    } as unknown as PiModel<Api>,
    modelRegistry,
    sessionManager,
    ui,
    isProjectTrusted: () => true,
    getContextUsage: options.getContextUsage ?? (() => ({ tokens: 0 })),
    compact: options.compact ?? (() => {}),
  } as unknown as ExtensionContext;
}

export function createFakePi(options: FakePiOptions): FakePi {
  const cwd = options.cwd ?? "/tmp/test";
  const branch = options.branch ?? [];
  const context = createFakeContext(cwd, branch, options);

  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();

  let currentBranch = branch;

  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    emit: (channel: string, data: unknown) => {
      for (const handler of busHandlers.get(channel) ?? []) {
        handler(data);
      }
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      if (!busHandlers.has(channel)) {
        busHandlers.set(channel, []);
      }
      busHandlers.get(channel)!.push(handler);
      return () => {
        const list = busHandlers.get(channel) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };

  const api: ExtensionAPI = {
    on: <E, R>(event: string, handler: (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(handler as unknown as (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown);
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(tool.name, tool as { execute: (...args: unknown[]) => Promise<unknown> });
    },
    registerCommand: (name: string, options: { handler: (ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, options as { handler: (ctx: ExtensionContext) => Promise<void> });
    },
    registerMcpServer: () => {},
    registerVirtualModel: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    registerMessageRenderer: () => {},
    registerToolRenderer: () => {},
    registerModelProvider: () => {},
    registerSessionBoundaryProvider: () => {},
    registerCacheWarmingDecisionProvider: () => {},
    registerProjectTrustHandler: () => {},
    setLabel: () => {},
    setThinkingLevel: () => {},
    setModel: () => {},
    setActiveTools: () => {},
    getCommands: () => [],
    getTools: () => [],
    getKeybindings: () => [],
    getFlags: () => ({}),
    getConfig: () => ({}),
    getSettings: () => options.settings ?? {},
    events,
  } as unknown as ExtensionAPI;

  const emit = async <T, R>(event: string, payload: T): Promise<R | undefined> => {
    const eventHandlers = handlers.get(event);
    if (!eventHandlers) {
      return undefined;
    }

    let result: R | undefined = undefined;
    for (const handler of eventHandlers) {
      try {
        const handlerResult = await Promise.resolve(handler(payload, context));
        if (handlerResult !== undefined) {
          result = handlerResult as R;
        }
      } catch (error) {
        // Swallow errors from handlers
      }
    }
    return result;
  };

  const emitStrict = async <T>(event: string, payload: T): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await Promise.resolve(handler(payload, context));
    }
  };

  const setBranch = (entries: SessionEntry[]) => {
    currentBranch = entries;
    (context.sessionManager as unknown as { setBranch: (entries: SessionEntry[]) => void }).setBranch(entries);
  };

  return {
    api,
    emit,
    emitStrict,
    emitBus: events.emit,
    tools,
    commands,
    context,
    setBranch,
  };
}
