import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    message: ""
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message
    };
  }

  public render() {
    if (this.state.hasError) {
      return (
        <main className="grid h-screen place-items-center bg-slate-950 p-6 text-slate-100">
          <div className="w-full max-w-xl rounded-2xl border border-rose-700/60 bg-rose-950/30 p-5">
            <h1 className="text-lg font-semibold">SNCode renderer crashed</h1>
            <p className="mt-2 text-sm text-slate-300">{this.state.message}</p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
