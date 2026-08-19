// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.2.10'

// Access / permissions schemas (layered editor — Epic 4.7.2)
export {
  AccessEntry,
  AccessLevel,
  DatasetAccess,
  SetAccessRequest,
} from './schemas/access.js'

// AHR schemas (Epic 11 + AHR — ANAS Hybrid RAID)
export {
  AhrArray,
  AhrArrayMember,
  AhrArraySync,
  AhrCapacity,
  AhrCreateRequest,
  AhrCreateSnapshotRequest,
  AhrDisk,
  AhrDiskPartition,
  AhrDiskRole,
  AhrExpandRequest,
  AhrExpansionIntent,
  AhrExpansionState,
  AhrExpansionStep,
  AhrExpansionStepKind,
  AhrExpansionTrigger,
  AhrLayoutPreview,
  AhrLayoutPreviewRequest,
  AhrMemberState,
  AhrMountpointRequest,
  AhrPool,
  AhrPoolState,
  AhrPreviewBand,
  AhrReplacePair,
  AhrReplaceRequest,
  AhrSnapshot,
  AhrSnapshotName,
  AhrSpareRequest,
  AhrStepStatus,
  AhrSyncAction,
  AhrType,
  ArrayLevel,
  ArrayState,
} from './schemas/ahr.js'

// API envelope schemas
export {
  ApiError,
  ConfirmHeader,
  dataResponse,
  ErrorCode,
  RequestHeaders,
} from './schemas/api.js'

// Backup schemas (Epic 16 — PBS file backup)
export {
  BACKUP_SKIP_EXIT_CODE,
  BACKUP_SKIPPED_OFF_WEEK,
  BACKUP_WEEKDAYS,
  BackupArchive,
  BackupAuthType,
  BackupCadence,
  BackupCadenceKind,
  BackupName,
  BackupNotifyMode,
  BackupPrunePreviewRequest,
  BackupPrunePreviewResponse,
  BackupPruneResult,
  BackupPruneSnapshot,
  BackupPruneVerdict,
  BackupRecentRun,
  BackupRepo,
  BackupRepoRef,
  BackupRepoRegistry,
  BackupRepoResponse,
  BackupRepoSource,
  BackupRepoTestRequest,
  BackupRepoTestResult,
  BackupRepoWrite,
  BackupRetention,
  BackupRunRequest,
  BackupRunResult,
  BackupTask,
  BackupTaskDetail,
  BackupTaskEntry,
  BackupTaskRequest,
  BackupTaskView,
  BackupTimeOfDay,
  BackupWeekday,
  BackupWeekParity,
  cadenceToOnCalendar,
  ChangeDetectionMode,
  hasRetentionKeeps,
  PVE_REPO_PREFIX,
  UpsertBackupRepoRequest,
} from './schemas/backup.js'

// Common validators
export {
  AbsolutePath,
  DatasetPath,
  DevicePath,
  DiskId,
  hasControlChars,
  ISODateTime,
  NotifyMode,
  PoolName,
  ShareName,
  SingleLine,
  SnapshotName,
  UUID,
} from './schemas/common.js'

// Dashboard schemas (Epic 2)
export {
  AhrBandBrief,
  AhrBandMemberBrief,
  AhrBandTelemetry,
  AhrPoolBrief,
  AhrPoolTelemetry,
  ArcTelemetry,
  DashboardWarning,
  DiskHealthCounts,
  DiskTelemetry,
  IoStats,
  JobBrief,
  NetInterface,
  NetTelemetry,
  PoolStatusBrief,
  PoolTelemetry,
  ShareStatusBrief,
  StatusSummary,
  Telemetry,
  VdevTelemetry,
} from './schemas/dashboard.js'

// Dataset schemas
export {
  AssociatedShare,
  CreateDatasetRequest,
  Dataset,
  DatasetDetail,
  DatasetProperties,
  DatasetType,
  MountpointPermissions,
  SetPermissionsRequest,
  UpdateDatasetPropertiesRequest,
} from './schemas/datasets.js'

// Disk schemas
export {
  Disk,
  DiskHealthStatus,
  DiskPartition,
  DiskUsageStatus,
  SmartAttribute,
  SmartData,
  SmartHealth,
} from './schemas/disks.js'

