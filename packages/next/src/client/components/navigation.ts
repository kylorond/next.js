import type { FlightRouterState } from '../../server/app-render/types'
import {
  isUnknownRouteParams,
  areUnknownRouteParamsKnown,
  type Params,
} from './params'

import { useContext, useMemo } from 'react'
import {
  AppRouterContext,
  LayoutRouterContext,
  type AppRouterInstance,
} from '../../shared/lib/app-router-context.shared-runtime'
import {
  SearchParamsContext,
  PathnameContext,
  PathParamsContext,
} from '../../shared/lib/hooks-client-context.shared-runtime'
import { getSegmentValue } from './router-reducer/reducers/get-segment-value'
import { PAGE_SEGMENT_KEY, DEFAULT_SEGMENT_KEY } from '../../shared/lib/segment'
import { ReadonlyURLSearchParams } from './navigation.react-server'
import { trackDynamicDataAccessed } from '../../server/app-render/dynamic-rendering'

/**
 * A [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components) hook
 * that lets you *read* the current URL's search parameters.
 *
 * Learn more about [`URLSearchParams` on MDN](https://developer.mozilla.org/docs/Web/API/URLSearchParams)
 *
 * @example
 * ```ts
 * "use client"
 * import { useSearchParams } from 'next/navigation'
 *
 * export default function Page() {
 *   const searchParams = useSearchParams()
 *   searchParams.get('foo') // returns 'bar' when ?foo=bar
 *   // ...
 * }
 * ```
 *
 * Read more: [Next.js Docs: `useSearchParams`](https://nextjs.org/docs/app/api-reference/functions/use-search-params)
 */
// Client components API
export function useSearchParams(): ReadonlyURLSearchParams {
  const searchParams = useContext(SearchParamsContext)

  // In the case where this is `null`, the compat types added in
  // `next-env.d.ts` will add a new overload that changes the return type to
  // include `null`.
  const readonlySearchParams = useMemo(() => {
    if (!searchParams) {
      // When the router is not ready in pages, we won't have the search params
      // available.
      return null
    }

    return new ReadonlyURLSearchParams(searchParams)
  }, [searchParams]) as ReadonlyURLSearchParams

  if (typeof window === 'undefined') {
    // AsyncLocalStorage should not be included in the client bundle.
    const { bailoutToClientRendering } =
      require('./bailout-to-client-rendering') as typeof import('./bailout-to-client-rendering')
    // TODO-APP: handle dynamic = 'force-static' here and on the client
    bailoutToClientRendering('useSearchParams()')
  }

  return readonlySearchParams
}

function trackParamsAccessed(expression: string) {
  if (typeof window === 'undefined') {
    // AsyncLocalStorage should not be included in the client bundle.
    const { staticGenerationAsyncStorage } =
      require('./static-generation-async-storage.external') as typeof import('./static-generation-async-storage.external')

    const staticGenerationStore = staticGenerationAsyncStorage.getStore()
    if (!staticGenerationStore) return

    // We only want to track dynamic parameter access if the params are
    // unknown.
    const { unknownRouteParams } = staticGenerationStore
    if (!isUnknownRouteParams(unknownRouteParams)) return

    // If there are any unknown route parameters, then we should track this as
    // a dynamic access.
    trackDynamicDataAccessed(staticGenerationStore, expression)
  }
}

/**
 * A [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components) hook
 * that lets you read the current URL's pathname.
 *
 * @example
 * ```ts
 * "use client"
 * import { usePathname } from 'next/navigation'
 *
 * export default function Page() {
 *  const pathname = usePathname() // returns "/dashboard" on /dashboard?foo=bar
 *  // ...
 * }
 * ```
 *
 * Read more: [Next.js Docs: `usePathname`](https://nextjs.org/docs/app/api-reference/functions/use-pathname)
 */
