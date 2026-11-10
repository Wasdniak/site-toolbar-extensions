# Site Toolbar Extensions

> **Personal project.** Built for my own setup (Zen + Sine). Shared as-is: no support, and it may break when Zen updates. Issues and PRs may not get a response.

Pinned extension buttons that only show on the sites you choose. For example, X extensions show on X tabs only, and YouTube extensions show on YouTube tabs only. Extensions you haven't given any sites stay visible everywhere.

## Using it

Right-click an extension's toolbar button, or the extension in the puzzle-piece extensions panel:

- **Show on _site_**: adds the current site to the extension's list (subdomains count too). If the extension isn't pinned yet, it gets pinned to the toolbar. Click it again to remove the site. Removing the last site unpins the extension and sends it back to the extensions panel.
- **Show on every site**: clears the list, so the extension acts like a normal pinned button again.

Switching tabs or navigating swaps the buttons. Leaving buttons sink down through the toolbar, then new ones rise up with a small bounce. The motion is based on Zia's glance card. If your system's reduce-motion setting is on, buttons fade instead.

- Each window follows its own selected tab.
- Switching sites only hides buttons, it doesn't unpin them, so toolbar order and pins are kept.
- Pages that aren't websites (`about:`, new tab, settings) show only the extensions without site lists.
- Customize Toolbar shows every button.
- Extensions stay in the puzzle-piece panel on every site.

## Settings

In **Settings → Sine Mods → Site Toolbar Extensions** you can turn the filtering or the animation off, or edit the rules as JSON (keyed by extension ID):

```json
{ "x-posed@xaitax.com": ["x.com", "twitter.com"] }
```

## Install

This is a JavaScript mod and needs the [Sine](https://github.com/CosmoCreeper/Sine) mod manager.

1. In Zen, open **Settings → Sine Mods**, click the gear (**Open settings**) and turn on **Enable installing JS from unofficial sources**.
2. Under the Marketplace, in the **add your own locally from a GitHub repo** box, enter `Wasdniak/site-toolbar-extensions` and click **Install**.
3. Go to `about:support`, click **Clear startup cache**, and restart Zen.

Sine checks this repo for updates on its own (unless auto-updates are off for Sine or for this mod).

## Releasing an update

Sine only installs an update when `updatedAt` in `theme.json` is newer than the installed copy's. For every release, bump `version`, set `updatedAt` to the current UTC time, then commit and push to `main`.

## License

MIT, see [LICENSE](LICENSE). The show and hide animations are adapted from Zia's glance card rise and sink, (c) 2026 z1nk, also MIT; see [ZIA-LICENSE.txt](ZIA-LICENSE.txt).
