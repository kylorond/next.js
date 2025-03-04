/**
 * This file contains runtime types and functions that are shared between all
 * Turbopack *development* ECMAScript runtimes.
 *
 * It will be appended to the runtime code of each runtime right after the
 * shared runtime utils.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

/// <reference path="../../../../shared/runtime-utils.ts" />
/// <reference path="./globals.d.ts" />
/// <reference path="./protocol.d.ts" />
/// <reference path="./extensions.d.ts" />

// This file must not use `import` and `export` statements. Otherwise, it
// becomes impossible to augment interfaces declared in `<reference>`d files
// (e.g. `Module`). Hence, the need for `import()` here.
type RefreshRuntimeGlobals =
  import("@next/react-refresh-utils/dist/runtime").RefreshRuntimeGlobals;

declare var CHUNK_BASE_PATH: string;
declare var $RefreshHelpers$: RefreshRuntimeGlobals["$RefreshHelpers$"];
declare var $RefreshReg$: RefreshRuntimeGlobals["$RefreshReg$"];
declare var $RefreshSig$: RefreshRuntimeGlobals["$RefreshSig$"];
declare var $RefreshInterceptModuleExecution$:
  | RefreshRuntimeGlobals["$RefreshInterceptModuleExecution$"];

type RefreshContext = {
  register: RefreshRuntimeGlobals["$RefreshReg$"];
  signature: RefreshRuntimeGlobals["$RefreshSig$"];
  registerExports: typeof registerExportsAndSetupBoundaryForReactRefresh;
};

type RefreshHelpers = RefreshRuntimeGlobals["$RefreshHelpers$"];

interface TurbopackDevBaseContext extends TurbopackBaseContext {
  k: RefreshContext;
  R: ResolvePathFromModule;
}

interface TurbopackDevContext extends TurbopackDevBaseContext {}

// string encoding of a module factory (used in hmr updates)
type ModuleFactoryString = string;

type ModuleFactory = (
  this: Module["exports"],
  context: TurbopackDevContext
) => undefined;

type DevRuntimeParams = {
  otherChunks: ChunkData[];
  runtimeModuleIds: ModuleId[];
};

type ChunkRegistration = [
  chunkPath: ChunkPath,
  chunkModules: ModuleFactories,
  params: DevRuntimeParams | undefined
];
type ChunkList = {
  path: ChunkPath;
  chunks: ChunkData[];
  source: "entry" | "dynamic";
};

enum SourceType {
  /**
   * The module was instantiated because it was included in an evaluated chunk's
   * runtime.
   */
  Runtime = 0,
  /**
   * The module was instantiated because a parent module imported it.
   */
  Parent = 1,
  /**
   * The module was instantiated because it was included in a chunk's hot module
   * update.
   */
  Update = 2,
}

type SourceInfo =
  | {
      type: SourceType.Runtime;
      chunkPath: ChunkPath;
    }
  | {
      type: SourceType.Parent;
      parentId: ModuleId;
    }
  | {
      type: SourceType.Update;
      parents?: ModuleId[];
    };

interface RuntimeBackend {
  registerChunk: (chunkPath: ChunkPath, params?: DevRuntimeParams) => void;
  loadChunk: (chunkPath: ChunkPath, source: SourceInfo) => Promise<void>;
  reloadChunk?: (chunkPath: ChunkPath) => Promise<void>;
  unloadChunk?: (chunkPath: ChunkPath) => void;

  restart: () => void;
}

class UpdateApplyError extends Error {
  name = "UpdateApplyError";

  dependencyChain: string[];

  constructor(message: string, dependencyChain: string[]) {
    super(message);
    this.dependencyChain = dependencyChain;
  }
}

const moduleFactories: ModuleFactories = Object.create(null);
const moduleCache: ModuleCache = Object.create(null);
/**
 * Maps module IDs to persisted data between executions of their hot module
 * implementation (`hot.data`).
 */
const moduleHotData: Map<ModuleId, HotData> = new Map();
/**
 * Maps module instances to their hot module state.
 */
const moduleHotState: Map<Module, HotState> = new Map();
/**
 * Modules that call `module.hot.invalidate()` (while being updated).
 */
const queuedInvalidatedModules: Set<ModuleId> = new Set();
/**
 * Module IDs that are instantiated as part of the runtime of a chunk.
 */
const runtimeModules: Set<ModuleId> = new Set();
/**
 * Map from module ID to the chunks that contain this module.
 *
 * In HMR, we need to keep track of which modules are contained in which so
 * chunks. This is so we don't eagerly dispose of a module when it is removed
 * from chunk A, but still exists in chunk B.
 */
const moduleChunksMap: Map<ModuleId, Set<ChunkPath>> = new Map();
/**
 * Map from a chunk path to all modules it contains.
 */
const chunkModulesMap: Map<ModuleId, Set<ChunkPath>> = new Map();
/**
 * Chunk lists that contain a runtime. When these chunk lists receive an update
 * that can't be reconciled with the current state of the page, we need to
 * reload the runtime entirely.
 */
const runtimeChunkLists: Set<ChunkPath> = new Set();
/**
 * Map from a chunk list to the chunk paths it contains.
 */
const chunkListChunksMap: Map<ChunkPath, Set<ChunkPath>> = new Map();
/**
 * Map from a chunk path to the chunk lists it belongs to.
 */