// Filesystem browse (read-only UI support — Epic 16.9)
export {
  FsBrowseQuery,
  FsBrowseResult,
  FsEntryType,
} from './schemas/fs.js'

// Identity schemas (share users & groups — Epic 8)
export {
  CreateGroupRequest,
  CreateShareUserRequest,
  IdentityName,
  LookupName,
  SetSmbPasswordRequest,
  SetUserEnabledRequest,
  ShareGroup,
  ShareUser,
  SystemGroup,
  SystemUser,
  UpdateGroupMembersRequest,
} from './schemas/identity.js'

// Job schemas
export {
  Job,
  JobAccepted,
  JobDetail,
  JobList,
  JobRef,
  JobStatus,
} from './schemas/jobs.js'

// Mount schemas (Epic 18 — external & local storage)
export {
  CreateMountRequest,
  DeleteMountQuery,
  MountCapacity,
  MountCharset,
  MountCifsCache,
  MountCifsOptions,
  MountCifsSec,
  MountCommonOptions,
  MountCredentials,
  MountCredentialsInfo,
  MountDetail,
  MountEntry,
  MountHealth,
  MountInlineCredentials,
  MountKind,
  MountLookupCache,
  MountMode,
  MountNfsOptions,
  MountNfsProto,
  MountNfsSec,
  MountOptions,
  MountQueryFlag,
  MountRequestOptions,
  MountSec,
  MountState,
  MountStateRequest,
  MountSummary,
  MountTestRequest,
  MountTestResult,
  MountTestVerdict,
  MountType,
  MountUnit,
  MountVers,
  UpdateMountRequest,
} from './schemas/mounts.js'

// Replication schemas (Epic 5.5)
export {
  LenientReplicationTask,
  RemotesFile,
  RemoteTestResult,
  ReplicatePlan,
  ReplicatePlanRequest,
  ReplicateRequest,
  ReplicationLocation,
  ReplicationRemote,
  ReplicationTarget,
  ReplicationTask,
  ReplicationTaskName,
  ReplicationTaskStatus,
  UpsertRemoteRequest,
} from './schemas/replication.js'

// Schedule schemas (Epic 17 — uniform ANAS-owned snapshot schedules)
export {
  LastScrub,
  PeriodicScrubState,
  RetentionBucket,
  RetentionPlan,
  RetentionPolicy,
  ScheduledSnapshot,
  ScheduleId,
  ScheduleRunResult,
  ScrubMechanism,
  ScrubRunning,
  ScrubTarget,
  ScrubToggleRequest,
  SnapshotCadence,
  SnapshotSchedule,
  SnapshotScheduleDetail,
  SnapshotScheduleRunResult,
  SnapshotScheduleStatus,
  SnapshotSource,
  SnapshotTarget,
} from './schemas/schedules.js'

// Share schemas (SMB + NFS)
export {
  CreateNfsExportRequest,
  CreateSmbShareRequest,
  NfsClient,
  NfsExport,
  ShareEntry,
  SmbConnection,
  SmbGlobalConfig,
  SmbShare,
  SmbShareDetail,
  UpdateNfsExportRequest,
  UpdateSmbGlobalConfigRequest,
  UpdateSmbShareRequest,
} from './schemas/shares.js'

// Snapshot schemas
export {
  CloneSnapshotRequest,
  CreateSnapshotRequest,
  RenameSnapshotRequest,
  Snapshot,
} from './schemas/snapshots.js'

// ZFS schemas
export {
  AddVdevRequest,
  AttachDiskRequest,
  CreatePoolRequest,
  ExpansionBusyState,
  ExpansionCapability,
  ExpansionGateReason,
  ExpansionOpKind,
  ExpansionTarget,
  ExportPoolRequest,
  ImportPoolRequest,
  PoolDetail,
  PoolDisk,
  PoolExpansionReport,
  PoolHealthMessage,
  PoolMountpointRequest,
  PoolProperties,
  PoolState,
  PoolSummary,
  PveStorageRef,
  ScanFunction,
  ScanState,
  ScanStatus,
  ScrubRequest,
  TrimPoolRequest,
  UpdatePoolPropertiesRequest,
  Vdev,
  VdevGroup,
  VdevRole,
  VdevSpec,
  VdevState,
  VdevType,
} from './schemas/zfs.js'
