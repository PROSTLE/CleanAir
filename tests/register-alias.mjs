// Lets `node --test` run the real TypeScript modules (Node's built-in type
// stripping) by resolving the app's "@/..." path alias. No test framework
// or build step needed.
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
