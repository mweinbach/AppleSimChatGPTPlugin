# Releasing

The root package is a private build project. Published packages are `packages/apple-device-hub-mcp` (`apple-device-hub-mcp`) and `plugins/apple-device-hub` (`apple-sim-chatgpt-plugin`). The plugin bundles the standalone MCP runtime, and keeps its own manifest, assets, installer and skills. Both packages share a release version so the bundled server can be traced to its standalone release.

## One-time npm setup

npm trusted publishing requires each package to exist before a trust relationship can be created. Bootstrap the first release from an authenticated maintainer account after CI and archive verification pass:

```sh
npm login
npm run build
npm run pack
npm run verify:packages
npm publish release/apple-device-hub-mcp-0.1.0.tgz --access public
npm publish release/apple-sim-chatgpt-plugin-0.1.0.tgz --access public
```

Then configure both packages to trust this repository's exact release workflow:

```sh
npm trust github apple-device-hub-mcp --repo mweinbach/AppleSimChatGPTPlugin --file publish.yml --allow-publish --yes
npm trust github apple-sim-chatgpt-plugin --repo mweinbach/AppleSimChatGPTPlugin --file publish.yml --allow-publish --yes
npm trust list apple-device-hub-mcp
npm trust list apple-sim-chatgpt-plugin
```

The npm account must have package write access and 2FA enabled. Authentication may require the account owner's browser or OTP interaction. Do not add a long-lived npm token to GitHub. The workflow uses GitHub's short-lived OIDC identity, Node 24 and npm's automatic provenance support. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## New version

From a clean `main` checkout with CI passing:

```sh
npm version patch
git push origin main
git push origin --tags
```

`npm version` synchronizes the root lockfile, both package manifests and the plugin manifest before creating its commit and tag. Use `minor`, `major`, or an explicit semantic version when appropriate. Keep `main` current before tagging. The release workflow validates the committed manifests after building.

The workflow rebuilds, tests and verifies both archives before publishing. A partial publication can be retried using **Actions → Publish → Run workflow** with its existing tag. Already-published versions are accepted only when their tarball integrity matches exactly. Different bytes require a new version. GitHub releases are created only after both packages publish successfully.

The initial bootstrap lacks GitHub provenance. All subsequent versions publish through the trusted workflow with provenance. The bootstrap tag should be recorded as a GitHub release after both packages exist; do not rerun it from another toolchain expecting identical native bytes.

CI validates packaging and protocol behavior. Real ChatGPT rendering, Xcode device interactions and physical-device behavior remain separate acceptance checks described in `VALIDATION.md`.