const chunkChunkListsMap: Map<ChunkPath, Set<ChunkPath>> = new Map();

const availableModules: Map<ModuleId, Promise<any> | true> = new Map();

const availableModuleChunks: Map<ChunkPath, Promise<any> | true> = new Map();

async function loadChunk(
  source: SourceInfo,
  chunkData: ChunkData
): Promise<any> {
  if (typeof chunkData === "string") {
    return loadChunkPath(source, chunkData);
  }

  const includedList = chunkData.included || [];
  const modulesPromises = includedList.map((included) => {
    if (moduleFactories[included]) return true;
    return availableModules.get(included);
  });
  if (modulesPromises.length > 0 && modulesPromises.every((p) => p)) {
    // When all included items are already loaded or loading, we can skip loading ourselves
    return Promise.all(modulesPromises);
  }

  const includedModuleChunksList = chunkData.moduleChunks || [];
  const moduleChunksPromises = includedModuleChunksList
    .map((included) => {
      // TODO(alexkirsz) Do we need this check?
      // if (moduleFactories[included]) return true;
      return availableModuleChunks.get(included);
    })
    .filter((p) => p);

  let promise;
  if (moduleChunksPromises.length > 0) {
    // Some module chunks are already loaded or loading.

    if (moduleChunksPromises.length === includedModuleChunksList.length) {
      // When all included module chunks are already loaded or loading, we can skip loading ourselves
      return Promise.all(moduleChunksPromises);
    }

    const moduleChunksToLoad: Set<ChunkPath> = new Set();
    for (const moduleChunk of includedModuleChunksList) {
      if (!availableModuleChunks.has(moduleChunk)) {
        moduleChunksToLoad.add(moduleChunk);
      }
    }

    for (const moduleChunkToLoad of moduleChunksToLoad) {
      const promise = loadChunkPath(source, moduleChunkToLoad);

      availableModuleChunks.set(moduleChunkToLoad, promise);

      moduleChunksPromises.push(promise);
    }

    promise = Promise.all(moduleChunksPromises);
  } else {
    promise = loadChunkPath(source, chunkData.path);

    // Mark all included module chunks as loading if they are not already loaded or loading.
    for (const includedModuleChunk of includedModuleChunksList) {
      if (!availableModuleChunks.has(includedModuleChunk)) {
        availableModuleChunks.set(includedModuleChunk, promise);
      }
    }
  }

  for (const included of includedList) {
    if (!availableModules.has(included)) {
      // It might be better to race old and new promises, but it's rare that the new promise will be faster than a request started earlier.
      // In production it's even more rare, because the chunk optimization tries to deduplicate modules anyway.
      availableModules.set(included, promise);
    }
  }

  return promise;
}

async function loadChunkPath(
  source: SourceInfo,
  chunkPath: ChunkPath
): Promise<any> {
  try {
    await BACKEND.loadChunk(chunkPath, source);
  } catch (error) {
    let loadReason;
    switch (source.type) {
      case SourceType.Runtime:
        loadReason = `as a runtime dependency of chunk ${source.chunkPath}`;
        break;
      case SourceType.Parent:
        loadReason = `from module ${source.parentId}`;
        break;
      case SourceType.Update:
        loadReason = "from an HMR update";
        break;
      default:
        invariant(source, (source) => `Unknown source type: ${source?.type}`);
    }
    throw new Error(
      `Failed to load chunk ${chunkPath} ${loadReason}${
        error ? `: ${error}` : ""
      }`,
      error
        ? {
            cause: error,
          }
        : undefined
    );
  }
}

/**
 * Returns an absolute url to an asset.
 */
function createResolvePathFromModule(
  resolver: (moduleId: string) => Exports
): (moduleId: string) => string {
  return function resolvePathFromModule(moduleId: string): string {
    const exported = resolver(moduleId);
    return exported?.default ?? exported;
  };
}

