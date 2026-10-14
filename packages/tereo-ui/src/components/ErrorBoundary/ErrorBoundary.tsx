import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorPage } from "./ErrorPage";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary]", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ error: null, errorInfo: null });
  };

  render(): ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === "function")
      return fallback(error, this.handleReset);
    if (fallback) return fallback;

    return (
      <ErrorPage
        error={error}
        details={errorInfo?.componentStack ?? null}
        onReset={this.handleReset}
      />
    );
  }
}
