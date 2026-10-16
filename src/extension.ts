import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Kitchen } from "./kitchen";

const GERM_BADGE = "*";
// How many paths the warm-up walk looks at per workspace folder, nearest first.
const WARM_LIMIT = 20000;

class KitchenDecorations implements vscode.FileDecorationProvider {
  private kitchens = new Map<string, Kitchen>();
  private changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const kitchen = this.kitchenFor(uri);
    if (!kitchen) return undefined;

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
    // VS Code already badges every symlink with ↪, so stashed paths only
    // get a tooltip; a second badge would show up as "↪, ↪".
    if (v.stashed) deco.tooltip = "Stashed: lives in __stash__ (bake shady)";
    return deco;
  }

  // Everything changed (a .gitignore, a .dishsoap, the stash itself).
  reloadAll(): void {
    for (const k of this.kitchens.values()) k.reload();
    this.changed.fire(undefined);
    this.warmAll();
  }

  // VS Code only asks for a decoration once a row is on screen, then redraws
  // when the answer arrives: that's the visible wait when opening a folder.
  // Announcing a path as changed makes VS Code fetch and cache its decoration
  // right away, so walk the project ahead of time and announce every path
  // that looks different. Undecorated paths need nothing.
  warmAll(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) void this.warm(folder.uri);
  }

  private async warm(rootUri: vscode.Uri): Promise<void> {
    const kitchen = this.kitchenFor(rootUri);
    if (!kitchen) return;
    const queue = [rootUri.fsPath];
    let batch: vscode.Uri[] = [];
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
        if (v.look || v.stashed) batch.push(vscode.Uri.file(abs));
        // Walk your own folders completely. Ignored ones (.venv, caches, data)
        // only one level deep: opening them is instant, digging deeper may wait.
        // Dirent doesn't follow symlinks, so the stash isn't walked.
        if (e.isDirectory() && !kitchen.verdict(dir).look) queue.push(abs);
      }
      if (batch.length >= 500) {
        this.changed.fire(batch);
        batch = [];
        await new Promise((r) => setImmediate(r)); // let VS Code breathe between batches
      }
    }
    if (batch.length) this.changed.fire(batch);
  }

  // One path appeared or disappeared.
  refresh(uri: vscode.Uri): void {
    const kitchen = this.kitchenFor(uri);
    if (!kitchen) return;
    kitchen.forget(uri.fsPath);
    this.changed.fire(uri);
  }

  dropKitchens(): void {
    this.kitchens.clear();
    this.changed.fire(undefined);
    this.warmAll();
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

export function activate(context: vscode.ExtensionContext): void {
  const decorations = new KitchenDecorations();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  decorations.warmAll();

  const rules = vscode.workspace.createFileSystemWatcher(
    "{**/.gitignore,.git/info/exclude,.makery/stations/*/workbench/.dishsoap,__stash__}"
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
