import { z } from "zod";

export const initialTicketSchema = z.object({
  itemId: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  indexEpoch: z.string().uuid(), operationId: z.string().regex(/^[a-f0-9]{64}$/),
  admissionKind: z.literal("owner_once").optional(),
}).strict();
export const initialStateSchema = z.object({ ticket: initialTicketSchema,
  state: z.enum(["reserved", "attempting", "complete", "uncertain"]),
}).strict();
export type InitialIngestTicket = z.infer<typeof initialTicketSchema>;
export type InitialIngest = z.infer<typeof initialStateSchema>;
export const sameInitial = (a: InitialIngestTicket, b: InitialIngestTicket) =>
  a.itemId === b.itemId && a.inputHash === b.inputHash && a.indexEpoch === b.indexEpoch
  && a.operationId === b.operationId && a.admissionKind === b.admissionKind;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const initialRecoveryProof = z.object({ previousId: digest, previousPlanHash: digest,
  previousJobHash: digest, indexEpoch: z.string().uuid(), operationId: digest, witnessHash: digest,
}).strict();
export type InitialRecoveryProof = z.infer<typeof initialRecoveryProof>;
