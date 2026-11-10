// Pure changed-path selection; importing this helper does not read recipes or run a build.
export function selectAuditRecipeIds(recipeIds, { only, changedFiles } = {}) {
  if (only) return only.split(","); // Keep unknown ids: audit must report them, not silently skip them.
  if (changedFiles === undefined) return [...recipeIds];
  // Tool helpers affect the build/index contract too. Do not turn a tools-only PR into a zero-target audit.
  const globalChange = changedFiles.some((file) => (file.startsWith("tools/") && file.endsWith(".mjs"))
    || file === "bases.json" || file === ".github/workflows/check.yml" || file === ".github/workflows/build.yml");
  if (globalChange) return [...recipeIds];
  const known = new Set(recipeIds);
  return [...new Set(changedFiles.map((file) => /^recipes\/([^/]+)\//.exec(file)?.[1])
    .filter((id) => known.has(id)))];
}
