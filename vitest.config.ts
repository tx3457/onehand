import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Agent worktrees under .claude/ contain their own copy of tests/.
    exclude: [...configDefaults.exclude, "dist/**", ".claude/**", ".omc/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