function instantiateModule(id: ModuleId, source: SourceInfo): Module {
  const moduleFactory = moduleFactories[id];
  if (typeof moduleFactory !== "function") {
    // This can happen if modules incorrectly handle HMR disposes/updates,
    // e.g. when they keep a `setTimeout` around which still executes old code
    // and contains e.g. a `require("something")` call.
    let instantiationReason;
    switch (source.type) {
      case SourceType.Runtime:
        instantiationReason = `as a runtime entry of chunk ${source.chunkPath}`;
        break;
      case SourceType.Parent:
        instantiationReason = `because it was required from module ${source.parentId}`;
        break;
      case SourceType.Update:
        instantiationReason = "because of an HMR update";
        break;
      default:
        invariant(source, (source) => `Unknown source type: ${source?.type}`);
    }
    throw new Error(
      `Module ${id} was instantiated ${instantiationReason}, but the module factory is not available. It might have been deleted in an HMR update.`
    );
  }

  const hotData = moduleHotData.get(id)!;
  const { hot, hotState } = createModuleHot(id, hotData);

  let parents: ModuleId[];
  switch (source.type) {
    case SourceType.Runtime:
      runtimeModules.add(id);
      parents = [];
      break;
    case SourceType.Parent:
      // No need to add this module as a child of the parent module here, this
      // has already been taken care of in `getOrInstantiateModuleFromParent`.
      parents = [source.parentId];
      break;
    case SourceType.Update:
      parents = source.parents || [];
      break;
    default:
      invariant(source, (source) => `Unknown source type: ${source?.type}`);
  }

  const module: Module = {
    exports: {},
    error: undefined,
    loaded: false,
    id,
    parents,
    children: [],
    namespaceObject: undefined,
    hot,
  };

  moduleCache[id] = module;
  moduleHotState.set(module, hotState);

  // NOTE(alexkirsz) This can fail when the module encounters a runtime error.
  try {
    const sourceInfo: SourceInfo = { type: SourceType.Parent, parentId: id };

    runModuleExecutionHooks(module, (refresh) => {
      const r = commonJsRequire.bind(null, module);
      moduleFactory.call(
        module.exports,
        augmentContext({
          a: asyncModule.bind(null, module),
          e: module.exports,
          r: commonJsRequire.bind(null, module),
          t: runtimeRequire,
          f: moduleContext,
          i: esmImport.bind(null, module),
          s: esmExport.bind(null, module, module.exports),
          j: dynamicExport.bind(null, module, module.exports),
          v: exportValue.bind(null, module),
          n: exportNamespace.bind(null, module),
          m: module,
          c: moduleCache,
          M: moduleFactories,
          l: loadChunk.bind(null, sourceInfo),
          w: loadWebAssembly.bind(null, sourceInfo),
          u: loadWebAssemblyModule.bind(null, sourceInfo),
          g: globalThis,
          P: resolveAbsolutePath,
          U: relativeURL,
          k: refresh,
          R: createResolvePathFromModule(r),
          __dirname: module.id.replace(/(^|\/)\/+$/, ""),
        })
      );
    });
  } catch (error) {
    module.error = error as any;
    throw error;
  }

  module.loaded = true;
  if (module.namespaceObject && module.exports !== module.namespaceObject) {
    // in case of a circular dependency: cjs1 -> esm2 -> cjs1
    interopEsm(module.exports, module.namespaceObject);
  }

  return module;
}

/**
 * no-op for browser
 * @param modulePath
 */
function resolveAbsolutePath(modulePath?: string): string {
  return `/ROOT/${modulePath ?? ""}`;
}

/**
 * NOTE(alexkirsz) Webpack has a "module execution" interception hook that
 * Next.js' React Refresh runtime hooks into to add module context to the
 * refresh registry.
 */
function runModuleExecutionHooks(
  module: Module,
  executeModule: (ctx: RefreshContext) => void
) {
  const cleanupReactRefreshIntercept =
    typeof globalThis.$RefreshInterceptModuleExecution$ === "function"
      ? globalThis.$RefreshInterceptModuleExecution$(module.id)
      : () => {};

  try {
    executeModule({
      register: globalThis.$RefreshReg$,
      signature: globalThis.$RefreshSig$,
      registerExports: registerExportsAndSetupBoundaryForReactRefresh,
    });
  } catch (e) {
    throw e;
  } finally {
    // Always cleanup the intercept, even if module execution failed.
    cleanupReactRefreshIntercept();
  }
}

/**
 * Retrieves a module from the cache, or instantiate it if it is not cached.
 */
const getOrInstantiateModuleFromParent: GetOrInstantiateModuleFromParent = (
  id,
  sourceModule
) => {
  if (!sourceModule.hot.active) {
    console.warn(
      `Unexpected import of module ${id} from module ${sourceModule.id}, which was deleted by an HMR update`
    );
  }

  const module = moduleCache[id];

  if (sourceModule.children.indexOf(id) === -1) {
    sourceModule.children.push(id);
  }

  if (module) {
    if (module.parents.indexOf(sourceModule.id) === -1) {
      module.parents.push(sourceModule.id);
    }

    return module;
  }

  return instantiateModule(id, {
    type: SourceType.Parent,
    parentId: sourceModule.id,
  });
};

/**
 * This is adapted from https://github.com/vercel/next.js/blob/3466862d9dc9c8bb3131712134d38757b918d1c0/packages/react-refresh-utils/internal/ReactRefreshModule.runtime.ts
 */
function registerExportsAndSetupBoundaryForReactRefresh(
  module: Module,
  helpers: RefreshHelpers
) {
  const currentExports = module.exports;
  const prevExports = module.hot.data.prevExports ?? null;

  helpers.registerExportsForReactRefresh(currentExports, module.id);

  // A module can be accepted automatically based on its exports, e.g. when
  // it is a Refresh Boundary.
  if (helpers.isReactRefreshBoundary(currentExports)) {
    // Save the previous exports on update, so we can compare the boundary
    // signatures.
    module.hot.dispose((data) => {
      data.prevExports = currentExports;
    });
    // Unconditionally accept an update to this module, we'll check if it's
    // still a Refresh Boundary later.
    module.hot.accept();

    // This field is set when the previous version of this module was a
    // Refresh Boundary, letting us know we need to check for invalidation or
    // enqueue an update.
    if (prevExports !== null) {
      // A boundary can become ineligible if its exports are incompatible
      // with the previous exports.
      //
      // For example, if you add/remove/change exports, we'll want to
      // re-execute the importing modules, and force those components to
      // re-render. Similarly, if you convert a class component to a
      // function, we want to invalidate the boundary.
      if (
        helpers.shouldInvalidateReactRefreshBoundary(
          helpers.getRefreshBoundarySignature(prevExports),
          helpers.getRefreshBoundarySignature(currentExports)
        )
      ) {
        module.hot.invalidate();
      } else {
        helpers.scheduleUpdate();
      }
    }
  } else {
    // Since we just executed the code for the module, it's possible that the
    // new exports made it ineligible for being a boundary.
    // We only care about the case when we were _previously_ a boundary,
    // because we already accepted this update (accidental side effect).
    const isNoLongerABoundary = prevExports !== null;
    if (isNoLongerABoundary) {
      module.hot.invalidate();
    }
  }
}