// Client components API
export function usePathname(): string {
  // If there are any unknown route parameters, then we should track this as
  // a dynamic access.
  trackParamsAccessed('usePathname()')

  // In the case where this is `null`, the compat types added in `next-env.d.ts`
  // will add a new overload that changes the return type to include `null`.
  return useContext(PathnameContext) as string
}

// Client components API
export {
  ServerInsertedHTMLContext,
  useServerInsertedHTML,
} from '../../shared/lib/server-inserted-html.shared-runtime'

/**
 *
 * This hook allows you to programmatically change routes inside [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components).
 *
 * @example
 * ```ts
 * "use client"
 * import { useRouter } from 'next/navigation'
 *
 * export default function Page() {
 *  const router = useRouter()
 *  // ...
 *  router.push('/dashboard') // Navigate to /dashboard
 * }
 * ```
 *
 * Read more: [Next.js Docs: `useRouter`](https://nextjs.org/docs/app/api-reference/functions/use-router)
 */
// Client components API
export function useRouter(): AppRouterInstance {
  const router = useContext(AppRouterContext)
  if (router === null) {
    throw new Error('invariant expected app router to be mounted')
  }

  return router
}

/**
 * A [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components) hook
 * that lets you read a route's dynamic params filled in by the current URL.
 *
 * @example
 * ```ts
 * "use client"
 * import { useParams } from 'next/navigation'
 *
 * export default function Page() {
 *   // on /dashboard/[team] where pathname is /dashboard/nextjs
 *   const { team } = useParams() // team === "nextjs"
 * }
 * ```
 *
 * Read more: [Next.js Docs: `useParams`](https://nextjs.org/docs/app/api-reference/functions/use-params)
 */
// Client components API
export function useParams<T extends Params = Params>(): T {
  // If there are any unknown route parameters, then we should track this as
  // a dynamic access.
  trackParamsAccessed('useParams()')

  const params = useContext(PathParamsContext)

  // Replace the unknown route params with the fallback ones.
  if (typeof window === 'undefined' && params) {
    const unknownRouteParams = getUnknownRouteParams()
    if (unknownRouteParams) {
      for (const [key, value] of unknownRouteParams) {
        params[key] = value
      }
    }
  }

  return params as T
}

function getUnknownRouteParams():
  | ReadonlyMap<string, string | string[]>
  | undefined {
  if (typeof window === 'undefined') {
    // AsyncLocalStorage should not be included in the client bundle.
    const { staticGenerationAsyncStorage } =
      require('./static-generation-async-storage.external') as typeof import('./static-generation-async-storage.external')

    const staticGenerationStore = staticGenerationAsyncStorage.getStore()
    if (
      staticGenerationStore &&
      staticGenerationStore.unknownRouteParams &&
      areUnknownRouteParamsKnown(staticGenerationStore.unknownRouteParams)
    ) {
      return staticGenerationStore.unknownRouteParams
    }
  }

  return undefined
}

/** Get the canonical parameters from the current level to the leaf node. */
// Client components API
export function getSelectedLayoutSegmentPath(
  tree: FlightRouterState,
  parallelRouteKey: string,
  first = true,
  segmentPath: string[] = []
): string[] {
  // If there are any unknown route parameters, then we should track this as
  // a dynamic access.
  // TODO: track only if one of the segments is unknown
  trackParamsAccessed('getSelectedLayoutSegmentPath()')

  let node: FlightRouterState
  if (first) {
    // Use the provided parallel route key on the first parallel route
    node = tree[1][parallelRouteKey]
  } else {
    // After first parallel route prefer children, if there's no children pick the first parallel route.
    const parallelRoutes = tree[1]
    node = parallelRoutes.children ?? Object.values(parallelRoutes)[0]
  }

  if (!node) return segmentPath
  const segment = node[0]

  let segmentValue = getSegmentValue(segment)

  // AsyncLocalStorage should not be included in the client bundle.
  if (typeof window === 'undefined') {
    // If we have a fallback dynamic param, we should use it to determine if
    // we should replace the segmentValue with the fallback one. This should
    // only happen during the dynamic render because the above
    // `trackDynamicDataAccessed` will throw during the static render.
    const unknownRouteParams = getUnknownRouteParams()
    const unknownRouteParam = unknownRouteParams?.get(segment[0])
    if (typeof unknownRouteParam === 'string') {
      segmentValue = unknownRouteParam
    } else if (Array.isArray(unknownRouteParam)) {
      segmentValue = unknownRouteParam.join('/')
    }
  }

  if (!segmentValue || segmentValue.startsWith(PAGE_SEGMENT_KEY)) {
    return segmentPath
  }

  segmentPath.push(segmentValue)

  return getSelectedLayoutSegmentPath(
    node,
    parallelRouteKey,
    false,
    segmentPath
  )
}

