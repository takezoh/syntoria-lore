export { CoreService } from './core-service.js';
export { CursorCodec } from './cursor.js';
export type { CursorState } from './cursor.js';
export { withAuthorizedActor } from './authorized-transaction.js';
export { observationLocatorDigest, sourceIdentityDigest } from './governance-keys.js';
export {
  UNCLASSIFIED_COMPARTMENT_ID,
  allowanceIds,
  canonicalLabel,
  compartmentNotAvailable,
  isSubsetLabel,
  narrowActor,
  normalizeCompartmentName,
  resolveCompartments,
  resolveWriteLabel,
  unionLabels,
} from './compartments.js';
export type { LabelOrigin, WriteLabel } from './compartments.js';
export { CompartmentService } from './compartment-service.js';
export type { AllowanceApproval, ConnectionRef } from './compartment-service.js';
