import * as vscode from "vscode";
import { Kitchen } from "./kitchen";

const GERM_BADGE = "*";

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
