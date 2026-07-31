import type { AttachmentMetadata } from "@/attachments/types";
import { getAttachmentStore } from "@/attachments/store";
import { isAbsolutePath } from "@/utils/path";

export interface EncodedImageAttachment {
  data: string;
  mimeType: string;
  /** Absolute local path when the attachment is already on disk (desktop/native). */
  path?: string;
}

function resolveSendableAttachmentPath(attachment: AttachmentMetadata): string | undefined {
  if (attachment.storageType !== "desktop-file" && attachment.storageType !== "native-file") {
    return undefined;
  }
  const candidate = attachment.storageKey.trim();
  return isAbsolutePath(candidate) ? candidate : undefined;
}

export async function persistAttachmentFromBlob(input: {
  blob: Blob;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "blob", blob: input.blob },
  });
}

export async function persistAttachmentFromDataUrl(input: {
  dataUrl: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "data_url", dataUrl: input.dataUrl },
  });
}

export async function persistAttachmentFromBytes(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "bytes", bytes: input.bytes },
  });
}

export async function persistAttachmentFromFileUri(input: {
  uri: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "file_uri", uri: input.uri },
  });
}

export async function encodeAttachmentsForSend(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<EncodedImageAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const store = await getAttachmentStore();
  const encoded = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const data = await store.encodeBase64({ attachment });
        const path = resolveSendableAttachmentPath(attachment);
        return {
          data,
          mimeType: attachment.mimeType,
          ...(path ? { path } : {}),
        } satisfies EncodedImageAttachment;
      } catch (error) {
        console.error("[attachments] Failed to encode attachment for send", {
          id: attachment.id,
          error,
        });
        return null;
      }
    }),
  );

  const valid = encoded.filter((entry): entry is EncodedImageAttachment => entry !== null);
  return valid.length > 0 ? valid : undefined;
}

export async function resolveAttachmentPreviewUrl(attachment: AttachmentMetadata): Promise<string> {
  const store = await getAttachmentStore();
  return await store.resolvePreviewUrl({ attachment });
}

export async function releaseAttachmentPreviewUrl(input: {
  attachment: AttachmentMetadata;
  url: string;
}): Promise<void> {
  const store = await getAttachmentStore();
  if (!store.releasePreviewUrl) {
    return;
  }
  await store.releasePreviewUrl({ attachment: input.attachment, url: input.url });
}

export async function deleteAttachments(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }
  const store = await getAttachmentStore();
  await Promise.all(
    attachments.map(async (attachment) => {
      try {
        await store.delete({ attachment });
      } catch (error) {
        console.warn("[attachments] Failed to delete attachment", {
          id: attachment.id,
          error,
        });
      }
    }),
  );
}

export async function garbageCollectAttachments(input: {
  referencedIds: ReadonlySet<string>;
}): Promise<void> {
  const store = await getAttachmentStore();
  await store.garbageCollect({ referencedIds: input.referencedIds });
}
