// What the Explorer should show for one path in a makery project.
// No VS Code imports here, so this file can be tested with plain node.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import picomatch from "picomatch";

export type Look = "germ" | "ignored" | undefined;

export interface Verdict {
  look: Look;
  stashed: boolean; // a symlink into __stash__
  germRoot: boolean; // the path a .dishsoap pattern names (not a child of it)
}

interface Layer {
  base: string; // directory the patterns are relative to
  ig: Ignore;
}

function readLines(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

// Where a symlink points: the literal target, plus the fully resolved one when
// it exists. The literal one still works when .shadow/ hasn't synced in yet
// (dangling link); the resolved one covers .shadow/ itself being a symlink.
function linkTargets(link: string): string[] {
  const out: string[] = [];
  try {
    out.push(path.resolve(path.dirname(link), fs.readlinkSync(link)));
  } catch {
    return out;
  }
  try {
    out.push(fs.realpathSync(link));
  } catch {
    /* dangling */
  }
  return out;
}

// git reads core.excludesFile, or ~/.config/git/ignore when it isn't set.
function globalExcludesFile(): string {
  const gitconfig = readLines(path.join(os.homedir(), ".gitconfig")) ?? "";
  const m = gitconfig.match(/^\s*excludesfile\s*=\s*(.+?)\s*$/im);
  if (m) return m[1].replace(/^~(?=\/)/, os.homedir()).replace(/^"(.*)"$/, "$1");
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "git", "ignore");
}

export class Kitchen {
  private dirLayers = new Map<string, Layer | null>(); // per-directory .gitignore
  private baseLayers: Layer[] = []; // global excludes + .git/info/exclude
  private germMatch: (rel: string) => boolean = () => false;
  private verdicts = new Map<string, Verdict>();
  private stashDirs: string[] = []; // where __stash__ points, see linkTargets

  constructor(readonly root: string) {
    this.reload();
  }

  // Forget everything: call when .gitignore, .dishsoap or __stash__ change.
  reload(): void {
    this.dirLayers.clear();
    this.verdicts.clear();

    this.baseLayers = [];
    for (const file of [globalExcludesFile(), path.join(this.root, ".git", "info", "exclude")]) {
      const text = readLines(file);
      if (text) this.baseLayers.push({ base: this.root, ig: ignore().add(text) });
    }

    const patterns: string[] = [];
    const stations = path.join(this.root, ".makery", "stations");
    let names: string[] = [];
    try {
      names = fs.readdirSync(stations);
    } catch {
      /* not a makery project */
    }
    for (const name of names) {
      if (name === "_empty_station") continue;
      const text = readLines(path.join(stations, name, "workbench", ".dishsoap")) ?? "";
      for (const line of text.split(/\r?\n/)) {
        // bash matches `.ruff_cache/` to the folder, picomatch needs it without the slash.
        const s = line.trim().replace(/\/+$/, "");
        if (s && !s.startsWith("#")) patterns.push(s);
      }
    }
    // Same rules as bash with globstar: `*` and `**` skip dot-folders
    // unless the pattern names them.
    this.germMatch = patterns.length ? picomatch(patterns, { dot: false }) : () => false;

    const stash = path.join(this.root, "__stash__");
    this.stashDirs = lstat(stash)?.isSymbolicLink() ? linkTargets(stash) : [];
  }

  // Forget one path (and anything below it) after it was created or deleted.
  forget(abs: string): void {
    const rel = this.rel(abs);
    for (const key of this.verdicts.keys()) {
      if (key === rel || key.startsWith(rel + "/")) this.verdicts.delete(key);
    }
  }

  verdict(abs: string): Verdict {
    const rel = this.rel(abs);
    let v = this.verdicts.get(rel);
    if (!v) {
      v = this.compute(rel);
      this.verdicts.set(rel, v);
    }
    return v;
  }

  private rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private compute(rel: string): Verdict {
    const none: Verdict = { look: undefined, stashed: false, germRoot: false };
    if (!rel || rel.startsWith("..") || rel === ".git" || rel.startsWith(".git/")) return none;

    const parts = rel.split("/");
    const parent = parts.length > 1 ? this.verdict(path.join(this.root, ...parts.slice(0, -1))) : none;
    const st = lstat(path.join(this.root, rel));

    const germRoot = this.germMatch(rel);
    const germ = germRoot || parent.look === "germ";
    // git never looks inside an ignored folder, so its children stay ignored.
    const ignored = germ || parent.look === "ignored" || this.isIgnored(rel, st);

    return {
      look: germ ? "germ" : ignored ? "ignored" : undefined,
      stashed: this.isStashed(rel, st),
      germRoot,
    };
  }

  // Layers from lowest to highest priority; the last one with an opinion wins.
  private isIgnored(rel: string, st: fs.Stats | undefined): boolean {
    // git treats a symlink as a file, so `foo/` patterns don't match it.
    const asDir = st?.isDirectory() ? "/" : "";
    let ignored = false;
    const layers = [...this.baseLayers];
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = path.join(this.root, ...parts.slice(0, i));
      const layer = this.layerFor(dir);
      if (layer) layers.push(layer);
    }
    for (const { base, ig } of layers) {
      const sub = path.relative(base, path.join(this.root, rel)).split(path.sep).join("/");
      const r = ig.test(sub + asDir);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
    return ignored;
  }

  private layerFor(dir: string): Layer | undefined {
    if (!this.dirLayers.has(dir)) {
      const text = readLines(path.join(dir, ".gitignore"));
      this.dirLayers.set(dir, text ? { base: dir, ig: ignore().add(text) } : null);
    }
    return this.dirLayers.get(dir) ?? undefined;
  }

  private isStashed(rel: string, st: fs.Stats | undefined): boolean {
    if (!this.stashDirs.length || !st?.isSymbolicLink() || rel === "__stash__") return false;
    const targets = linkTargets(path.join(this.root, rel));
    return targets.some((t) => this.stashDirs.some((s) => t.startsWith(s + path.sep)));
  }
}
