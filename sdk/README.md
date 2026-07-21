# ZCode Extension SDK

Typed authoring helpers for extensions hosted by [ZCode Desktop Extensions](https://github.com/notmike101/zcode-extensions).

```sh
npm install @notmike101/zcode-extension-sdk
```

Main-process extensions import from `@notmike101/zcode-extension-sdk/main`; renderer extensions import from `@notmike101/zcode-extension-sdk/renderer`. The `experimental` entrypoint exposes version-fragile raw ZCode service access.

The manifest wire version remains `apiVersion: 1`. APIs added in SDK 0.3 require `engines.host` to include `>=0.3.0` and the corresponding declared capabilities.

Extensions are trusted code, not a security sandbox. Capability declarations provide disclosure and SDK-boundary checks; they cannot prevent Node or renderer code from bypassing the SDK.
