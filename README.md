# Makery Kitchen Explorer

A VS Code extension that shows what kind of kitchen mess each file is, right in the Explorer.

| Look | Means | Comes from |
|---|---|---|
| grey | git ignores it | `.gitignore` (every level), `.git/info/exclude`, your global excludes file |
| dimmer grey + `*` | a germ: `bake germs` deletes it | `.makery/stations/*/workbench/.dishsoap` of every hired station |
| `↪` (VS Code's own symlink badge) + "Stashed" tooltip | stashed: a symlink into `__stash__` | `bake shady` |

It reads those files itself instead of asking git, and keeps the answers in memory, so a folder
shows the right colours the moment you open it. It reloads when a `.gitignore`, a `.dishsoap` or
`__stash__` changes, and re-checks single paths when files appear or disappear.

A stash that hasn't synced to this machine yet still shows `↪`: a dangling link into `__stash__`
is still stashed.

## Recommended settings

Turn off VS Code's own git colours so they don't fight this extension, and turn badges on:

```jsonc
"git.decorations.enabled": false,
"explorer.decorations.colors": true,
"explorer.decorations.badges": true,
"problems.decorations.enabled": false
```

The colours are themeable as `makeryKitchen.ignoredForeground` and `makeryKitchen.germForeground`
in `workbench.colorCustomizations`.

## Develop

```sh
npm install
npm test          # checks the matching rules against `git check-ignore` on a scratch repo
npm run package   # builds makery-kitchen-explorer-<version>.vsix
code --install-extension makery-kitchen-explorer-0.1.0.vsix
```
