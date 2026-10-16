// Checks Kitchen against git itself on a scratch repo. Run: npm test
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Kitchen } from "../kitchen";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-test-")));
const root = path.join(tmp, "proj");
const shadow = path.join(tmp, "shadow");

function write(rel: string, text = ""): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

fs.mkdirSync(root, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: root });

write(".gitignore", ["*.log", "!keep.log", "build/", "data/", ".env", "__pycache__/", ".claude", "deep/**/tmp"].join("\n"));
write("sub/.gitignore", ["secret.txt", "!important.log"].join("\n"));
write(".git/info/exclude", "local-only/\n");
write(".makery/stations/python/workbench/.dishsoap", ["# germs", "**/__pycache__", ".ruff_cache", "*.egg-info", ".mypy_cache/"].join("\n"));
write(".makery/stations/_empty_station/workbench/.dishsoap", "normal.py\n"); // must be skipped

for (const f of [
  "normal.py", "a.log", "keep.log", "build/x", "src/build", "data/y", "src/data/z",
  "sub/secret.txt", "sub/important.log", "sub/other.log", "sub/deeper/secret.txt",
  "local-only/z", "src/__pycache__/m.pyc", "__pycache__/r.pyc", ".env",
  "deep/a/b/tmp", "deep/tmp", ".ruff_cache/c", "pkg.egg-info/PKG-INFO", "src/pkg.egg-info/x",
  ".venv/lib/__pycache__/v.pyc", ".mypy_cache/m",
]) write(f);

// Stash: __stash__ points at the shadow folder, .claude links into it.
fs.mkdirSync(path.join(shadow, ".claude"), { recursive: true });
fs.symlinkSync(shadow, path.join(root, "__stash__"));
fs.symlinkSync(path.join(shadow, ".claude"), path.join(root, ".claude"));
fs.symlinkSync("/etc/hosts", path.join(root, "elsewhere-link")); // a symlink NOT into the stash

const kitchen = new Kitchen(root);
const v = (rel: string) => kitchen.verdict(path.join(root, rel));

function gitIgnores(rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${(e as Error).message}`);
  }
}

console.log("## matches git check-ignore (non-germ paths)");
const nonGerm = [
  "normal.py", "a.log", "keep.log", "build", "build/x", "src/build", "data", "data/y", "src/data", "src/data/z",
  "sub/secret.txt", "sub/important.log", "sub/other.log", "sub/deeper/secret.txt",
  "local-only", "local-only/z", ".env", "deep/a/b/tmp", "deep/tmp", ".claude", "elsewhere-link", ".makery",
];
for (const rel of nonGerm) {
  check(rel, () => assert.strictEqual(v(rel).look !== undefined, gitIgnores(rel), `kitchen=${v(rel).look} git=${gitIgnores(rel)}`));
}

console.log("## germs (.dishsoap, bash-glob rules)");
for (const rel of ["src/__pycache__", "__pycache__", ".ruff_cache", "pkg.egg-info", ".mypy_cache"]) {
  check(`${rel} is a germ root`, () => {
    assert.strictEqual(v(rel).look, "germ");
    assert.strictEqual(v(rel).germRoot, true);
  });
}
check("child of a germ is dim but has no badge", () => {
  assert.strictEqual(v(".ruff_cache/c").look, "germ");
  assert.strictEqual(v(".ruff_cache/c").germRoot, false);
});
check("*.egg-info only matches at the root, like bash", () => assert.notStrictEqual(v("src/pkg.egg-info").germRoot, true));
check("** does not reach into hidden .venv", () => assert.notStrictEqual(v(".venv/lib/__pycache__").germRoot, true));
check("_empty_station's .dishsoap is skipped", () => assert.notStrictEqual(v("normal.py").look, "germ"));

console.log("## stashed (symlink into __stash__)");
check(".claude is stashed", () => assert.strictEqual(v(".claude").stashed, true));
check("symlink elsewhere is not stashed", () => assert.strictEqual(v("elsewhere-link").stashed, false));
check("__stash__ itself is not marked", () => assert.strictEqual(v("__stash__").stashed, false));
check("plain file is not stashed", () => assert.strictEqual(v("normal.py").stashed, false));

// .shadow/ not synced to this machine yet: __stash__ and the links dangle.
const root2 = path.join(tmp, "proj2");
fs.mkdirSync(root2);
const missing = path.join(tmp, "not-synced-yet");
fs.symlinkSync(missing, path.join(root2, "__stash__"));
fs.symlinkSync(path.join(missing, ".env"), path.join(root2, ".env"));
fs.symlinkSync("/nowhere/x", path.join(root2, "other-dangling"));
const k2 = new Kitchen(root2);
check("dangling link into unsynced stash is stashed", () => assert.strictEqual(k2.verdict(path.join(root2, ".env")).stashed, true));
check("dangling link elsewhere is not stashed", () => assert.strictEqual(k2.verdict(path.join(root2, "other-dangling")).stashed, false));

console.log("## reload picks up .gitignore edits");
write(".gitignore", "normal.py\n");
kitchen.reload();
check("normal.py ignored after edit", () => assert.strictEqual(v("normal.py").look, "ignored"));
check("a.log no longer ignored", () => assert.strictEqual(v("a.log").look, undefined));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`## ${failures} failures`);
process.exit(failures ? 1 : 0);
