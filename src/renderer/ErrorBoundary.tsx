import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    message: "",
    stack: "",
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message,
      stack: error.stack || "",
    };
  }

  public componentDidCatch(error: Error) {
    // Keep a renderer-side log so users have something actionable when reporting issues.
    console.error("[renderer-crash]", error);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <main className="grid h-screen place-items-center bg-[radial-gradient(circle_at_top,_#1a1a1a_0%,_#0f0f0f_45%,_#090909_100%)] p-6 text-[var(--text-primary)]">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-card)] shadow-2xl shadow-black/40">
            <div className="border-b border-[var(--border)] bg-[linear-gradient(120deg,_rgba(185,28,28,0.22),_rgba(127,29,29,0.05))] px-6 py-4">
              <div className="text-[17px] font-semibold text-[var(--text-primary)]">Renderer crashed</div>
              <p className="mt-1 text-[12px] text-[var(--text-dim)]">
                SnCode hit an unexpected runtime error in the UI process.
              </p>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-200">
                {this.state.message || "Unknown renderer error"}
              </div>

              {this.state.stack && (
                <details className="group rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-input)]">
                  <summary className="cursor-pointer select-none px-3.5 py-2 text-[12px] text-[var(--text-muted)]">
                    Error details
                  </summary>
                  <pre className="max-h-60 overflow-auto border-t border-[var(--border-subtle)] px-3.5 py-2 text-[11px] leading-relaxed text-[var(--text-dim)]">
                    {this.state.stack}
                  </pre>
                </details>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-lg bg-[var(--bg-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
                >
                  Reload app
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const body = `${this.state.message}\n\n${this.state.stack || ""}`.trim();
                    void navigator.clipboard.writeText(body);
                  }}
                  className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-active)]"
                >
                  Copy error
                </button>
              </div>
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
