import {
  approvalChallenge,
  releaseApprovalChallenge,
  approveRelease,
  approvalStatus,
  approveEnrolment,
  approveEnvironment,
  enrolmentChallenge,
  approversOverview,
  registerChallenge,
  firstApproverChallenge,
  enrolFirstApprover,
  keyPolicyChallenge,
  approveKeyPolicy,
  approvalPolicyChallenge,
  approveApprovalPolicy,
  requestEnrolment,
  submitApproval,
} from "./definitions/approvals";
import { getApprovalPolicyOp, setApprovalPolicyOp } from "./definitions/approval-policy";
import { dbBackupOp } from "./definitions/db-backup";
import { logStoreMigrateOp } from "./definitions/log-store-migrate";
import { instanceDbCopyOp } from "./definitions/instance-db-copy";
import { approveRunChallengeOp, approveRunOp } from "./definitions/approve-run";
import { cancel } from "./definitions/cancel";
import { doctor } from "./definitions/doctor";
import { checksForSha } from "./definitions/checks-for-sha";
import { acceptActionMoveOp, listActionPinsOp } from "./definitions/action-pins";
import {
  checkArtifactConsumption,
  getArtifact,
  getArtifactFile,
  getArtifactFiles,
  listArtifacts,
} from "./definitions/artifacts";
import {
  instanceDoctorOp,
  instanceDrainOp,
  instanceDrainStatusOp,
  instanceOrgSummaryOp,
  instanceRunActivityOp,
  instanceRunSummaryOp,
  instanceInfraErrorsOp,
  instanceAuditVerifyOp,
  instanceListOrgs,
  instanceWhoami,
  rotateInstanceTokenOp,
  createOrgOp,
  createOrgTokenOp,
  moveRepoBindingOp,
  instanceStartInstallationClaimOp,
  instanceBindInstallationOp,
  instancePruneUnconfiguredProjectsOp,
  setQuotas,
  bootstrapApprover,
} from "./definitions/instance";
import {
  instanceReplaceAppPrivateKeyOp,
  instanceRotateWebhookSecretOp,
} from "./definitions/instance-app-secrets";
import { instanceRevokeOrgTokenOp } from "./definitions/instance-revoke-org-token";
import { githubAppStatus, instanceGithubAppStatus } from "./definitions/github-app-status";
import { getQuotas } from "./definitions/quotas";
import {
  createProjectOp,
  getProjectSettings,
  setProjectSettings,
  setProjectEgressOp,
  tightenProjectEgress,
} from "./definitions/project-settings";
import {
  changeProjectPrPolicy,
  getProjectPrPolicy,
  setProjectPrPolicy,
} from "./definitions/pr-policy";
import { registerSandboxImage } from "./definitions/sandbox-images";
import { createApiToken } from "./definitions/create-api-token";
import { listApiTokensOp } from "./definitions/list-api-tokens";
import { revokeApiTokenOp } from "./definitions/revoke-api-token";
import { events } from "./definitions/events";
import { failureDigest } from "./definitions/failure-digest";
import { listOrgs } from "./definitions/list-orgs";
import { myActivityFeed } from "./definitions/my-activity-feed";
import { listProjects } from "./definitions/list-projects";
import { rerun } from "./definitions/rerun";
import { runDispatch } from "./definitions/run-dispatch";
import {
  listInstallationRepos,
  onboardRepos,
  previewWorkflows,
  runDefaultBranch,
} from "./definitions/onboarding-repos";
import { signRelease } from "./definitions/sign-release";
import {
  getReleaseApprovalOp,
  getReleaseRequestOp,
  requestReleaseOp,
} from "./definitions/release-requests";
import { getInstallationClaimOp, startInstallationClaim } from "./definitions/installation-claim";
import {
  bindInstallationOp,
  listMyOrgsOp,
  listUserInstallationsOp,
  onboardingCreateOrgOp,
} from "./definitions/onboarding";
import { whoami } from "./definitions/whoami";
import {
  getNotificationPrefsOp,
  myNotificationsOp,
  notificationsAckOp,
  setNotificationPrefsOp,
} from "./definitions/notifications";
import { myPendingApprovalsOp } from "./definitions/my-pending-approvals";
import { instanceBindGithubLoginOp, inviteMemberOp } from "./definitions/members";
import { sessionStepUpChallenge } from "./definitions/session-step-up";
import {
  releaseKeyShow,
  releaseSecretStatus,
  releaseCosignKeySet,
  releaseCosignKeyRemove,
  releaseCosignKeyList,
  releasePinRepo,
  releasePublishTargetDelete,
  releasePublishTargetList,
  releasePublishTargetSet,
  releaseSecretSet,
  releaseInitKey,
  releasePublicKey,
  releaseSetProjectSigning,
  releaseProjectSigning,
} from "./definitions/release-config";
import {
  addPassthroughHostOp,
  deletePassthroughHostOp,
  deleteProxyRuleOp,
  listPassthroughHostsOp,
  listProxyRulesOp,
  setProxyRuleOp,
} from "./definitions/proxy-rules";
import { deleteSecretOp, listSecretsOp, rotateSecretOp, setSecretOp } from "./definitions/vault";
import { getRun } from "./definitions/get-run";
import { incidentFreeze, incidentStatus, incidentUnfreeze } from "./definitions/incident";
import { sandboxUsageOp } from "./definitions/sandbox-usage";
import { secretUsage } from "./definitions/secret-usage";
import { addProject, removeProject } from "./definitions/projects";
import { resyncInstallation } from "./definitions/resync-installation";
import { ingestStatusOp } from "./definitions/ingest-status";
import { instanceNetworkStatusOp, networkStatusOp } from "./definitions/network-status";
import { instanceIngestStatusOp } from "./definitions/instance-ingest-status";
import { jobCuts } from "./definitions/job-cuts";
import { jobLog } from "./definitions/job-log";
import { jobSteps } from "./definitions/job-steps";
import { listRuns } from "./definitions/list-runs";
import {
  createWebhookOp,
  disableWebhookOp,
  enableWebhookOp,
  webhookEndpointsOp,
  rotateWebhookSecretOp,
  webhookDeliveriesOp,
} from "./definitions/webhooks";
import { setOidcAudiencesOp } from "./definitions/oidc-audiences";
import {
  deleteProjectVarInstanceOp,
  deleteProjectVarOp,
  listProjectVarsOp,
  setProjectVarInstanceOp,
  setProjectVarOp,
} from "./definitions/project-vars";
import {
  getSettingOp,
  instanceGetSettingOp,
  instanceListSettingsOp,
  instanceSandboxLimitsOp,
  sandboxLimitsOp,
  instanceSetSettingOp,
  listSettingsOp,
  setSettingOp,
} from "./definitions/settings";
import { createRegistry } from "./registry";

