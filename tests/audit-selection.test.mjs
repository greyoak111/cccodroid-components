// Pure selection regression: no gh, devkit, downloads, component builds or device files.
import assert from "node:assert/strict";
import test from "node:test";
import { selectAuditRecipeIds } from "../tools/audit-selection.mjs";

const ids = ["alpha", "beta", "gamma"];

test("tool-only and build-workflow changes select every recipe", () => {
  for (const file of ["tools/audit.mjs", "tools/audit-selection.mjs", "tools/ci-selftest.mjs",
    "tools/ci-build.mjs", "tools/lib.mjs", "tools/build-index.mjs", "tools/check-recipes.mjs",
    "tools/future-helper.mjs", "bases.json", ".github/workflows/check.yml", ".github/workflows/build.yml"]) {
    const selected = selectAuditRecipeIds(ids, { changedFiles: [file] });
    assert.deepEqual(selected, ids, file);
    assert.notEqual(selected, ids, file);
  }
});

test("one recipe selects only itself, multiple changed files do not duplicate it", () => {
  assert.deepEqual(selectAuditRecipeIds(ids, { changedFiles: ["recipes/beta/recipe.json"] }), ["beta"]);
  assert.deepEqual(selectAuditRecipeIds(ids, { changedFiles: ["recipes/beta/recipe.json",
    "recipes/beta/skill/SKILL.md", "docs/recipe.md", "recipes/alpha/wrapper.sh"] }), ["beta", "alpha"]);
});

test("global tool changes take precedence over a single changed recipe", () => {
  assert.deepEqual(selectAuditRecipeIds(ids, { changedFiles: ["recipes/beta/recipe.json", "tools/lib.mjs"] }), ids);
});

test("documentation and test-only changes have no recipe targets", () => {
  for (const changedFiles of [[], ["README.md"], ["docs/recipe.md"], ["tools/README.md"],
    ["tests/audit-selection.test.mjs", "tests/host-api.test.mjs"]]) {
    assert.deepEqual(selectAuditRecipeIds(ids, { changedFiles }), [], JSON.stringify(changedFiles));
  }
});

test("deleted or unknown recipe directories do not become build targets", () => {
  assert.deepEqual(selectAuditRecipeIds(ids, { changedFiles: ["recipes/removed/recipe.json", "recipes/alpha/skill/SKILL.md"] }), ["alpha"]);
});

test("no changed filter selects all, while --only preserves explicit validation and ordering", () => {
  const selected = selectAuditRecipeIds(ids);
  assert.deepEqual(selected, ids);
  assert.notEqual(selected, ids);
  assert.deepEqual(selectAuditRecipeIds(ids, { only: "beta,missing", changedFiles: ["tools/lib.mjs"] }), ["beta", "missing"]);
  assert.deepEqual(selectAuditRecipeIds(ids, { only: "beta", changedFiles: [] }), ["beta"]);
});
