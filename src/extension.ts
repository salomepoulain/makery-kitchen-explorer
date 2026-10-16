import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Kitchen, parseGitIgnored } from "./kitchen";

const GERM_BADGE = "*";
// How many paths the warm-up walk looks at per workspace folder, nearest first.
const WARM_LIMIT = 20000;
// VS Code drops most of a change event above 250 paths ("CAPPING events").
const EVENT_MAX = 250;
// Wait this long after the last file change before asking git again.
const GIT_DEBOUNCE_MS = 400;
// Look-aheads triggered by our own announcements (not by rows you see), per
// workspace folder. Without a cap they would chain through all of .venv.
const CHAIN_LIMIT = 1500;

function run(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? undefined : out))
  );
}

class KitchenDecorations implements vscode.FileDecorationProvider {
  private kitchens = new Map<string, Kitchen>();
  private gitTimers = new Map<string, NodeJS.Timeout>();
  // Folders whose contents were already announced (see lookAhead).
  private lookedInto = new Set<string>();
  // Paths we announced: VS Code asking about them is a prefetch, not a row on screen.
  private announced = new Set<string>();
  private chained = new Map<string, number>(); // per workspace folder
  private changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const kitchen = this.kitchenFor(uri);
    if (!kitchen) return undefined;

    if (!this.announced.has(uri.fsPath)) {
      this.lookAhead(kitchen, uri.fsPath);
    } else {
      const used = this.chained.get(kitchen.root) ?? 0;
      if (used < CHAIN_LIMIT) {
        this.chained.set(kitchen.root, used + 1);
        this.lookAhead(kitchen, uri.fsPath);
      }
    }
    const v = kitchen.verdict(uri.fsPath);
    if (!v.look && !v.stashed) return undefined;

    const deco = new vscode.FileDecoration();
    if (v.look === "germ") {
      deco.color = new vscode.ThemeColor("makeryKitchen.germForeground");
      deco.tooltip = "Germ: deleted by `bake germs`";
      if (v.germRoot) deco.badge = GERM_BADGE;
    } else if (v.look === "ignored") {
      deco.color = new vscode.ThemeColor("makeryKitchen.ignoredForeground");
      deco.tooltip = "Ignored by git";
    }
    // Stashed paths only get a tooltip: no badge (VS Code already shows ↪ on
    // symlinks when badges are on) and no colour of their own.
    if (v.stashed) deco.tooltip = "Stashed: lives in __stash__ (bake shady)";
    return deco;
  }

  // VS Code asks about a row once it's on screen. If that row is a folder,
  // announce what's inside it now, so the contents already have their colours
  // by the time you open it. This reaches as deep as you click, which the
  // startup walk (one level into ignored folders) doesn't.
  private lookAhead(kitchen: Kitchen, dir: string): void {
    if (this.lookedInto.has(dir)) return;
    this.lookedInto.add(dir);
    void fs.promises.readdir(dir, { withFileTypes: true }).then(
      (entries) => {
        const found: string[] = [];
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          const v = kitchen.verdict(abs);
          if (v.look || v.stashed) found.push(abs);
        }
        return this.announce(found);
      },
      () => undefined // a file, or gone: nothing inside to announce
    );
  }

  // Everything changed (a .gitignore, a .dishsoap, the stash itself).
  reloadAll(): void {
    this.lookedInto.clear();
    this.announced.clear();
    this.chained.clear();
    for (const k of this.kitchens.values()) k.reload();
    this.changed.fire(undefined);
    this.warmAll();
  }

  // One path appeared or disappeared.
  refresh(uri: vscode.Uri): void {
    const kitchen = this.kitchenFor(uri);
    if (!kitchen) return;
    kitchen.forget(uri.fsPath);
    this.lookedInto.delete(path.dirname(uri.fsPath));
    this.lookedInto.delete(uri.fsPath);
    this.changed.fire(uri);
    this.scheduleGit(kitchen);
  }

  dropKitchens(): void {
    this.kitchens.clear();
    this.lookedInto.clear();
    this.announced.clear();
    this.chained.clear();
    this.changed.fire(undefined);
    this.warmAll();
  }

  // VS Code only asks for a decoration once a row is on screen, then redraws
  // when the answer arrives: that's the visible wait when opening a folder.
  // Announcing a path as changed makes VS Code fetch and cache its decoration
  // right away, so walk the project ahead of time and announce every path
  // that looks different. Undecorated paths need nothing.
  warmAll(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const kitchen = this.kitchenFor(folder.uri);
      if (!kitchen) continue;
      void this.warm(kitchen);
      this.scheduleGit(kitchen, 0);
    }
  }

  private async warm(kitchen: Kitchen): Promise<void> {
    const queue = [kitchen.root];
    const found: string[] = [];
    let seen = 0;
    while (queue.length && seen < WARM_LIMIT) {
      const dir = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const abs = path.join(dir, e.name);
        seen++;
        const v = kitchen.verdict(abs);
        if (v.look || v.stashed) found.push(abs);
        // Walk your own folders completely. Ignored ones (.venv, caches, data)
        // only one level deep: opening them is instant, digging deeper may wait.
        // Dirent doesn't follow symlinks, so the stash isn't walked.
        if (e.isDirectory() && !kitchen.verdict(dir).look) queue.push(abs);
      }
    }
    await this.announce(found);
  }

  // Fire change events in chunks VS Code accepts whole.
  private async announce(paths: string[]): Promise<void> {
    for (const p of paths) this.announced.add(p);
    for (let i = 0; i < paths.length; i += EVENT_MAX) {
      this.changed.fire(paths.slice(i, i + EVENT_MAX).map((p) => vscode.Uri.file(p)));
      await new Promise((r) => setImmediate(r)); // let VS Code breathe between chunks
    }
  }

  // `git status --ignored` is slow on big untracked data (1-2 s), so it never
  // blocks: the .gitignore reading answers first, git fills in afterwards.
  private scheduleGit(kitchen: Kitchen, delay = GIT_DEBOUNCE_MS): void {
    clearTimeout(this.gitTimers.get(kitchen.root));
    this.gitTimers.set(
      kitchen.root,
      setTimeout(() => void this.askGit(kitchen), delay)
    );
  }

  private async askGit(kitchen: Kitchen): Promise<void> {
    const prefix = await run("git", ["rev-parse", "--show-prefix"], kitchen.root);
    if (prefix === undefined) return; // not a git repo: .gitignore reading only
    const out = await run("git", ["status", "--porcelain=v1", "-z", "--ignored"], kitchen.root);
    if (out === undefined) return;
    await this.announce(kitchen.setGitIgnored(parseGitIgnored(out, prefix.trim())));
  }

  private kitchenFor(uri: vscode.Uri): Kitchen | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const root = folder.uri.fsPath;
    let k = this.kitchens.get(root);
    if (!k) {
      k = new Kitchen(root);
      this.kitchens.set(root, k);
    }
    return k;
  }
}

