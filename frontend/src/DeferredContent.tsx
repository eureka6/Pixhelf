import { Component, type ComponentChildren } from "preact";
import { Suspense } from "preact/compat";
import { LoaderCircle } from "./icons";
import { useModalDialog } from "./useModalDialog";

function LoadingMessage({ failed = false }: { failed?: boolean }) {
  return <div className="deferred-message" role={failed ? "alert" : "status"}>
    {failed ? <><span>加载失败，请检查网络后重试。</span><button type="button" onClick={() => location.reload()}>重新加载</button></>
      : <><LoaderCircle className="spin" size={22} /><span>正在加载…</span></>}
  </div>;
}

function LoadingDialog({ onClose, failed }: { onClose: () => void; failed: boolean }) {
  const dialog = useModalDialog(onClose);
  return <dialog {...dialog} className="deferred-dialog" aria-label={failed ? "加载失败" : "正在打开"}>
    <LoadingMessage failed={failed} />
    <button type="button" onClick={onClose}>关闭</button>
  </dialog>;
}

// Keep navigation available while a feature downloads, and surface module-load
// failures instead of leaving an empty page on an unreliable connection.
export class DeferredContent extends Component<{ children: ComponentChildren; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    const fallback = this.props.onClose
      ? <LoadingDialog onClose={this.props.onClose} failed={this.state.failed} />
      : <LoadingMessage failed={this.state.failed} />;
    return this.state.failed ? fallback : <Suspense fallback={fallback}>{this.props.children}</Suspense>;
  }
}
