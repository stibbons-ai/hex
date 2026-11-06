// The DateExtractor for tests: answers as scripted and records every Document it was asked
// about, standing in for the model as the recording Mailer stands in for the SMTP server.
import { DateExtractionError, DateExtractor } from "@hex/adapters";
import type { DocumentFile } from "@hex/adapters";
import { Effect, Layer } from "effect";

/**
 * What the scripted DateExtractor answers for a Document, standing in for the model's answer: a
 * date, an Error (a failed model call), or a promise of either (a model call that takes until the
 * test says so).
 */
export type Script = (document: DocumentFile) => unknown;

/** A DateExtractor answering by `script`; `asked` holds each Document it was asked about. */
export function scriptedDateExtractor(script: Script) {
  const asked: DocumentFile[] = [];
  const layer = Layer.succeed(DateExtractor, {
    extract: (document) =>
      Effect.promise(async () => {
        asked.push(document);
        return script(document);
      }).pipe(
        Effect.flatMap((answer) =>
          answer instanceof Error
            ? Effect.fail(new DateExtractionError({ message: answer.message }))
            : Effect.succeed({ answer, usage: undefined }),
        ),
      ),
  });
  return { layer, asked };
}