// "Show Badges" in the Explorer's ... menu, with a checkmark while they're on.
function toggleBadges(): Thenable<void> {
  const config = vscode.workspace.getConfiguration("explorer.decorations");
  return config.update("badges", !config.get<boolean>("badges"), vscode.ConfigurationTarget.Global);
}

export function activate(context: vscode.ExtensionContext): void {
  const decorations = new KitchenDecorations();
  let registration = vscode.window.registerFileDecorationProvider(decorations);
  context.subscriptions.push(
    { dispose: () => registration.dispose() },
    vscode.commands.registerCommand("makeryKitchen.toggleBadges", toggleBadges)
  );
  decorations.warmAll();

  // VS Code's git extension always greys ignored files, even with
  // git.decorations.enabled off. When two extensions colour the same file,
  // the one that registered last wins. So colour right away, and register
  // again once git has started, which puts these colours back on top.
  void Promise.resolve(vscode.extensions.getExtension("vscode.git")?.activate()).then(
    () => {
      registration.dispose();
      registration = vscode.window.registerFileDecorationProvider(decorations);
      decorations.reloadAll();
    },
    () => undefined // git disabled or missing: nothing to win from
  );

  // `.makery/stations/**`, not just the .dishsoap files: `bake first` moves a
  // whole station folder in (and `bake burnt` removes one), which VS Code
  // reports as one folder event, never as a .dishsoap file event.
  const rules = vscode.workspace.createFileSystemWatcher(
    "{**/.gitignore,.git/info/exclude,.makery/stations/**,__stash__}"
  );
  const files = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
  context.subscriptions.push(
    rules,
    files,
    rules.onDidChange(() => decorations.reloadAll()),
    rules.onDidCreate(() => decorations.reloadAll()),
    rules.onDidDelete(() => decorations.reloadAll()),
    files.onDidCreate((uri) => decorations.refresh(uri)),
    files.onDidDelete((uri) => decorations.refresh(uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => decorations.dropKitchens())
  );
}

export function deactivate(): void {}