/**
 * A [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components) hook
 * that lets you read the active route segments **below** the Layout it is called from.
 *
 * @example
 * ```ts
 * 'use client'
 *
 * import { useSelectedLayoutSegments } from 'next/navigation'
 *
 * export default function ExampleClientComponent() {
 *   const segments = useSelectedLayoutSegments()
 *
 *   return (
 *     <ul>
 *       {segments.map((segment, index) => (
 *         <li key={index}>{segment}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * Read more: [Next.js Docs: `useSelectedLayoutSegments`](https://nextjs.org/docs/app/api-reference/functions/use-selected-layout-segments)
 */
// Client components API
export function useSelectedLayoutSegments(
  parallelRouteKey: string = 'children'
): string[] {
  // If there are any unknown route parameters, then we should track this as
  // a dynamic access.
  // TODO: track only if one of the segments is unknown
  trackParamsAccessed('useSelectedLayoutSegments()')

  const context = useContext(LayoutRouterContext)
  // @ts-expect-error This only happens in `pages`. Type is overwritten in navigation.d.ts
  if (!context) return null

  return getSelectedLayoutSegmentPath(context.tree, parallelRouteKey)
}

/**
 * A [Client Component](https://nextjs.org/docs/app/building-your-application/rendering/client-components) hook
 * that lets you read the active route segment **one level below** the Layout it is called from.
 *
 * @example
 * ```ts
 * 'use client'
 * import { useSelectedLayoutSegment } from 'next/navigation'
 *
 * export default function ExampleClientComponent() {
 *   const segment = useSelectedLayoutSegment()
 *
 *   return <p>Active segment: {segment}</p>
 * }
 * ```
 *
 * Read more: [Next.js Docs: `useSelectedLayoutSegment`](https://nextjs.org/docs/app/api-reference/functions/use-selected-layout-segment)
 */
// Client components API
export function useSelectedLayoutSegment(
  parallelRouteKey: string = 'children'
): string | null {
  // If there are any unknown route parameters, then we should track this as
  // a dynamic access.
  // TODO: track only if one of the segments is unknown
  trackParamsAccessed('useSelectedLayoutSegment()')

  const selectedLayoutSegments = useSelectedLayoutSegments(parallelRouteKey)

  if (!selectedLayoutSegments || selectedLayoutSegments.length === 0) {
    return null
  }

  const selectedLayoutSegment =
    parallelRouteKey === 'children'
      ? selectedLayoutSegments[0]
      : selectedLayoutSegments[selectedLayoutSegments.length - 1]

  // if the default slot is showing, we return null since it's not technically "selected" (it's a fallback)
  // and returning an internal value like `__DEFAULT__` would be confusing.
  return selectedLayoutSegment === DEFAULT_SEGMENT_KEY
    ? null
    : selectedLayoutSegment
}

// Shared components APIs
export {
  notFound,
  redirect,
  permanentRedirect,
  RedirectType,
  ReadonlyURLSearchParams,
  unstable_rethrow,
} from './navigation.react-server'
