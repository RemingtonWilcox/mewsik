# Runtime license provenance

`node-v24.15.0.LICENSE` is the unmodified license file from the official Node.js
`v24.15.0` tag:

- Source: https://github.com/nodejs/node/blob/v24.15.0/LICENSE
- SHA-256: `4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`

The runtime preparation script verifies this hash before copying the license
into an application bundle. Updating the bundled Node version requires adding
the exact matching official license and updating the pinned version and hash in
`scripts/prepare-runtime-resources.mjs`.