function formatDependencyChain(dependencyChain: ModuleId[]): string {
  return `Dependency chain: ${dependencyChain.join(" -> ")}`;
}

function computeOutdatedModules(
  added: Map<ModuleId, EcmascriptModuleEntry | undefined>,
  modified: Map<ModuleId, EcmascriptModuleEntry>
): {
  outdatedModules: Set<ModuleId>;
  newModuleFactories: Map<ModuleId, ModuleFactory>;
} {
  const newModuleFactories = new Map<ModuleId, ModuleFactory>();

  for (const [moduleId, entry] of added) {
    if (entry != null) {
      newModuleFactories.set(moduleId, _eval(entry));
    }
  }

  const outdatedModules = computedInvalidatedModules(modified.keys());

  for (const [moduleId, entry] of modified) {
    newModuleFactories.set(moduleId, _eval(entry));
  }

  return { outdatedModules, newModuleFactories };
}

function computedInvalidatedModules(
  invalidated: Iterable<ModuleId>
): Set<ModuleId> {
  const outdatedModules = new Set<ModuleId>();

  for (const moduleId of invalidated) {
    const effect = getAffectedModuleEffects(moduleId);

    switch (effect.type) {
      case "unaccepted":
        throw new UpdateApplyError(
          `cannot apply update: unaccepted module. ${formatDependencyChain(
            effect.dependencyChain
          )}.`,
          effect.dependencyChain
        );
      case "self-declined":
        throw new UpdateApplyError(
          `cannot apply update: self-declined module. ${formatDependencyChain(
            effect.dependencyChain
          )}.`,
          effect.dependencyChain
        );
      case "accepted":
        for (const outdatedModuleId of effect.outdatedModules) {
          outdatedModules.add(outdatedModuleId);
        }
        break;
      // TODO(alexkirsz) Dependencies: handle dependencies effects.
      default:
        invariant(effect, (effect) => `Unknown effect type: ${effect?.type}`);
    }
  }

  return outdatedModules;
}

function computeOutdatedSelfAcceptedModules(
  outdatedModules: Iterable<ModuleId>
): { moduleId: ModuleId; errorHandler: true | Function }[] {
  const outdatedSelfAcceptedModules = [];
  for (const moduleId of outdatedModules) {
    const module = moduleCache[moduleId];
    const hotState = moduleHotState.get(module)!;
    if (module && hotState.selfAccepted && !hotState.selfInvalidated) {
      outdatedSelfAcceptedModules.push({
        moduleId,
        errorHandler: hotState.selfAccepted,
      });
    }
  }
  return outdatedSelfAcceptedModules;
}

/**
 * Adds, deletes, and moves modules between chunks. This must happen before the
 * dispose phase as it needs to know which modules were removed from all chunks,
 * which we can only compute *after* taking care of added and moved modules.
 */
function updateChunksPhase(
  chunksAddedModules: Map<ChunkPath, Set<ModuleId>>,
  chunksDeletedModules: Map<ChunkPath, Set<ModuleId>>
): { disposedModules: Set<ModuleId> } {
  for (const [chunkPath, addedModuleIds] of chunksAddedModules) {
    for (const moduleId of addedModuleIds) {
      addModuleToChunk(moduleId, chunkPath);
    }
  }

  const disposedModules: Set<ModuleId> = new Set();
  for (const [chunkPath, addedModuleIds] of chunksDeletedModules) {
    for (const moduleId of addedModuleIds) {
      if (removeModuleFromChunk(moduleId, chunkPath)) {
        disposedModules.add(moduleId);
      }
    }
  }

  return { disposedModules };
}

function disposePhase(
  outdatedModules: Iterable<ModuleId>,
  disposedModules: Iterable<ModuleId>
): { outdatedModuleParents: Map<ModuleId, Array<ModuleId>> } {
  for (const moduleId of outdatedModules) {
    disposeModule(moduleId, "replace");
  }

  for (const moduleId of disposedModules) {
    disposeModule(moduleId, "clear");
  }

  // Removing modules from the module cache is a separate step.
  // We also want to keep track of previous parents of the outdated modules.
  const outdatedModuleParents = new Map();
  for (const moduleId of outdatedModules) {
    const oldModule = moduleCache[moduleId];
    outdatedModuleParents.set(moduleId, oldModule?.parents);
    delete moduleCache[moduleId];
  }

  // TODO(alexkirsz) Dependencies: remove outdated dependency from module
  // children.

  return { outdatedModuleParents };
}

/**
 * Disposes of an instance of a module.
 *
 * Returns the persistent hot data that should be kept for the next module
 * instance.
 *
 * NOTE: mode = "replace" will not remove modules from the moduleCache.
 * This must be done in a separate step afterwards.
 * This is important because all modules need to be disposed to update the
 * parent/child relationships before they are actually removed from the moduleCache.
 * If this was done in this method, the following disposeModule calls won't find
 * the module from the module id in the cache.
 */
