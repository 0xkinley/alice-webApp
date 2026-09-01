export { saveCandidateUpdate } from "./candidate-updates.ts";
export { suggestProjectUpdatesFromFile } from "./file-candidate-suggestions.ts";
export {
  activeTargetForConnection,
  listSelectableProjectContexts,
  setActiveConnectionTarget,
} from "./active-targets.ts";
export { listIntegrationConnections, revokeIntegrationConnection } from "./connections.ts";
export {
  ContextAccessUserError,
  endContextAccess,
  getContextAccessView,
  grantContextAccess,
  updateContextAccessRole,
} from "./context-access.ts";
export {
  listContextReadEvents,
  recordContextReadFailure,
  recordContextReadSuccess,
} from "./context-read-events.ts";
export type { ContextReadFailureCode, ContextReadRequestMode } from "./context-read-events.ts";
export {
  getRemovalPreview,
  getSavedContextView,
  removeSavedContextEntry,
} from "./saved-context.ts";
export { appendAuditEvent } from "./audit.ts";
export {
  contextScopeForConnection,
  contextScopeForUser,
  projectScopeForConnection,
  projectScopeForUser,
  tenantScopeForConnection,
  tenantScopeForUser,
} from "./authorization.ts";
export type {
  ConnectionScope,
  ContextCapability,
  ContextRole,
  ContextScope,
  ProjectCapability,
  ProjectConnectionScope,
  ProjectRole,
  ProjectScope,
  TenantScope,
} from "./authorization.ts";
export {
  alphaInvitationForToken,
  authenticateUser,
  createUserSession,
  issueAlphaInvitation,
  registerUser,
  revokeUserSession,
  userForSession,
} from "./authentication.ts";
export { ContextBudgetError, getProjectContext, listProjects } from "./project-context.ts";
export { getPrivateAlphaSignals } from "./product-signals.ts";
export { getProjectAccessOverview } from "./project-access.ts";
export {
  createHostFileSaveOffer,
  decideHostFileSaveOffer,
  getHostFileSaveOfferPreview,
  HOST_FILE_SAVE_OFFER_LIFETIME_MS,
  HostFileSaveOfferUserError,
} from "./host-file-save-offers.ts";
export type { HostFileSaveDecision } from "./host-file-save-offers.ts";
export {
  archiveProject,
  cancelProjectDeletion,
  exportProjectData,
  getProjectLifecycle,
  listArchivedProjects,
  ProjectLifecycleUserError,
  requestProjectDeletion,
  restoreProject,
} from "./project-lifecycle.ts";
export { createProject, getProject } from "./projects.ts";
export {
  acceptProjectInvitation,
  createProjectInvitation,
  declineProjectInvitation,
  getProjectCollaborators,
  getProjectInvitationPreview,
  getProjectMembershipView,
  leaveProject,
  listSharedProjects,
  ProjectMembershipUserError,
  removeProjectMember,
  resendProjectInvitation,
  revokeProjectInvitation,
  transferProjectOwnership,
  updateProjectMemberRole,
} from "./project-memberships.ts";
export type { ProjectInvitationRole, ProjectMembershipRole } from "./project-memberships.ts";
export {
  FILE_UPLOAD_LIMIT_BYTES,
  FILE_UPLOAD_INTENT_LIFETIME_MS,
  FILE_UPLOAD_URL_LIFETIME_SECONDS,
  ProjectFileUserError,
  createProjectFileUploadIntent,
  exportProjectFileMetadata,
  getProjectFileDownload,
  getProjectFilePreview,
  getProjectFileReferencePreview,
  getProjectFileRemovalPreview,
  getProjectFileView,
  listProjectFiles,
  finalizeProjectFileUpload,
  readProjectFilePdfText,
  readProjectFileText,
  refreshProjectFileScan,
  referenceProjectFileInContext,
  removeProjectFileReference,
  sanitizeProjectFileDisplayName,
  uploadProjectFile,
  validateProjectFileUploadDeclaration,
  validateProjectFile,
} from "./project-files.ts";
export type {
  FileScanStatus,
  PrivateFileStore,
  ProviderScanResult,
  VerifiedFileMediaType,
} from "./project-files.ts";
export { getReviewQueue, listReviewProjects } from "./review-queue.ts";
export {
  acceptCandidate,
  cancelCapturedUpdate,
  confirmCapturedUpdate,
  getCapturePreview,
  rejectCandidate,
  supersedeAcceptedState,
} from "./trusted-state.ts";
export {
  createWorkContext,
  getWorkContextHistory,
  listWorkContexts,
  provisionInitialWorkContexts,
  suggestSimilarWorkContexts,
} from "./work-contexts.ts";
