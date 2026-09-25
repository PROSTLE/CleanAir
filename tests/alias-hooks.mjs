import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", "/index.ts"];

function resolveFile(base) {
  if (existsSync(base) && !base.endsWith(path.sep)) {
    const ext = path.extname(base);
    if (ext) return base;
  }
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const file = resolveFile(path.join(root, specifier.slice(2)));
    if (file) return nextResolve(pathToFileURL(file).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.includes("/lib/")) {
    const file = resolveFile(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (file) return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
