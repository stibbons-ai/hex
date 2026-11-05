import { isDocument, normalizeContentId } from "./document";
import type { AttachmentFacts } from "./document";
import { safeFileName } from "./file-name";

/** One attachment as an Intake carries it. */
export type IntakeAttachmentFacts = Omit<AttachmentFacts, "referencedByCid"> & {
  /** Content-ID as sent, with or without angle brackets. */
  readonly contentId?: string | undefined;
};

/** A Document found among an Intake's attachments. */
export interface DetectedDocument {
  /** Its 0-based index among the attachments (a fallback name uses `index + 1`). */
  readonly index: number;
  /** The safe name to file it under (see `safeFileName`). */
  readonly fileName: string;
}

/**
 * The Documents among an Intake's attachments, in order, each with the safe name to file it
 * under; `cidReferences` are the Content-IDs the HTML body references (`contentIdReferences`),
 * with or without angle brackets, any case.
 */
export function detectDocuments(
  attachments: readonly IntakeAttachmentFacts[],
  cidReferences: Iterable<string>,
): DetectedDocument[] {
  const references = new Set(Array.from(cidReferences, normalizeContentId));
  return attachments.flatMap((attachment, index) => {
    const referencedByCid =
      attachment.contentId !== undefined &&
      references.has(normalizeContentId(attachment.contentId));
    if (!isDocument({ ...attachment, referencedByCid })) return [];
    return [{ index, fileName: safeFileName(attachment.fileName, attachment.mimeType, index + 1) }];
  });
}