function disposeModule(moduleId: ModuleId, mode: "clear" | "replace") {
  const module = moduleCache[moduleId];
  if (!module) {
    return;
  }

  const hotState = moduleHotState.get(module)!;
  const data = {};

  // Run the `hot.dispose` handler, if any, passing in the persistent
  // `hot.data` object.
  for (const disposeHandler of hotState.disposeHandlers) {
    disposeHandler(data);
  }

  // This used to warn in `getOrInstantiateModuleFromParent` when a disposed
  // module is still importing other modules.
  module.hot.active = false;

  moduleHotState.delete(module);

  // TODO(alexkirsz) Dependencies: delete the module from outdated deps.

  // Remove the disposed module from its children's parent list.
  // It will be added back once the module re-instantiates and imports its
  // children again.
  for (const childId of module.children) {
    const child = moduleCache[childId];
    if (!child) {
      continue;
    }

    const idx = child.parents.indexOf(module.id);
    if (idx >= 0) {
      child.parents.splice(idx, 1);
    }
  }

  switch (mode) {
    case "clear":
      delete moduleCache[module.id];
      moduleHotData.delete(module.id);
      break;
    case "replace":
      moduleHotData.set(module.id, data);
      break;
    default:
      invariant(mode, (mode) => `invalid mode: ${mode}`);
  }
}

function applyPhase(
  outdatedSelfAcceptedModules: {
    moduleId: ModuleId;
    errorHandler: true | Function;
  }[],
  newModuleFactories: Map<ModuleId, ModuleFactory>,
  outdatedModuleParents: Map<ModuleId, Array<ModuleId>>,
  reportError: (err: any) => void
) {
  // Update module factories.
  for (const [moduleId, factory] of newModuleFactories.entries()) {
    moduleFactories[moduleId] = factory;
  }

  // TODO(alexkirsz) Run new runtime entries here.

  // TODO(alexkirsz) Dependencies: call accept handlers for outdated deps.

  // Re-instantiate all outdated self-accepted modules.
  for (const { moduleId, errorHandler } of outdatedSelfAcceptedModules) {
    try {
      instantiateModule(moduleId, {
        type: SourceType.Update,
        parents: outdatedModuleParents.get(moduleId),
      });
    } catch (err) {
      if (typeof errorHandler === "function") {
        try {
          errorHandler(err, { moduleId, module: moduleCache[moduleId] });
        } catch (err2) {
          reportError(err2);
          reportError(err);
        }
      } else {
        reportError(err);
      }
    }
  }
}

function applyUpdate(update: PartialUpdate) {
  switch (update.type) {
    case "ChunkListUpdate":
      applyChunkListUpdate(update);
      break;
    default:
      invariant(update, (update) => `Unknown update type: ${update.type}`);
  }
}

function applyChunkListUpdate(update: ChunkListUpdate) {
  if (update.merged != null) {
    for (const merged of update.merged) {
      switch (merged.type) {
        case "EcmascriptMergedUpdate":
          applyEcmascriptMergedUpdate(merged);
          break;
        default:
          invariant(merged, (merged) => `Unknown merged type: ${merged.type}`);
      }
    }
  }

  if (update.chunks != null) {
    for (const [chunkPath, chunkUpdate] of Object.entries(update.chunks)) {
      switch (chunkUpdate.type) {
        case "added":
          BACKEND.loadChunk(chunkPath, { type: SourceType.Update });
          break;
        case "total":
          BACKEND.reloadChunk?.(chunkPath);
          break;
        case "deleted":
          BACKEND.unloadChunk?.(chunkPath);
          break;
        case "partial":
          invariant(
            chunkUpdate.instruction,
            (instruction) =>
              `Unknown partial instruction: ${JSON.stringify(instruction)}.`
          );
          break;
        default:
          invariant(
            chunkUpdate,
            (chunkUpdate) => `Unknown chunk update type: ${chunkUpdate.type}`
          );
      }
    }
  }
}

function applyEcmascriptMergedUpdate(update: EcmascriptMergedUpdate) {
  const { entries = {}, chunks = {} } = update;
  const { added, modified, chunksAdded, chunksDeleted } = computeChangedModules(
    entries,
    chunks
  );
  const { outdatedModules, newModuleFactories } = computeOutdatedModules(
    added,
    modified
  );
  const { disposedModules } = updateChunksPhase(chunksAdded, chunksDeleted);

  applyInternal(outdatedModules, disposedModules, newModuleFactories);
}

function applyInvalidatedModules(outdatedModules: Set<ModuleId>) {
  if (queuedInvalidatedModules.size > 0) {
    computedInvalidatedModules(queuedInvalidatedModules).forEach((moduleId) => {
      outdatedModules.add(moduleId);
    });

    queuedInvalidatedModules.clear();
  }

  return outdatedModules;
}

