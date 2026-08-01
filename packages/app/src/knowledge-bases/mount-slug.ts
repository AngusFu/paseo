/** Same pattern as daemon `assertValidKbSlug` (docs-vfs knowledge-base-registry). */
export const KB_MOUNT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const VIRTUAL_VFS_ROOT = "/paseo-vfs";

export function isValidKbMountSlug(slug: string): boolean {
  return KB_MOUNT_SLUG_PATTERN.test(slug);
}

export function vfsPathForMountSlug(mountSlug: string): string {
  return `${VIRTUAL_VFS_ROOT}/${mountSlug}`;
}
