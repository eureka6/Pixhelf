export async function copyText(name: string, container: HTMLElement = document.body): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(name);
      return;
    }
  } catch { /* Keep copying available on HTTP and when clipboard access is denied. */ }
  const active = document.activeElement;
  const input = document.createElement("textarea");
  input.value = name;
  input.readOnly = true;
  input.tabIndex = -1;
  Object.assign(input.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" });
  container.append(input);
  input.focus({ preventScroll: true });
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
  }
}