function applyInternal(
  outdatedModules: Set<ModuleId>,
  disposedModules: Iterable<ModuleId>,
  newModuleFactories: Map<ModuleId, ModuleFactory>
) {
  outdatedModules = applyInvalidatedModules(outdatedModules);

  const outdatedSelfAcceptedModules =
    computeOutdatedSelfAcceptedModules(outdatedModules);

  const { outdatedModuleParents } = disposePhase(
    outdatedModules,
    disposedModules
  );

  // we want to continue on error and only throw the error after we tried applying all updates
  let error: any;

  function reportError(err: any) {
    if (!error) error = err;
  }

  applyPhase(
    outdatedSelfAcceptedModules,
    newModuleFactories,
    outdatedModuleParents,
    reportError
  );

  if (error) {
    throw error;
  }

  if (queuedInvalidatedModules.size > 0) {
    applyInternal(new Set(), [], new Map());
  }
}

function computeChangedModules(
  entries: Record<ModuleId, EcmascriptModuleEntry>,
  updates: Record<ChunkPath, EcmascriptMergedChunkUpdate>
): {
  added: Map<ModuleId, EcmascriptModuleEntry | undefined>;
  modified: Map<ModuleId, EcmascriptModuleEntry>;
  deleted: Set<ModuleId>;
  chunksAdded: Map<ChunkPath, Set<ModuleId>>;
  chunksDeleted: Map<ChunkPath, Set<ModuleId>>;
} {
  const chunksAdded = new Map();
  const chunksDeleted = new Map();
  const added: Map<ModuleId, EcmascriptModuleEntry> = new Map();
  const modified = new Map();
  const deleted: Set<ModuleId> = new Set();

  for (const [chunkPath, mergedChunkUpdate] of Object.entries(updates)) {
    switch (mergedChunkUpdate.type) {
      case "added": {
        const updateAdded = new Set(mergedChunkUpdate.modules);
        for (const moduleId of updateAdded) {
          added.set(moduleId, entries[moduleId]);
        }
        chunksAdded.set(chunkPath, updateAdded);
        break;
      }
      case "deleted": {
        // We could also use `mergedChunkUpdate.modules` here.
        const updateDeleted = new Set(chunkModulesMap.get(chunkPath));
        for (const moduleId of updateDeleted) {
          deleted.add(moduleId);
        }
        chunksDeleted.set(chunkPath, updateDeleted);
        break;
      }
      case "partial": {
        const updateAdded = new Set(mergedChunkUpdate.added);
        const updateDeleted = new Set(mergedChunkUpdate.deleted);
        for (const moduleId of updateAdded) {
          added.set(moduleId, entries[moduleId]);
        }
        for (const moduleId of updateDeleted) {
          deleted.add(moduleId);
        }
        chunksAdded.set(chunkPath, updateAdded);
        chunksDeleted.set(chunkPath, updateDeleted);
        break;
      }
      default:
        invariant(
          mergedChunkUpdate,
          (mergedChunkUpdate) =>
            `Unknown merged chunk update type: ${mergedChunkUpdate.type}`
        );
    }
  }

  // If a module was added from one chunk and deleted from another in the same update,
  // consider it to be modified, as it means the module was moved from one chunk to another
  // AND has new code in a single update.
  for (const moduleId of added.keys()) {
    if (deleted.has(moduleId)) {
      added.delete(moduleId);
      deleted.delete(moduleId);
    }
  }

  for (const [moduleId, entry] of Object.entries(entries)) {
    // Modules that haven't been added to any chunk but have new code are considered
    // to be modified.
    // This needs to be under the previous loop, as we need it to get rid of modules
    // that were added and deleted in the same update.
    if (!added.has(moduleId)) {
      modified.set(moduleId, entry);
    }
  }

  return { added, deleted, modified, chunksAdded, chunksDeleted };
}

type ModuleEffect =
  | {
      type: "unaccepted";
      dependencyChain: ModuleId[];
    }
  | {
      type: "self-declined";
      dependencyChain: ModuleId[];
      moduleId: ModuleId;
    }
  | {
      type: "accepted";
      moduleId: ModuleId;
      outdatedModules: Set<ModuleId>;
    };

function getAffectedModuleEffects(moduleId: ModuleId): ModuleEffect {
  const outdatedModules: Set<ModuleId> = new Set();

  type QueueItem = { moduleId?: ModuleId; dependencyChain: ModuleId[] };

  const queue: QueueItem[] = [
    {
      moduleId,
      dependencyChain: [],
    },
  ];

  let nextItem;
  while ((nextItem = queue.shift())) {
    const { moduleId, dependencyChain } = nextItem;

    if (moduleId != null) {
      if (outdatedModules.has(moduleId)) {
        // Avoid infinite loops caused by cycles between modules in the dependency chain.
        continue;
      }

      outdatedModules.add(moduleId);
    }

    // We've arrived at the runtime of the chunk, which means that nothing
    // else above can accept this update.
    if (moduleId === undefined) {
      return {
        type: "unaccepted",
        dependencyChain,
      };
    }

    const module = moduleCache[moduleId];
    const hotState = moduleHotState.get(module)!;

    if (
      // The module is not in the cache. Since this is a "modified" update,
      // it means that the module was never instantiated before.
      !module || // The module accepted itself without invalidating globalThis.
      // TODO is that right?
      (hotState.selfAccepted && !hotState.selfInvalidated)
    ) {
      continue;
    }

    if (hotState.selfDeclined) {
      return {
        type: "self-declined",
        dependencyChain,
        moduleId,
      };
    }

    if (runtimeModules.has(moduleId)) {
      queue.push({
        moduleId: undefined,
        dependencyChain: [...dependencyChain, moduleId],
      });
      continue;
    }

    for (const parentId of module.parents) {
      const parent = moduleCache[parentId];

      if (!parent) {
        // TODO(alexkirsz) Is this even possible?
        continue;
      }

      // TODO(alexkirsz) Dependencies: check accepted and declined
      // dependencies here.

      queue.push({
        moduleId: parentId,
        dependencyChain: [...dependencyChain, moduleId],
      });
    }
  }

  return {
    type: "accepted",
    moduleId,
    outdatedModules,
  };
}

