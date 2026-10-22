# Skills Manager

Installed a bunch of agent skills you no longer use? Clean them up from your terminal.

Skills Manager finds skills on your computer, groups them by name, and lets you select and remove the ones you no longer need.

## Run

Requires Node.js 20+. From a local checkout:

```sh
npm start
```

Or run the checkout with npx:

```sh
npx --yes --package . skills-manager
```

## Use

- Type to search and use the arrow keys to browse.
- Press **Enter** to open a group, then **Space** to select skills.
- Press **Ctrl+D** to review the paths and deletion risks.
- Type **delete** to confirm. Removal is permanent.

Press **Esc** to go back or **?** for more shortcuts.

## Contribute

Issues and pull requests are welcome. Run `npm test` and `npm run check` before submitting changes.

## License

[MIT](LICENSE)