export { authenticate, dispatch, type DispatchEnv, type DispatchResult } from "./dispatch";
export { defineOp, type Op, type OpContext, type OpSpec } from "./define";
export { type Credential, type Principal } from "./principal";
export { createRegistry, type OpRegistry } from "./registry";
export { ROLE_RANK, roleSatisfies, type Role } from "./roles";
export { generateToken, hashToken } from "./tokens";
export { ERROR_STATUS, OpError, type ErrorCode } from "./errors";

/** The shipped operations. Signature ops are added here when the first one exists. */
export const registry = createRegistry([
  listRuns,
  getRun,
  jobLog,
  jobSteps,
  jobCuts,
  failureDigest,
  events,
  checksForSha,
  cancel,
  rerun,
  runDispatch,
  listInstallationRepos,
  onboardRepos,
  addProject,
  removeProject,
  previewWorkflows,
  runDefaultBranch,
  approveRunOp,
  approveRunChallengeOp,
  signRelease,
  whoami,
  doctor,
  listOrgs,
  myActivityFeed,
  listProjects,
  ingestStatusOp,
  networkStatusOp,
  createApiToken,
  listApiTokensOp,
  revokeApiTokenOp,
  listActionPinsOp,
  listArtifacts,
  checkArtifactConsumption,
  getArtifact,
  getArtifactFile,
  getArtifactFiles,
  githubAppStatus,
  instanceGithubAppStatus,
  getQuotas,
  instanceWhoami,
  rotateInstanceTokenOp,
  createOrgOp,
  createOrgTokenOp,
  instanceRevokeOrgTokenOp,
  moveRepoBindingOp,
  instanceStartInstallationClaimOp,
  instanceBindInstallationOp,
  instanceRotateWebhookSecretOp,
  instanceReplaceAppPrivateKeyOp,
  instancePruneUnconfiguredProjectsOp,
  instanceListOrgs,
  instanceDoctorOp,
  instanceDrainOp,
  instanceDrainStatusOp,
  instanceOrgSummaryOp,
  instanceRunActivityOp,
  instanceRunSummaryOp,
  instanceInfraErrorsOp,
  instanceIngestStatusOp,
  instanceNetworkStatusOp,
  instanceAuditVerifyOp,
  setQuotas,
  bootstrapApprover,
  dbBackupOp,
  logStoreMigrateOp,
  instanceDbCopyOp,
  acceptActionMoveOp,
  setSecretOp,
  rotateSecretOp,
  deleteSecretOp,
  setProxyRuleOp,
  listProxyRulesOp,
  deleteProxyRuleOp,
  addPassthroughHostOp,
  listPassthroughHostsOp,
  deletePassthroughHostOp,
  listSecretsOp,
  approvalStatus,
  approversOverview,
  myPendingApprovalsOp,
  myNotificationsOp,
  notificationsAckOp,
  getNotificationPrefsOp,
  setNotificationPrefsOp,
  approvalChallenge,
  releaseApprovalChallenge,
  enrolmentChallenge,
  registerChallenge,
  firstApproverChallenge,
  enrolFirstApprover,
  keyPolicyChallenge,
  approveKeyPolicy,
  approvalPolicyChallenge,
  approveApprovalPolicy,
  getApprovalPolicyOp,
  setApprovalPolicyOp,
  requestEnrolment,
  submitApproval,
  approveEnvironment,
  approveRelease,
  approveEnrolment,
  incidentFreeze,
  incidentUnfreeze,
  incidentStatus,
  secretUsage,
  sandboxUsageOp,
  requestReleaseOp,
  getReleaseRequestOp,
  getReleaseApprovalOp,
  startInstallationClaim,
  getInstallationClaimOp,
  bindInstallationOp,
  listMyOrgsOp,
  onboardingCreateOrgOp,
  listUserInstallationsOp,
  inviteMemberOp,
  sessionStepUpChallenge,
  releaseKeyShow,
  releaseSecretStatus,
  releaseCosignKeySet,
  releaseCosignKeyRemove,
  releaseCosignKeyList,
  releasePinRepo,
  releasePublishTargetSet,
  releasePublishTargetList,
  releasePublishTargetDelete,
  releaseSecretSet,
  releaseInitKey,
  releasePublicKey,
  releaseSetProjectSigning,
  releaseProjectSigning,
  instanceBindGithubLoginOp,
  resyncInstallation,
  setOidcAudiencesOp,
  listProjectVarsOp,
  setProjectVarOp,
  deleteProjectVarOp,
  setProjectVarInstanceOp,
  deleteProjectVarInstanceOp,
  getProjectSettings,
  setProjectSettings,
  registerSandboxImage,
  setProjectEgressOp,
  tightenProjectEgress,
  getProjectPrPolicy,
  changeProjectPrPolicy,
  setProjectPrPolicy,
  createProjectOp,
  createWebhookOp,
  webhookEndpointsOp,
  rotateWebhookSecretOp,
  disableWebhookOp,
  enableWebhookOp,
  webhookDeliveriesOp,
  getSettingOp,
  listSettingsOp,
  setSettingOp,
  instanceGetSettingOp,
  instanceListSettingsOp,
  instanceSandboxLimitsOp,
  sandboxLimitsOp,
  instanceSetSettingOp,
]);