function handleApply(chunkListPath: ChunkPath, update: ServerMessage) {
  switch (update.type) {
    case "partial": {
      // This indicates that the update is can be applied to the current state of the application.
      applyUpdate(update.instruction);
      break;
    }
    case "restart": {
      // This indicates that there is no way to apply the update to the
      // current state of the application, and that the application must be
      // restarted.
      BACKEND.restart();
      break;
    }
    case "notFound": {
      // This indicates that the chunk list no longer exists: either the dynamic import which created it was removed,
      // or the page itself was deleted.
      // If it is a dynamic import, we simply discard all modules that the chunk has exclusive access to.
      // If it is a runtime chunk list, we restart the application.
      if (runtimeChunkLists.has(chunkListPath)) {
        BACKEND.restart();
      } else {
        disposeChunkList(chunkListPath);
      }
      break;
    }
    default:
      throw new Error(`Unknown update type: ${update.type}`);
  }
}

function createModuleHot(
  moduleId: ModuleId,
  hotData: HotData
): { hot: Hot; hotState: HotState } {
  const hotState: HotState = {
    selfAccepted: false,
    selfDeclined: false,
    selfInvalidated: false,
    disposeHandlers: [],
  };

  const hot: Hot = {
    // TODO(alexkirsz) This is not defined in the HMR API. It was used to
    // decide whether to warn whenever an HMR-disposed module required other
    // modules. We might want to remove it.
    active: true,

    data: hotData ?? {},

    // TODO(alexkirsz) Support full (dep, callback, errorHandler) form.
    accept: (
      modules?: string | string[] | AcceptErrorHandler,
      _callback?: AcceptCallback,
      _errorHandler?: AcceptErrorHandler
    ) => {
      if (modules === undefined) {
        hotState.selfAccepted = true;
      } else if (typeof modules === "function") {
        hotState.selfAccepted = modules;
      } else {
        throw new Error("unsupported `accept` signature");
      }
    },

    decline: (dep) => {
      if (dep === undefined) {
        hotState.selfDeclined = true;
      } else {
        throw new Error("unsupported `decline` signature");
      }
    },

    dispose: (callback) => {
      hotState.disposeHandlers.push(callback);
    },

    addDisposeHandler: (callback) => {
      hotState.disposeHandlers.push(callback);
    },

    removeDisposeHandler: (callback) => {
      const idx = hotState.disposeHandlers.indexOf(callback);
      if (idx >= 0) {
        hotState.disposeHandlers.splice(idx, 1);
      }
    },

    invalidate: () => {
      hotState.selfInvalidated = true;
      queuedInvalidatedModules.add(moduleId);
    },

    // NOTE(alexkirsz) This is part of the management API, which we don't
    // implement, but the Next.js React Refresh runtime uses this to decide
    // whether to schedule an update.
    status: () => "idle",

    // NOTE(alexkirsz) Since we always return "idle" for now, these are no-ops.
    addStatusHandler: (_handler) => {},
    removeStatusHandler: (_handler) => {},

    // NOTE(jridgewell) Check returns the list of updated modules, but we don't
    // want the webpack code paths to ever update (the turbopack paths handle
    // this already).
    check: () => Promise.resolve(null),
  };

  return { hot, hotState };
}

/**
 * Adds a module to a chunk.
 */
function addModuleToChunk(moduleId: ModuleId, chunkPath: ChunkPath) {
  let moduleChunks = moduleChunksMap.get(moduleId);
  if (!moduleChunks) {
    moduleChunks = new Set([chunkPath]);
    moduleChunksMap.set(moduleId, moduleChunks);
  } else {
    moduleChunks.add(chunkPath);
  }

  let chunkModules = chunkModulesMap.get(chunkPath);
  if (!chunkModules) {
    chunkModules = new Set([moduleId]);
    chunkModulesMap.set(chunkPath, chunkModules);
  } else {
    chunkModules.add(moduleId);
  }
}

/**
 * Returns the first chunk that included a module.
 * This is used by the Node.js backend, hence why it's marked as unused in this
 * file.
 */
function getFirstModuleChunk(moduleId: ModuleId) {
  const moduleChunkPaths = moduleChunksMap.get(moduleId);
  if (moduleChunkPaths == null) {
    return null;
  }

  return moduleChunkPaths.values().next().value;
}

/**
 * Removes a module from a chunk.
 * Returns `true` if there are no remaining chunks including this module.
 */
function removeModuleFromChunk(
  moduleId: ModuleId,
  chunkPath: ChunkPath
): boolean {
  const moduleChunks = moduleChunksMap.get(moduleId)!;
  moduleChunks.delete(chunkPath);

  const chunkModules = chunkModulesMap.get(chunkPath)!;
  chunkModules.delete(moduleId);

  const noRemainingModules = chunkModules.size === 0;
  if (noRemainingModules) {
    chunkModulesMap.delete(chunkPath);
  }

  const noRemainingChunks = moduleChunks.size === 0;
  if (noRemainingChunks) {
    moduleChunksMap.delete(moduleId);
  }

  return noRemainingChunks;
}

