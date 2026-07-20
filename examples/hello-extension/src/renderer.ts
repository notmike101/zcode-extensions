import type {ExtensionBridge} from "../../../sdk/index.ts";

type Greeting = {message: string; count: number};

window.ZDP_REGISTER_PLUGIN_RENDERER?.({
  id: "hello-extension",
  mount(container, bridge) {
    const style = document.createElement("style");
    style.textContent = `
      .hello-extension { display: grid; gap: 16px; max-width: 680px; }
      .hello-extension label { display: grid; gap: 6px; font-weight: 600; }
      .hello-extension input {
        border: 1px solid #454954; border-radius: 8px; padding: 10px 12px;
        background: #17191f; color: inherit;
      }
      .hello-extension button {
        width: fit-content; border: 0; border-radius: 8px; padding: 10px 14px;
        background: #5865f2; color: white; cursor: pointer;
      }
      .hello-extension output { min-height: 24px; color: #c7cad3; }
    `;

    const root = document.createElement("section");
    root.className = "hello-extension";
    root.innerHTML = `
      <div>
        <h2>Hello Extension</h2>
        <p>A minimal extension page backed by a namespaced main-process handler.</p>
      </div>
      <label>Your name <input type="text" maxlength="80" value="ZCode"></label>
      <button type="button">Send greeting</button>
      <output aria-live="polite">Ready.</output>
    `;
    container.replaceChildren(style, root);

    const input = root.querySelector("input");
    const button = root.querySelector("button");
    const output = root.querySelector("output");
    if (!input || !button || !output) throw new Error("Hello Extension UI did not initialize");

    const showGreeting = (value: unknown) => {
      if (!value || typeof value !== "object" || !("message" in value)) return;
      output.textContent = String((value as Greeting).message);
    };

    const removeListener = bridge.on((event, payload) => {
      if (event === "plugin:hello-extension:greeted") showGreeting(payload);
    });

    const greet = async () => {
      button.disabled = true;
      output.textContent = "Greeting…";
      try {
        const result = await invoke<Greeting>(bridge, "greet", {name: input.value});
        showGreeting(result);
      } catch (error) {
        output.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    };
    button.addEventListener("click", greet);

    return () => {
      removeListener();
      button.removeEventListener("click", greet);
      container.replaceChildren();
    };
  },
});

function invoke<T>(bridge: ExtensionBridge, method: string, payload?: unknown): Promise<T> {
  return bridge.invoke<T>("plugin:invoke", {pluginId: "hello-extension", method, payload});
}
