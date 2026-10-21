import { Component, createContext, type ReactNode, useContext } from 'react'

interface ErrorScope {
  routeKey: string
  fallback: ReactNode
}

export const RouteErrorScope = createContext<ErrorScope | null>(null)

class ErrorBoundary extends Component<
  ErrorScope & { children: ReactNode },
  { failed: boolean; routeKey: string }
> {
  override state = { failed: false, routeKey: this.props.routeKey }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps({ routeKey }: ErrorScope, state: { routeKey: string }) {
    return routeKey !== state.routeKey ? { failed: false, routeKey } : null
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Language providers keep their scope mounted when a page below them fails. */
export function ScopedRouteErrorBoundary({ children }: { children: ReactNode }) {
  const scope = useContext(RouteErrorScope)
  return scope ? <ErrorBoundary {...scope}>{children}</ErrorBoundary> : children
}