/**
 * Disposes of a chunk list and its corresponding exclusive chunks.
 */
function disposeChunkList(chunkListPath: ChunkPath): boolean {
  const chunkPaths = chunkListChunksMap.get(chunkListPath);
  if (chunkPaths == null) {
    return false;
  }
  chunkListChunksMap.delete(chunkListPath);

  for (const chunkPath of chunkPaths) {
    const chunkChunkLists = chunkChunkListsMap.get(chunkPath)!;
    chunkChunkLists.delete(chunkListPath);

    if (chunkChunkLists.size === 0) {
      chunkChunkListsMap.delete(chunkPath);
      disposeChunk(chunkPath);
    }
  }

  // We must also dispose of the chunk list's chunk itself to ensure it may
  // be reloaded properly in the future.
  BACKEND.unloadChunk?.(chunkListPath);

  return true;
}

/**
 * Disposes of a chunk and its corresponding exclusive modules.
 *
 * @returns Whether the chunk was disposed of.
 */
function disposeChunk(chunkPath: ChunkPath): boolean {
  // This should happen whether the chunk has any modules in it or not.
  // For instance, CSS chunks have no modules in them, but they still need to be unloaded.
  BACKEND.unloadChunk?.(chunkPath);

  const chunkModules = chunkModulesMap.get(chunkPath);
  if (chunkModules == null) {
    return false;
  }
  chunkModules.delete(chunkPath);

  for (const moduleId of chunkModules) {
    const moduleChunks = moduleChunksMap.get(moduleId)!;
    moduleChunks.delete(chunkPath);

    const noRemainingChunks = moduleChunks.size === 0;
    if (noRemainingChunks) {
      moduleChunksMap.delete(moduleId);
      disposeModule(moduleId, "clear");
      availableModules.delete(moduleId);
    }
  }

  return true;
}

/**
 * Instantiates a runtime module.
 */
function instantiateRuntimeModule(
  moduleId: ModuleId,
  chunkPath: ChunkPath
): Module {
  return instantiateModule(moduleId, { type: SourceType.Runtime, chunkPath });
}

/**
 * Gets or instantiates a runtime module.
 */
function getOrInstantiateRuntimeModule(
  moduleId: ModuleId,
  chunkPath: ChunkPath
): Module {
  const module = moduleCache[moduleId];
  if (module) {
    if (module.error) {
      throw module.error;
    }
    return module;
  }

  return instantiateModule(moduleId, { type: SourceType.Runtime, chunkPath });
}

/**
 * Returns the URL relative to the origin where a chunk can be fetched from.
 */
function getChunkRelativeUrl(chunkPath: ChunkPath): string {
  return `${CHUNK_BASE_PATH}${chunkPath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/")}`;
}

/**
 * Subscribes to chunk list updates from the update server and applies them.
 */
function registerChunkList(
  chunkUpdateProvider: ChunkUpdateProvider,
  chunkList: ChunkList
) {
  chunkUpdateProvider.push([
    chunkList.path,
    handleApply.bind(null, chunkList.path),
  ]);

  // Adding chunks to chunk lists and vice versa.
  const chunks = new Set(chunkList.chunks.map(getChunkPath));
  chunkListChunksMap.set(chunkList.path, chunks);
  for (const chunkPath of chunks) {
    let chunkChunkLists = chunkChunkListsMap.get(chunkPath);
    if (!chunkChunkLists) {
      chunkChunkLists = new Set([chunkList.path]);
      chunkChunkListsMap.set(chunkPath, chunkChunkLists);
    } else {
      chunkChunkLists.add(chunkList.path);
    }
  }

  if (chunkList.source === "entry") {
    markChunkListAsRuntime(chunkList.path);
  }
}

/**
 * Marks a chunk list as a runtime chunk list. There can be more than one
 * runtime chunk list. For instance, integration tests can have multiple chunk
 * groups loaded at runtime, each with its own chunk list.
 */
function markChunkListAsRuntime(chunkListPath: ChunkPath) {
  runtimeChunkLists.add(chunkListPath);
}

function registerChunk([
  chunkPath,
  chunkModules,
  runtimeParams,
]: ChunkRegistration) {
  for (const [moduleId, moduleFactory] of Object.entries(chunkModules)) {
    if (!moduleFactories[moduleId]) {
      moduleFactories[moduleId] = moduleFactory;
    }
    addModuleToChunk(moduleId, chunkPath);
  }

  return BACKEND.registerChunk(chunkPath, runtimeParams);
}

globalThis.TURBOPACK_CHUNK_UPDATE_LISTENERS ??= [];

const chunkListsToRegister = globalThis.TURBOPACK_CHUNK_LISTS;
if (Array.isArray(chunkListsToRegister)) {
  for (const chunkList of chunkListsToRegister) {
    registerChunkList(globalThis.TURBOPACK_CHUNK_UPDATE_LISTENERS, chunkList);
  }
}

globalThis.TURBOPACK_CHUNK_LISTS = {
  push: (chunkList) => {
    registerChunkList(globalThis.TURBOPACK_CHUNK_UPDATE_LISTENERS!, chunkList);
  },
} satisfies ChunkListProvider;
