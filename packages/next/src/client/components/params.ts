import { trackDynamicDataAccessed } from '../../server/app-render/dynamic-rendering'
import { ReflectAdapter } from '../../server/web/spec-extension/adapters/reflect'
import { getRouteMatcher } from '../../shared/lib/router/utils/route-matcher'
import { getRouteRegex } from '../../shared/lib/router/utils/route-regex'
import { staticGenerationAsyncStorage } from './static-generation-async-storage.external'

export type UnknownRouteParams =
  | ReadonlySet<string>
  | ReadonlyMap<string, string | string[]>
  | undefined

/**
 * Returns true if the params represent parameters where the value is known.
 *
 * @param unknownRouteParams the unknown route params
 * @returns true if the params represent parameters where the value is known
 */
export function areUnknownRouteParamsKnown(
  unknownRouteParams: UnknownRouteParams
): unknownRouteParams is ReadonlyMap<string, string | string[]> {
  if (unknownRouteParams instanceof Map) return unknownRouteParams.size > 0
  return false
}

/**
 * Returns true if the params represent parameters where the value is unknown.
 *
 * @param unknownRouteParams the unknown route params
 * @returns true if the params represent parameters where the value is unknown
 */
export function isUnknownRouteParams(
  unknownRouteParams: UnknownRouteParams
): unknownRouteParams is ReadonlySet<string> {
  if (unknownRouteParams instanceof Set) return unknownRouteParams.size > 0
  return false
}

export function getParamKeys(page: string) {
  const pattern = getRouteRegex(page)
  const matcher = getRouteMatcher(pattern)

  // Get the default list of allowed params.
  return Object.keys(matcher(page))
}

export type Params = Record<string, string | string[] | undefined>

export type CreateDynamicallyTrackedParams =
  typeof createDynamicallyTrackedParams

export function createDynamicallyTrackedParams(params: Params): Params {
  const staticGenerationStore = staticGenerationAsyncStorage.getStore()

  // If we are not in a static generation context, we can just return the
  // params.
  if (!staticGenerationStore) return params

  // If there are no unknown route params, we can just return the params.
  const { unknownRouteParams, forceStatic } = staticGenerationStore
  if (!isUnknownRouteParams(unknownRouteParams)) return params

  // If we are in force static mode, we should return the params as is.
  if (forceStatic) return params

  return new Proxy(params as Params, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && unknownRouteParams.has(prop)) {
        trackDynamicDataAccessed(staticGenerationStore, `params.${prop}`)
      }

      return ReflectAdapter.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string' && unknownRouteParams.has(prop)) {
        trackDynamicDataAccessed(staticGenerationStore, `params.${prop}`)
      }

      return ReflectAdapter.has(target, prop)
    },
    ownKeys(target) {
      if (unknownRouteParams.size > 0) {
        trackDynamicDataAccessed(staticGenerationStore, 'params')
      }

      return Reflect.ownKeys(target)
    },
  })
}
