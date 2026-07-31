import type { AttachmentMetadata } from "@/attachments/types";
import { encodeAttachmentsForSend, type EncodedImageAttachment } from "@/attachments/service";

type ImageInput = AttachmentMetadata;

export async function encodeImages(
  images?: ImageInput[],
): Promise<EncodedImageAttachment[] | undefined> {
  return await encodeAttachmentsForSend(images);
}
