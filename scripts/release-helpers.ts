export const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolveReleaseTag(
  explicitTag: string | undefined,
  refType: string | undefined,
  refName: string | undefined,
  version: string,
): string {
  return explicitTag ?? (refType === "tag" ? refName : undefined) ?? `v${version}`;
}

export function assertReleaseVersion(tag: string, packageVersion: string, hostVersion: string): string {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) throw new Error(`Release tag must use strict vX.Y.Z syntax: ${tag}`);
  const tagVersion = match.slice(1).join(".");
  if (packageVersion !== hostVersion) {
    throw new Error(`package.json version ${packageVersion} does not match HOST_VERSION ${hostVersion}`);
  }
  if (tagVersion !== packageVersion) {
    throw new Error(`Release tag ${tag} does not match project version ${packageVersion}`);
  }
  return tagVersion;
}

export function releaseBaseName(version: string): string {
  return `zcode-extensions-v${version}-windows-x64`;
}
