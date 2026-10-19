import { registerHooks } from "node:module";
import { workspaceSource } from "./workspace-sources.mjs";

// A relative ".js" specifier with no ".js" file behind it falls back to the sibling ".ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = workspaceSource(specifier);
    if (source) {
      return nextResolve(source, context);
    }
    if (!specifier.endsWith(".js")) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
