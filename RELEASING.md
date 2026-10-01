# Releasing

The root package is a private build project. The published npm package is `packages/apple-device-hub-mcp` (`apple-device-hub-mcp`). The plugin in `plugins/apple-device-hub` is installed from this repository's `apple-device-hub` marketplace with `codex plugin`; its `.mcp.json` runs `apple-device-hub-mcp` of the same version through `npx`, so a new version must be published before `main` advertises it. The earlier `apple-sim-chatgpt-plugin` npm installer is no longer published.

## One-time npm setup

npm trusted publishing requires each package to exist before a trust relationship can be created. Bootstrap the first release from an authenticated maintainer account after CI and archive verification pass:

```sh
npm login
npm run build
npm run pack
npm run verify:packages
npm publish ./release/apple-device-hub-mcp-0.1.0.tgz --access public
```

Then configure the package to trust this repository's exact release workflow:

```sh
npm trust github apple-device-hub-mcp --repo mweinbach/AppleSimChatGPTPlugin --file publish.yml --allow-publish --yes
npm trust list apple-device-hub-mcp
```

The npm account must have package write access and 2FA enabled. Authentication may require the account owner's browser or OTP interaction. Do not add a long-lived npm token to GitHub. The workflow uses GitHub's short-lived OIDC identity, Node 24 and npm's automatic provenance support. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## New version

From a clean `main` checkout with CI passing:

```sh
npm version patch
git push origin main
git push origin --tags
```

`npm version` synchronizes the root lockfile, the MCP package manifest, the plugin manifests and the plugin's npx server version before creating its commit and tag. Use `minor`, `major`, or an explicit semantic version when appropriate. Keep `main` current before tagging. The release workflow validates the committed manifests after building. Plugin installs from `main` can start the new server only once the workflow has published it, a few minutes after the tag is pushed.

The workflow rebuilds, tests and verifies the npm archive and the complete `apple-device-hub-<version>.zip` before publishing. The ZIP contains portable manifests, a compatibility manifest, skills and the bundled runtime. It is extracted and probed independently of the source checkout. GitHub releases attach both archives with SHA-256 checksums. See [gallery submission](docs/gallery/SUBMISSION.md) for the local MCP review route; publishing npm or GitHub artifacts does not publish to the gallery.

A partial publication can be retried using **Actions → Publish → Run workflow** with its existing tag. Already-published versions are accepted only when their tarball integrity matches exactly. Different bytes require a new version. GitHub releases are created only after the package publishes successfully.

The initial bootstrap lacks GitHub provenance. All subsequent versions publish through the trusted workflow with provenance. The bootstrap tag should be recorded as a GitHub release after the package exists; do not rerun it from another toolchain expecting identical native bytes.

CI validates packaging and protocol behavior. Real ChatGPT rendering, Xcode device interactions and physical-device behavior remain separate acceptance checks described in `VALIDATION.md`.
